// tests/prototype02-quality-tests.js
// tools/repair/prototype02-quality.js の検証。
// 実行: node tests/prototype02-quality-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('../tools/repair/prototype02-analyzer.js');
const Q = require('../tools/repair/prototype02-quality.js');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

// production fixture: 現在のpuzzle.js(本番REPAIR_CELLS)をそのまま読み込む。
// ここでは「例外なく完走する」「型・不変条件を満たす」ことだけを検証し、
// 本番候補固有の正誤内訳・最短交換数・path数などの具体値はassertしない。
// exactな置換構造(3-cycle/4-cycle等)の検証は本ファイル後半のsynthetic fixtureで行う。
function loadProductionCells(){
  const ctx = {};
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js/repair/puzzle.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'puzzle.js' });
  vm.runInContext(`globalThis.REPAIR_CELLS = REPAIR_CELLS;`, ctx);
  return ctx.REPAIR_CELLS.map(c => Object.assign({}, c));
}

// synthetic fixture共通ヘルパー: 本番REPAIR_CELLSの座標・順序・initialValueに一切依存しない、
// 機械的に列挙した座標(グリッド先頭からn件)を使う。correctValueは実際のCUBE_DATAから取得する
// (盤面・ライン計算が成立するために必要な実データであり、本番候補固有の値ではない)。
function arbitraryCoords(n){
  const coords = [];
  findCoords: for(let L=1; L<=5; L++) for(let r=0; r<5; r++) for(let c=0; c<5; c++){
    coords.push({L,r,c});
    if(coords.length===n) break findCoords;
  }
  return coords;
}
function buildSyntheticCells(CUBE_DATA, n){
  return arbitraryCoords(n).map(coord => ({
    L: coord.L, r: coord.r, c: coord.c,
    correctValue: CUBE_DATA[coord.L-1][coord.r][coord.c],
  }));
}

const { CUBE_DATA, lines } = A.loadCubeContext();
const productionCells = loadProductionCells();

console.log('== optimal path探索: production fixture(不変条件のみ、具体値はassertしない) ==');
{
  const cellsSnapshot = JSON.stringify(productionCells);
  const t0 = Date.now();
  const result = Q.analyzeOptimalPaths(CUBE_DATA, lines, productionCells);
  const elapsedMs = Date.now()-t0;

  check('入力cellsを変更しない', JSON.stringify(productionCells)===cellsSnapshot);
  check('rootDistanceが数値で候補基準(4以上)を満たす', typeof result.rootDistance==='number' && result.rootDistance>=4);
  check('探索がキャップに達していない', result.capped===false);

  check('optimal first pairが1件以上存在する(未クリア状態には必ず改善手がある)', result.optimalFirstPairCount>=1);
  check('optimal pathが1件以上存在する', result.optimalPathCount>=1);
  check('perPathSummariesの件数がoptimalPathCountと一致', result.perPathSummaries.length===result.optimalPathCount);

  check('各経路の長さはrootDistanceと一致', result.perPathSummaries.every(p=>p.length===result.rootDistance));
  check('全経路で成立ライン数は減少しない(decreasedSteps=0)', result.perPathSummaries.every(p=>p.decreasedSteps===0));
  check('finalBurstRatioは0〜1の範囲に収まる(定義範囲内)', result.perPathSummaries.every(p=>p.finalBurstRatio===null || (p.finalBurstRatio>=0 && p.finalBurstRatio<=1)));

  // 全optimal pathの終端が正解状態であること(各手を適用した最終値が全セルのcorrectValueと一致)。
  const correctValues = productionCells.map(c=>c.correctValue);
  const allPathsEndCorrect = result._rawPaths.every(movesPath=>{
    let values = productionCells.map(c=>c.initialValue);
    for(const [i,j] of movesPath){ const next=values.slice(); const tmp=next[i]; next[i]=next[j]; next[j]=tmp; values=next; }
    return values.every((v,idx)=>v===correctValues[idx]);
  });
  check('全optimal pathの終端が正解状態', allPathsEndCorrect);

  check('aggregatesにmin/max/meanが揃っている',
    ['finalBurstRatio','maxSingleStepRecovery','increasedSteps','decreasedSteps'].every(k=>{
      const agg = result.aggregates[k];
      return agg && typeof agg.min==='number' && typeof agg.max==='number' && typeof agg.mean==='number';
    }));
  // path集計のmin/max/averageが実経路集合と一致することを、実データから再計算して照合する。
  const finalBurstValues = result.perPathSummaries.map(p=>p.finalBurstRatio).filter(v=>typeof v==='number' && Number.isFinite(v));
  if(finalBurstValues.length>0){
    const expectedMin = Math.min(...finalBurstValues), expectedMax = Math.max(...finalBurstValues);
    const expectedMean = finalBurstValues.reduce((a,b)=>a+b,0)/finalBurstValues.length;
    check('finalBurstRatio集計(min/max/mean)が実経路集合と一致',
      result.aggregates.finalBurstRatio.min===expectedMin &&
      result.aggregates.finalBurstRatio.max===expectedMax &&
      Math.abs(result.aggregates.finalBurstRatio.mean-expectedMean) < 1e-9);
  }
  check('mostGradualPathが返る', result.mostGradualPath !== null && Array.isArray(result.mostGradualPath.eqSeries));

  console.log(`  (elapsed: ${elapsedMs}ms, nodesExplored: ${result.nodesExplored})`);

  // 同一状態のメモ化: 全経路を毎回別々に辿ると総手数(経路数×長さ)相当のノード数になるはずだが、
  // 状態の再利用によりnodesExploredは大幅に少なくなる。
  check('メモ化により探索ノード数が経路総手数より大幅に少ない', result.nodesExplored < result.optimalPathCount * result.rootDistance);
}

