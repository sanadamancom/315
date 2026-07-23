// tools/repair/search-production-candidates.js
//
// 本番候補3問(導入/標準/高難度、いずれも中立ID)を決定論的に生成する。
//
// 再利用方針:
//   - 座標配置の方式(groupA/groupB的な3巡回グループ + 各グループセルを含む
//     「レベル内1個ライン0本」ブロックのdecoy)は、既存の
//     search-prototype11-3d.js の方式をそのまま踏襲し、グループ数を
//     パラメータ化しただけ(2グループ=Prototype 11既存構造相当、
//     3グループ=より広い誤配置構造)。
//   - hard gate・構造指標の測定は、tools/repair/prototype02-analyzer.js の
//     既存関数(analyzeDirectSubtraction, analyzeSignOnlyCompatibleSwaps,
//     countLineConstrainedSolutions)をそのまま呼び出すだけで行う。
//     これらは元々8セル(Prototype02)専用に書かれたものではなく、
//     cells配列の長さに依存しない汎用実装(search-prototype03.jsが12セルで
//     再利用しているのと同じ理由で、22セル前後でも変更なく使える)。
//   - CUBE_DATA・109ライン構築は tools/repair/bounded-human-player/internal/
//     prototype-fixture.js の buildLines109/CUBE_DATA を読み取り専用で再利用する
//     (このファイルは変更しない。requireするだけ)。
//   - 正解値・正解交換・exact deviationは、生成後の静的データにも
//     このスクリプトの標準出力にも一切出力しない(candidatesファイル自体には
//     必要上correctValueを含めるが、それは「問題データそのもの」であり、
//     人間向けの応答やレポートへは座標・正解値を書き出さない)。
//
// 探索手順(procedure、事前固定・決定論的):
//   1. 3役割それぞれの構造条件(groupCount・rootStrongCompatibleCountの帯域)を
//      このファイルの定数として先に固定する(ROLE_SPECS)。
//   2. 単一のRNG(seed=20260723)を3役割で順番に共有し、各役割の条件を満たす
//      最初の候補を採用する(個別traceを見てからの条件変更・手選びはしない)。
//   3. 各役割で条件を満たす候補が見つからなければ、その役割の探索件数を
//      報告し、生成済み候補には手を加えず停止する(if_band_empty)。

'use strict';

const path = require('path');
const A = require('./prototype02-analyzer.js');
const { buildLines109, CUBE_DATA } = require('./bounded-human-player/internal/prototype-fixture.js');

const N = 5;
const lines = buildLines109();

