// tools/repair/prototype02-analyzer.js
// Prototype 02の問題候補(未確定8セル)を機械評価する開発用Analyzer。
//
// 方針:
//   - 合否閾値は一切埋め込まない。判定材料となる生の数値・真偽値だけを返す。
//   - 入力(cube, candidateCells)は破壊的変更しない。内部では常にコピーして扱う。
//   - CUBE_DATA/109ラインは既存テスト(tests/repair-tests.js)と同じ方法(vm実行)で読み込む。
//   - js/repair/*.js は一切変更しない。measure.js等はPrototype01(REPAIR_CELLS)に
//     依存した実装のため、ここでは再利用せず、盤面配列を直接扱う独立ロジックとして書く。
//
// candidateCells の形式(puzzle.jsのREPAIR_CELLSと同じ8要素配列):
//   [{ L, r, c, correctValue, initialValue }, ...] × 8
//   L: 1-5, r: 0-4, c: 0-4 (座標系はcube-data.js / lines109.jsと同じ)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const N5 = 5;

// --- 既存テストと同じ方法でCUBE_DATA/109ラインを読み込む -----------------
function loadCubeContext(){
  const files = [
    'js/repair/cube-data.js',
    'js/repair/lines109.js',
  ];
  const ctx = {};
  vm.createContext(ctx);
  for(const f of files){
    const code = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  vm.runInContext(`
    globalThis.CUBE_DATA = CUBE_DATA;
    globalThis.buildLines109 = buildLines109;
  `, ctx);
  return { CUBE_DATA: ctx.CUBE_DATA, lines: ctx.buildLines109() };
}

// --- 座標8件の範囲・重複検証 ---------------------------------------------
function validateCandidateCells(cells){
  const errors = [];
  if(!Array.isArray(cells) || cells.length !== 8){
    errors.push('cell-count');
    return { valid:false, errors, length: Array.isArray(cells) ? cells.length : 0, duplicateCount:0, outOfRangeCount:0 };
  }
  let outOfRangeCount = 0;
  const seen = new Set();
  let duplicateCount = 0;
  for(const cell of cells){
    const { L, r, c } = cell;
    const inRange = Number.isInteger(L) && L>=1 && L<=N5 &&
                     Number.isInteger(r) && r>=0 && r<N5 &&
                     Number.isInteger(c) && c>=0 && c<N5;
    if(!inRange) outOfRangeCount++;
    const key = `${L}-${r}-${c}`;
    if(seen.has(key)) duplicateCount++;
    seen.add(key);
  }
  if(outOfRangeCount>0) errors.push('out-of-range');
  if(duplicateCount>0) errors.push('duplicate-coords');
  return {
    valid: outOfRangeCount===0 && duplicateCount===0,
    errors,
    length: cells.length,
    duplicateCount,
    outOfRangeCount,
  };
}

// --- 初期値が対象8セルの正解値集合の順列か検証 ---------------------------
function validateInitialIsPermutationOfCorrect(cells){
  const correct = cells.map(c=>c.correctValue).slice().sort((a,b)=>a-b);
  const initial = cells.map(c=>c.initialValue).slice().sort((a,b)=>a-b);
  const isPermutation = correct.length===initial.length &&
    correct.every((v,i)=>v===initial[i]);
  return { isPermutation, correctMultiset: correct, initialMultiset: initial };
}

// --- 盤面構築(非破壊。CUBE_DATAはコピーしてcandidateで上書き) ------------
function buildBoard(CUBE_DATA, cells){
  const board = CUBE_DATA.map(plane => plane.map(row => row.slice()));
  for(const cell of cells){
    board[cell.L-1][cell.r][cell.c] = cell.initialValue;
  }
  return board;
}

function cellsIndexByCoord(cells){
  const map = new Map();
  cells.forEach((cell,i)=> map.set(`${cell.L}-${cell.r}-${cell.c}`, i));
  return map;
}

// --- 盤面全体が1〜125を重複欠落なく含むか検証 -----------------------------
function validateBoardCompleteness(board){
  const flat = [];
  for(let z=0; z<N5; z++) for(let y=0; y<N5; y++) for(let x=0; x<N5; x++) flat.push(board[z][y][x]);
  const uniq = new Set(flat);
  return {
    valid: flat.length===125 && uniq.size===125 && Math.min(...flat)===1 && Math.max(...flat)===125,
    count: flat.length,
    uniqueCount: uniq.size,
    min: flat.length ? Math.min(...flat) : null,
    max: flat.length ? Math.max(...flat) : null,
  };
}

// --- 固定117セルが正解状態のままか検証 -------------------------------------
function validateFixedCellsUnchanged(CUBE_DATA, board, cells){
  const idx = cellsIndexByCoord(cells);
  let fixedCellCount = 0, unchangedCount = 0, mismatchCount = 0;
  for(let z=0; z<N5; z++) for(let y=0; y<N5; y++) for(let x=0; x<N5; x++){
    const L = z+1;
    if(idx.has(`${L}-${y}-${x}`)) continue; // 未確定セルは対象外
    fixedCellCount++;
    if(board[z][y][x] === CUBE_DATA[z][y][x]) unchangedCount++;
    else mismatchCount++;
  }
  return { fixedCellCount, unchangedCount, mismatchCount, valid: mismatchCount===0 };
}

// --- 正解位置／誤配置の未確定セル数を内部集計 ------------------------------
function countPlacementStatus(cells){
  let correctCount = 0, misplacedCount = 0;
  const misplacedLevels = new Set();
  cells.forEach(cell=>{
    if(cell.initialValue === cell.correctValue) correctCount++;
    else { misplacedCount++; misplacedLevels.add(cell.L); }
  });
  return {
    correctCount,
    misplacedCount,
    misplacedLevelCount: misplacedLevels.size,
    misplacedLevels: Array.from(misplacedLevels).sort((a,b)=>a-b),
  };
}

// --- ラインのz座標判定と階層内／階層横断の分類 ------------------------------
function classifyLine(line){
  const zs = new Set(line.cells.map(cell=>cell.z));
  return zs.size === 1 ? 'intra' : 'cross';
}

function lineSum(board, line){
  let sum = 0;
  for(const cell of line.cells) sum += board[cell.z][cell.y][cell.x];
  return sum;
}

function lineStatus(sum){
  if(sum === 315) return '=';
  return sum > 315 ? '↑' : '↓';
}

// --- 109ラインの成立／↑／↓集計 + 階層内／階層横断分類・異常数集計 ----------
function summarizeLines(board, lines){
  const result = {
    total: lines.length,
    eq: 0, over: 0, under: 0,
    byClass: {
      intra: { total:0, eq:0, over:0, under:0, abnormal:0 },
      cross: { total:0, eq:0, over:0, under:0, abnormal:0 },
    },
  };
  for(const line of lines){
    const sum = lineSum(board, line);
    const status = lineStatus(sum);
    const cls = classifyLine(line);
    result.byClass[cls].total++;
    if(status==='='){ result.eq++; result.byClass[cls].eq++; }
    else {
      if(status==='↑'){ result.over++; result.byClass[cls].over++; }
      else { result.under++; result.byClass[cls].under++; }
      result.byClass[cls].abnormal++;
    }
  }
  return result;
}

// --- 指定セル(L,r,c)が属するラインの一覧 -----------------------------------
function linesThroughCell(lines, L, r, c){
  const z=L-1, y=r, x=c;
  return lines.filter(line => line.cells.some(cell=>cell.z===z && cell.y===y && cell.x===x));
}

// --- 未確定セルごとの所属不成立ライン数集計 ---------------------------------
function perCellAbnormalLineCounts(board, lines, cells){
  return cells.map((cell, index)=>{
    const touching = linesThroughCell(lines, cell.L, cell.r, cell.c);
    const abnormal = touching.filter(line => lineSum(board, line) !== 315).length;
    return { index, L:cell.L, r:cell.r, c:cell.c, touchingLineCount: touching.length, abnormalLineCount: abnormal };
  });
}

// --- 交換候補28通りの分析 ---------------------------------------------------
function swapBoard(board, cellA, cellB){
  const next = board.map(plane => plane.map(row => row.slice()));
  const tmp = next[cellA.L-1][cellA.r][cellA.c];
  next[cellA.L-1][cellA.r][cellA.c] = next[cellB.L-1][cellB.r][cellB.c];
  next[cellB.L-1][cellB.r][cellB.c] = tmp;
  return next;
}

function analyzeSwap(board, lines, cellA, cellB){
  const before = lines.map(line => lineSum(board, line));
  const swapped = swapBoard(board, cellA, cellB);
  const after = lines.map(line => lineSum(swapped, line));

  let eqBefore=0, eqAfter=0;
  let devBefore=0, devAfter=0;
  let improved=0, worsened=0, newlyEqual=0, newlyUnequal=0;

  for(let i=0;i<lines.length;i++){
    const b = before[i], a = after[i];
    const db = Math.abs(b-315), da = Math.abs(a-315);
    devBefore += db; devAfter += da;
    if(b===315) eqBefore++;
    if(a===315) eqAfter++;
    if(da < db) improved++;
    else if(da > db) worsened++;
    if(b!==315 && a===315) newlyEqual++;
    if(b===315 && a!==315) newlyUnequal++;
  }

  return {
    eqBefore, eqAfter, eqDelta: eqAfter-eqBefore,
    devBefore, devAfter, devDelta: devAfter-devBefore,
    improvedLineCount: improved,
    worsenedLineCount: worsened,
    newlyEqualCount: newlyEqual,
    newlyUnequalCount: newlyUnequal,
  };
}

function analyzeAllSwaps(board, lines, cells){
  const results = [];
  for(let i=0;i<cells.length;i++){
    for(let j=i+1;j<cells.length;j++){
      const metrics = analyzeSwap(board, lines, cells[i], cells[j]);
      results.push(Object.assign({ i, j }, metrics));
    }
  }
  return results; // 8C2 = 28件
}

// --- 置換の巡回構造から最短交換数を算出(汎用版) -----------------------------
// currentValues[i] が本来どの位置(correctValuesがcurrentValues[i]と一致する位置)に
// 属するかをたどってサイクル分解する。minSwaps = 要素数 - サイクル数。
// state探索(quality.js)など、initialValue/correctValueのセルオブジェクトを持たない
// 場面でも使えるよう、配列2本だけを受け取る形にしてある。
function minSwapsForValues(currentValues, correctValues){
  const n = currentValues.length;
  const correctIndexOfValue = new Map();
  correctValues.forEach((v,i)=> correctIndexOfValue.set(v, i));

  const visited = new Array(n).fill(false);
  const cycleLengths = [];
  for(let i=0;i<n;i++){
    if(visited[i]) continue;
    let len = 0;
    let cur = i;
    while(!visited[cur]){
      visited[cur] = true;
      len++;
      const value = currentValues[cur];
      const next = correctIndexOfValue.get(value);
      if(next === undefined){ len = -1; break; } // 対応が取れない(順列でない)
      cur = next;
    }
    cycleLengths.push(len);
  }
  const validDecomposition = cycleLengths.every(l => l>0);
  const minSwaps = validDecomposition ? n - cycleLengths.length : null;
  return { cycleLengths, minSwaps, validDecomposition };
}

// 既存API(cells配列直接渡し)は上記の薄いラッパーとして維持する。挙動は変更なし。
function minSwapsFromCycles(cells){
  return minSwapsForValues(cells.map(c=>c.initialValue), cells.map(c=>c.correctValue));
}

// --- ライン集合に対するΣ|sum-315|(総偏差)を算出 ----------------------------
function totalDeviation(board, lines){
  let sum = 0;
  for(const line of lines) sum += Math.abs(lineSum(board, line) - 315);
  return sum;
}

// --- 未確定8セルの8!全探索: 109ライン全成立配置数を数える -------------------
function permutations(arr){
  if(arr.length<=1) return [arr];
  const res=[];
  for(let i=0;i<arr.length;i++){
    const rest = arr.slice(0,i).concat(arr.slice(i+1));
    for(const p of permutations(rest)) res.push([arr[i],...p]);
  }
  return res;
}

function exhaustiveUniqueSolutionCount(CUBE_DATA, lines, cells){
  // 対象8セルに関与するラインだけを対象にすれば十分(他ラインは固定セルのみで常に315)。
  const idx = cellsIndexByCoord(cells);
  const relevantLines = lines.filter(line =>
    line.cells.some(cell => idx.has(`${cell.z+1}-${cell.y}-${cell.x}`))
  );

  const baseBoard = CUBE_DATA.map(plane => plane.map(row => row.slice()));
  const correctValues = cells.map(c=>c.correctValue);
  const idxPerms = permutations(cells.map((_,i)=>i));

  let solutionCount = 0;
  for(const perm of idxPerms){
    // trialBoard: baseBoardをコピーし、対象8セルにperm順の値を割り当てる
    const trial = baseBoard.map(plane => plane.map(row => row.slice()));
    cells.forEach((cell, i)=>{
      trial[cell.L-1][cell.r][cell.c] = correctValues[perm[i]];
    });
    let ok = true;
    for(const line of relevantLines){
      let sum = 0;
      for(const cell of line.cells) sum += trial[cell.z][cell.y][cell.x];
      if(sum !== 315){ ok = false; break; }
    }
    if(ok) solutionCount++;
  }

  return {
    solutionCount,
    permutationsChecked: idxPerms.length,
    relevantLineCount: relevantLines.length,
    isUnique: solutionCount === 1,
  };
}

module.exports = {
  N5,
  loadCubeContext,
  validateCandidateCells,
  validateInitialIsPermutationOfCorrect,
  buildBoard,
  validateBoardCompleteness,
  validateFixedCellsUnchanged,
  countPlacementStatus,
  classifyLine,
  lineSum,
  lineStatus,
  summarizeLines,
  linesThroughCell,
  perCellAbnormalLineCounts,
  swapBoard,
  analyzeSwap,
  analyzeAllSwaps,
  minSwapsFromCycles,
  minSwapsForValues,
  totalDeviation,
  exhaustiveUniqueSolutionCount,
};
