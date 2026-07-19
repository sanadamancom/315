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

// =========================================================================
// analyzeDirectSubtraction: 「4固定＋1未確定ライン」の直接引き算による確定と、
// その伝播(wave)を検出する純粋関数。
//
// 方針:
//   - cellsはL,r,c,initialValueのみを読む。correctValueは一切参照しない
//     (存在しても無視する。渡されなくても動作は変わらない)。
//   - 未確定セルの「正解値」は、着目ライン上で他4セルがすでに既知(固定セル
//     または既に導出済みの未確定セル)であるとき、315から既知4セルの合計を
//     引くことで直接求まる。この値は盤面全体が315均衡であることのみを根拠
//     とし、正解配置を直接参照しない。
//   - 導出済みセルを既知集合へ加え、新たに解けるラインがなくなるまで
//     wave単位で繰り返す(伝播)。
//   - 同一wave内で同一セルに異なる値が導出された場合は矛盾として記録し、
//     そのセルはそのwaveでは確定させない(remainingに残す)。
//   - 導出値が未確定セル群の初期表示値プールに存在しない、または複数セルに
//     重複対応する場合も異常(contradiction)として記録するが、算術的な
//     導出そのものは無効化しない(値は確定値として採用する)。
//   - 入力(CUBE_DATA, lines, cells)は非破壊。
// =========================================================================
function coordKey(L,r,c){ return `${L}-${r}-${c}`; }

function analyzeDirectSubtraction(CUBE_DATA, lines, cells){
  const cellIndex = new Map(); // key -> cell
  for(const cell of cells) cellIndex.set(coordKey(cell.L, cell.r, cell.c), cell);

  // 未確定セル群の初期表示値プール(重複対応チェック用。correctValueは使わない)。
  const initialValuePool = cells.map(cell => cell.initialValue);

  // --- 初期: 109ラインごとの未確定セル数ヒストグラム -----------------------
  const lineUnknownCountHistogram = {};
  for(const line of lines){
    let unknownCount = 0;
    for(const cell of line.cells){
      if(cellIndex.has(coordKey(cell.z+1, cell.y, cell.x))) unknownCount++;
    }
    lineUnknownCountHistogram[unknownCount] = (lineUnknownCountHistogram[unknownCount] || 0) + 1;
  }
  const initialSingleUnknownLineCount = lineUnknownCountHistogram[1] || 0;

  // --- 伝播 ----------------------------------------------------------------
  const solvedValues = new Map(); // key(未確定セル座標) -> 導出値
  const remaining = new Set(cellIndex.keys());
  const contradictions = [];
  const waves = [];

  while(true){
    const waveCandidates = new Map(); // key -> 導出値(このwaveで初めて算出された値)

    for(const line of lines){
      let unresolvedKeys = [];
      let knownSum = 0;
      for(const cell of line.cells){
        const key = coordKey(cell.z+1, cell.y, cell.x);
        if(remaining.has(key)){
          unresolvedKeys.push(key);
        } else if(cellIndex.has(key)){
          knownSum += solvedValues.get(key);
        } else {
          knownSum += CUBE_DATA[cell.z][cell.y][cell.x];
        }
      }
      if(unresolvedKeys.length !== 1) continue;

      const key = unresolvedKeys[0];
      const derivedValue = 315 - knownSum;
      if(waveCandidates.has(key)){
        if(waveCandidates.get(key) !== derivedValue){
          contradictions.push({ key, type:'conflicting-derivation', values:[waveCandidates.get(key), derivedValue] });
        }
      } else {
        waveCandidates.set(key, derivedValue);
      }
    }

    if(waveCandidates.size === 0) break;

    // 同一wave内で矛盾したキーは、このwaveでは確定させず次waveへ持ち越す。
    const conflictedKeysThisWave = new Set(
      contradictions.filter(c => c.type==='conflicting-derivation').map(c => c.key)
    );

    const waveCells = [];
    for(const [key, value] of waveCandidates){
      if(conflictedKeysThisWave.has(key)) continue;

      const matchCount = initialValuePool.filter(v => v === value).length;
      if(matchCount === 0) contradictions.push({ key, type:'value-not-in-pool', value });
      else if(matchCount > 1) contradictions.push({ key, type:'value-multiple-matches', value, matchCount });

      const cell = cellIndex.get(key);
      waveCells.push({ L: cell.L, r: cell.r, c: cell.c, derivedValue: value });
      solvedValues.set(key, value);
      remaining.delete(key);
    }

    if(waveCells.length === 0) break; // 全候補が矛盾で確定不能 -> 停止(無限ループ防止)
    waves.push({ solvedCount: waveCells.length, cells: waveCells });
  }

  const solvedCellCount = solvedValues.size;
  const solvedRatio = cells.length > 0 ? solvedCellCount / cells.length : 0;
  const initialDirectCellCount = waves.length > 0 ? waves[0].solvedCount : 0;
  const isComplete = remaining.size === 0 && contradictions.length === 0;

  return {
    lineUnknownCountHistogram,
    initialSingleUnknownLineCount,
    initialDirectCellCount,
    waves,
    solvedCellCount,
    solvedRatio,
    isComplete,
    contradictions,
  };
}