// --- seed指定可能なPRNG(既存のsearch-prototype02.js/search-prototype11-3d.jsと同型) ---
function createRng(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(c){ return `${c.z}-${c.y}-${c.x}`; }

// --- 1レベル内(5x5・12ライン)の構造検証(search-prototype11-3d.jsと同一方式) ---
function linesOfLevel(){
  const ls = [];
  for(let y=0;y<N;y++){ const c=[]; for(let x=0;x<N;x++) c.push(y*N+x); ls.push(c); }
  for(let x=0;x<N;x++){ const c=[]; for(let y=0;y<N;y++) c.push(y*N+x); ls.push(c); }
  ls.push(Array.from({length:N},(_,i)=>i*N+i));
  ls.push(Array.from({length:N},(_,i)=>i*N+(N-1-i)));
  return ls;
}
const LEVEL_LINES = linesOfLevel();
function idx2d(y,x){ return y*N+x; }

function combos(arr, k){
  const res = [];
  function rec(start, cur){
    if(cur.length===k){ res.push(cur.slice()); return; }
    for(let i=start;i<arr.length;i++){ cur.push(arr[i]); rec(i+1,cur); cur.pop(); }
  }
  rec(0, []);
  return res;
}
const ALL_CELLS_2D = Array.from({length:N*N}, (_,i)=>i);
const blockCache = {};
function validBlocksContaining(y, x){
  const k = `${y}-${x}`;
  if(blockCache[k]) return blockCache[k];
  const target = idx2d(y,x);
  const found = [];
  for(const c of combos(ALL_CELLS_2D, 4)){
    if(!c.includes(target)) continue;
    const set = new Set(c);
    const ok = LEVEL_LINES.every(line => line.filter(cell=>set.has(cell)).length !== 1);
    if(ok) found.push(c.map(v => [Math.floor(v/N), v%N]));
  }
  blockCache[k] = found;
  return found;
}

function countSingles(movableKeySet){
  let s = 0;
  for(const line of lines){
    const cnt = line.cells.filter(c => movableKeySet.has(key(c))).length;
    if(cnt === 1) s++;
  }
  return s;
}

function correctValueOf(c){ return CUBE_DATA[c.z][c.y][c.x]; }

function cyclicDisplay(group){
  const vals = group.map(correctValueOf);
  return group.map((c,i) => ({
    coord: c,
    correctValue: vals[i],
    displayedValue: vals[(i-1+group.length) % group.length],
  }));
}

// --- 1回の試行: groupCount個の3巡回グループ + decoyブロックを構築する ---
function attempt(rng, groupCount){
  const usedCoordKeys = new Set(); // グループ間の座標衝突も避ける(既存スクリプトはグループ内のzだけ回避していたが、
                                    // ここではgroupCount>=3もあるため、グループ間の座標重複も明示的に防ぐ)
  function randCoord(usedZ){
    let tries = 0;
    while(true){
      if(tries++ > 500) return null;
      const z = Math.floor(rng()*N);
      if(usedZ.has(z)) continue;
      const y = Math.floor(rng()*N);
      const x = Math.floor(rng()*N);
      const k = `${z}-${y}-${x}`;
      if(usedCoordKeys.has(k)) continue;
      usedZ.add(z);
      usedCoordKeys.add(k);
      return { z, y, x };
    }
  }

  const groups = [];
  for(let g=0; g<groupCount; g++){
    const usedZ = new Set();
    const group = [randCoord(usedZ), randCoord(usedZ), randCoord(usedZ)];
    if(group.some(c => c === null)) return null;
    groups.push(group);
  }

  const perCell = [];
  for(const group of groups){
    for(const c of group){
      const blocks = validBlocksContaining(c.y, c.x);
      if(blocks.length === 0) return null;
      perCell.push({ coord: c, blocks });
    }
  }

  const movable = new Set();
  const chosenBlocks = [];
  for(const { coord, blocks } of perCell){
    const b = blocks[Math.floor(rng()*blocks.length)];
    chosenBlocks.push({ z: coord.z, anchor: [coord.y, coord.x], block: b });
    for(const [y,x] of b) movable.add(`${coord.z}-${y}-${x}`);
  }

  const singleCount = countSingles(movable);
  if(singleCount !== 0) return null;

  const groupCoordKeys = new Set(groups.flat().map(key));
  const decoyKeys = [...movable].filter(k => !groupCoordKeys.has(k));

  return { groups, chosenBlocks, movable, decoyKeys };
}

// --- attempt結果を analyzer 用の cells 配列(L,r,c,correctValue,initialValue) へ変換 ---
function buildAnalyzerCells(result){
  const cells = [];
  for(const group of result.groups){
    for(const disp of cyclicDisplay(group)){
      cells.push({
        L: disp.coord.z + 1, r: disp.coord.y, c: disp.coord.x,
        correctValue: disp.correctValue, initialValue: disp.displayedValue,
      });
    }
  }
  for(const k of result.decoyKeys){
    const [z,y,x] = k.split('-').map(Number);
    const cv = correctValueOf({ z, y, x });
    cells.push({ L: z+1, r: y, c: x, correctValue: cv, initialValue: cv });
  }
  return cells;
}

// --- hard gate + 構造指標の測定(既存Analyzerの関数をそのまま呼ぶだけ) ---
function evaluateCandidate(cells, groupCount){
  const gates = {};

  const direct = A.analyzeDirectSubtraction(CUBE_DATA, lines, cells);
  gates.directSubtractionSolvedZero = direct.solvedCellCount === 0;

  const board = A.buildBoard(CUBE_DATA, cells);
  const signOnly = A.analyzeSignOnlyCompatibleSwaps(board, lines, cells);
  const rootStrongCompatibleCount = signOnly.compatibleSwapCount;

  const minSwaps = A.minSwapsFromCycles(cells).minSwaps;

  gates.structureOk = gates.directSubtractionSolvedZero === true;

  let uniqueness = null;
  if(gates.structureOk){
    uniqueness = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells, { maxSolutions: 3 });
    gates.uniquenessOk = uniqueness.isUnique === true;
  } else {
    gates.uniquenessOk = false;
  }

  const passed = gates.structureOk && gates.uniquenessOk;

  return {
    passed, gates, rootStrongCompatibleCount, minSwaps, groupCount,
    movableCellCount: cells.length,
    uniqueness,
  };
}

