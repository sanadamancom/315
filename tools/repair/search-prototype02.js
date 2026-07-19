// tools/repair/search-prototype02.js
// Prototype 02の未確定8セル候補を決定論的に探索するツール。
// 本ファイル単体では最終候補の選定・保存は行わない(CLIの--outは将来のフック)。
//
// パイプライン:
//   1. 座標・値・固定セル・LEVEL分散など安価な構造検証(O(125)程度)
//   2. ↑↓/階層内外異常/28交換/optimal pathなどの品質評価(候補ごとにO(数百〜数千))
//   3. 品質評価を通過した候補のうち、スコア上位shortlistだけ8!一意解検証(O(40320))
//
// 乱数はMath.randomに依存せず、seed指定可能なPRNG(mulberry32)を使う。
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const A = require('./prototype02-analyzer.js');
const Q = require('./prototype02-quality.js');

const N5 = 5;

// --- 選定gateの named constants -----------------------------------------------
const SELECTION_GATE_VERSION = 1;         // gateロジックのバージョン(候補データのsourceへ記録する)
const DEFAULT_SHORTLIST_SIZE = 20;        // shortlist件数のデフォルト(過去の選定作業で使われた規模)
const MIN_CORRECT_UNLOCKED = 2;           // 正しい位置の未確定セルの下限
const MIN_MISPLACED_LEVELS = 3;           // 誤配置セルが分散すべき最小LEVEL数
const MIN_SWAP_DISTANCE = 4;              // 最短交換数の下限
const MAX_FINAL_BURST_RATIO = 0.5;        // 最終手への回復集中の上限(0-1、低いほど段階的)
const MAX_OPTIMAL_DIRECTIONAL_RANK = 3;   // optimal first pairがdirectional evidence上位とみなす順位の上限
const MAX_NONOPTIMAL_IMPROVING_RATIO = 0.25; // 非optimal交換のうち成立数が増える割合の上限

// --- seed指定可能なPRNG(mulberry32) -----------------------------------------
function createRng(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates。非破壊(新しい配列を返す)。
function shuffled(arr, rng){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    const tmp = a[i]; a[i]=a[j]; a[j]=tmp;
  }
  return a;
}

// 125セル(L1-5, r0-4, c0-4)の全座標を固定順で列挙する。
function allCoords(){
  const coords = [];
  for(let L=1; L<=N5; L++) for(let r=0; r<N5; r++) for(let c=0; c<N5; c++) coords.push({L,r,c});
  return coords; // 125件
}

// rngで125座標をシャッフルし、先頭n件を選ぶ(重複しない)。
function pickCoords(rng, n){
  return shuffled(allCoords(), rng).slice(0, n);
}

// --- 候補生成: 座標選択 + 正解値の順列で初期値を作る --------------------------
// rngの消費量は座標数nに関わらず「全125要素のシャッフル」+「n要素のシャッフル」で
// 固定であり、サンプル間の再現性を壊さない。
function generateCandidate(CUBE_DATA, rng, cellCount){
  const coords = pickCoords(rng, cellCount);
  const base = coords.map(coord => ({
    L: coord.L, r: coord.r, c: coord.c,
    correctValue: CUBE_DATA[coord.L-1][coord.r][coord.c],
  }));
  const permIndex = shuffled(base.map((_,i)=>i), rng);
  return base.map((cell, i) => Object.assign({}, cell, { initialValue: base[permIndex[i]].correctValue }));
}

// --- Step 1: 安価な構造検証 --------------------------------------------------
function cheapStructuralCheck(CUBE_DATA, cells){
  const coordCheck = A.validateCandidateCells(cells);
  if(!coordCheck.valid) return { pass:false, stage:'coords', coordCheck };

  const permCheck = A.validateInitialIsPermutationOfCorrect(cells);
  if(!permCheck.isPermutation) return { pass:false, stage:'permutation', permCheck };

  const board = A.buildBoard(CUBE_DATA, cells);
  const completeness = A.validateBoardCompleteness(board);
  if(!completeness.valid) return { pass:false, stage:'completeness', completeness };

  const fixedCheck = A.validateFixedCellsUnchanged(CUBE_DATA, board, cells);
  if(!fixedCheck.valid) return { pass:false, stage:'fixed-cells', fixedCheck };

  const placement = A.countPlacementStatus(cells);
  if(placement.correctCount < MIN_CORRECT_UNLOCKED) return { pass:false, stage:'correct-count', placement };
  if(placement.misplacedLevelCount < MIN_MISPLACED_LEVELS) return { pass:false, stage:'level-spread', placement };

  const cycles = A.minSwapsFromCycles(cells);
  if(!cycles.validDecomposition || cycles.minSwaps < MIN_SWAP_DISTANCE) return { pass:false, stage:'min-swaps', cycles };

  return { pass:true, board, placement, cycles };
}