// =========================================================================
// analyzeSignOnlyCompatibleSwaps: プレイヤーに見える情報だけで、
// 2セル交換が「改悪ラインを1本も生まず、少なくとも1本を改善する」かを判定する。
//
// 方針:
//   - 使ってよい情報: 各未確定セルの現在表示値(cell.initialValue)、各セルの所属ライン、
//     現在の異常ライン(board上のlineSum!==315)の↑/↓のみ。
//   - 使わない情報: exact deviation量(|sum-315|の値そのもの)、交換後の正確な合計、
//     correctValue、正解配置、optimal path情報。cells引数はL,r,c,initialValueのみ読み、
//     correctValueが含まれていても一切参照しない。
//   - 各ペア(i,j)について、交換後にcellIが得る値はcellJの現在表示値(逆も同様)。
//     どちらの値が大きいかという符号だけを使い、増減の大きさ(overshoot判定)は使わない。
//   - 両セルを含むライン(交換しても合計不変)は判定対象外。
//   - 現在成立している(=)ラインは判定対象外(非表示の成立ラインは使わない)。
//   - improvedLineCount/worsenedLineCountは、交換元セル(I)側・交換先セル(J)側の
//     内訳をimprovedLineCountI/J、worsenedLineCountI/Jとしても個別に返す
//     (improvedLineCount = improvedLineCountI + improvedLineCountJ、worsenedLineCountも同様)。
//     この内訳はisCompatibleの判定条件には使わない(既存の合計ベース条件のまま)。
//   - 入力(board, lines, cells)は非破壊。
// =========================================================================
function lineStatusSignOnly(board, line){
  const sum = lineSum(board, line);
  if(sum === 315) return '=';
  return sum > 315 ? 'up' : 'down';
}

function linesTouchingOnly(lines, targetCell, otherCell){
  const touching = linesThroughCell(lines, targetCell.L, targetCell.r, targetCell.c);
  return touching.filter(line => !line.cells.some(c =>
    c.z===otherCell.L-1 && c.y===otherCell.r && c.x===otherCell.c
  ));
}

function analyzeSignOnlyCompatibleSwaps(board, lines, cells){
  const pairs = allIndexPairsForCells(cells.length);

  const results = pairs.map(([i, j]) => {
    const cellI = cells[i], cellJ = cells[j];
    // delta: 交換後にcellIが得る値との差の符号のみを使う(cellIの表示値がどちらへ動くか)。
    const delta = cellJ.initialValue - cellI.initialValue;

    const onlyI = linesTouchingOnly(lines, cellI, cellJ);
    const onlyJ = linesTouchingOnly(lines, cellJ, cellI);

    let improvedLineCountI = 0, worsenedLineCountI = 0;
    let improvedLineCountJ = 0, worsenedLineCountJ = 0;

    for(const line of onlyI){
      const status = lineStatusSignOnly(board, line);
      if(status === '=') continue; // 非表示の成立ラインは判定対象外
      const requiresIncrease = status === 'down'; // ↓なら増加(delta>0)が改善方向
      const improves = requiresIncrease ? delta > 0 : delta < 0;
      if(improves) improvedLineCountI++; else worsenedLineCountI++;
    }

    for(const line of onlyJ){
      const status = lineStatusSignOnly(board, line);
      if(status === '=') continue;
      // cellJが得る変化量は -delta。↓なら増加(-delta>0 すなわち delta<0)が改善方向。
      const requiresIncrease = status === 'down';
      const improves = requiresIncrease ? delta < 0 : delta > 0;
      if(improves) improvedLineCountJ++; else worsenedLineCountJ++;
    }

    const improvedLineCount = improvedLineCountI + improvedLineCountJ;
    const worsenedLineCount = worsenedLineCountI + worsenedLineCountJ;

    const isCompatible = worsenedLineCount === 0 && improvedLineCount >= 1;
    return {
      i, j,
      improvedLineCount, worsenedLineCount,
      improvedLineCountI, improvedLineCountJ,
      worsenedLineCountI, worsenedLineCountJ,
      isCompatible,
    };
  });

  const compatibleSwaps = results.filter(r => r.isCompatible);

  return {
    totalSwapCount: pairs.length,
    compatibleSwapCount: compatibleSwaps.length,
    compatibleSwaps,
    results,
  };
}

