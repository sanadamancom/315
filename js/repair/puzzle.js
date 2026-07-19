// puzzle.js — 修復型プロトタイプの「静的な1問」を定義する。
// 出題生成は行わない。座標・初期破損状態はすべてコード上に固定。
//
// Prototype 02: tools/repair/prototype02-candidate.json(seed/samples/gate情報を含む)から
// 選定した8セル候補を採用。座標は分散配置(隣接・2x2x2ブロックへの限定なし)。
// hard filter(座標・値の妥当性、正しい位置2以上、誤配置3LEVEL以上、最短交換数4以上)、
// provisional gate(↑↓両存在、階層内外異常両存在、方向的根拠等)、複合推理gate(交差戦略の
// 単純解を防ぐ条件)をすべて満たし、8!(40320通り)全探索で一意解であることを確認済み。
// 検証手順は tools/repair/prototype02-analyzer.js・prototype02-quality.js・
// search-prototype02.js、および候補データ自体は tools/repair/prototype02-candidate.json を参照。

const REPAIR_CELLS = [
  { L:1, r:2, c:0, correctValue:42,  initialValue:108 },
  { L:3, r:2, c:2, correctValue:63,  initialValue:63  },
  { L:4, r:2, c:4, correctValue:96,  initialValue:56  },
  { L:4, r:3, c:4, correctValue:74,  initialValue:74  },
  { L:4, r:4, c:0, correctValue:56,  initialValue:96  },
  { L:5, r:0, c:1, correctValue:108, initialValue:122 },
  { L:5, r:1, c:2, correctValue:122, initialValue:46  },
  { L:5, r:4, c:2, correctValue:46,  initialValue:42  },
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
