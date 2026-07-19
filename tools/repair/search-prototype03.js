// tools/repair/search-prototype03.js
// Prototype 03専用のSearch本体。12セル(中心対称な軸部分集合2×2×3の直積、軸入替あり)
// 候補を決定論的に探索し、hard gate通過候補をcomparatorで順位付けする。
//
// 方針:
//   - Prototype 02のSearch(search-prototype02.js)を全面コピーしない。
//     RNG(createRng)・非破壊shuffle(shuffled)だけを再利用し、それ以外は
//     Prototype 03専用のロジックとしてこのファイルへ最小実装する。
//   - 座標生成は「一般的な125セルからの組合せ探索」ではなく、probeで検証済みの
//     中心対称な軸部分集合(サイズ2または3)の直積+軸入替という構造族だけを使う。
//   - hard gateはすべてtools/repair/prototype02-analyzer.jsの既存検証済み関数
//     (analyzeDirectSubtraction / analyzeStrongStagedPath / countLineConstrainedSolutions等)
//     を呼び出すだけで判定する。analyzeDirectionalEvidence等のexact deviation系や
//     正解情報を使ったdiscoverability判定は一切使用しない(forbidden_gates)。
//   - progress_metrics(nonPositiveProgressStepCount/finalStepGainShare等)は
//     hard gateではなく、候補間の決定論的な比較にのみ使う。
//   - 候補JSONの保存はこのファイルの責務に含めない(--outは将来のフックとして
//     用意するが、本工程では呼び出さない)。
'use strict';
const fs = require('fs');
const A = require('./prototype02-analyzer.js');
const { createRng, shuffled } = require('./search-prototype02.js');

const N5 = 5;
const SELECTION_GATE_VERSION = 1;
const DEFAULT_SEED = 20260719;
const DEFAULT_MAXIMUM_SAMPLES = 10000;

// --- hard gateのnamed constants ---------------------------------------------
const MIN_CORRECT_UNLOCKED = 1;           // 正しい位置に残る未確定セルの下限
const MIN_MISPLACED_LEVELS = 2;           // 誤配置セルが分散すべき最小LEVEL数
const MIN_STRONG_COMPATIBLE = 1;          // analyzeStrongStagedPathのrootStrongCompatibleCount下限
const MAX_STRONG_COMPATIBLE = 3;          // 同上限
const ALLOWED_PATH_LENGTHS = new Set([7, 8]); // staged pathの交換手数として許容する範囲

// =========================================================================
// buildPrototype03CellSets: 中心対称な軸部分集合(サイズ2または3)の直積を
// 軸入替も含めて生成し、重複除外・singleton 0判定まで行う。
// =========================================================================
const AXIS_SIZE2_OPTIONS = [[0, 4], [1, 3]];
const AXIS_SIZE3_OPTIONS = [[0, 2, 4], [1, 2, 3]];
const AXES = ['z', 'y', 'x'];

function buildCellSetFromAxisOptions(opt){
  const cells = [];
  for(const z of opt.z) for(const y of opt.y) for(const x of opt.x) cells.push({ L: z + 1, r: y, c: x });
  return cells;
}

function cellSetKey(cells){
  return cells.map(c => `${c.L}-${c.r}-${c.c}`).sort().join(',');
}

// 未確定1件ラインが0本であること(構造のみ、値非依存)を確認する。
function hasNoSingletonLine(cellSetBase, lines){
  const idx = new Set(cellSetBase.map(c => `${c.L}-${c.r}-${c.c}`));
  for(const line of lines){
    let unknownCount = 0;
    for(const cell of line.cells){
      if(idx.has(`${cell.z + 1}-${cell.y}-${cell.x}`)) unknownCount++;
    }
    if(unknownCount === 1) return false;
  }
  return true;
}

