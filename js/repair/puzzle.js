// puzzle.js — 修復型プロトタイプの「静的な1問」を定義する。
// 出題生成は行わない。座標・初期破損状態はすべてコード上に固定。
//
// Prototype 03: tools/repair/prototype03-candidate.json(seed/samples/gate情報を含む)から
// 選定した12セル候補を採用。座標は中心対称な軸部分集合(サイズ2または3)の2×2×3直積構造。
// 構造gate(未確定セル数12、未確定1件ラインが0本、直接引き算で確定不能、正しい位置1件以上、
// 誤配置複数LEVEL分散、↑↓両存在、階層内外異常両存在)、human_visible gate(strong compatible
// swapだけを辿るstaged pathが存在し、rootのstrong compatible数が1〜3、交換手数が7または8)、
// validation gate(制約付きbacktrackingで一意解)をすべて満たすことを確認済み。
// 検証手順は tools/repair/prototype02-analyzer.js・search-prototype03.js、候補データ自体は
// tools/repair/prototype03-candidate.json を参照。

const REPAIR_CELLS = [
  { L:1, r:0, c:0, correctValue:25, initialValue:121 },
  { L:1, r:0, c:4, correctValue:90, initialValue:86 },
  { L:1, r:4, c:0, correctValue:67, initialValue:101 },
  { L:1, r:4, c:4, correctValue:5, initialValue:36 },
  { L:3, r:0, c:0, correctValue:47, initialValue:47 },
  { L:3, r:0, c:4, correctValue:86, initialValue:79 },
  { L:3, r:4, c:0, correctValue:40, initialValue:67 },
  { L:3, r:4, c:4, correctValue:79, initialValue:90 },
  { L:5, r:0, c:0, correctValue:121, initialValue:5 },
  { L:5, r:0, c:4, correctValue:59, initialValue:59 },
  { L:5, r:4, c:0, correctValue:36, initialValue:25 },
  { L:5, r:4, c:4, correctValue:101, initialValue:40 },
];

function repairCellKey(L,r,c){ return `${L}-${r}-${c}`; }

function isRepairUnlocked(L,r,c){
  return REPAIR_CELLS.some(cell => cell.L===L && cell.r===r && cell.c===c);
}

function repairCellDef(L,r,c){
  return REPAIR_CELLS.find(cell => cell.L===L && cell.r===r && cell.c===c) || null;
}

// 現在の盤面値を返す: locked=CUBE_DATAの値(常に正解)、unlocked=渡されたstateの値。
// state: { [key]: currentValue } (repairCellKeyをキーとする、12エントリ)
function repairGridValue(state, L, r, c){
  const def = repairCellDef(L,r,c);
  if(def) return state[repairCellKey(L,r,c)];
  return CUBE_DATA[L-1][r][c];
}

function createInitialRepairState(){
  const state = {};
  for(const cell of REPAIR_CELLS) state[repairCellKey(cell.L,cell.r,cell.c)] = cell.initialValue;
  return state;
}

// 未確定セル2個の値を交換する。固定セルが混ざっていたら何もしない(呼び出し側でも弾く想定)。
function swapRepairCells(state, a, b){
  if(!isRepairUnlocked(a.L,a.r,a.c) || !isRepairUnlocked(b.L,b.r,b.c)) return state;
  const ka = repairCellKey(a.L,a.r,a.c), kb = repairCellKey(b.L,b.r,b.c);
  if(ka === kb) return state;
  const next = Object.assign({}, state);
  const tmp = next[ka]; next[ka] = next[kb]; next[kb] = tmp;
  return next;
}

function isRepairSolved(state){
  return REPAIR_CELLS.every(cell => state[repairCellKey(cell.L,cell.r,cell.c)] === cell.correctValue);
}
