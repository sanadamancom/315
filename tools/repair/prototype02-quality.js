// tools/repair/prototype02-quality.js
// Prototype 02の問題候補について「最短修復経路の進行感」「単純な異常ライン交差数戦略」
// 「方向・偏差を考慮した判断」「誤誘導」を評価する開発用ツール。
//
// 方針:
//   - 盤面全体の無差別BFSは実装しない。optimal move(最短交換数が1減る手)だけを辿る。
//   - 同一状態(値の並び)はメモ化し、重複探索を避ける。
//   - 入力(cells)・既存Analyzerの戻り値は破壊的変更しない。
//   - 合否閾値は埋め込まず、判定材料となる数値を返す。
'use strict';
const A = require('./prototype02-analyzer.js');

// 探索ノード数の暴走防止用の安全上限(未確定セル数が増えた場合の保険)。
// Prototype01(8セル・4-cycle1つ)規模では到達しない想定。
const NODE_CAP = 20000;

// --- 状態(=各位置の現在値の配列)まわりの共通ヘルパー -----------------------
function stateKey(values){ return values.join(','); }

function boardForValues(CUBE_DATA, cells, values){
  const cellsLike = cells.map((cell, i)=> ({ L:cell.L, r:cell.r, c:cell.c, initialValue: values[i] }));
  return A.buildBoard(CUBE_DATA, cellsLike);
}

function allIndexPairs(n){
  const pairs = [];
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) pairs.push([i,j]);
  return pairs;
}

function swappedValues(values, i, j){
  const next = values.slice();
  const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
  return next;
}