function buildPrototype03CellSets(lines){
  const raw = [];
  for(let size3AxisIdx = 0; size3AxisIdx < 3; size3AxisIdx++){
    const size3Axis = AXES[size3AxisIdx];
    const size2Axes = AXES.filter(a => a !== size3Axis);
    for(const size3Opt of AXIS_SIZE3_OPTIONS){
      for(const opt0 of AXIS_SIZE2_OPTIONS){
        for(const opt1 of AXIS_SIZE2_OPTIONS){
          const opt = {};
          opt[size3Axis] = size3Opt;
          opt[size2Axes[0]] = opt0;
          opt[size2Axes[1]] = opt1;
          raw.push(buildCellSetFromAxisOptions(opt));
        }
      }
    }
  }

  const seenKeys = new Set();
  const dedupedCellSets = [];
  for(const cells of raw){
    const key = cellSetKey(cells);
    if(seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedCellSets.push(cells);
  }

  return dedupedCellSets.map((cellSetBase, index) => ({
    cellSetIndex: index,
    cellSetBase,
    structuralOk: cellSetBase.length === 12 && hasNoSingletonLine(cellSetBase, lines),
  }));
}

// =========================================================================
// 成立ライン数(established line count)を数える小さなヘルパー。
// progress_metrics算出専用(hard gateには使わない)。
// =========================================================================
function countEstablishedLines(CUBE_DATA, lines, cellSetBase, values){
  const cellsAtState = cellSetBase.map((c, i) => ({ L: c.L, r: c.r, c: c.c, initialValue: values[i] }));
  const board = A.buildBoard(CUBE_DATA, cellsAtState);
  return A.summarizeLines(board, lines).eq;
}

// witnessPathを内部で再生し、各stepの成立ライン増加量からprogress_metricsを得る。
function computeProgressMetrics(CUBE_DATA, lines, cellSetBase, initialValues, witnessPath){
  let values = initialValues.slice();
  const eqSeries = [countEstablishedLines(CUBE_DATA, lines, cellSetBase, values)];

  for(const step of witnessPath){
    const next = values.slice();
    const tmp = next[step.i]; next[step.i] = next[step.j]; next[step.j] = tmp;
    values = next;
    eqSeries.push(countEstablishedLines(CUBE_DATA, lines, cellSetBase, values));
  }

  const gains = [];
  for(let k = 1; k < eqSeries.length; k++) gains.push(eqSeries[k] - eqSeries[k - 1]);

  const nonPositiveProgressStepCount = gains.filter(g => g <= 0).length;
  const totalGain = eqSeries[eqSeries.length - 1] - eqSeries[0];
  const lastGain = gains.length > 0 ? gains[gains.length - 1] : 0;
  const finalStepGainShare = totalGain !== 0 ? (lastGain / totalGain) : null;
  const witnessStrongCompatibleSum = witnessPath.reduce((sum, step) => sum + step.strongCompatibleCount, 0);

  return { nonPositiveProgressStepCount, finalStepGainShare, witnessStrongCompatibleSum };
}

// =========================================================================
// evaluatePrototype03Candidate: 1候補(cellSetBase + initialValuesの割当)を
// hard gate(structure/human_visible/validation)で判定し、progress_metricsを
// 併せて算出する。
// =========================================================================
function evaluatePrototype03Candidate(CUBE_DATA, lines, cellSetBase, correctValues, initialValues, meta){
  const cells = cellSetBase.map((c, i) => ({
    L: c.L, r: c.r, c: c.c,
    correctValue: correctValues[i],
    initialValue: initialValues[i],
  }));

  const gates = {};

  // --- structure gates ------------------------------------------------------
  gates.cellCountIs12 = cellSetBase.length === 12;
  gates.noSingletonLine = hasNoSingletonLine(cellSetBase, lines);

  const direct = A.analyzeDirectSubtraction(CUBE_DATA, lines, cells);
  gates.directSubtractionSolvedZero = direct.solvedCellCount === 0;

  const correctCount = cells.filter(c => c.initialValue === c.correctValue).length;
  gates.correctCellCountAtLeastOne = correctCount >= MIN_CORRECT_UNLOCKED;

  const misplacedLevels = new Set(cells.filter(c => c.initialValue !== c.correctValue).map(c => c.L));
  gates.misplacedLevelSpread = misplacedLevels.size >= MIN_MISPLACED_LEVELS;

  const board = A.buildBoard(CUBE_DATA, cells);
  const summary = A.summarizeLines(board, lines);
  gates.hasUpAndDown = summary.over > 0 && summary.under > 0;
  gates.hasIntraAndCrossAbnormal = summary.byClass.intra.abnormal > 0 && summary.byClass.cross.abnormal > 0;

  const structurePassed = Object.keys(gates).every(k => gates[k] === true);

  // --- human_visible gate(analyzeStrongStagedPath) --------------------------
  let stagedPath = null, humanVisiblePassed = false;
  const humanVisibleGates = {};
  if(structurePassed){
    stagedPath = A.analyzeStrongStagedPath(CUBE_DATA, lines, cells);
    humanVisibleGates.hasPath = stagedPath.hasPath === true;
    humanVisibleGates.rootStrongCompatibleInRange =
      stagedPath.rootStrongCompatibleCount >= MIN_STRONG_COMPATIBLE &&
      stagedPath.rootStrongCompatibleCount <= MAX_STRONG_COMPATIBLE;
    humanVisibleGates.pathLengthAllowed = stagedPath.hasPath === true && ALLOWED_PATH_LENGTHS.has(stagedPath.pathLength);
    humanVisiblePassed = Object.keys(humanVisibleGates).every(k => humanVisibleGates[k] === true);
  }

  // --- validation gate(countLineConstrainedSolutions) -----------------------
  let uniqueness = null, validationPassed = false;
  if(structurePassed && humanVisiblePassed){
    uniqueness = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells);
    validationPassed = uniqueness.isUnique === true;
  }

  const passed = structurePassed && humanVisiblePassed && validationPassed;

  let metrics = null;
  if(passed){
    const progress = computeProgressMetrics(CUBE_DATA, lines, cellSetBase, initialValues, stagedPath.witnessPath);
    metrics = Object.assign({
      rootStrongCompatibleCount: stagedPath.rootStrongCompatibleCount,
      pathLength: stagedPath.pathLength,
    }, progress);
  }

  return {
    cellSetIndex: meta.cellSetIndex,
    sampleIndex: meta.sampleIndex,
    cellSetBase,
    correctValues,
    initialValues,
    gates,
    humanVisibleGates,
    passed,
    metrics,
  };
}