// --- score: 単一値+component breakdown --------------------------------------
// 重みは公開定数として調整可能にしておく(このタスクでは閾値埋め込みではなく相対順位付けのみに使う)。
const SCORE_WEIGHTS = {
  gradualness: 1,          // 最短経路が段階的に改善するほど加点(分散が小さいほど良い)
  finalBurstRatio: 5,      // 最終手への回復集中が小さいほど加点
  directionalRank: 0.2,    // optimal first pairがdirectional evidence上位ほど加点
  nonUniqueIntersection: 2,// 最大交差ペアが一意でない(=単純戦略が自明に解けない)ほど加点
  misleadingPenalty: 1,    // 非optimalな見かけ改善が多いほど減点
  correctCellTopRankPenalty: 3, // 正しい位置のセルを動かす手が最有力に見えるほど減点
};

function computeScore(cells, evalData){
  const bestFinalBurst = evalData.optimalPaths.aggregates.finalBurstRatio.min;
  const bestDirectionalRank = evalData.directional.optimalFirstPairRanks.length
    ? Math.min(...evalData.directional.optimalFirstPairRanks.map(r=>r.rank))
    : 28;
  const gradualVariance = evalData.optimalPaths.mostGradualPath
    ? evalData.optimalPaths.mostGradualPath.gradualnessVariance
    : null;
  const nonUniqueBonus = evalData.intersection.isUniqueMaxPair ? 0 : 1;
  const misleadingPenaltyRaw = evalData.misleading.nonOptimalEqIncreases + evalData.misleading.nonOptimalDevImproves;

  const topRanked = evalData.directional.ranked.find(r=>r.rank===1);
  const topMovesCorrectCell = topRanked
    ? (cells[topRanked.i].initialValue===cells[topRanked.i].correctValue ||
       cells[topRanked.j].initialValue===cells[topRanked.j].correctValue)
    : false;

  const components = {
    gradualness: gradualVariance===null ? 0 : -gradualVariance,
    finalBurstRatio: bestFinalBurst===null ? 0 : -bestFinalBurst,
    directionalRank: -bestDirectionalRank,
    nonUniqueIntersection: nonUniqueBonus,
    misleadingPenalty: -misleadingPenaltyRaw,
    correctCellTopRankPenalty: topMovesCorrectCell ? -1 : 0,
  };

  let total = 0;
  for(const key of Object.keys(components)) total += components[key] * SCORE_WEIGHTS[key];

  return { total, components, weights: Object.assign({}, SCORE_WEIGHTS) };
}

// --- Step 2: 品質評価(検証基盤A/Bを利用) -------------------------------------
function qualityEvaluation(CUBE_DATA, lines, cells, board){
  const summary = A.summarizeLines(board, lines);
  const hasUpDown = summary.over>0 && summary.under>0;
  const hasIntraCrossAbnormal = summary.byClass.intra.abnormal>0 && summary.byClass.cross.abnormal>0;

  const perCell = A.perCellAbnormalLineCounts(board, lines, cells);
  const correctCellsInvolved = cells.every((cell,i) =>
    cell.initialValue !== cell.correctValue || perCell[i].abnormalLineCount > 0
  );

  const hardFilterPass = hasUpDown && hasIntraCrossAbnormal && correctCellsInvolved;

  const optimalPaths = Q.analyzeOptimalPaths(CUBE_DATA, lines, cells);
  const intersection = Q.analyzeIntersectionHeuristic(board, lines, cells, optimalPaths.optimalFirstPairs);
  const directional = Q.analyzeDirectionalEvidence(board, lines, cells, optimalPaths.optimalFirstPairs);
  const misleading = Q.analyzeMisleadingFeedback(board, lines, cells);

  const evalData = { summary, perCell, optimalPaths, intersection, directional, misleading };
  const score = computeScore(cells, evalData);

  return Object.assign({ hardFilterPass, hasUpDown, hasIntraCrossAbnormal, correctCellsInvolved, score }, evalData);
}

// =========================================================================
// Step 3.5: 最終候補選定(provisional gate → compound reasoning gate → 順位付け)
// 一時スクリプトでのみ実行していたロジックをここへ永続化する。
// =========================================================================