console.log('== optimal move: 最短距離が必ず1減ることの直接検証(production fixture) ==');
{
  const correctValues = productionCells.map(c=>c.correctValue);
  const rootValues = productionCells.map(c=>c.initialValue);
  const rootDistance = A.minSwapsForValues(rootValues, correctValues).minSwaps;

  const n = rootValues.length;
  let optimalCount = 0, nonOptimalCount = 0;
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    const next = rootValues.slice();
    const tmp = next[i]; next[i]=next[j]; next[j]=tmp;
    const d = A.minSwapsForValues(next, correctValues).minSwaps;
    if(d === rootDistance-1) optimalCount++;
    else nonOptimalCount++;
  }
  const totalPairs = n*(n-1)/2;
  check('optimal・non-optimalの合計がC(n,2)と一致', optimalCount + nonOptimalCount === totalPairs);
  check('未クリア状態には少なくとも1つのoptimalな交換が存在する', rootDistance>0 ? optimalCount>=1 : true);
}

console.log('== 非optimal moveがoptimal pathへ混入しないこと ==');
{
  const result = Q.analyzeOptimalPaths(CUBE_DATA, lines, productionCells);
  const correctValues = productionCells.map(c=>c.correctValue);

  let violation = false;
  for(const movesPath of result._rawPaths){
    let values = productionCells.map(c=>c.initialValue);
    let dist = A.minSwapsForValues(values, correctValues).minSwaps;
    for(const [i,j] of movesPath){
      const next = values.slice(); const tmp=next[i]; next[i]=next[j]; next[j]=tmp;
      const nextDist = A.minSwapsForValues(next, correctValues).minSwaps;
      if(nextDist !== dist-1){ violation = true; }
      values = next; dist = nextDist;
    }
  }
  check('全optimal path上の手はすべて距離を1減らす手のみで構成される', violation===false);
}

