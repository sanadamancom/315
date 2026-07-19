// tests/prototype02-search-tests.js
// tools/repair/search-prototype02.js の検証。
// 実行: node tests/prototype02-search-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const A = require('../tools/repair/prototype02-analyzer.js');
const S = require('../tools/repair/search-prototype02.js');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

// テスト用の軽量パラメータ(qualityPass数 > shortlist数になる組合せを事前に実測して選定)。
const SEED = 1;
const SAMPLES = 80;
const SHORTLIST = 2;

console.log('== 同一seedで同一結果 ==');
{
  const r1 = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  const r2 = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  check('同一seed・同一パラメータで結果が完全一致する', JSON.stringify(r1) === JSON.stringify(r2));
}

console.log('== 異なるseedで探索列が変わる ==');
{
  const r1 = S.runSearch({ seed: 1, samples: 20, shortlistSize: 2 });
  const r2 = S.runSearch({ seed: 2, samples: 20, shortlistSize: 2 });
  check('seedが違えば生成される候補の座標列が変わる', JSON.stringify(r1.shortlist.map(x=>x.cells)) !== JSON.stringify(r2.shortlist.map(x=>x.cells)));
}

console.log('== 8座標の範囲と一意性 ==');
{
  const rng = S.createRng(999);
  const { CUBE_DATA } = A.loadCubeContext();
  for(let i=0;i<5;i++){
    const cells = S.generateCandidate(CUBE_DATA, rng, 8);
    const result = A.validateCandidateCells(cells);
    check(`生成#${i}: 座標が範囲内かつ重複なし`, result.valid===true);
  }
}

console.log('== hard filter: 正しい位置2以上・LEVEL分散3以上・最短交換数4以上 ==');
{
  const result = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  check('quality pass候補が1件以上得られる(パラメータ選定の前提)', result.qualityPassCount > 0);
  check('shortlist候補は正しい位置2以上', result.shortlist.every(item => item.structural.placement.correctCount >= 2));
  check('shortlist候補は誤配置が3LEVEL以上に分散', result.shortlist.every(item => item.structural.placement.misplacedLevelCount >= 3));
  check('shortlist候補は最短交換数4以上', result.shortlist.every(item => item.structural.cycles.minSwaps >= 4));
  check('shortlist候補は↑と↓が両方存在', result.shortlist.every(item => item.quality.hasUpDown));
  check('shortlist候補は階層内・階層横断の異常が両方存在', result.shortlist.every(item => item.quality.hasIntraCrossAbnormal));
  check('shortlist候補は正しい位置のセルも不成立ラインに関与', result.shortlist.every(item => item.quality.correctCellsInvolved));
}

console.log('== 安価な検証が一意解全探索より先に実行される/shortlist以外へ8!検証を実行しない ==');
{
  const original = A.exhaustiveUniqueSolutionCount;
  let callCount = 0;
  A.exhaustiveUniqueSolutionCount = function(...args){ callCount++; return original.apply(A, args); };
  let result;
  try {
    result = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  } finally {
    A.exhaustiveUniqueSolutionCount = original;
  }
  check('qualityPassがshortlistより多い(絞り込みの検証が意味を持つ条件)', result.qualityPassCount > result.shortlist.length);
  check('8!検証の呼び出し回数はshortlist件数と一致する', callCount === result.shortlist.length);
  check('shortlist以外にはuniquenessが付与されない', result.shortlist.every(item => 'uniqueness' in item));
  check('uniqueness.isUniqueがboolean型で得られる', result.shortlist.every(item => typeof item.uniqueness.isUnique === 'boolean'));
}

console.log('== SearchがAnalyzerのisUnique契約をそのまま利用する(独自補完なし) ==');
{
  const result = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  check('shortlist候補が1件以上ある(検証の前提)', result.shortlist.length > 0);

  const allConsistent = result.shortlist.every(item => {
    const direct = A.exhaustiveUniqueSolutionCount(A.loadCubeContext().CUBE_DATA, A.loadCubeContext().lines, item.cells);
    const searchKeys = Object.keys(item.uniqueness).sort();
    const directKeys = Object.keys(direct).sort();
    const sameShape = JSON.stringify(searchKeys) === JSON.stringify(directKeys);
    const sameValues = searchKeys.every(k => item.uniqueness[k] === direct[k]);
    return sameShape && sameValues;
  });
  check('Searchのuniquenessは、Analyzerを直接呼んだ結果と完全に一致する(構造・値とも)', allConsistent);
  check('Search独自の補完フィールドが増えていない(キー集合がAnalyzer出力と同一)', result.shortlist.every(item => {
    const direct = A.exhaustiveUniqueSolutionCount(A.loadCubeContext().CUBE_DATA, A.loadCubeContext().lines, item.cells);
    return Object.keys(item.uniqueness).length === Object.keys(direct).length;
  }));
}