// 経路統計(成立数増加割合)の共通ヘルパー。既存Quality結果(mostGradualPath)から算出する。
function increasingStepRatio(bestPath){
  if(!bestPath) return 0;
  const totalSteps = bestPath.eqSeries.length - 1;
  if(totalSteps<=0) return 0;
  let increasingSteps = 0;
  for(let k=1;k<bestPath.eqSeries.length;k++){
    if(bestPath.eqSeries[k] > bestPath.eqSeries[k-1]) increasingSteps++;
  }
  return increasingSteps / totalSteps;
}

// --- 8gate: 一時選定スクリプトで使っていたprovisional gateを正式化 -----------
// 入力candidate(item.cells / item.quality / item.uniqueness)は変更しない。
function evaluateProvisionalGates(item){
  const q = item.quality;
  const cells = item.cells;
  const gates = {};

  gates.structuralHardFilterPass = item.structural.pass === true && q.hardFilterPass === true;
  gates.uniqueSolution = !!(item.uniqueness && item.uniqueness.isUnique === true);

  const bestPath = q.optimalPaths.mostGradualPath;
  const increasingRatio = increasingStepRatio(bestPath);
  gates.majorityIncreasingSteps = !!bestPath && (bestPath.eqSeries.length-1) > 0 && increasingRatio >= 0.5;

  gates.finalBurstRatioWithinLimit = !!(bestPath && bestPath.finalBurstRatio !== null && bestPath.finalBurstRatio <= MAX_FINAL_BURST_RATIO);

  gates.optimalFirstPairTopRanked = q.directional.optimalFirstPairRanks.some(r => r.rank <= MAX_OPTIMAL_DIRECTIONAL_RANK);

  gates.maxUnionPairMultiple = q.intersection.isUniqueMaxPair === false;

  const topRanked = q.directional.ranked.find(r=>r.rank===1);
  const topMovesCorrectCell = topRanked
    ? (cells[topRanked.i].initialValue===cells[topRanked.i].correctValue ||
       cells[topRanked.j].initialValue===cells[topRanked.j].correctValue)
    : true;
  gates.directionalTopDoesNotMoveCorrectCell = !topMovesCorrectCell;

  const mis = q.misleading;
  const nonOptimalEqRatio = mis.nonOptimalPairCount>0 ? mis.nonOptimalEqIncreases/mis.nonOptimalPairCount : 0;
  gates.nonOptimalImprovingRatioWithinLimit = mis.nonOptimalPairCount>0 ? nonOptimalEqRatio <= MAX_NONOPTIMAL_IMPROVING_RATIO : true;

  const passed = Object.keys(gates).every(k => gates[k]===true);
  return { passed, gates };
}

// --- 4gate: 一時選定スクリプトで使っていたcompound reasoning gateを正式化 ---
// 既存Quality結果(intersection.maxUnionPairs / optimalPaths.optimalFirstPairs / directional.ranked)を
// 再利用し、独自の座標・値ベースの再解析は行わない。ただし「正しい位置セルを動かさない」の判定だけは、
// provisional gateの#directionalTopDoesNotMoveCorrectCellと同一の最小限の等値チェックを再利用する
// (Quality側にこの真偽値を直接返すフィールドが存在しないため)。
function evaluateCompoundReasoningGates(item){
  const q = item.quality;
  const cells = item.cells;
  const gates = {};

  const optimalFirstPairSet = new Set(q.optimalPaths.optimalFirstPairs.map(([i,j])=>`${i}-${j}`));
  const maxUnionPairs = q.intersection.maxUnionPairs;

  gates.maxUnionPairsAtLeastTwo = maxUnionPairs.length >= 2;

  const maxUnionOptimalFlags = maxUnionPairs.map(([i,j]) => optimalFirstPairSet.has(`${i}-${j}`));
  gates.maxUnionHasBothOptimalAndNonOptimal = maxUnionOptimalFlags.some(f=>f===true) && maxUnionOptimalFlags.some(f=>f===false);

  const rankOf = new Map(q.directional.ranked.map(r=>[`${r.i}-${r.j}`, r]));
  let bestWithinMaxUnion = null;
  for(const [i,j] of maxUnionPairs){
    const r = rankOf.get(`${i}-${j}`);
    if(!r) continue;
    if(bestWithinMaxUnion === null || r.rank < bestWithinMaxUnion.rank) bestWithinMaxUnion = r;
  }
  gates.maxUnionTopIsOptimal = bestWithinMaxUnion ? optimalFirstPairSet.has(`${bestWithinMaxUnion.i}-${bestWithinMaxUnion.j}`) : false;

  const bestMovesCorrectCell = bestWithinMaxUnion
    ? (cells[bestWithinMaxUnion.i].initialValue===cells[bestWithinMaxUnion.i].correctValue ||
       cells[bestWithinMaxUnion.j].initialValue===cells[bestWithinMaxUnion.j].correctValue)
    : true;
  gates.maxUnionTopDoesNotMoveCorrectCell = !bestMovesCorrectCell;

  const passed = Object.keys(gates).every(k => gates[k]===true);
  return { passed, gates };
}