console.log('== synthetic fixtures: 置換構造ごとの理論値検証(production非依存) ==');
{
  // 各fixtureの期待値は置換の巡回構造から理論的に導出したもの:
  //   - 巡回長Lの単一サイクルの最短交換数 = L-1
  //   - 単一サイクルをL-1個の互換の積として分解する最小分解の総数(Dénesの定理) = L^(L-2)
  //   - 単一サイクル内の初手候補数 = C(L,2)(サイクル内の任意の2要素の互換が最適手になる)
  //   - 互いに素な複数サイクルの場合、全体の最短交換数は各サイクルの(長さ-1)の総和
  //   - 経路総数は「手順の割当て方(多項係数)」×「各サイクルの分解総数の積」

  function runCase(label, n, applyPermutation, expected){
    const cells = buildSyntheticCells(CUBE_DATA, n);
    applyPermutation(cells);
    const cellsSnapshot = JSON.stringify(cells);

    const cyc = A.minSwapsForValues(cells.map(c=>c.initialValue), cells.map(c=>c.correctValue));
    check(`[${label}] 最短交換数が理論値と一致`, cyc.minSwaps===expected.minSwaps);

    const result = Q.analyzeOptimalPaths(CUBE_DATA, lines, cells);
    check(`[${label}] optimal first pair数が理論値と一致`, result.optimalFirstPairCount===expected.firstPairCount);
    check(`[${label}] optimal path数が理論値と一致`, result.optimalPathCount===expected.pathCount);
    check(`[${label}] 入力cellsを変更しない`, JSON.stringify(cells)===cellsSnapshot);

    // quality_invariants: 全列挙経路が正解状態で終了すること
    const correctValues = cells.map(c=>c.correctValue);
    const allEndCorrect = result._rawPaths.every(movesPath=>{
      let values = cells.map(c=>c.initialValue);
      for(const [i,j] of movesPath){ const next=values.slice(); const tmp=next[i]; next[i]=next[j]; next[j]=tmp; values=next; }
      return values.every((v,idx)=>v===correctValues[idx]);
    });
    check(`[${label}] 全経路が正解状態で終了する`, allEndCorrect);

    // quality_invariants: 各経路の全手が最短距離を1ずつ減らす(non-optimalが混入しない)
    const allStepsOptimal = result._rawPaths.every(movesPath=>{
      let values = cells.map(c=>c.initialValue);
      let dist = A.minSwapsForValues(values, correctValues).minSwaps;
      for(const [i,j] of movesPath){
        const next = values.slice(); const tmp=next[i]; next[i]=next[j]; next[j]=tmp;
        const nextDist = A.minSwapsForValues(next, correctValues).minSwaps;
        if(nextDist !== dist-1) return false;
        values = next; dist = nextDist;
      }
      return true;
    });
    check(`[${label}] 全経路の全手がoptimal moveのみで構成される`, allStepsOptimal);
  }

  // 1) すべて正解(0-cycle): 交換不要
  runCase('すべて正解', 3, (cells)=>{
    cells.forEach(c=>{ c.initialValue = c.correctValue; });
  }, { minSwaps:0, firstPairCount:0, pathCount:1 });

  // 2) 単一swap(2-cycle): 最短交換数1、経路は1通りのみ
  runCase('単一swap', 2, (cells)=>{
    const cv = cells.map(c=>c.correctValue);
    cells[0].initialValue = cv[1];
    cells[1].initialValue = cv[0];
  }, { minSwaps:1, firstPairCount:1, pathCount:1 });

  // 3) 3-cycle: 最短交換数2、初手候補3通り(3C2)、最小分解3通り(3^1)
  runCase('3-cycle', 3, (cells)=>{
    const cv = cells.map(c=>c.correctValue);
    cells[0].initialValue = cv[1];
    cells[1].initialValue = cv[2];
    cells[2].initialValue = cv[0];
  }, { minSwaps:2, firstPairCount:3, pathCount:3 });

  // 4) 4-cycle: 最短交換数3、初手候補6通り(4C2)、最小分解16通り(4^2)
  runCase('4-cycle', 4, (cells)=>{
    const cv = cells.map(c=>c.correctValue);
    cells[0].initialValue = cv[1];
    cells[1].initialValue = cv[2];
    cells[2].initialValue = cv[3];
    cells[3].initialValue = cv[0];
  }, { minSwaps:3, firstPairCount:6, pathCount:16 });

  // 5) 独立した複数cycle(3-cycle + 2-cycle, n=5):
  //    最短交換数 = (3-1)+(2-1) = 3。初手候補 = 3(3-cycle内)+1(2-cycle内) = 4。
  //    経路数 = 手順の割当て方C(3,2)=3 × 3-cycleの分解数3 × 2-cycleの分解数1 = 9。
  runCase('独立した複数cycle(3+2)', 5, (cells)=>{
    const cv = cells.map(c=>c.correctValue);
    cells[0].initialValue = cv[1];
    cells[1].initialValue = cv[2];
    cells[2].initialValue = cv[0];
    cells[3].initialValue = cv[4];
    cells[4].initialValue = cv[3];
  }, { minSwaps:3, firstPairCount:4, pathCount:9 });
}

