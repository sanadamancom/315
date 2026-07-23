// internal/puzzle-engine.js
//
// 【internal専用】盤面の実際の状態を保持・操作する。
// このモジュールが返すオブジェクト(PuzzleEngine)への参照は、
// public-observation-adapter.js の内部にのみ保持され、
// policy層やcognitive-state層へは一切渡さない。
//
// ここでは正規CUBE_DATAとの比較、ライン合計、正確な偏差など、
// 「非公開にすべき情報」を自由に扱ってよい(ただしそれを外部へ
// 漏らすかどうかはadapter側の責務)。

'use strict';

const { CUBE_DATA, MOVABLE_RAW, buildLines109, N5 } = require('./prototype-fixture');

const MAGIC = 315;
const LARGE_THRESHOLD = 30;

function cloneBoard(b){ return b.map(l => l.map(r => r.slice())); }

function cellKey(c){ return `${c.z}-${c.y}-${c.x}`; }

function createPuzzleEngine(){
  const lines = buildLines109();
  const linesById = new Map(lines.map(l => [l.id, l]));
  const movableMap = new Map(MOVABLE_RAW.map(m => [cellKey(m.coord), m]));

  function initialBoard(){
    const b = cloneBoard(CUBE_DATA);
    for(const m of MOVABLE_RAW){ b[m.coord.z][m.coord.y][m.coord.x] = m.initial; }
    return b;
  }

  let board = initialBoard();
  let swapCount = 0;
  let probeCount = 0;
  let undoStack = [];
  let status = 'active'; // active | cleared | stuck

  function lineSum(lineId){
    const line = linesById.get(lineId);
    if(!line) throw new Error(`unknown line id: ${lineId}`);
    let s = 0;
    for(const c of line.cells) s += board[c.z][c.y][c.x];
    return s;
  }

  function lineStatus(lineId){
    const sum = lineSum(lineId);
    if(sum === MAGIC) return { status: 'equal', band: null };
    const status = sum > MAGIC ? 'up' : 'down';
    const band = Math.abs(sum - MAGIC) > LARGE_THRESHOLD ? 'large' : 'small';
    return { status, band };
  }

  function isMovable(key){ return movableMap.has(key); }

  function boardValue(z,y,x){ return board[z][y][x]; }

  function applySwap(keyA, keyB){
    if(!isMovable(keyA) || !isMovable(keyB)) throw new Error('swap対象は可動セルのみ');
    if(keyA === keyB) throw new Error('同一セルはswapできない');
    const [za,ya,xa] = keyA.split('-').map(Number);
    const [zb,yb,xb] = keyB.split('-').map(Number);
    undoStack.push({ board: cloneBoard(board), swapCount, probeCount });
    const tmp = board[za][ya][xa];
    board[za][ya][xa] = board[zb][yb][xb];
    board[zb][yb][xb] = tmp;
    swapCount++;
    checkCompletion();
  }

  function registerProbe(){
    probeCount++;
  }

  function checkCompletion(){
    let allMatch = true;
    outer:
    for(let z=0; z<N5; z++) for(let y=0; y<N5; y++) for(let x=0; x<N5; x++){
      if(board[z][y][x] !== CUBE_DATA[z][y][x]){ allMatch = false; break outer; }
    }
    if(allMatch) status = 'cleared';
  }

  function canUndo(){ return undoStack.length > 0 && status === 'active'; }

  function applyUndo(){
    if(!canUndo()) throw new Error('undo不可');
    const prev = undoStack.pop();
    board = prev.board;
    // swapCount/probeCountはいずれも払い戻さない(累積の認知消費として扱う)。
    // Undoは盤面の状態だけを1手前へ戻す操作であり、
    // 「そのswapを実行した」という事実そのものは取り消さない。
  }

  function declareStuck(){
    status = 'stuck';
  }

  function boardStateHash(){
    // ループ検知用の内部ハッシュ(公開しない、内容そのものも外部へは渡さない)
    return board.flat(2).join(',');
  }

  return {
    lines,
    linesById,
    movableMap,
    isMovable,
    boardValue,
    lineSum,        // internal専用: adapterはこれを呼び出さない
    lineStatus,      // adapterが呼び出してよい(合計は含まない)
    applySwap,
    registerProbe,
    canUndo,
    applyUndo,
    declareStuck,
    boardStateHash,  // internal専用
    getSwapCount: () => swapCount,
    getProbeCount: () => probeCount,
    getStatus: () => status,
  };
}

module.exports = { createPuzzleEngine, cellKey };