// --- 3役割の構造条件(探索前に固定、if_band_emptyでも黙って緩和しない) ---
//
// groupCountはPrototype 11の既存構造(誤配置グループ2つ・各3巡回)をそのまま
// 維持し、3役割いずれも変更しない(「新しいコアルールや難易度機構を作らない」
// requirementに従う)。難易度の differentiation は、既存Analyzer
// (analyzeSignOnlyCompatibleSwaps)がそのまま返す rootStrongCompatibleCount
// (公開情報だけで見た「符号だけの互換交換」の総数。値が大きいほど、局所的に
// 「良さそうに見えるが実際には不確定な」交換候補が多く、初期情報だけでは
// 絞り込みにくいことを意味する)の帯域だけで行う。
// この帯域は、実測(groupCount=2の合格候補15件、seed=20260723)で得られた
// 分布(23〜83)を土台に、探索前に固定した。
const ROLE_SPECS = [
  {
    role: 'role_introduction',
    groupCount: 2,
    rootStrongCompatibleCountRange: [20, 35], // 相対的に候補が少なく、早期に絞れる
  },
  {
    role: 'role_standard',
    groupCount: 2,
    rootStrongCompatibleCountRange: [36, 55], // 初手候補が複数あり、更新が必要
  },
  {
    role: 'role_advanced',
    groupCount: 2,
    rootStrongCompatibleCountRange: [56, 90], // 初期情報だけでは一意化しにくい
  },
];

const MASTER_SEED = 20260723;
const MAX_TRIALS_PER_ROLE = 2000000;

function runSearchForRole(spec, rng){
  let evaluated = 0;
  for(let trial = 1; trial <= MAX_TRIALS_PER_ROLE; trial++){
    const result = attempt(rng, spec.groupCount);
    if(!result) continue;
    evaluated++;
    const cells = buildAnalyzerCells(result);
    const evalResult = evaluateCandidate(cells, spec.groupCount);
    const [lo, hi] = spec.rootStrongCompatibleCountRange;
    const inBand = evalResult.rootStrongCompatibleCount >= lo && evalResult.rootStrongCompatibleCount <= hi;
    if(evalResult.passed && inBand){
      return {
        role: spec.role, trial, evaluated,
        result, cells, evalResult,
      };
    }
  }
  return { role: spec.role, trial: null, evaluated, result: null };
}

function runAllRoles(){
  const rng = createRng(MASTER_SEED); // 3役割で単一RNGを順番に共有する(procedure通り)
  const outcomes = [];
  for(const spec of ROLE_SPECS){
    outcomes.push(runSearchForRole(spec, rng));
  }
  return { seed: MASTER_SEED, outcomes };
}

// --- 静的データ形式への変換(schemaVersion, 中立ID, 非ネタバレmetricsのみ) ---
function buildCandidateArtifact(publicId, outcome){
  if(!outcome.result) return null;
  const { result, cells, evalResult } = outcome;

  const movableCells = cells.map(c => ({
    z: c.L - 1, y: c.r, x: c.c, initialValue: c.initialValue,
  })).sort((a,b) => (a.z-b.z)||(a.y-b.y)||(a.x-b.x));

  return {
    schemaVersion: 1,
    publicId,
    classification: 'provisional',
    source: {
      masterSeed: outcome.seed !== undefined ? outcome.seed : MASTER_SEED,
      trial: outcome.trial,
      evaluatedInRole: outcome.evaluated,
      groupCount: evalResult.groupCount,
    },
    cells: cells.map(c => ({ z: c.L-1, y: c.r, x: c.c, correctValue: c.correctValue, initialValue: c.initialValue }))
      .sort((a,b)=>(a.z-b.z)||(a.y-b.y)||(a.x-b.x)),
    structuralMetrics: {
      movableCellCount: evalResult.movableCellCount,
      groupCount: evalResult.groupCount,
      rootStrongCompatibleCount: evalResult.rootStrongCompatibleCount,
      minSwaps: evalResult.minSwaps,
      singleLineCount: 0,
    },
  };
}

function main(){
  const { seed, outcomes } = runAllRoles();
  console.log(`master seed=${seed}`);
  for(const o of outcomes){
    if(o.result){
      console.log(`${o.role}: FOUND at trial=${o.trial} (evaluated=${o.evaluated}) rootStrongCompatibleCount=${o.evalResult.rootStrongCompatibleCount} movableCellCount=${o.evalResult.movableCellCount} minSwaps=${o.evalResult.minSwaps}`);
    } else {
      console.log(`${o.role}: NOT FOUND (evaluated=${o.evaluated}/${MAX_TRIALS_PER_ROLE})`);
    }
  }
  return outcomes;
}

if(require.main === module){ main(); }

module.exports = {
  MASTER_SEED,
  MAX_TRIALS_PER_ROLE,
  ROLE_SPECS,
  createRng,
  attempt,
  buildAnalyzerCells,
  evaluateCandidate,
  runSearchForRole,
  runAllRoles,
  buildCandidateArtifact,
  main,
};