console.log('== score breakdownと安定した順位 ==');
{
  const result = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  check('各shortlist候補にscore.componentsが揃っている', result.shortlist.every(item => {
    const c = item.quality.score.components;
    return ['gradualness','finalBurstRatio','directionalRank','nonUniqueIntersection','misleadingPenalty','correctCellTopRankPenalty']
      .every(key => typeof c[key] === 'number');
  }));
  check('scoreTotalはcomponents×weightsの合計と一致する', result.shortlist.every(item => {
    const { total, components, weights } = item.quality.score;
    const recomputed = Object.keys(components).reduce((s,k)=> s + components[k]*weights[k], 0);
    return Math.abs(recomputed - total) < 1e-9;
  }));
  check('shortlistはscoreTotal降順に並んでいる', result.shortlist.every((item, idx) =>
    idx===0 || result.shortlist[idx-1].quality.score.total >= item.quality.score.total
  ));

  // 同点対策(生成順)の安定性: 同一seedで2回実行しても同じ順序になることを確認
  const result2 = S.runSearch({ seed: SEED, samples: SAMPLES, shortlistSize: SHORTLIST });
  check('同一seedでの順位が安定して再現される', JSON.stringify(result.shortlist.map(i=>i.sampleIndex)) === JSON.stringify(result2.shortlist.map(i=>i.sampleIndex)));
}