// =========================================================================
// comparePrototype03Candidates: 完全決定論的な比較(exact deviation不使用)。
// =========================================================================
function comparePrototype03Candidates(a, b){
  const ma = a.metrics, mb = b.metrics;

  if(ma.nonPositiveProgressStepCount !== mb.nonPositiveProgressStepCount){
    return ma.nonPositiveProgressStepCount - mb.nonPositiveProgressStepCount; // 少ない方が良い
  }
  if(ma.finalStepGainShare !== mb.finalStepGainShare){
    return ma.finalStepGainShare - mb.finalStepGainShare; // 小さい方が良い
  }
  const distA = Math.abs(ma.rootStrongCompatibleCount - 2);
  const distB = Math.abs(mb.rootStrongCompatibleCount - 2);
  if(distA !== distB) return distA - distB; // 2に近い方が良い
  if(ma.witnessStrongCompatibleSum !== mb.witnessStrongCompatibleSum){
    return ma.witnessStrongCompatibleSum - mb.witnessStrongCompatibleSum; // 少ない方が良い
  }
  if(ma.pathLength !== mb.pathLength){
    return ma.pathLength - mb.pathLength; // 短い方が良い
  }
  if(a.cellSetIndex !== b.cellSetIndex) return a.cellSetIndex - b.cellSetIndex; // 小さい方が良い
  return a.sampleIndex - b.sampleIndex; // 最終的な決着(常に一意)
}

