// puzzle.js — 修復型プロトタイプの「静的な1問」を定義する。
// 出題生成は行わない。座標・初期破損状態はすべてコード上に固定。
//
// 選定領域: 2x2x2ブロック (z=1..2, y=1..2, x=1..2) = ゲーム座標で L2-L3, r1-2, c1-2。
// 選定理由: この領域は空間対角線4本すべて・xz/yz(縦断面)対角線8本を含む28本のラインに
// 関与し、8!(40320通り)の全探索で「全109ラインが315に戻る配置は元の並び(恒等置換)の
// 1通りだけ」であることを確認済み(検証はtests/repair-tests.jsに実装)。
//
// 初期破損: L3層(z=2)の4マスだけを 4→5→6→7→4 の巡回でシャッフル。L2層(z=1)の4マスは
// 最初から正解(correct_unlocked_cells=4)。

const REPAIR_CELLS = [
  // idx0-3: L2層 (z=1) — 初期状態から正解
  { L:2, r:1, c:1, correctValue:64,  initialValue:64  },
  { L:2, r:1, c:2, correctValue:117, initialValue:117 },
  { L:2, r:2, c:1, correctValue:118, initialValue:118 },
  { L:2, r:2, c:2, correctValue:21,  initialValue:21  },
  // idx4-7: L3層 (z=2) — 4-cycle破損 (4→5→6→7→4)
  { L:3, r:1, c:1, correctValue:43,  initialValue:38  },
  { L:3, r:1, c:2, correctValue:38,  initialValue:68  },
  { L:3, r:2, c:1, correctValue:68,  initialValue:63  },
  { L:3, r:2, c:2, correctValue:63,  initialValue:43  },
];

function repairCellKey(L,r,c){ return `${L}-${r}-${c}`; }

function isRepairUnlocked(L,r,c){
  return REPAIR_CELLS.some(cell => cell.L===L && cell.r===r && cell.c===c);
}

function repairCellDef(L,r,c){
  return REPAIR_CELLS.find(cell => cell.L===L && cell.r===r && cell.c===c) || null;
}

// 現在の盤面値を返す: locked=CUBE_DATAの値(常に正解)、unlocked=渡されたstateの値。
// state: { [key]: currentValue } (repairCellKeyをキーとする、8エントリ)
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