// =========================================================================
// optimal_paths: 最短交換数が1減る手だけを辿り、全optimal pathを列挙・評価する
// =========================================================================
function analyzeOptimalPaths(CUBE_DATA, lines, cells){
  const n = cells.length;
  const correctValues = cells.map(c=>c.correctValue);
  const rootValues = cells.map(c=>c.initialValue);
  const pairs = allIndexPairs(n);

  const memoDistance = new Map();
  function distanceOf(values){
    const key = stateKey(values);
    if(memoDistance.has(key)) return memoDistance.get(key);
    const d = A.minSwapsForValues(values, correctValues).minSwaps;
    memoDistance.set(key, d);
    return d;
  }

  const rootDistance = distanceOf(rootValues);

  // solve(values) -> そのstateから解(distance=0)までの、optimal moveのみを辿る
  // 手順列の配列(各要素は[[i,j],[i,j],...])。同一stateはメモ化して再利用する。
  const memoPaths = new Map();
  let nodesExplored = 0;
  let capped = false;

  function solve(values){
    const key = stateKey(values);
    if(memoPaths.has(key)) return memoPaths.get(key);
    nodesExplored++;
    if(nodesExplored > NODE_CAP){ capped = true; memoPaths.set(key, []); return []; }

    const d = distanceOf(values);
    if(d === 0){ memoPaths.set(key, [[]]); return [[]]; }

    const results = [];
    for(const [i,j] of pairs){
      const next = swappedValues(values, i, j);
      if(distanceOf(next) === d-1){
        const subPaths = solve(next);
        for(const sub of subPaths) results.push([[i,j]].concat(sub));
      }
    }
    memoPaths.set(key, results);
    return results;
  }

  const allMovePaths = solve(rootValues); // [[ [i,j], [i,j], ... ], ...]

  // optimal first pair集合(最初の一手として現れる[i,j]の重複なし集合)
  const optimalFirstPairSet = new Set();
  for(const path of allMovePaths){
    if(path.length>0) optimalFirstPairSet.add(`${path[0][0]}-${path[0][1]}`);
  }

  // 各経路について、成立ライン数推移・Σ|sum-315|推移などを算出する
  const pathReports = allMovePaths.map(path=>{
    let values = rootValues;
    const valuesSeries = [values];
    for(const [i,j] of path){ values = swappedValues(values, i, j); valuesSeries.push(values); }

    const eqSeries = valuesSeries.map(v => A.summarizeLines(boardForValues(CUBE_DATA, cells, v), lines).eq);
    const devSeries = valuesSeries.map(v => A.totalDeviation(boardForValues(CUBE_DATA, cells, v), lines));

    let increasedSteps=0, maintainedSteps=0, decreasedSteps=0;
    let devImprovedSteps=0, devMaintainedSteps=0, devWorsenedSteps=0;
    let maxSingleStepRecovery = -Infinity;
    for(let k=1;k<eqSeries.length;k++){
      const deltaEq = eqSeries[k]-eqSeries[k-1];
      if(deltaEq>0) increasedSteps++; else if(deltaEq===0) maintainedSteps++; else decreasedSteps++;
      if(deltaEq > maxSingleStepRecovery) maxSingleStepRecovery = deltaEq;

      const deltaDev = devSeries[k]-devSeries[k-1];
      if(deltaDev<0) devImprovedSteps++; else if(deltaDev===0) devMaintainedSteps++; else devWorsenedSteps++;
    }

    const totalEqGain = eqSeries[eqSeries.length-1] - eqSeries[0];
    const lastStepGain = path.length>0 ? (eqSeries[eqSeries.length-1]-eqSeries[eqSeries.length-2]) : 0;
    const finalBurstRatio = totalEqGain !== 0 ? (lastStepGain/totalEqGain) : null;

    // 段階的改善の度合い: 各手のeq増分の分散が小さいほど「段階的」とみなす。
    const eqDeltas = [];
    for(let k=1;k<eqSeries.length;k++) eqDeltas.push(eqSeries[k]-eqSeries[k-1]);
    const meanDelta = eqDeltas.length ? eqDeltas.reduce((a,b)=>a+b,0)/eqDeltas.length : 0;
    const varianceDelta = eqDeltas.length
      ? eqDeltas.reduce((a,b)=>a+(b-meanDelta)*(b-meanDelta),0)/eqDeltas.length
      : 0;

    return {
      moves: path, // [[i,j], ...] (位置インデックスのみ。座標・値は含めない)
      length: path.length,
      eqSeries,
      devSeries,
      increasedSteps, maintainedSteps, decreasedSteps,
      devImprovedSteps, devMaintainedSteps, devWorsenedSteps,
      finalBurstRatio,
      maxSingleStepRecovery,
      gradualnessVariance: varianceDelta, // 小さいほど段階的
    };
  });

  function aggregate(field){
    const values = pathReports.map(p=>p[field]).filter(v => typeof v === 'number' && Number.isFinite(v));
    if(values.length===0) return { min:null, max:null, mean:null, count:0 };
    const sum = values.reduce((a,b)=>a+b,0);
    return { min: Math.min(...values), max: Math.max(...values), mean: sum/values.length, count: values.length };
  }

  let mostGradual = null;
  for(const p of pathReports){
    if(mostGradual === null || p.gradualnessVariance < mostGradual.gradualnessVariance) mostGradual = p;
  }

  return {
    rootDistance,
    nodesExplored,
    capped,
    optimalFirstPairCount: optimalFirstPairSet.size,
    optimalFirstPairs: Array.from(optimalFirstPairSet).map(s=>s.split('-').map(Number)),
    optimalPathCount: pathReports.length,
    perPathSummaries: pathReports.map(p => ({
      length: p.length,
      increasedSteps: p.increasedSteps, maintainedSteps: p.maintainedSteps, decreasedSteps: p.decreasedSteps,
      devImprovedSteps: p.devImprovedSteps, devMaintainedSteps: p.devMaintainedSteps, devWorsenedSteps: p.devWorsenedSteps,
      finalBurstRatio: p.finalBurstRatio,
      maxSingleStepRecovery: p.maxSingleStepRecovery,
    })),
    aggregates: {
      finalBurstRatio: aggregate('finalBurstRatio'),
      maxSingleStepRecovery: aggregate('maxSingleStepRecovery'),
      increasedSteps: aggregate('increasedSteps'),
      decreasedSteps: aggregate('decreasedSteps'),
    },
    mostGradualPath: mostGradual ? {
      length: mostGradual.length,
      eqSeries: mostGradual.eqSeries,
      devSeries: mostGradual.devSeries,
      finalBurstRatio: mostGradual.finalBurstRatio,
      maxSingleStepRecovery: mostGradual.maxSingleStepRecovery,
      gradualnessVariance: mostGradual.gradualnessVariance,
    } : null,
    // 内部データとして経路そのものを保持(座標・値は含まず、位置インデックスの手順のみ)
    _rawPaths: pathReports.map(p=>p.moves),
  };
}

// =========================================================================
// intersection_heuristic: 単純な「異常ライン交差数最大」戦略の評価
// =========================================================================
function abnormalLineKeySetForCell(board, lines, cell){
  const touching = A.linesThroughCell(lines, cell.L, cell.r, cell.c);
  const keys = new Set();
  for(const line of touching){ if(A.lineSum(board, line) !== 315) keys.add(line.key); }
  return keys;
}

