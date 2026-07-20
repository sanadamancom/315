// puzzle.js — 修復型プロトタイプの「静的な1問」を定義する。
// 出題生成は行わない。座標・初期破損状態はすべてコード上に固定。
//
// Prototype 07: tools/repair/prototype07-candidate.json(M layout ID 0808a60f /
// presentation mask ID 07b69206 / candidate ID 106b01ad)から選定した12セル候補を採用。
// 初期状態gate・確定済みmajority方式によるP2 path品質gate・109ライン一意解gateを
// すべて満たすことを tests/prototype07-candidate-tests.js で検証済み。
// 正解値(correctValue)はcandidate JSONへ保存せず、既存方式どおりCUBE_DATAから導出する。

const REPAIR_CELLS = [
  { L:2, r:0, c:2, correctValue:71, initialValue:14 },
  { L:2, r:0, c:3, correctValue:6, initialValue:112 },
  { L:2, r:4, c:2, correctValue:14, initialValue:65 },
  { L:2, r:4, c:3, correctValue:73, initialValue:55 },
  { L:3, r:0, c:1, correctValue:61, initialValue:120 },
  { L:3, r:0, c:3, correctValue:76, initialValue:61 },
  { L:3, r:4, c:1, correctValue:50, initialValue:71 },
  { L:3, r:4, c:3, correctValue:65, initialValue:50 },
  { L:4, r:0, c:1, correctValue:53, initialValue:73 },
  { L:4, r:0, c:2, correctValue:112, initialValue:6 },
  { L:4, r:4, c:1, correctValue:120, initialValue:76 },
  { L:4, r:4, c:2, correctValue:55, initialValue:53 },
];

// Prototype 07: 固定セル(REPAIR_CELLSに含まれない113セル)のうち、数字を表示する57セル
// (presentation mask ID 07b69206)。選定はread-onlyなprobe(座標・109ライン所属のみ使用、
// 数字・正誤・正解交換・witnessPathは不使用)による段階的厳密最適化で決定。
// LEVEL別M件数は4/4/4/0/0(順序非依存)。各active line(可動セルを含む109ライン)は
// revealed-fixedを最低1・sealed-fixedを最低1残し、各inactive line(固定セルのみのライン)は
// sealed-fixedを0個または2個以上にして単独差分での判明を防ぐ。各LEVELの全row・columnに
// revealed-fixedとsealed-fixedの両方が存在する。
const REVEALED_FIXED_CELLS = [
  { L:1, r:0, c:0 }, { L:1, r:0, c:3 }, { L:1, r:0, c:4 }, { L:1, r:1, c:2 },
  { L:1, r:1, c:3 }, { L:1, r:1, c:4 }, { L:1, r:2, c:1 }, { L:1, r:2, c:3 },
  { L:1, r:3, c:0 }, { L:1, r:3, c:2 }, { L:1, r:4, c:1 }, { L:1, r:4, c:4 },
  { L:2, r:0, c:1 }, { L:2, r:0, c:4 }, { L:2, r:1, c:1 }, { L:2, r:1, c:4 },
  { L:2, r:2, c:2 }, { L:2, r:2, c:3 }, { L:2, r:3, c:0 }, { L:2, r:3, c:2 },
  { L:2, r:3, c:3 }, { L:2, r:4, c:0 }, { L:2, r:4, c:1 }, { L:3, r:0, c:0 },
  { L:3, r:0, c:2 }, { L:3, r:1, c:1 }, { L:3, r:1, c:3 }, { L:3, r:2, c:0 },
  { L:3, r:2, c:1 }, { L:3, r:2, c:4 }, { L:3, r:3, c:3 }, { L:3, r:3, c:4 },
  { L:3, r:4, c:0 }, { L:3, r:4, c:2 }, { L:4, r:0, c:0 }, { L:4, r:0, c:4 },
  { L:4, r:1, c:0 }, { L:4, r:1, c:2 }, { L:4, r:1, c:3 }, { L:4, r:2, c:1 },
  { L:4, r:2, c:3 }, { L:4, r:3, c:1 }, { L:4, r:3, c:2 }, { L:4, r:4, c:3 },
  { L:4, r:4, c:4 }, { L:5, r:0, c:1 }, { L:5, r:0, c:2 }, { L:5, r:0, c:3 },
  { L:5, r:1, c:0 }, { L:5, r:1, c:1 }, { L:5, r:2, c:0 }, { L:5, r:2, c:2 },
  { L:5, r:2, c:4 }, { L:5, r:3, c:1 }, { L:5, r:3, c:4 }, { L:5, r:4, c:2 },
  { L:5, r:4, c:3 },
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