console.log('== dry-runでファイルを書かない ==');
{
  const outPath = path.join(os.tmpdir(), `p02-search-test-${Date.now()}.json`);
  if(fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const scriptPath = path.join(__dirname, '..', 'tools', 'repair', 'search-prototype02.js');
  const stdout = execFileSync('node', [scriptPath, '--dry-run', '--seed=1', '--samples=10', '--shortlist=1', `--out=${outPath}`], { encoding: 'utf8' });

  check('dry-run実行がエラーなく完了する', typeof stdout === 'string' && stdout.length > 0);
  check('dry-runでは--outを指定してもファイルを書かない', fs.existsSync(outPath)===false);
  check('デフォルト出力に座標を示すL/r/cのようなキー文字列が含まれない', !/"L":\d/.test(stdout) && !/correctValue/.test(stdout));

  if(fs.existsSync(outPath)) fs.unlinkSync(outPath); // 念のため後始末
}

console.log('== 入力データを破壊しない ==');
{
  const before = JSON.stringify(A.loadCubeContext().CUBE_DATA);
  S.runSearch({ seed: SEED, samples: 30, shortlistSize: 2 });
  const after = JSON.stringify(A.loadCubeContext().CUBE_DATA);
  check('探索後もCUBE_DATAが変化しない', before === after);
}

// =========================================================================
// Major 2A: 最終候補選定ロジック(provisional gate / compound gate / comparator)
// =========================================================================

// gate単体の挙動を、実際のQuality計算結果と同じ「形」を持つ最小限のmock itemで検証する。
// 全gateを通過する基準状態(baseItem)を1つ定義し、各テストでは「1箇所だけ」値を変えて
// 対象gateだけがfalseになることを確認する。
function cloneDeep(x){ return JSON.parse(JSON.stringify(x)); }

function makeBaseItem(){
  return {
    sampleIndex: 42,
    cells: [
      { L:1, r:0, c:0, correctValue: 10, initialValue: 20 }, // idx0: 誤配置
      { L:1, r:0, c:1, correctValue: 20, initialValue: 10 }, // idx1: 誤配置
      { L:1, r:0, c:2, correctValue: 30, initialValue: 30 }, // idx2: 正しい位置
      { L:1, r:0, c:3, correctValue: 40, initialValue: 40 }, // idx3: 正しい位置
    ],
    structural: { pass: true },
    uniqueness: { isUnique: true },
    quality: {
      hardFilterPass: true,
      optimalPaths: {
        mostGradualPath: { eqSeries: [0,1,2,3], finalBurstRatio: 0.3 },
        optimalFirstPairs: [[0,1]],
      },
      intersection: { isUniqueMaxPair: false, maxUnionPairs: [[0,1],[2,3]] },
      directional: {
        ranked: [ {i:0,j:1,rank:1}, {i:2,j:3,rank:2} ],
        optimalFirstPairRanks: [ {i:0,j:1,rank:1} ],
      },
      misleading: { nonOptimalPairCount: 10, nonOptimalEqIncreases: 1 },
      score: { total: 5 },
    },
  };
}

console.log('== provisional gate: baseItemは全gateを通過する(前提確認) ==');
{
  const base = makeBaseItem();
  const result = S.evaluateProvisionalGates(base);
  check('baseItemはprovisional gateを全通過する', result.passed === true && Object.values(result.gates).every(v=>v===true));
}

console.log('== provisional gate: 各項目を1つずつ落とす ==');
{
  const cases = [
    ['structuralHardFilterPass', item => { item.structural.pass = false; }],
    ['uniqueSolution', item => { item.uniqueness.isUnique = false; }],
    ['majorityIncreasingSteps', item => { item.quality.optimalPaths.mostGradualPath.eqSeries = [0,0,0,0]; }],
    ['finalBurstRatioWithinLimit', item => { item.quality.optimalPaths.mostGradualPath.finalBurstRatio = 0.9; }],
    ['optimalFirstPairTopRanked', item => { item.quality.directional.optimalFirstPairRanks = [{ i:0, j:1, rank:5 }]; }],
    ['maxUnionPairMultiple', item => { item.quality.intersection.isUniqueMaxPair = true; }],
    ['directionalTopDoesNotMoveCorrectCell', item => { item.cells[0].initialValue = item.cells[0].correctValue; }],
    ['nonOptimalImprovingRatioWithinLimit', item => { item.quality.misleading.nonOptimalEqIncreases = 9; }],
  ];
  for(const [gateName, breakFn] of cases){
    const item = makeBaseItem();
    breakFn(item);
    const result = S.evaluateProvisionalGates(item);
    check(`[${gateName}] 単独で落ちる`, result.gates[gateName] === false && result.passed === false);
    const others = Object.keys(result.gates).filter(k=>k!==gateName);
    check(`[${gateName}] 他のgateは影響を受けない`, others.every(k=>result.gates[k]===true));
  }
}

console.log('== compound reasoning gate: baseItemは全gateを通過する(前提確認) ==');
{
  const base = makeBaseItem();
  const result = S.evaluateCompoundReasoningGates(base);
  check('baseItemはcompound gateを全通過する', result.passed === true && Object.values(result.gates).every(v=>v===true));
}

console.log('== compound reasoning gate: 各項目を1つずつ落とす ==');
{
  const cases = [
    ['maxUnionPairsAtLeastTwo', item => { item.quality.intersection.maxUnionPairs = [[0,1]]; }],
    ['maxUnionHasBothOptimalAndNonOptimal', item => { item.quality.optimalPaths.optimalFirstPairs = [[0,1],[2,3]]; }],
    ['maxUnionTopIsOptimal', item => { item.quality.directional.ranked = [ {i:2,j:3,rank:1}, {i:0,j:1,rank:2} ]; }],
    ['maxUnionTopDoesNotMoveCorrectCell', item => { item.cells[0].initialValue = item.cells[0].correctValue; }],
  ];
  for(const [gateName, breakFn] of cases){
    const item = makeBaseItem();
    breakFn(item);
    const result = S.evaluateCompoundReasoningGates(item);
    check(`[${gateName}] 単独で落ちる`, result.gates[gateName] === false && result.passed === false);
  }
}

console.log('== comparator: 優先順位を1段ずつ検証 ==');
{
  function makeMetricItem(overrides){
    const item = makeBaseItem();
    if('finalBurstRatio' in overrides) item.quality.optimalPaths.mostGradualPath.finalBurstRatio = overrides.finalBurstRatio;
    if('eqSeries' in overrides) item.quality.optimalPaths.mostGradualPath.eqSeries = overrides.eqSeries;
    if('nonOptimalEqIncreases' in overrides) item.quality.misleading.nonOptimalEqIncreases = overrides.nonOptimalEqIncreases;
    if('optimalFirstPairRanks' in overrides) item.quality.directional.optimalFirstPairRanks = overrides.optimalFirstPairRanks;
    if('scoreTotal' in overrides) item.quality.score.total = overrides.scoreTotal;
    if('sampleIndex' in overrides) item.sampleIndex = overrides.sampleIndex;
    return item;
  }

  // 1) final_burst_ratio昇順(低い方が勝つ)
  {
    const better = makeMetricItem({ finalBurstRatio: 0.1 });
    const worse = makeMetricItem({ finalBurstRatio: 0.4 });
    check('finalBurstRatio: 低い方が優先される', S.compareFinalCandidates(better, worse) < 0);
    check('finalBurstRatio: 逆順でも対称的に判定される', S.compareFinalCandidates(worse, better) > 0);
  }
  // 2) 成立数増加手の割合降順(finalBurstRatioを同値にして次の段を検証)
  {
    const better = makeMetricItem({ eqSeries: [0,1,2,3] }); // 全手で増加(ratio=1)
    const worse = makeMetricItem({ eqSeries: [0,1,1,2] });  // 一部維持(ratio<1)
    check('increasingRatio: 割合が高い方が優先される(finalBurstRatio同値時)', S.compareFinalCandidates(better, worse) < 0);
  }
  // 3) 非optimal成立数増加件数昇順(前2段を同値にして検証)
  {
    const better = makeMetricItem({ nonOptimalEqIncreases: 0 });
    const worse = makeMetricItem({ nonOptimalEqIncreases: 5 });
    check('nonOptimalEqIncreases: 少ない方が優先される(前段同値時)', S.compareFinalCandidates(better, worse) < 0);
  }
  // 4) optimal pairのdirectional evidence順位昇順
  {
    const better = makeMetricItem({ optimalFirstPairRanks: [{ i:0, j:1, rank:1 }] });
    const worse = makeMetricItem({ optimalFirstPairRanks: [{ i:0, j:1, rank:4 }] });
    check('bestDirectionalRank: 上位(小さい順位)が優先される(前段同値時)', S.compareFinalCandidates(better, worse) < 0);
  }
  // 5) 既存total score降順
  {
    const better = makeMetricItem({ scoreTotal: 10 });
    const worse = makeMetricItem({ scoreTotal: 1 });
    check('scoreTotal: 高い方が優先される(前段同値時)', S.compareFinalCandidates(better, worse) < 0);
  }
  // 6) 完全同値時はsampleIndex昇順
  {
    const a = makeMetricItem({ sampleIndex: 3 });
    const b = makeMetricItem({ sampleIndex: 9 });
    check('完全同値時はsampleIndexの小さい方が優先される', S.compareFinalCandidates(a, b) < 0);
    check('完全同値かつsampleIndexも同じなら0を返す(決定論性)', S.compareFinalCandidates(a, a) === 0);
  }
}

console.log('== selectFinalCandidate: 通過0件・非破壊性 ==');
{
  const allFail = [0,1,2].map(idx=>{
    const item = makeBaseItem();
    item.sampleIndex = idx;
    item.uniqueness.isUnique = false; // 全件をprovisional gateで落とす
    return item;
  });
  const snapshot = JSON.stringify(allFail);
  const result = S.selectFinalCandidate(allFail);
  check('全件gate落ちならpassedCount=0', result.passedCount === 0);
  check('全件gate落ちならselectedCandidate=null', result.selectedCandidate === null);
  check('selectFinalCandidateは候補一覧・candidateを変更しない', JSON.stringify(allFail) === snapshot);
}

console.log('== selectFinalCandidate: 複数候補からの選定・非破壊性 ==');
{
  const good1 = makeBaseItem(); good1.sampleIndex = 1; good1.quality.score.total = 1; // scoreは低いが他が有利
  const good2 = makeBaseItem(); good2.sampleIndex = 2; good2.quality.optimalPaths.mostGradualPath.finalBurstRatio = 0.05; // より低いfinalBurstRatio
  const bad = makeBaseItem(); bad.sampleIndex = 3; bad.uniqueness.isUnique = false; // gate落ち

  const shortlist = [good1, good2, bad];
  const snapshot = JSON.stringify(shortlist);
  const result = S.selectFinalCandidate(shortlist);

  check('gateを通過した2件だけがpassedCountに含まれる', result.passedCount === 2);
  check('finalBurstRatioがより低いgood2が選ばれる', result.selectedCandidate !== null && result.selectedCandidate.sampleIndex === 2);
  check('selectFinalCandidateは候補一覧・candidateを変更しない(複数候補時)', JSON.stringify(shortlist) === snapshot);
}

// --- runSearch統合・CLI・再現性(実データによる小規模実行) -------------------
const FINAL_SEED = 1, FINAL_SAMPLES = 80, FINAL_SHORTLIST = 10;

console.log('== runSearch統合: finalGatePassCount/selectedCandidateが追加される ==');
{
  const result = S.runSearch({ seed: FINAL_SEED, samples: FINAL_SAMPLES, shortlistSize: FINAL_SHORTLIST });
  check('finalGatePassCountが数値で返る', typeof result.finalGatePassCount === 'number');
  check('selectedCandidateが返る(このパラメータでは1件以上ヒットする前提)', result.selectedCandidate !== null);
  check('既存フィールド(shortlist/qualityPassCount等)は維持される', Array.isArray(result.shortlist) && typeof result.qualityPassCount==='number');
}

console.log('== 同一seedで同一selectedCandidate ==');
{
  const r1 = S.runSearch({ seed: FINAL_SEED, samples: FINAL_SAMPLES, shortlistSize: FINAL_SHORTLIST });
  const r2 = S.runSearch({ seed: FINAL_SEED, samples: FINAL_SAMPLES, shortlistSize: FINAL_SHORTLIST });
  check('同一seedなら同一sampleIndexのselectedCandidateが選ばれる',
    r1.selectedCandidate.sampleIndex === r2.selectedCandidate.sampleIndex);
}

console.log('== --outがselectedCandidateを保存する・sourceに再現パラメータが揃う ==');
{
  const outPath = path.join(os.tmpdir(), `p02-final-candidate-test-${Date.now()}.json`);
  if(fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const scriptPath = path.join(__dirname, '..', 'tools', 'repair', 'search-prototype02.js');

  execFileSync('node', [scriptPath, `--seed=${FINAL_SEED}`, `--samples=${FINAL_SAMPLES}`, `--shortlist=${FINAL_SHORTLIST}`, `--out=${outPath}`], { encoding: 'utf8' });

  check('--outでファイルが作成される', fs.existsSync(outPath));
  if(fs.existsSync(outPath)){
    const saved = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    check('保存structureにschemaVersion/prototype/source/cells/integrityが揃う',
      typeof saved.schemaVersion==='number' && typeof saved.prototype==='string' &&
      saved.source && Array.isArray(saved.cells) && saved.integrity && typeof saved.integrity.canonicalSha256==='string');
    check('sourceにseed/samples/shortlist/selectionGateVersionが揃う',
      saved.source.seed===FINAL_SEED && saved.source.samples===FINAL_SAMPLES &&
      saved.source.shortlist===FINAL_SHORTLIST && saved.source.selectionGateVersion===S.SELECTION_GATE_VERSION);
    check('cellsが8件でinitialValue/z/y/xを持つ', saved.cells.length===8 &&
      saved.cells.every(c=>typeof c.z==='number' && typeof c.y==='number' && typeof c.x==='number' && typeof c.initialValue==='number'));
    fs.unlinkSync(outPath);
  }
}

console.log('== --dry-runでは最終候補も書き込まない ==');
{
  const outPath = path.join(os.tmpdir(), `p02-final-candidate-dryrun-${Date.now()}.json`);
  if(fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const scriptPath = path.join(__dirname, '..', 'tools', 'repair', 'search-prototype02.js');
  execFileSync('node', [scriptPath, '--dry-run', `--seed=${FINAL_SEED}`, `--samples=${FINAL_SAMPLES}`, `--shortlist=${FINAL_SHORTLIST}`, `--out=${outPath}`], { encoding: 'utf8' });
  check('--dry-run指定時は最終候補が存在してもファイルを書かない', fs.existsSync(outPath)===false);
}

// =========================================================================
// Major 3: candidate.jsonの由来・整合性検証(tests/repair-tests.jsから移管)
// 300件探索の再実行は行わず、既存のcandidate.json・puzzle.jsを動的に読むだけ。
// 座標・値はテストコードへ再転記しない。
// =========================================================================
console.log('== candidate.json: schema検証 ==');
{
  const candidatePath = path.join(__dirname, '..', 'tools', 'repair', 'prototype02-candidate.json');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

  check('schemaVersionが数値', typeof candidate.schemaVersion === 'number');
  check('prototypeが文字列', typeof candidate.prototype === 'string');
  check('sourceオブジェクトが存在', typeof candidate.source === 'object' && candidate.source !== null);
  check('sourceにseed/samples/shortlist/selectionGateVersionが存在',
    typeof candidate.source.seed === 'number' &&
    typeof candidate.source.samples === 'number' &&
    typeof candidate.source.shortlist === 'number' &&
    typeof candidate.source.selectionGateVersion === 'number');
  check('cellsが8件の配列', Array.isArray(candidate.cells) && candidate.cells.length === 8);
  check('各cellがz/y/x/initialValueを持つ', candidate.cells.every(c =>
    typeof c.z==='number' && typeof c.y==='number' && typeof c.x==='number' && typeof c.initialValue==='number'
  ));
  check('integrity.canonicalSha256が64文字の文字列', typeof candidate.integrity==='object' &&
    typeof candidate.integrity.canonicalSha256==='string' && candidate.integrity.canonicalSha256.length===64);
}

console.log('== candidate.json: canonicalSha256の一致 ==');
{
  const candidatePath = path.join(__dirname, '..', 'tools', 'repair', 'prototype02-candidate.json');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const canonicalObject = { schemaVersion: candidate.schemaVersion, prototype: candidate.prototype, source: candidate.source, cells: candidate.cells };
  const recomputed = crypto.createHash('sha256').update(JSON.stringify(canonicalObject)).digest('hex');
  check('canonicalSha256が再計算値と一致する', recomputed === candidate.integrity.canonicalSha256);
}

console.log('== candidate.json ⇔ puzzle.js: 座標変換とinitialValueの完全一致 ==');
{
  const candidatePath = path.join(__dirname, '..', 'tools', 'repair', 'prototype02-candidate.json');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

  // puzzle.jsのREPAIR_CELLSは既存テストと同じvm方式で動的に読み込む(座標・値は再転記しない)。
  const ctx = {};
  vm.createContext(ctx);
  const puzzleCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'repair', 'puzzle.js'), 'utf8');
  vm.runInContext(puzzleCode, ctx, { filename: 'puzzle.js' });
  vm.runInContext('globalThis.REPAIR_CELLS = REPAIR_CELLS;', ctx);
  const REPAIR_CELLS = ctx.REPAIR_CELLS;

  check('REPAIR_CELLSが8件(puzzle.js側)', REPAIR_CELLS.length === 8);

  // 座標変換: candidate.json(z,y,x) <-> puzzle.js(L,r,c) は L=z+1, r=y, c=x
  const candidateKeySet = new Set(candidate.cells.map(c => `${c.z+1}-${c.y}-${c.x}-${c.initialValue}`));
  const puzzleKeySet = new Set(REPAIR_CELLS.map(c => `${c.L}-${c.r}-${c.c}-${c.initialValue}`));
  check('candidate.jsonとpuzzle.jsの座標・initialValueが完全一致(件数含む)',
    candidateKeySet.size === 8 && puzzleKeySet.size === 8 &&
    [...candidateKeySet].every(k => puzzleKeySet.has(k)));

  const candidateCoordSet = new Set(candidate.cells.map(c => `${c.z+1}-${c.y}-${c.x}`));
  const puzzleCoordSet = new Set(REPAIR_CELLS.map(c => `${c.L}-${c.r}-${c.c}`));
  check('座標変換(z=L-1,y=r,x=c)だけでも一致する', candidateCoordSet.size === puzzleCoordSet.size &&
    [...candidateCoordSet].every(k => puzzleCoordSet.has(k)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