console.log('== ペアの不成立ラインunion計算・最大交差ペア ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const optimalPathsResult = Q.analyzeOptimalPaths(CUBE_DATA, lines, productionCells);
  const heuristic = Q.analyzeIntersectionHeuristic(board, lines, productionCells, optimalPathsResult.optimalFirstPairs);

  check('セル単体の不成立ライン数が8セル分揃う', heuristic.perCellAbnormalLineCounts.length===8);
  check('union件数は28ペア分揃う', heuristic.pairUnionCounts.length===28);
  check('union件数は各セル単体の最大値以上(和集合なので単調)', heuristic.pairUnionCounts.every(p=>{
    const maxSingle = Math.max(heuristic.perCellAbnormalLineCounts[p.i], heuristic.perCellAbnormalLineCounts[p.j]);
    return p.unionCount >= maxSingle;
  }));
  check('最大交差ペア集合が1件以上存在する', heuristic.maxUnionPairs.length>=1);
  check('isUniqueMaxPairはmaxUnionPairs.length===1と一致', heuristic.isUniqueMaxPair === (heuristic.maxUnionPairs.length===1));
  check('最大交差ペアとoptimal first pairの重なりが集計される', typeof heuristic.maxUnionPairOverlapWithOptimalFirst.overlapCount === 'number');
}

console.log('== directional evidence順位 ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const optimalPathsResult = Q.analyzeOptimalPaths(CUBE_DATA, lines, productionCells);
  const directional = Q.analyzeDirectionalEvidence(board, lines, productionCells, optimalPathsResult.optimalFirstPairs);

  check('28ペア全てに順位が付く', directional.ranked.length===28);
  const ranks = directional.ranked.map(r=>r.rank).sort((a,b)=>a-b);
  check('順位は1〜28の連番(重複・欠落なし)', ranks.every((r,idx)=>r===idx+1));
  check('順位はdevDelta昇順(改善が大きいほど上位)', directional.ranked.every((r,idx)=>
    idx===0 || directional.ranked[idx-1].devDelta <= r.devDelta
  ));
  check('optimal first pairの順位が取得できる', directional.optimalFirstPairRanks.length===optimalPathsResult.optimalFirstPairCount);
}

console.log('== 改善して見える非optimal交換の検出(misleading feedback, production fixture) ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const misleading = Q.analyzeMisleadingFeedback(board, lines, productionCells);

  // 非optimalペア数は「全ペア数 - optimalペア数」と一致するはず(値そのものは候補依存のためassertしない)。
  const correctValues = productionCells.map(c=>c.correctValue);
  const rootValues = productionCells.map(c=>c.initialValue);
  const rootDistance = A.minSwapsForValues(rootValues, correctValues).minSwaps;
  const n = rootValues.length;
  let optimalCount = 0;
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    const next = rootValues.slice(); const tmp=next[i]; next[i]=next[j]; next[j]=tmp;
    if(A.minSwapsForValues(next, correctValues).minSwaps === rootDistance-1) optimalCount++;
  }
  const totalPairs = n*(n-1)/2;
  check('非optimalペア数が(全ペア数-optimalペア数)と一致', misleading.nonOptimalPairCount === totalPairs - optimalCount);
  check('非optimalのうち成立数が増えるものの件数を取得できる', typeof misleading.nonOptimalEqIncreases==='number' && misleading.nonOptimalEqIncreases>=0);
  check('非optimalのうち総偏差が改善するものの件数を取得できる', typeof misleading.nonOptimalDevImproves==='number' && misleading.nonOptimalDevImproves>=0);
  check('正しい位置のセルを動かす交換の件数が取得できる(候補基準:正しい位置2以上のため必ず1件以上)', misleading.movesCorrectCellPairCount>0);
  check('その中での成立数増加・偏差改善件数も取得できる',
    typeof misleading.movesCorrectCellEqIncreases==='number' && typeof misleading.movesCorrectCellDevImproves==='number');
}

console.log('== 入力データを変更しないこと(横断確認) ==');
{
  const boardSnapshot = JSON.stringify(A.buildBoard(CUBE_DATA, productionCells));
  const cellsSnapshot = JSON.stringify(productionCells);
  const linesSnapshot = JSON.stringify(lines);

  const board = A.buildBoard(CUBE_DATA, productionCells);
  Q.analyzeOptimalPaths(CUBE_DATA, lines, productionCells);
  Q.analyzeIntersectionHeuristic(board, lines, productionCells, []);
  Q.analyzeDirectionalEvidence(board, lines, productionCells, []);
  Q.analyzeMisleadingFeedback(board, lines, productionCells);

  check('cellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);
  check('linesが変化しない', JSON.stringify(lines)===linesSnapshot);
  check('boardの再構築結果が変化しない(CUBE_DATA非破壊)', JSON.stringify(A.buildBoard(CUBE_DATA, productionCells))===boardSnapshot);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