// =========================================================================
// runPrototype03Search: 探索本体。
// =========================================================================
function runPrototype03Search(options){
  const opts = Object.assign({ seed: DEFAULT_SEED, maximumSamples: DEFAULT_MAXIMUM_SAMPLES }, options || {});
  const { CUBE_DATA, lines } = A.loadCubeContext();

  const allCellSets = buildPrototype03CellSets(lines);
  const validCellSets = allCellSets.filter(cs => cs.structuralOk);

  const rng = createRng(opts.seed);
  const perSetCap = Math.max(1, Math.floor(opts.maximumSamples / Math.max(1, validCellSets.length)));

  let evaluatedSamples = 0;
  const passedCandidates = [];

  outer:
  for(const { cellSetIndex, cellSetBase } of validCellSets){
    const correctValues = cellSetBase.map(c => CUBE_DATA[c.L - 1][c.r][c.c]);

    for(let attempt = 0; attempt < perSetCap; attempt++){
      if(evaluatedSamples >= opts.maximumSamples) break outer;

      const permIndex = shuffled(cellSetBase.map((_, i) => i), rng);
      const isIdentity = permIndex.every((v, i) => v === i);
      if(isIdentity) continue;

      const initialValues = permIndex.map(pi => correctValues[pi]);
      const sampleIndex = evaluatedSamples;
      evaluatedSamples++;

      const result = evaluatePrototype03Candidate(
        CUBE_DATA, lines, cellSetBase, correctValues, initialValues,
        { cellSetIndex, sampleIndex }
      );
      if(result.passed) passedCandidates.push(result);
    }
  }

  passedCandidates.sort(comparePrototype03Candidates);
  const selectedCandidate = passedCandidates.length > 0 ? passedCandidates[0] : null;

  return {
    seed: opts.seed,
    maximumSamples: opts.maximumSamples,
    cellSetCount: allCellSets.length,
    structurallyValidCellSetCount: validCellSets.length,
    evaluatedSamples,
    passedCount: passedCandidates.length,
    selectedCandidate,
  };
}

// =========================================================================
// buildPrototype03Artifact: 候補データファイルと同一系統のスキーマへ正規化する。
// witnessPathと正解交換手順、exact deviation順位は一切含めない。
// =========================================================================
function buildPrototype03Artifact(result){
  if(!result.selectedCandidate) return null;
  const cand = result.selectedCandidate;

  const repairCells = cand.cellSetBase
    .map((coord, i) => ({ z: coord.L - 1, y: coord.r, x: coord.c, initialValue: cand.initialValues[i] }))
    .sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));

  return {
    schemaVersion: 1,
    prototype: 'repair-prototype-03',
    source: {
      seed: result.seed,
      maximumSamples: result.maximumSamples,
      evaluatedSamples: result.evaluatedSamples,
      selectionGateVersion: SELECTION_GATE_VERSION,
    },
    cells: repairCells,
    metrics: {
      nonPositiveProgressStepCount: cand.metrics.nonPositiveProgressStepCount,
      finalStepGainShare: cand.metrics.finalStepGainShare,
      rootStrongCompatibleCount: cand.metrics.rootStrongCompatibleCount,
      pathLength: cand.metrics.pathLength,
      witnessStrongCompatibleSum: cand.metrics.witnessStrongCompatibleSum,
    },
  };
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv){
  const args = { seed: DEFAULT_SEED, maximumSamples: DEFAULT_MAXIMUM_SAMPLES, dryRun: false, out: null };
  for(const arg of argv){
    if(arg === '--dry-run') args.dryRun = true;
    else if(arg.startsWith('--seed=')) args.seed = parseInt(arg.slice('--seed='.length), 10);
    else if(arg.startsWith('--samples=')) args.maximumSamples = parseInt(arg.slice('--samples='.length), 10);
    else if(arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  return args;
}

function formatSummary(result){
  const lines = [];
  lines.push(`seed=${result.seed} maximumSamples=${result.maximumSamples}`);
  lines.push(`cellSetCount=${result.cellSetCount} structurallyValidCellSetCount=${result.structurallyValidCellSetCount}`);
  lines.push(`evaluatedSamples=${result.evaluatedSamples} passedCount=${result.passedCount}`);
  lines.push(`selected=${result.selectedCandidate ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  const result = runPrototype03Search({ seed: args.seed, maximumSamples: args.maximumSamples });
  console.log(formatSummary(result));
  if(args.dryRun){
    console.log('(dry-run: ファイルは書き込みません)');
    return;
  }
  if(args.out){
    const artifact = buildPrototype03Artifact(result);
    if(!artifact){
      console.log('selectedCandidate=null のため、ファイルは書き込みません(非成功)');
      return;
    }
    fs.writeFileSync(args.out, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`written to ${args.out}`);
  }
}

if(require.main === module){ main(); }

module.exports = {
  N5,
  SELECTION_GATE_VERSION,
  DEFAULT_SEED,
  DEFAULT_MAXIMUM_SAMPLES,
  buildPrototype03CellSets,
  evaluatePrototype03Candidate,
  comparePrototype03Candidates,
  runPrototype03Search,
  buildPrototype03Artifact,
  parseArgs,
  formatSummary,
};