// --- 比較指標の抽出(既存Quality結果からのみ算出、非破壊) ----------------------
function comparisonMetrics(item){
  const bestPath = item.quality.optimalPaths.mostGradualPath;
  const increasingRatio = increasingStepRatio(bestPath);
  const ranks = item.quality.directional.optimalFirstPairRanks.map(r=>r.rank);
  const bestDirectionalRank = ranks.length ? Math.min(...ranks) : Infinity;
  return {
    finalBurstRatio: (bestPath && bestPath.finalBurstRatio !== null) ? bestPath.finalBurstRatio : Infinity,
    increasingRatio,
    nonOptimalEqIncreases: item.quality.misleading.nonOptimalEqIncreases,
    bestDirectionalRank,
    scoreTotal: item.quality.score.total,
    sampleIndex: item.sampleIndex,
  };
}

// --- 最終候補の順序付け(常に決定論的。candidateは変更しない) -----------------
function compareFinalCandidates(a, b){
  const ma = comparisonMetrics(a), mb = comparisonMetrics(b);
  if(ma.finalBurstRatio !== mb.finalBurstRatio) return ma.finalBurstRatio - mb.finalBurstRatio; // 昇順(低いほど良い)
  if(ma.increasingRatio !== mb.increasingRatio) return mb.increasingRatio - ma.increasingRatio; // 降順(高いほど良い)
  if(ma.nonOptimalEqIncreases !== mb.nonOptimalEqIncreases) return ma.nonOptimalEqIncreases - mb.nonOptimalEqIncreases; // 昇順(少ないほど良い)
  if(ma.bestDirectionalRank !== mb.bestDirectionalRank) return ma.bestDirectionalRank - mb.bestDirectionalRank; // 昇順(上位ほど良い)
  if(ma.scoreTotal !== mb.scoreTotal) return mb.scoreTotal - ma.scoreTotal; // 降順(高いほど良い)
  return ma.sampleIndex - mb.sampleIndex; // 最後はsampleIndex昇順(生成順、決定論性の保証)
}

// --- shortlistから最終候補を1件選ぶ(非破壊。候補一覧・candidateとも変更しない) --
function selectFinalCandidate(shortlist){
  const evaluated = shortlist.map(item => ({
    item,
    provisional: evaluateProvisionalGates(item),
    compound: evaluateCompoundReasoningGates(item),
  }));
  const passing = evaluated.filter(e => e.provisional.passed && e.compound.passed);
  const sorted = passing.slice().sort((a,b) => compareFinalCandidates(a.item, b.item));
  const selectedCandidate = sorted.length > 0 ? sorted[0].item : null;
  return { passedCount: passing.length, selectedCandidate };
}

// --- 探索本体 -----------------------------------------------------------------
function runSearch({ seed = 1, samples = 200, shortlistSize = DEFAULT_SHORTLIST_SIZE, cellCount = 8 } = {}){
  const { CUBE_DATA, lines } = A.loadCubeContext();
  const rng = createRng(seed);

  const stats = { samplesRequested: samples, evaluated: 0, cheapPass: 0, qualityPass: 0 };
  const passed = [];

  for(let i=0; i<samples; i++){
    const cells = generateCandidate(CUBE_DATA, rng, cellCount);
    stats.evaluated++;

    const structural = cheapStructuralCheck(CUBE_DATA, cells);
    if(!structural.pass) continue;
    stats.cheapPass++;

    const quality = qualityEvaluation(CUBE_DATA, lines, cells, structural.board);
    if(!quality.hardFilterPass) continue;
    stats.qualityPass++;

    passed.push({ sampleIndex: i, cells, structural, quality });
  }

  // スコア降順。同点はsampleIndex昇順(生成順)で安定させ、seed固定時に再現できるようにする。
  passed.sort((x, y) => (y.quality.score.total - x.quality.score.total) || (x.sampleIndex - y.sampleIndex));

  const shortlist = passed.slice(0, shortlistSize);
  // Step 3: shortlistだけ8!全探索の一意解検証を行う(全candidateへは実行しない)。
  // isUniqueはAnalyzer側の正式な戻り値契約であり、Search側での補完・上書きは行わない。
  for(const item of shortlist){
    item.uniqueness = A.exhaustiveUniqueSolutionCount(CUBE_DATA, lines, item.cells);
  }

  // Step 3.5: provisional gate + compound reasoning gateを通過した候補から1件選ぶ。
  const { passedCount, selectedCandidate } = selectFinalCandidate(shortlist);

  return {
    seed, samples, shortlistSize, cellCount, stats,
    qualityPassCount: passed.length, shortlist,
    finalGatePassCount: passedCount, selectedCandidate,
  };
}