function analyzeIntersectionHeuristic(board, lines, cells, optimalFirstPairs){
  const perCellSets = cells.map(cell => abnormalLineKeySetForCell(board, lines, cell));
  const perCellCounts = perCellSets.map(s=>s.size);

  const pairs = allIndexPairs(cells.length);
  const pairUnionCounts = pairs.map(([i,j])=>{
    const union = new Set([...perCellSets[i], ...perCellSets[j]]);
    return { i, j, unionCount: union.size };
  });

  const maxUnionCount = pairUnionCounts.reduce((m,p)=>Math.max(m,p.unionCount), -Infinity);
  const maxUnionPairs = pairUnionCounts.filter(p=>p.unionCount===maxUnionCount).map(p=>[p.i,p.j]);

  const optimalFirstPairSet = new Set((optimalFirstPairs||[]).map(([i,j])=>`${i}-${j}`));
  const overlapWithOptimal = maxUnionPairs.filter(([i,j])=>optimalFirstPairSet.has(`${i}-${j}`));

  return {
    perCellAbnormalLineCounts: perCellCounts,
    pairUnionCounts,
    maxUnionCount,
    maxUnionPairs,
    isUniqueMaxPair: maxUnionPairs.length === 1,
    maxUnionPairOverlapWithOptimalFirst: {
      overlapCount: overlapWithOptimal.length,
      overlapPairs: overlapWithOptimal,
    },
  };
}

// =========================================================================
// directional_evidence: signed deviationに基づく28ペアの順位付け
// =========================================================================
function analyzeDirectionalEvidence(board, lines, cells, optimalFirstPairs){
  const swapResults = A.analyzeAllSwaps(board, lines, cells); // 28件、各々 i,j,eqDelta,devDelta,improvedLineCount,worsenedLineCount...

  // ランキング基準: devDelta(総偏差の変化)が小さい(より負, つまり改善)ほど良い。
  // 同点はimprovedLineCount(悪化を伴わず改善したライン数)が多い方を上位とする。
  const ranked = swapResults.slice().sort((a,b)=>{
    if(a.devDelta !== b.devDelta) return a.devDelta - b.devDelta;
    return b.improvedLineCount - a.improvedLineCount;
  }).map((r, idx)=> Object.assign({ rank: idx+1 }, r));

  const optimalFirstPairSet = new Set((optimalFirstPairs||[]).map(([i,j])=>`${i}-${j}`));
  const optimalFirstPairRanks = ranked
    .filter(r => optimalFirstPairSet.has(`${r.i}-${r.j}`))
    .map(r => ({ i:r.i, j:r.j, rank:r.rank }));

  return {
    ranked: ranked.map(r => ({ i:r.i, j:r.j, rank:r.rank, devDelta:r.devDelta, eqDelta:r.eqDelta,
      improvedLineCount:r.improvedLineCount, worsenedLineCount:r.worsenedLineCount })),
    optimalFirstPairRanks,
  };
}

// =========================================================================
// misleading_feedback: 最短距離を減らさない交換のうち、見かけ上「良く見える」ものを検出
// =========================================================================
function analyzeMisleadingFeedback(board, lines, cells){
  const n = cells.length;
  const correctValues = cells.map(c=>c.correctValue);
  const rootValues = cells.map(c=>c.initialValue);
  const rootDistance = A.minSwapsForValues(rootValues, correctValues).minSwaps;

  const swapResults = A.analyzeAllSwaps(board, lines, cells);
  const pairs = allIndexPairs(n);

  const classified = pairs.map(([i,j], idx)=>{
    const nextValues = swappedValues(rootValues, i, j);
    const nextDistance = A.minSwapsForValues(nextValues, correctValues).minSwaps;
    const isOptimal = nextDistance === rootDistance - 1;
    const movesCorrectCell = (cells[i].initialValue === cells[i].correctValue) ||
                              (cells[j].initialValue === cells[j].correctValue);
    const sr = swapResults[idx]; // analyzeAllSwapsもpairsと同じ順序(i<jの昇順)で生成される
    return { i, j, isOptimal, movesCorrectCell, eqDelta: sr.eqDelta, devDelta: sr.devDelta };
  });

  const nonOptimal = classified.filter(c => !c.isOptimal);
  const nonOptimalEqIncreases = nonOptimal.filter(c => c.eqDelta > 0).length;
  const nonOptimalDevImproves = nonOptimal.filter(c => c.devDelta < 0).length;

  const movesCorrectCellPairs = classified.filter(c => c.movesCorrectCell);
  const movesCorrectCellEqIncreases = movesCorrectCellPairs.filter(c => c.eqDelta > 0).length;
  const movesCorrectCellDevImproves = movesCorrectCellPairs.filter(c => c.devDelta < 0).length;

  return {
    rootDistance,
    nonOptimalPairCount: nonOptimal.length,
    nonOptimalEqIncreases,
    nonOptimalDevImproves,
    movesCorrectCellPairCount: movesCorrectCellPairs.length,
    movesCorrectCellEqIncreases,
    movesCorrectCellDevImproves,
  };
}

module.exports = {
  NODE_CAP,
  stateKey,
  boardForValues,
  analyzeOptimalPaths,
  analyzeIntersectionHeuristic,
  analyzeDirectionalEvidence,
  analyzeMisleadingFeedback,
};