// analyzeAllSwapsのallIndexPairs相当(analyzer.js内には未定義のため、cells長からunordered pairを生成する)。
function allIndexPairsForCells(n){
  const pairs = [];
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) pairs.push([i,j]);
  return pairs;
}

// =========================================================================
// countLineConstrainedSolutions: 制約付きbacktrackingによる一意解カウンター。
// 8セルの8!全探索(exhaustiveUniqueSolutionCount)を置き換えず、12セル等
// より大きな未確定セル数でも現実的な時間で解数(0/1/2以上)を判定できるように
// 別関数として追加する。
//
// 方針:
//   - 未確定セルの位置を変数、cells各要素のinitialValueの集合をdomainとする
//     (all-different: 各値を1回だけ使用する)。
//   - 固定値として使うCUBE_DATAは、未確定位置以外のセルのみ。未確定位置に
//     ある(=候補cellsに含まれる座標の)CUBE_DATA値は、たとえ正解値であっても
//     一切参照しない(cells引数のcorrectValueも同様に未参照)。
//   - 制約は「各ライン(未確定セルを1つ以上含むもの)の最終合計が315」のみ。
//   - 変数順序: そのラインが多く絡む(制約の多い)位置を優先する静的順序。
//   - 枝刈り: ライン内の未割当位置数に対し、残りdomain値の最小和・最大和で
//     目標値に届き得るかを判定。ラインが埋まった時点で不一致なら即枝刈り。
//   - options.maxSolutionsに達した時点で探索を打ち切る(デフォルト2)。
//   - 解の配置そのものは返さない(件数・統計のみ)。
//   - 入力(CUBE_DATA, lines, cells, options)は非破壊。
// =========================================================================
function countLineConstrainedSolutions(CUBE_DATA, lines, cells, options){
  const opts = Object.assign({ maxSolutions: 2 }, options || {});
  const maxSolutions = opts.maxSolutions;

  const n = cells.length;
  const idxOf = new Map();
  cells.forEach((cell, i) => idxOf.set(coordKey(cell.L, cell.r, cell.c), i));
  const domainValues = cells.map(cell => cell.initialValue);

  // --- 未確定セルを1つ以上含むラインだけを制約対象にする ---------------------
  const relevantLines = [];
  for(const line of lines){
    const positions = [];
    let fixedSum = 0;
    for(const cell of line.cells){
      const key = coordKey(cell.z+1, cell.y, cell.x);
      if(idxOf.has(key)) positions.push(idxOf.get(key));
      else fixedSum += CUBE_DATA[cell.z][cell.y][cell.x]; // 未確定位置以外のCUBE_DATA値のみ使用
    }
    if(positions.length > 0) relevantLines.push({ positions, target: 315 - fixedSum });
  }

  const linesByPosition = Array.from({ length: n }, () => []);
  relevantLines.forEach((rl, li) => { for(const p of rl.positions) linesByPosition[p].push(li); });

  // 制約数(所属する関連ライン数)の多い位置を優先する静的順序。
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => linesByPosition[b].length - linesByPosition[a].length);

  const assigned = new Array(n).fill(null);
  const usedValue = new Set();
  let solutionCount = 0;
  let nodesExplored = 0;
  let reachedLimit = false;

  function remainingUnusedSorted(){
    return domainValues.filter(v => !usedValue.has(v)).sort((a, b) => a - b);
  }

  function isLineConsistentPartial(rl){
    let sum = 0, unassignedCount = 0;
    for(const p of rl.positions){
      if(assigned[p] !== null) sum += assigned[p];
      else unassignedCount++;
    }
    if(unassignedCount === 0) return sum === rl.target;
    const remaining = remainingUnusedSorted();
    if(remaining.length < unassignedCount) return false;
    const minSum = sum + remaining.slice(0, unassignedCount).reduce((a, b) => a + b, 0);
    const maxSum = sum + remaining.slice(remaining.length - unassignedCount).reduce((a, b) => a + b, 0);
    return rl.target >= minSum && rl.target <= maxSum;
  }

  function dfs(depth){
    if(reachedLimit) return;
    nodesExplored++;
    if(depth === n){ solutionCount++; if(solutionCount >= maxSolutions) reachedLimit = true; return; }

    const pos = order[depth];
    for(const val of domainValues){
      if(usedValue.has(val)) continue;
      assigned[pos] = val;
      usedValue.add(val);

      let ok = true;
      for(const li of linesByPosition[pos]){
        if(!isLineConsistentPartial(relevantLines[li])){ ok = false; break; }
      }
      if(ok) dfs(depth + 1);

      usedValue.delete(val);
      assigned[pos] = null;

      if(reachedLimit) return;
    }
  }

  if(n === 0){
    return { solutionCount: 0, isUnique: false, reachedLimit: false, nodesExplored: 0 };
  }

  dfs(0);

  return {
    solutionCount,
    isUnique: solutionCount === 1 && !reachedLimit,
    reachedLimit,
    nodesExplored,
  };
}

