// puzzle.js — 修復型プロトタイプの「静的な1問」を定義する。
// 出題生成は行わない。座標・初期破損状態はすべてコード上に固定。
//
// Prototype 04: tools/repair/prototype04-candidate.json(seed/samples/gate情報を含む)から
// 選定した12セル候補を採用。構造gate・human_visible gate(staged path)・validation gate
// (制約付きbacktrackingで一意解)をすべて満たすことを確認済み。Prototype 03と同一の
// selection gate/comparatorをseed違いで実行して選定(Search側は変更していない)。
// 検証手順は tools/repair/prototype02-analyzer.js・search-prototype03.js、候補データ自体は
// tools/repair/prototype04-candidate.json を参照。

const REPAIR_CELLS = [
  { L:1, r:0, c:0, correctValue:25, initialValue:59 },
  { L:1, r:0, c:4, correctValue:90, initialValue:90 },
  { L:1, r:2, c:0, correctValue:42, initialValue:5 },
  { L:1, r:2, c:4, correctValue:75, initialValue:121 },
  { L:1, r:4, c:0, correctValue:67, initialValue:75 },
  { L:1, r:4, c:4, correctValue:5, initialValue:51 },
  { L:5, r:0, c:0, correctValue:121, initialValue:67 },
  { L:5, r:0, c:4, correctValue:59, initialValue:36 },
  { L:5, r:2, c:0, correctValue:51, initialValue:42 },
  { L:5, r:2, c:4, correctValue:84, initialValue:101 },
  { L:5, r:4, c:0, correctValue:36, initialValue:84 },
  { L:5, r:4, c:4, correctValue:101, initialValue:25 },
];

// Prototype 05: 固定セル(REPAIR_CELLSに含まれない113セル)のうち、数字を表示する15セル。
// 選定は tools/repair 側のread-onlyなgeometry probe(座標・109ライン所属のみ使用、
// 数字・正誤・正解交換・witnessPathは不使用)による決定論的な制約充足解(Variant C)。
// 各LEVEL 3個、LEVEL内でrow/column非重複、各LEVELで最低1個は未確定セルを含む
// active lineに所属、各active lineでrevealed-fixedは最大1・sealed-fixedは最低2を維持。
const REVEALED_FIXED_CELLS = [
  { L:1, r:0, c:1 }, { L:1, r:2, c:3 }, { L:1, r:4, c:2 },
  { L:2, r:0, c:2 }, { L:2, r:1, c:4 }, { L:2, r:2, c:1 },
  { L:3, r:0, c:2 }, { L:3, r:1, c:4 }, { L:3, r:2, c:0 },
  { L:4, r:0, c:2 }, { L:4, r:1, c:1 }, { L:4, r:3, c:3 },
  { L:5, r:0, c:3 }, { L:5, r:1, c:1 }, { L:5, r:3, c:2 },
];

function isRevealedFixed(L,r,c){
  return REVEALED_FIXED_CELLS.some(cell => cell.L===L && cell.r===r && cell.c===c);
}

// セルの表示状態を返す純粋query: 'movable' | 'revealed-fixed' | 'sealed-fixed'。
// renderBoard(repair-main.js)がこの状態を数字表示・鍵穴表示へ接続する。
// このquery自体はDOM非依存。既存のisRepairUnlocked等の意味は変更しない。
function cellPresentationState(L,r,c){
  if(isRepairUnlocked(L,r,c)) return 'movable';
  if(isRevealedFixed(L,r,c)) return 'revealed-fixed';
  return 'sealed-fixed';
}

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