// --- CLI ------------------------------------------------------------------
function parseArgs(argv){
  const args = { seed: 1, samples: 200, shortlist: DEFAULT_SHORTLIST_SIZE, dryRun: false, out: null };
  for(const arg of argv){
    if(arg === '--dry-run') args.dryRun = true;
    else if(arg.startsWith('--seed=')) args.seed = parseInt(arg.slice('--seed='.length), 10);
    else if(arg.startsWith('--samples=')) args.samples = parseInt(arg.slice('--samples='.length), 10);
    else if(arg.startsWith('--shortlist=')) args.shortlist = parseInt(arg.slice('--shortlist='.length), 10);
    else if(arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  return args;
}

// デフォルト出力には座標・値・交換内容を含めない(件数・スコアのみ)。
function formatSummary(result){
  const lines = [];
  lines.push(`seed=${result.seed} samples=${result.samples} shortlist=${result.shortlistSize}`);
  lines.push(`evaluated=${result.stats.evaluated} cheapPass=${result.stats.cheapPass} qualityPass=${result.stats.qualityPass}`);
  lines.push(`shortlist candidates: ${result.shortlist.length}`);
  result.shortlist.forEach((item, idx) => {
    lines.push(`  #${idx+1} scoreTotal=${item.quality.score.total.toFixed(3)} isUnique=${item.uniqueness.isUnique} solutionCount=${item.uniqueness.solutionCount}`);
  });
  lines.push(`finalGatePassCount=${result.finalGatePassCount} selected=${result.selectedCandidate ? 'yes' : 'no'}`);
  return lines.join('\n');
}

// 最終候補を候補データファイル(candidate.json)と同一スキーマで保存するための正規化。
function buildCanonicalCandidateObject(result){
  const item = result.selectedCandidate;
  const cells = item.cells.map(c => ({ z: c.L-1, y: c.r, x: c.c, initialValue: c.initialValue }))
    .sort((a,b) => (a.z-b.z) || (a.y-b.y) || (a.x-b.x));
  return {
    schemaVersion: 1,
    prototype: 'repair-prototype-02',
    source: {
      seed: result.seed,
      samples: result.samples,
      shortlist: result.shortlistSize,
      selectionGateVersion: SELECTION_GATE_VERSION,
    },
    cells,
  };
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  const result = runSearch({ seed: args.seed, samples: args.samples, shortlistSize: args.shortlist });
  console.log(formatSummary(result));
  if(args.dryRun){
    console.log('(dry-run: ファイルは書き込みません)');
    return;
  }
  if(args.out){
    if(!result.selectedCandidate){
      console.log('selectedCandidate=null のため、ファイルは書き込みません(非成功)');
      return;
    }
    const canonicalObject = buildCanonicalCandidateObject(result);
    const canonicalSha256 = crypto.createHash('sha256').update(JSON.stringify(canonicalObject)).digest('hex');
    const fileObject = Object.assign({}, canonicalObject, { integrity: { canonicalSha256 } });
    fs.writeFileSync(args.out, JSON.stringify(fileObject, null, 2) + '\n');
    console.log(`written to ${args.out}`);
  }
}

if(require.main === module){ main(); }

module.exports = {
  createRng,
  shuffled,
  allCoords,
  pickCoords,
  generateCandidate,
  cheapStructuralCheck,
  qualityEvaluation,
  computeScore,
  SCORE_WEIGHTS,
  evaluateProvisionalGates,
  evaluateCompoundReasoningGates,
  compareFinalCandidates,
  selectFinalCandidate,
  buildCanonicalCandidateObject,
  runSearch,
  parseArgs,
  formatSummary,
  SELECTION_GATE_VERSION,
  DEFAULT_SHORTLIST_SIZE,
  MIN_CORRECT_UNLOCKED,
  MIN_MISPLACED_LEVELS,
  MIN_SWAP_DISTANCE,
  MAX_FINAL_BURST_RATIO,
  MAX_OPTIMAL_DIRECTIONAL_RANK,
  MAX_NONOPTIMAL_IMPROVING_RATIO,
};