// =========================================================================
// analyzeStrongStagedPath: strong compatible swap(analyzeSignOnlyCompatibleSwaps
// のisCompatible=trueかつ両端点(I側・J側)にminImprovedLinesPerEndpoint本以上の
// 改善根拠がある交換)だけを辿り、正解状態まで到達できるかを判定する純粋関数。
//
// 方針(player-visible判定とvalidation判定の分離):
//   - [player-visible phase] 各状態でのstrong pair抽出はanalyzeSignOnlyCompatibleSwaps
//     経由でのみ行う。これは現在表示値・所属ライン・↑↓だけを使い、exact deviation・
//     correctValue・正解配置・optimal pathを一切使わない(analyzeSignOnlyCompatibleSwaps
//     自体の契約どおり)。
//   - [validation phase] correctValueは、次の3箇所だけに限定して使用する:
//       (a) rootDistance/各状態でのdistance算出(minSwapsForValues)
//       (b) strong pairの中から「distanceを1減らす交換」をoptimalとラベル付けする
//       (c) 正解状態(distance===0)かどうかのterminal判定
//     このvalidation phaseの処理は、player-visible phaseのstrong pair抽出コードとは
//     別のステップとして呼び出し、混在させない。
//   - analyzeDirectionalEvidence/analyzeMisleadingFeedbackは使用しない。
//   - 正解状態(terminal)ではstrong pair数の範囲条件を要求しない。
//   - 同一状態(現在値の配列)をmemoizeする。distanceが単調に1ずつ減る辺だけを
//     辿るため経路上のサイクルは発生しない。
//   - pairは常にi<jの昇順で走査し、探索の分岐選択(最初に成功した子を採用)も
//     決定論的にする。同じ入力に対しては常に同じwitness pathを返す。
//   - 入力(CUBE_DATA, lines, cells, options)は非破壊。
// =========================================================================
function analyzeStrongStagedPath(CUBE_DATA, lines, cells, options){
  const opts = Object.assign({
    minStrongCompatible: 1,
    maxStrongCompatible: 3,
    minImprovedLinesPerEndpoint: 2,
  }, options || {});

  // --- validation phase専用ヘルパー(correctValueを使用してよい範囲) -----------
  const correctValues = cells.map(cell => cell.correctValue);
  function distanceOf(values){
    return minSwapsForValues(values, correctValues).minSwaps;
  }

  // --- player-visible phase専用ヘルパー(correctValueを一切渡さない) ----------
  function buildCellsForValues(values){
    return cells.map((cell, i) => ({ L: cell.L, r: cell.r, c: cell.c, initialValue: values[i] }));
  }
  function extractStrongPairs(values){
    const cellsAtState = buildCellsForValues(values); // correctValueを含めない
    const board = buildBoard(CUBE_DATA, cellsAtState);
    const signOnly = analyzeSignOnlyCompatibleSwaps(board, lines, cellsAtState);
    return signOnly.results
      .filter(r => r.isCompatible &&
        r.improvedLineCountI >= opts.minImprovedLinesPerEndpoint &&
        r.improvedLineCountJ >= opts.minImprovedLinesPerEndpoint)
      .sort((a, b) => (a.i - b.i) || (a.j - b.j)); // 決定論的な順序
  }

  const visited = new Map(); // stateKey -> { status:'success', pathLength, witnessTail } | { status:'dead', reason }
  const failureReasonCounts = {};
  let statesVisited = 0;

  function recordFailure(reason){
    failureReasonCounts[reason] = (failureReasonCounts[reason] || 0) + 1;
  }

  function dfs(values){
    statesVisited++;
    const key = values.join(',');
    if(visited.has(key)) return visited.get(key);

    // --- validation phase: terminal判定 -------------------------------------
    const dist = distanceOf(values);
    if(dist === 0){
      const res = { status: 'success', pathLength: 0, witnessTail: [] };
      visited.set(key, res);
      return res;
    }

    // --- player-visible phase: strong pair抽出 ------------------------------
    const strong = extractStrongPairs(values);
    const strongCompatibleCount = strong.length;

    if(strongCompatibleCount < opts.minStrongCompatible || strongCompatibleCount > opts.maxStrongCompatible){
      const res = { status: 'dead', reason: 'strong-out-of-range' };
      visited.set(key, res);
      recordFailure('strong-out-of-range');
      return res;
    }

    // --- validation phase: optimal strong pairのラベル付け -------------------
    const optimalStrong = [];
    for(const sw of strong){
      const nextValues = values.slice();
      const tmp = nextValues[sw.i]; nextValues[sw.i] = nextValues[sw.j]; nextValues[sw.j] = tmp;
      const nextDist = distanceOf(nextValues);
      if(nextDist === dist - 1) optimalStrong.push({ sw, nextValues, nextDist });
    }

    if(optimalStrong.length === 0){
      const res = { status: 'dead', reason: 'no-optimal-in-strong' };
      visited.set(key, res);
      recordFailure('no-optimal-in-strong');
      return res;
    }

    visited.set(key, { status: 'solving' }); // サイクル安全弁(理論上到達しない)

    let chosen = null;
    for(const cand of optimalStrong){
      const childRes = dfs(cand.nextValues);
      if(childRes.status === 'success'){ chosen = { cand, childRes }; break; } // 決定論的: 最初に成功した子を採用
    }

    let res;
    if(chosen){
      const step = {
        i: chosen.cand.sw.i, j: chosen.cand.sw.j,
        strongCompatibleCount,
        optimalStrongCount: optimalStrong.length,
        distanceBefore: dist,
        distanceAfter: chosen.cand.nextDist,
      };
      res = { status: 'success', pathLength: chosen.childRes.pathLength + 1, witnessTail: [step, ...chosen.childRes.witnessTail] };
    } else {
      res = { status: 'dead', reason: 'all-children-dead' };
      recordFailure('all-children-dead');
    }
    visited.set(key, res);
    return res;
  }

  const initialValues = cells.map(cell => cell.initialValue);
  const rootStrongCompatibleCount = extractStrongPairs(initialValues).length;
  const finalResult = dfs(initialValues);

  return {
    hasPath: finalResult.status === 'success',
    pathLength: finalResult.status === 'success' ? finalResult.pathLength : null,
    witnessPath: finalResult.status === 'success' ? finalResult.witnessTail : [],
    rootStrongCompatibleCount,
    statesVisited,
    failureReasonCounts,
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
  analyzeDirectSubtraction,
  analyzeSignOnlyCompatibleSwaps,
  countLineConstrainedSolutions,
  analyzeStrongStagedPath,
};
