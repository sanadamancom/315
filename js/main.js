// main.js — state, user interaction, and the newer features
// (difficulty presets, display toggles, assist button, X share).
// Depends on generator.js and render.js being loaded first.

let SOLUTION = null;
let given = {};             // given[L][r][c] = true/false (fixed starting cells)
let grid = {};               // grid[L][r][c] = value or null
let allPlayableValues = [];  // every value that is NOT a given/fixed cell, always shown in the pool
let tentative = {};          // tentative[L][r][c] = true/false -- "maybe this, not confirmed" marker (right-click, like Minesweeper flags)
// which difficulty mode is active: a DIFFICULTY_PRESETS key.
// Label AND generation constraints are both derived from this single value, so the
// clear-screen label can never disagree with what the menu shows.
let currentMode = 'normal';
let generating = false;           // true while async puzzle generation is running
let currentNoGuarantee = false;   // 現在の問題が「論理推理だけでは解き切れない」場合true (バッジ表示用)

let selected = null;         // a pool value chosen first, awaiting a cell click
let typingBuffer = '';       // keyboard digit-entry buffer for the currently selected cell
let selectedCell = null;     // an empty cell chosen first ({L,r,c}), awaiting a pool click
let selectedDepth = null;    // {r,c} highlighted via the stack's top-tier depth cells
let selectedTriag = null;    // 'mm'|'ma'|'am'|'aa' -- selected space diagonal (stack badge click)

// display toggles (used by render.js's composeEdgeLabelText)
let labelMode = 'sum';   // 'sum' | 'remaining' | 'fillcount' | 'off' -- mutually exclusive

let startTime = null;         // timestamp when the current puzzle was generated
let clearedSeconds = null;    // time of the FIRST successful clear this puzzle; frozen after that
let isSurrender = false;      // true if the current clear was reached via the surrender button
let currentDifficultyLabel = 'ふつう'; // for the clear screen: which preset is active

let history = [];    // array of grid snapshots (deep copies); index 0 = initial state
let historyIndex = -1;
const MAX_HISTORY = 50;

function snapshotGrid(){
  // NOTE: tentative(仮置きフラグ)も一緒に保存しないと、Undo後に「空マスなのに
  // 仮置きスタイルが残る」表示バグが起きる。必ず grid とセットでスナップショットする。
  const snap = { grid:{}, tentative:{} };
  for(let L=1; L<=LEVELS; L++){
    snap.grid[L] = grid[L].map(row => row.slice());
    snap.tentative[L] = tentative[L]
      ? tentative[L].map(row => row.slice())
      : Array.from({length:N},()=>Array(N).fill(false));
  }
  return snap;
}

function resetHistory(){
  history = [snapshotGrid()];
  historyIndex = 0;
  updateUndoRedoButtons();
}

// call after any grid-mutating action (placing/removing a number, assist, surrender, etc.)
function pushHistory(){
  // if we'd previously undone some steps, branching now discards that "future"
  if(historyIndex < history.length - 1){
    history = history.slice(0, historyIndex + 1);
  }
  history.push(snapshotGrid());
  if(history.length > MAX_HISTORY){
    history.shift();
  } else {
    historyIndex++;
  }
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function restoreSnapshot(snap){
  for(let L=1; L<=LEVELS; L++){
    grid[L] = snap.grid[L].map(row => row.slice());
    tentative[L] = snap.tentative[L].map(row => row.slice());
  }
}

function undo(){
  if(guardCleared()) return;
  if(historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(history[historyIndex]);
  selected = null; selectedCell = null;
  renderAll();
  updateUndoRedoButtons();
}

function redo(){
  if(guardCleared()) return;
  if(historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreSnapshot(history[historyIndex]);
  selected = null; selectedCell = null;
  renderAll();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons(){
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if(undoBtn) undoBtn.disabled = historyIndex <= 0;
  if(redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
}

function hintCountsVal(){
  const out = {};
  for(let L=1; L<=LEVELS; L++){
    const v = parseInt(document.getElementById(`hint-${L}`).value,10);
    // 6〜25。11未満は「論理保証なし」枠として許可される
    // (ソルバ検証をスキップして即出題し、仮置きによる仮説検証を前提とする)。
    out[L] = isNaN(v) ? 16 : Math.max(6, Math.min(25, v));
  }
  return out;
}

// true if the player has placed at least one (non-fixed) number on the board
function hasAnyPlayerAnswers(){
  if(!grid || !given) return false;
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(!given[L][r][c] && grid[L][r][c] !== null) return true;
      }
    }
  }
  return false;
}

function applyDifficultyPreset(name){
  if(generating) return; // 生成中の切替はハイライトと実際の問題の食い違いを生むため無視
  const preset = DIFFICULTY_PRESETS[name];
  if(!preset) return;
  currentMode = name;
  for(let L=1; L<=LEVELS; L++){
    document.getElementById(`hint-${L}`).value = preset.perLevel[L-1];
  }
  setActiveDiffButton(`.diff-btn[data-diff="${name}"]`);
  if(!hasAnyPlayerAnswers()){
    newPuzzle();
  } else {
    showToast('初期配置の数を変更しました。「新しい問題」を押すと反映されます。', 'info');
  }
}

function setActiveDiffButton(selector){
  document.querySelectorAll('.diff-btn').forEach(b=> b.classList.remove('active'));
  const el = document.querySelector(selector);
  if(el) el.classList.add('active');
}

// single source of truth: label + generation constraints per mode.
function modeConstraints(hc){
  const p = DIFFICULTY_PRESETS[currentMode] || DIFFICULTY_PRESETS.normal;
  return { label:p.label, genuine:p.genuine2Blank, minPairRounds:p.minPairRounds||0, noGuarantee:!!p.noGuarantee };
}

// Simulates the same deduction logic as assistFill() on a throwaway copy of the grid
// and returns HOW MANY cells remain unfilled. 0 = fully solvable by pure deduction.
// With include2Blank=false the return value is the number of cells that 1-blank
// subtraction alone cannot reach -- our measurable "pair reasoning workload" metric.
function solveResidue(SOL, giv, include2Blank){
  if(include2Blank === undefined) include2Blank = true;
  const tempGrid = {};
  const played = [];
  for(let L=1; L<=LEVELS; L++){
    tempGrid[L] = Array.from({length:N},()=>Array(N).fill(null));
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(giv[L][r][c]){ tempGrid[L][r][c] = SOL[L][r][c]; }
        else { played.push(SOL[L][r][c]); }
      }
    }
  }
  let progress = true;
  while(progress){
    progress = false;
    const confirmed = findConfirmedPlacements(tempGrid, giv, played, N, LEVELS, TARGET, include2Blank);
    for(const { L, r, c, value } of confirmed){
      if(tempGrid[L][r][c] !== null) continue;
      let usedElsewhere = false;
      for(let LL=1; LL<=LEVELS && !usedElsewhere; LL++) for(let rr=0;rr<N && !usedElsewhere;rr++) for(let cc=0;cc<N;cc++)
        if(!giv[LL][rr][cc] && tempGrid[LL][rr][cc]===value){ usedElsewhere = true; break; }
      if(usedElsewhere) continue;
      tempGrid[L][r][c] = value;
      progress = true;
    }
  }
  let remaining = 0;
  for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++)
    if(tempGrid[L][r][c] === null) remaining++;
  return remaining;
}

// 実際に解くのに必要な「独立した2マス推理の発動回数」を数える。
// 残数(solveResidue)だけでは、1回のペア推理が連鎖的に大半を解いてしまう
// ケースを区別できず、体感難度を正しく表せない(実測: 残数30以上でも
// 発動回数はわずか1〜3回のことがある)。生成時の受理条件はこちらを使う。
function countPairRounds(SOL, giv){
  const g = {}; const played = [];
  for(let L=1; L<=LEVELS; L++){
    g[L] = Array.from({length:N},()=>Array(N).fill(null));
    for(let r=0;r<N;r++) for(let c=0;c<N;c++){
      if(giv[L][r][c]) g[L][r][c] = SOL[L][r][c]; else played.push(SOL[L][r][c]);
    }
  }
  const saturate1Blank = ()=>{
    let progress = true;
    while(progress){
      progress = false;
      const confirmed = findConfirmedPlacements(g, giv, played, N, LEVELS, TARGET, false);
      for(const {L,r,c,value} of confirmed){
        if(g[L][r][c] !== null) continue;
        let used = false;
        for(let LL=1; LL<=LEVELS && !used; LL++) for(let rr=0;rr<N && !used;rr++) for(let cc=0;cc<N;cc++)
          if(!giv[LL][rr][cc] && g[LL][rr][cc]===value){ used = true; break; }
        if(used) continue;
        g[L][r][c] = value; progress = true;
      }
    }
  };
  let rounds = 0;
  while(true){
    saturate1Blank();
    let remaining = 0;
    for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++) if(g[L][r][c]===null) remaining++;
    if(remaining === 0) return { solved:true, rounds };
    const confirmed2 = findConfirmedPlacements(g, giv, played, N, LEVELS, TARGET, true);
    let placedThisRound = 0;
    for(const {L,r,c,value} of confirmed2){
      if(g[L][r][c] !== null) continue;
      let used = false;
      for(let LL=1; LL<=LEVELS && !used; LL++) for(let rr=0;rr<N && !used;rr++) for(let cc=0;cc<N;cc++)
        if(!giv[LL][rr][cc] && g[LL][rr][cc]===value){ used = true; break; }
      if(used) continue;
      g[L][r][c] = value; placedThisRound++;
    }
    if(placedThisRound === 0) return { solved:false, rounds };
    rounds++;
  }
}

// 実測(ふつう~とても難しい)で平均attempt数は15~145程度だが裾が長く、
// 300では稀に(数%)上限に達し不完全な問題が出ることがあったため1000に引き上げ。
// cap=1000で40回試行して上限到達0件、最大実測877msと許容範囲。
const MAX_GEN_ATTEMPTS = 1000;

function newPuzzle(){
  if(generating) return;
  const hc = hintCountsVal();
  const cons = modeConstraints(hc);
  currentDifficultyLabel = cons.label;

  generating = true;
  showGenLoading(true, 0);

  let attempt = 0;
  let generationOK = false;

  const tryOne = ()=>{
    attempt++;
    SOLUTION = generateSolution();
    given = {};
    for(let L=1; L<=LEVELS; L++){
      given[L] = Array.from({length:N},()=>Array(N).fill(false));
      const positions = [];
      for(let r=0;r<N;r++) for(let c=0;c<N;c++) positions.push([r,c]);
      const emptyPositions = shuffled(positions).slice(0, N*N - hc[L]);
      const emptySet = new Set(emptyPositions.map(([r,c])=>`${r},${c}`));
      for(let r=0;r<N;r++){
        for(let c=0;c<N;c++){
          if(!emptySet.has(`${r},${c}`)) given[L][r][c] = true;
        }
      }
    }
    // must be solvable by pure logical deduction (1-blank + 2-blank combined) AND
    // require at least minPairRounds INDEPENDENT rounds of 2-blank reasoning to reach
    // the solution -- a single residual-cell count was a poor proxy (one lucky pair
    // deduction could cascade and solve most of the board via 1-blank afterward).
    if(cons.noGuarantee){
      return true;
    }
    const base = countPairRounds(SOLUTION, given);
    if(!base.solved) return false;
    const baseOk = (!cons.genuine || base.rounds > 0) && base.rounds >= cons.minPairRounds;
    return baseOk;
  };

  // run generation in <=40ms slices so the browser can keep painting the spinner
  const step = ()=>{
    try{
      const t0 = Date.now();
      while(Date.now() - t0 < 40){
        if(tryOne()){ generationOK = true; break; }
        if(attempt >= MAX_GEN_ATTEMPTS) break;
      }
      if(generationOK || attempt >= MAX_GEN_ATTEMPTS){
        finishNewPuzzle(generationOK, cons);
      } else {
        showGenLoading(true, attempt);
        setTimeout(step, 0);
      }
    } catch(err){
      // 例外でローディングが永久に残る(以後「新しい問題」不能になる)ソフトロックを防ぐ
      console.error('puzzle generation failed:', err);
      showGenLoading(false);
      generating = false;
      showToast('問題の生成中にエラーが発生しました。もう一度お試しください。', 'fail');
    }
  };
  setTimeout(step, 0);
}

function finishNewPuzzle(generationOK, cons){
  grid = {}; tentative = {};
  allPlayableValues = [];
  for(let L=1; L<=LEVELS; L++){
    grid[L] = Array.from({length:N},()=>Array(N).fill(null));
    tentative[L] = Array.from({length:N},()=>Array(N).fill(false));
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(given[L][r][c]){ grid[L][r][c] = SOLUTION[L][r][c]; }
        else { allPlayableValues.push(SOLUTION[L][r][c]); }
      }
    }
  }
  allPlayableValues.sort((a,b)=>a-b);
  selected = null; selectedCell = null; selectedDepth = null; selectedTriag = null; typingBuffer = '';
  startTime = Date.now();
  clearedSeconds = null;
  isSurrender = false;
  resetHistory();
  // a leftover ?s= would win over the auto-save on reload; remove it
  try{
    const url = new URL(window.location.href);
    if(url.searchParams.has('s')){
      url.searchParams.delete('s');
      window.history.replaceState(null, '', url.toString());
    }
  }catch(err){}
  if(cons && cons.noGuarantee){
    showToast('論理保証なしの問題です。推理だけでは確定しないマスが残り得ます。仮説→仮置き→検証で突き崩してください。', 'info');
  } else if(generationOK){
    showToast('新しい配分が生成されました。白のマスは固定です。', 'info');
  } else {
    showToast('この設定では論理だけで解ける問題を作れませんでした。そのまま出題しますが、推理では確定しないマスが残る可能性があります。', 'fail');
  }
  // 実測ベースの正直なフラグ: 保証ありティアでは構成上必ずfalseになる
  currentNoGuarantee = solveResidue(SOLUTION, given, true) !== 0;
  updateTimerBadge();
  buildCube();
  refreshStackModal();
  renderAll();
  syncBoardZoomSize();
  showGenLoading(false);
  generating = false;
}

function showGenLoading(on, attempt){
  const el = document.getElementById('genLoading');
  if(!el) return;
  el.style.display = on ? 'flex' : 'none';
  if(on){
    const t = document.getElementById('genLoadingText');
    if(t) t.textContent = (attempt && attempt > 30) ? `問題を生成中… (試行 ${attempt}回)` : '問題を生成中…';
  }
}

// exposed for automated tests (let変数はwindowプロパティにならないため)
function isGenerating(){ return generating; }
function getCurrentMode(){ return currentMode; }

function restartSamePuzzle(){
  for(let L=1; L<=LEVELS; L++){
    grid[L] = Array.from({length:N},()=>Array(N).fill(null));
    tentative[L] = Array.from({length:N},()=>Array(N).fill(false));
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(given[L][r][c]){ grid[L][r][c] = SOLUTION[L][r][c]; }
      }
    }
  }
  selected = null; selectedCell = null; selectedDepth = null; selectedTriag = null;
  startTime = Date.now();
  clearedSeconds = null;
  isSurrender = false;
  resetHistory();
  showToast('固定マス以外をリセットしました。', 'info');
  updateTimerBadge();
  renderAll();
}

// find where a (non-given) value currently sits on the board, if placed
function findPlacement(value){
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(!given[L][r][c] && grid[L][r][c] === value) return {L,r,c};
      }
    }
  }
  return null;
}

// ---- interaction: works in either order (number-first or cell-first) ----

function isBoardFull(){
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(grid[L][r][c] === null) return false;
      }
    }
  }
  return true;
}

function onCellClick(L,r,c){
  if(guardCleared()) return;

  // a keyboard entry in progress is CONFIRMED by ANY cell click (given cells too):
  // clicking the same cell commits it there and stops; clicking another cell
  // commits it to the originally selected cell first, then the click continues.
  if(typingBuffer && selectedCell){
    const sameCell = selectedCell.L===L && selectedCell.r===r && selectedCell.c===c;
    commitTypedValue();
    if(sameCell || given[L][r][c]) return;
  }
  if(given[L][r][c]) return; // fixed, cannot modify
  typingBuffer = '';
  const current = grid[L][r][c];

  if(current !== null){
    // occupied non-given cell: clicking it always picks the number back up
    grid[L][r][c] = null;
    tentative[L][r][c] = false;
    selectedCell = null;
    pushHistory();
    renderAll();
    return;
  }

  if(selected !== null){
    // a number was chosen first -> place it here
    grid[L][r][c] = selected;
    tentative[L][r][c] = false;
    selected = null; selectedCell = null;
    pushHistory();
  } else {
    // no number chosen yet -> select this empty cell, waiting for a number click
    selectedCell = (selectedCell && selectedCell.L===L && selectedCell.r===r && selectedCell.c===c)
      ? null : {L,r,c};
  }
  renderAll();
  if(isBoardFull()) checkAnswer();
}

function onChipClick(value){
  if(guardCleared()) return;
  typingBuffer = '';
  const placement = findPlacement(value);
  if(placement){
    // already on the board: clicking it again picks it back up into the pool
    grid[placement.L][placement.r][placement.c] = null;
    tentative[placement.L][placement.r][placement.c] = false;
    if(selected === value) selected = null;
    pushHistory();
    renderAll();
    // どのマスから回収したかを一瞬フラッシュして知らせる
    const el = document.querySelector(`.iso-cell[data-l="${placement.L}"][data-r="${placement.r}"][data-c="${placement.c}"]`);
    if(el){
      el.classList.add('locate-flash');
      setTimeout(()=> el.classList.remove('locate-flash'), 900);
    }
    return;
  }
  if(selectedCell !== null){
    // a cell was chosen first -> place this number there
    grid[selectedCell.L][selectedCell.r][selectedCell.c] = value;
    tentative[selectedCell.L][selectedCell.r][selectedCell.c] = false;
    selectedCell = null; selected = null;
    pushHistory();
  } else {
    selected = (selected === value) ? null : value;
  }
  renderAll();
  if(isBoardFull()) checkAnswer();
}

// right-click on a filled (non-given) cell toggles a "maybe this, not confirmed"
// marker -- like a Minesweeper flag, purely visual, doesn't affect the pool or checking.
function onCellRightClick(L,r,c){
  if(guardCleared()) return;
  if(given[L][r][c]) return;
  if(grid[L][r][c] === null) return;
  tentative[L][r][c] = !tentative[L][r][c];
  pushHistory();
  renderAll();
}

// クリア後は盤面を編集不可にする (編集を許すとクリア状態・タイマー・セーブの
// 整合が壊れる: 例) クリア後Undo→リロードで「不完全盤面なのにクリア済み」になる)
function guardCleared(){
  if(clearedSeconds === null) return false;
  showToast('クリア済みの盤面です。「やり直す」または「新しい問題」からどうぞ。', 'info');
  return true;
}

function onTriagClick(id){
  selectedTriag = (selectedTriag === id) ? null : id;
  selectedDepth = null; // 縦列選択とは排他
  renderAll();
}

function onDepthClick(r,c){
  selectedTriag = null; // 対角線選択とは排他
  if(selectedDepth && selectedDepth.r===r && selectedDepth.c===c){ selectedDepth = null; }
  else { selectedDepth = {r,c}; }
  renderAll();
}

// ---- assist button: fill in every cell that can be determined with certainty ----
// (any line with exactly one blank cell has a fixed required value; if that value
// is still available in the pool, place it there. Repeat until no more progress.)
function assistFill(){
  if(guardCleared()) return;
  // one pass only: fill whatever is determinable RIGHT NOW via 1-blank direct
  // subtraction. (2-blank pair reasoning is deliberately EXCLUDED here -- include2Blank
  // is false -- so that on 普通以上 the player still has real deduction left to do.)
  // Clicking again re-scans for a fresh round.
  const confirmed = findConfirmedPlacements(grid, given, allPlayableValues, N, LEVELS, TARGET, false);
  let placedAny = false;
  for(const { L, r, c, value } of confirmed){
    if(grid[L][r][c] !== null) continue; // already filled by an earlier item in this same batch
    if(findPlacement(value)) continue;   // value got claimed by an earlier item in this same batch
    grid[L][r][c] = value;
    placedAny = true;
  }
  showToast(
    placedAny ? '確定できるマスを自動で埋めました。' : '今の状態では確定できるマスが見つかりませんでした。',
    placedAny ? 'info' : 'fail'
  );
  if(placedAny) pushHistory();
  renderAll();
  if(isBoardFull()) checkAnswer();
}

// ---- surrender: fill in the entire solution (debug / give-up button) ----
// ---- save/restore state via a URL parameter (?s=...), since localStorage isn't available here ----
// ---- compact binary state codec ("v2." prefix + base64url) ----
// Layout: [125 solution bytes][16 given-bitmask bytes][1 byte per NON-given cell:
// its current grid value or 0][16 tentative-bitmask bytes][4 elapsed-seconds bytes].
// Roughly 80% shorter than the legacy comma-separated format, which is still
// decodable for old shared URLs and old saves.
function bytesToB64url(bytes){
  let bin = '';
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlToBytes(s){
  let b64 = s.replace(/-/g,'+').replace(/_/g,'/');
  while(b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

// includeProgress=false -> encode the puzzle as freshly generated (no player answers,
// no tentative marks, timer at 0). Used by the "この問題を最初から共有" button.
function encodeCurrentState(includeProgress){
  if(includeProgress === undefined) includeProgress = true;
  const bytes = [];
  const givBits = new Uint8Array(16);
  const tentBits = new Uint8Array(16);
  const gridBytes = [];
  let idx = 0;
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        bytes.push(SOLUTION[L][r][c]); // bytes[0..124] = solution
        if(given[L][r][c]){
          givBits[idx>>3] |= (1 << (idx & 7));
        } else {
          const v = (includeProgress && grid[L][r][c] !== null) ? grid[L][r][c] : 0;
          gridBytes.push(v);
        }
        if(includeProgress && tentative[L] && tentative[L][r][c]) tentBits[idx>>3] |= (1 << (idx & 7));
        idx++;
      }
    }
  }
  const rawElapsed = clearedSeconds !== null
    ? clearedSeconds
    : (startTime ? Math.floor((Date.now()-startTime)/1000) : 0);
  const e = includeProgress ? Math.max(0, Math.min(0xFFFFFFFF, rawElapsed)) : 0;
  for(let i=0;i<16;i++) bytes.push(givBits[i]);
  for(let i=0;i<gridBytes.length;i++) bytes.push(gridBytes[i]);
  for(let i=0;i<16;i++) bytes.push(tentBits[i]);
  bytes.push((e>>>24)&255, (e>>>16)&255, (e>>>8)&255, e&255);
  return 'v2.' + bytesToB64url(bytes);
}

function buildShareURL(includeProgress){
  const url = new URL(window.location.href);
  url.searchParams.set('s', encodeCurrentState(includeProgress));
  return url.toString();
}

function copyShareURL(finalURL, okMessage){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(finalURL)
      .then(()=> showToast(okMessage, 'info'))
      .catch(()=>{
        window.history.replaceState(null, '', finalURL);
        showToast('自動コピーできなかったため、アドレスバーのURLを共有してください。', 'info');
      });
  } else {
    window.history.replaceState(null, '', finalURL);
    showToast('アドレスバーのURLを共有してください。', 'info');
  }
}

function shareCurrentStateURL(){
  copyShareURL(buildShareURL(true), '今の状態の共有URLをコピーしました。');
}

// share the puzzle exactly as generated: given cells only, no answers, timer at 0
function shareProblemURL(){
  copyShareURL(buildShareURL(false), 'この問題を最初から遊べる共有URLをコピーしました。');
}

// shared decoder used by both URL restore and localStorage restore.
// Validates that the encoded solution really is a permutation of 1..125, so a
// corrupted or tampered payload can never produce a broken board.
function applyStateString(s){
  try{
    let solArr, givArr, gridArr, tentArr, elapsedSeconds;

    if(s.indexOf('v3.') === 0 || s.indexOf('v2.') === 0){
      // v3は大小ヒント機能があった頃の旧フォーマット。ヒント部分は読み飛ばして復元する。
      const p = b64urlToBytes(s.slice(3));
      if(p.length < 125 + 16 + 16 + 4) return false;
      solArr = Array.prototype.slice.call(p, 0, 125);
      givArr = [];
      for(let i=0;i<125;i++) givArr.push((p[125 + (i>>3)] >> (i & 7)) & 1);
      const nonGiven = givArr.reduce((a,g)=> a + (g === 0 ? 1 : 0), 0);
      if(p.length < 125 + 16 + nonGiven + 16 + 4) return false; // v3の旧データは末尾に大小ヒントバイトが付くため以上判定
      gridArr = [];
      let gp = 125 + 16;
      for(let i=0;i<125;i++){
        if(givArr[i] === 1) gridArr.push(solArr[i]);
        else gridArr.push(p[gp++]);
      }
      tentArr = [];
      for(let i=0;i<125;i++) tentArr.push((p[gp + (i>>3)] >> (i & 7)) & 1);
      const ep = gp + 16;
      elapsedSeconds = ((p[ep]<<24) | (p[ep+1]<<16) | (p[ep+2]<<8) | p[ep+3]) >>> 0;
    } else {
      // legacy comma-separated format (old shared URLs and old saves)
      const decoded = atob(s);
      const parts = decoded.split(';');
      if(parts.length !== 3 && parts.length !== 5) return false;
      solArr = parts[0].split(',').map(Number);
      givArr = parts[1].split(',').map(Number);
      gridArr = parts[2].split(',').map(Number);
      tentArr = parts.length === 5 ? parts[3].split(',').map(Number) : new Array(125).fill(0);
      elapsedSeconds = parts.length === 5 ? parseInt(parts[4], 10) || 0 : 0;
      if(solArr.length !== 125 || givArr.length !== 125 || gridArr.length !== 125 || tentArr.length !== 125) return false;
      if(solArr.some(isNaN) || givArr.some(isNaN) || gridArr.some(isNaN)) return false;
    }

    const sortedSol = [...solArr].sort((a,b)=>a-b);
    for(let i=0;i<125;i++) if(sortedSol[i] !== i+1) return false;
    if(gridArr.some(v => v < 0 || v > 125)) return false;
    // ルール改定(空間対角線も315必須)以前に生成された解は、新ルールでは
    // クリア不能な問題になるため復元を拒否し、新しい問題を出し直す。
    const at = (i)=> solArr[i];
    const triIdx = [
      [0,1,2,3,4].map(t=> t*25 + t*5 + t),
      [0,1,2,3,4].map(t=> t*25 + t*5 + (4-t)),
      [0,1,2,3,4].map(t=> t*25 + (4-t)*5 + t),
      [0,1,2,3,4].map(t=> t*25 + (4-t)*5 + (4-t)),
    ];
    for(const idxs of triIdx){
      if(idxs.reduce((s,i)=> s + at(i), 0) !== 315) return false;
    }

    SOLUTION = {}; given = {}; grid = {}; tentative = {}; allPlayableValues = [];
    let idx = 0;
    for(let L=1; L<=LEVELS; L++){
      SOLUTION[L] = Array.from({length:N},()=>Array(N).fill(0));
      given[L] = Array.from({length:N},()=>Array(N).fill(false));
      grid[L] = Array.from({length:N},()=>Array(N).fill(null));
      tentative[L] = Array.from({length:N},()=>Array(N).fill(false));
      for(let r=0;r<N;r++){
        for(let c=0;c<N;c++){
          SOLUTION[L][r][c] = solArr[idx];
          given[L][r][c] = givArr[idx] === 1;
          grid[L][r][c] = gridArr[idx] === 0 ? null : gridArr[idx];
          if(given[L][r][c]) grid[L][r][c] = SOLUTION[L][r][c]; // given cells always show the solution value
          tentative[L][r][c] = tentArr[idx] === 1;
          if(!given[L][r][c]) allPlayableValues.push(SOLUTION[L][r][c]);
          idx++;
        }
      }
    }
    allPlayableValues.sort((a,b)=>a-b);
    currentNoGuarantee = solveResidue(SOLUTION, given, true) !== 0; // 復元時も再計算
    selected = null; selectedCell = null; selectedDepth = null; selectedTriag = null; typingBuffer = '';
    startTime = Date.now() - elapsedSeconds*1000; // resume the timer from where it was
    clearedSeconds = null; isSurrender = false;
    resetHistory();
    buildCube();
    refreshStackModal();
    renderAll();
    syncBoardZoomSize();
    return true;
  } catch(err){
    return false;
  }
}

function tryLoadFromURL(){
  const params = new URLSearchParams(window.location.search);
  const s = params.get('s');
  if(!s) return false;
  if(!applyStateString(s)) return false;
  currentDifficultyLabel = 'URLから復元';
  // strip ?s= from the address bar: from here on, progress lives in the auto-save,
  // so a reload should resume the LATEST state, not this (frozen) URL snapshot.
  try{
    const url = new URL(window.location.href);
    url.searchParams.delete('s');
    window.history.replaceState(null, '', url.toString());
  }catch(err){}
  showToast('URLから状態を復元しました。ここからの進行は自動保存されます。', 'info');
  return true;
}

// ---- localStorage: auto-save on every render so the player can close the tab
// and resume later. (The URL-share feature is kept as an explicit share/backup.) ----
const LOCAL_SAVE_KEY = 'fivefold-magic-cube-save-v1';
const BEST_TIMES_KEY = 'fivefold-magic-cube-best-v1';

function saveToLocal(){
  if(!SOLUTION) return;
  try{
    localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify({
      s: encodeCurrentState(),
      label: currentDifficultyLabel,
      cleared: clearedSeconds,        // non-null once solved: freezes the timer across reloads
      surrendered: isSurrender,
      mode: currentMode,
      hints: [1,2,3,4,5].map(L=> parseInt(document.getElementById(`hint-${L}`).value, 10) || 16),
      t: Date.now(),
    }));
  } catch(err){ /* storage unavailable (private browsing etc.) -- silently skip */ }
}

function tryLoadFromLocal(){
  try{
    const raw = localStorage.getItem(LOCAL_SAVE_KEY);
    if(!raw) return false;
    const data = JSON.parse(raw);
    if(!data || typeof data.s !== 'string') return false;
    if(!applyStateString(data.s)) return false;
    currentDifficultyLabel = data.label || '前回の続き';
    // restore the difficulty-menu state (mode, hint values, button highlight)
    if(data.mode && DIFFICULTY_PRESETS[data.mode]){
      currentMode = data.mode;
      if(Array.isArray(data.hints) && data.hints.length === 5){
        for(let L=1; L<=LEVELS; L++) document.getElementById(`hint-${L}`).value = data.hints[L-1];
      }
      setActiveDiffButton(`.diff-btn[data-diff="${currentMode}"]`);
    }
    if(typeof data.cleared === 'number'){
      // already solved: freeze the timer at the clear time instead of resuming it
      clearedSeconds = data.cleared;
      isSurrender = !!data.surrendered;
      startTime = Date.now() - clearedSeconds*1000;
      // applyStateString()内のrenderAllがcleared:nullで上書き保存しているので、
      // 復元したクリア情報で保存し直す
      saveToLocal();
      showToast('クリア済みの盤面を復元しました。', 'info');
    } else {
      showToast('前回の続きから再開しました。', 'info');
    }
    return true;
  } catch(err){
    return false;
  }
}

// ---- best-time records per difficulty label (never records surrendered clears) ----
function loadBestTimes(){
  try{ return JSON.parse(localStorage.getItem(BEST_TIMES_KEY)) || {}; }
  catch(err){ return {}; }
}

function maybeRecordBest(label, seconds){
  if(isSurrender || typeof seconds !== 'number') return { best: null, isNew: false };
  if(label === 'URLから復元' || label === '前回の続き') return { best: null, isNew: false }; // 一時ラベルは記録しない
  const bests = loadBestTimes();
  const prev = bests[label];
  const isNew = (prev === undefined || seconds < prev);
  if(isNew){
    bests[label] = seconds;
    try{ localStorage.setItem(BEST_TIMES_KEY, JSON.stringify(bests)); }catch(err){}
  }
  return { best: isNew ? seconds : prev, isNew };
}

function formatSeconds(sec){
  return `${Math.floor(sec/60)}分${sec%60}秒`;
}

// ---- panel layout persistence: positions, collapsed/pinned state, zoom ----
const LAYOUT_KEY = 'fivefold-magic-cube-layout-v1';
const LAYOUT_PANEL_IDS = ['sidebar','poolPanel','miniStack','comboPanel','boardPanel'];

function saveLayout(){
  try{
    const slider = document.getElementById('zoomSlider');
    const layout = { panels: {}, zoom: slider ? slider.value : '100' };
    LAYOUT_PANEL_IDS.forEach(id=>{
      const p = document.getElementById(id);
      if(!p) return;
      const rect = p.getBoundingClientRect();
      layout.panels[id] = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        collapsed: p.classList.contains('collapsed'),
        pinned: p.dataset.pinned === 'true',
        front: p.dataset.front === 'true',
      };
    });
    layout.frontOrder = [...frontOrder]; // 固定同士の優先順位も保存
    layout.labelMode = labelMode;
    layout.acc = [...document.querySelectorAll('.side-section.acc')].map(s=> s.classList.contains('closed'));
    layout.panelVisible = {};
    PANEL_TOGGLE_IDS.forEach(id=>{
      const cb = document.getElementById(`panelToggle-${id}`);
      if(cb) layout.panelVisible[id] = cb.checked;
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch(err){ /* storage unavailable -- skip */ }
}

function restoreLayout(){
  let layout = null;
  try{ layout = JSON.parse(localStorage.getItem(LAYOUT_KEY)); }catch(err){}
  if(!layout || !layout.panels) return;
  for(const id of LAYOUT_PANEL_IDS){
    const p = document.getElementById(id);
    const st = layout.panels[id];
    if(!p || !st) continue;
    if(Number.isFinite(st.left) && Number.isFinite(st.top)){
      p.style.right = 'auto';
      p.style.bottom = 'auto';
      if(id === 'boardPanel') p.style.transform = 'none';
      p.style.left = st.left + 'px';
      p.style.top = st.top + 'px';
    }
    if(st.collapsed){
      p.classList.add('collapsed');
      p.style.width = '210px';
    }
    if(st.pinned){
      p.dataset.pinned = 'true';
      const btn = document.querySelector(`.pin-btn[data-pin-target="${id}"]`);
      if(btn){ btn.classList.add('active'); btn.title = 'ピン留め中(クリックで解除)'; }
    }
  }
  // 最前面固定の復元 (保存済みの優先順で)
  const order = Array.isArray(layout.frontOrder) ? layout.frontOrder : [];
  for(const id of order){
    const st = layout.panels[id];
    if(st && st.front){
      setFrontPinned(id, true);
      const btn = document.querySelector(`.front-btn[data-front-target="${id}"]`);
      if(btn){ btn.classList.add('active'); btn.title = '最前面固定中(クリックで解除)'; }
    }
  }
  if(layout.labelMode){
    labelMode = layout.labelMode;
    document.querySelectorAll('.seg-btn').forEach(b=> b.classList.toggle('active', b.dataset.labelmode === labelMode));
  }
  if(Array.isArray(layout.acc)){
    const secs = document.querySelectorAll('.side-section.acc');
    layout.acc.forEach((closed, i)=>{ if(secs[i]) secs[i].classList.toggle('closed', !!closed); });
  }
  if(layout.panelVisible){
    PANEL_TOGGLE_IDS.forEach(id=>{
      if(!(id in layout.panelVisible)) return;
      const visible = layout.panelVisible[id];
      const cb = document.getElementById(`panelToggle-${id}`);
      const panel = document.getElementById(id);
      if(cb) cb.checked = visible;
      if(panel) panel.style.display = visible ? '' : 'none';
    });
  }
  const slider = document.getElementById('zoomSlider');
  if(slider && layout.zoom){
    slider.value = layout.zoom;
    const zv = document.getElementById('zoomValue');
    if(zv) zv.textContent = `${slider.value}%`;
    syncBoardZoomSize();
  }
}

// ②の保険: 万一パネルを見失っても、画面下中央の固定バーから一発で初期配置に戻せる
function resetPanelLayout(){
  LAYOUT_PANEL_IDS.forEach(id=>{
    const p = document.getElementById(id);
    if(!p) return;
    p.classList.remove('collapsed');
    p.style.left = ''; p.style.top = ''; p.style.right = ''; p.style.bottom = '';
    p.style.width = ''; p.style.transform = '';
    p.dataset.pinned = 'false';
    p.dataset.front = 'false';
    p.style.zIndex = '';
  });
  frontOrder.length = 0;
  PANEL_TOGGLE_IDS.forEach(id=>{
    const cb = document.getElementById(`panelToggle-${id}`);
    const panel = document.getElementById(id);
    if(cb) cb.checked = true;
    if(panel) panel.style.display = '';
  });
  document.querySelectorAll('.pin-btn').forEach(b=>{
    b.classList.remove('active');
    b.title = 'ピン留め(位置固定)';
  });
  document.querySelectorAll('.front-btn').forEach(b=>{
    b.classList.remove('active');
    b.title = '最前面に固定(他のウィンドウの下に隠れなくなる)';
  });
  const slider = document.getElementById('zoomSlider');
  if(slider){
    slider.value = 100;
    const zv = document.getElementById('zoomValue');
    if(zv) zv.textContent = '100%';
  }
  try{ localStorage.removeItem(LAYOUT_KEY); }catch(err){}
  syncBoardZoomSize();
  showToast('パネル配置を初期状態に戻しました。', 'info');
}

function surrenderPuzzle(){
  if(clearedSeconds !== null) return; // すでにクリア済みなら何もしない
  if(!SOLUTION) return;
  isSurrender = true;
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        grid[L][r][c] = SOLUTION[L][r][c];
      }
    }
  }
  selected = null; selectedCell = null;
  pushHistory();
  renderAll();
  checkAnswer();
}

// ---- combination search: which currently-unplaced pool numbers sum to a target ----
function runComboSearch(){
  const count = parseInt(document.getElementById('comboCount').value, 10);
  const target = parseInt(document.getElementById('comboTarget').value, 10);
  const resultsEl = document.getElementById('comboResults');
  resultsEl.innerHTML = '';

  if(isNaN(target)){
    resultsEl.innerHTML = '<div class="combo-empty">目標の合計を入力してください。</div>';
    return;
  }
  const available = allPlayableValues.filter(v => !findPlacement(v));
  if(available.length < count){
    resultsEl.innerHTML = '<div class="combo-empty">残りプールの数字が足りません。</div>';
    return;
  }

  const found = new Set();
  function combos(start, chosen){
    if(found.size >= 30) return; // cap results for sanity
    if(chosen.length === count){
      const sum = chosen.reduce((a,i)=>a+available[i],0);
      if(sum === target){
        const key = chosen.map(i=>available[i]).sort((a,b)=>a-b).join('+');
        found.add(key);
      }
      return;
    }
    for(let i=start; i<available.length; i++) combos(i+1, [...chosen, i]);
  }
  combos(0, []);

  if(found.size === 0){
    resultsEl.innerHTML = '<div class="combo-empty">条件に合う組み合わせは見つかりませんでした。</div>';
  } else {
    [...found].forEach(key=>{
      const chip = document.createElement('div');
      chip.className = 'combo-chip';
      chip.textContent = key.replace(/\+/g,' + ') + ` = ${target}`;
      resultsEl.appendChild(chip);
    });
  }
}

// ---- rendering ----

function renderAll(){
  // 選択中の空間対角線に属するセル集合 (盤面/スタック双方のハイライトに使用)
  const triagSet = selectedTriag
    ? new Set(triagCellsById(selectedTriag).map(cl=>`${cl.L},${cl.r},${cl.c}`))
    : null;
  document.querySelectorAll('.iso-cell').forEach(cellEl=>{
    const L = +cellEl.dataset.l, r = +cellEl.dataset.r, c = +cellEl.dataset.c;
    const v = grid[L][r][c];
    const isGiven = given[L] && given[L][r][c];
    const label = cellEl.querySelector('.cube-label');
    const isTyping = !!(typingBuffer && selectedCell && selectedCell.L===L && selectedCell.r===r && selectedCell.c===c);
    cellEl.classList.toggle('typing', isTyping);
    if(label) label.textContent = isTyping ? typingBuffer : (v !== null ? v : '');
    cellEl.classList.toggle('empty', v === null);
    cellEl.classList.toggle('given', !!isGiven);
    cellEl.classList.toggle('echo', !!(selectedDepth && r===selectedDepth.r && c===selectedDepth.c));
    cellEl.classList.toggle('techo', !!(triagSet && triagSet.has(`${L},${r},${c}`)));
    cellEl.classList.toggle('placeable', !!(selected !== null && v===null && !isGiven));
    cellEl.classList.toggle('cell-selected', !!(selectedCell && selectedCell.L===L && selectedCell.r===r && selectedCell.c===c));
    cellEl.classList.toggle('tentative', !!(tentative[L] && tentative[L][r][c]));
    cellEl.classList.remove('ok','warn','bad');
    if(v !== null && !isGiven){
      cellEl.classList.add(cellStatus(L,r,c));
    }
  });

  const poolDiv = document.getElementById('globalPool');
  poolDiv.innerHTML = '';
  allPlayableValues.forEach(v=>{
    const chip = document.createElement('div');
    const placed = findPlacement(v) !== null;
    chip.className = 'chip' + (placed ? ' used' : '') + (selected === v ? ' selected' : '');
    chip.textContent = v;
    chip.title = placed ? 'クリックで盤面から外してプールに戻す' : 'クリックで選択・配置';
    chip.addEventListener('click', ()=> onChipClick(v));
    poolDiv.appendChild(chip);
  });

  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      const vals = Array.from({length:N},(_,c)=>grid[L][r][c]);
      const b = lineBadge(vals, TARGET);
      const el = document.querySelector(`.row-wall-label[data-l="${L}"][data-r="${r}"]`);
      if(el){ el.textContent = composeLabelText(b); el.setAttribute('class', 'wall-label row-wall-label ' + b.cls); }
    }
    for(let c=0;c<N;c++){
      const vals = Array.from({length:N},(_,r)=>grid[L][r][c]);
      const b = lineBadge(vals, TARGET);
      const el = document.querySelector(`.col-wall-label[data-l="${L}"][data-c="${c}"]`);
      if(el){ el.textContent = composeLabelText(b); el.setAttribute('class', 'wall-label col-wall-label ' + b.cls); }
    }
    {
      const mainVals = Array.from({length:N},(_,i)=>grid[L][i][i]);
      const bm = lineBadge(mainVals, TARGET);
      const elm = document.querySelector(`.diag-sum-main[data-l="${L}"]`);
      if(elm){ elm.textContent = composeLabelText(bm); elm.setAttribute('class', 'edge-label diag-sum-main ' + bm.cls); }

      const antiVals = Array.from({length:N},(_,i)=>grid[L][i][N-1-i]);
      const ba = lineBadge(antiVals, TARGET);
      const ela = document.querySelector(`.diag-sum-anti[data-l="${L}"]`);
      if(ela){ ela.textContent = composeLabelText(ba); ela.setAttribute('class', 'edge-label diag-sum-anti ' + ba.cls); }
    }
  }

  for(let r=0; r<N; r++){
    for(let c=0; c<N; c++){
      const vals = []; for(let L=1; L<=LEVELS; L++) vals.push(grid[L][r][c]);
      const b = lineBadge(vals, TARGET);
      const isSel = !!(selectedDepth && selectedDepth.r===r && selectedDepth.c===c);
      document.querySelectorAll(`.stack-cell[data-r="${r}"][data-c="${c}"]`).forEach(cellG=>{
        cellG.classList.toggle('echo', isSel);
        const label = cellG.querySelector('.stack-label');
        if(label){
          label.textContent = composeLabelText(b);
          label.setAttribute('class', 'stack-label ' + b.cls);
        }
      });
      document.querySelectorAll(`.stack-wall[data-r="${r}"][data-c="${c}"]`).forEach(wall=>{
        wall.classList.toggle('echo', isSel);
      });
    }
  }

  // 空間対角線: スタックセルのハイライト・バッジの合計/状態・折れ線の強調を更新
  document.querySelectorAll('.stack-cell').forEach(cellG=>{
    const on = !!(triagSet && triagSet.has(`${cellG.dataset.l},${cellG.dataset.r},${cellG.dataset.c}`));
    cellG.classList.toggle('techo', on);
  });
  document.querySelectorAll('.stack-wall').forEach(wall=>{
    const on = !!(triagSet && triagSet.has(`${wall.dataset.l},${wall.dataset.r},${wall.dataset.c}`));
    wall.classList.toggle('techo', on);
  });
  for(const def of TRIAG_INFO_DEFS){
    const vals = triagValues(def);
    const b = lineBadge(vals, TARGET);
    const badge = document.querySelector(`.triag-badge-${def.id}`);
    if(badge){
      const t = badge.querySelector('.triag-badge-text');
      if(t) t.textContent = composeLabelText(b);
      badge.style.display = labelMode === 'off' ? 'none' : '';
      badge.setAttribute('class', `triag-badge triag-badge-${def.id} ${b.cls}${selectedTriag===def.id ? ' sel' : ''}`);
    }
    const line = document.querySelector(`.triag-line.triag-${def.id}`);
    if(line) line.classList.toggle('sel', selectedTriag===def.id);
  }

  const ngBadge = document.getElementById('ngBadge');
  if(ngBadge) ngBadge.style.display = currentNoGuarantee ? 'block' : 'none';
  positionNgBadge();

  saveToLocal();
}

function checkAnswer(){
  let allFilled = true;
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        if(grid[L][r][c]===null) allFilled = false;
      }
    }
  }
  if(!allFilled){
    showToast('まだ空いているマスがあります。全125マスを埋めてから解答してください。', 'fail');
    return;
  }
  const lines = [];
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){ lines.push(Array.from({length:N},(_,c)=>grid[L][r][c])); }
    for(let c=0;c<N;c++){ lines.push(Array.from({length:N},(_,r)=>grid[L][r][c])); }
    lines.push(Array.from({length:N},(_,i)=>grid[L][i][i]));
    lines.push(Array.from({length:N},(_,i)=>grid[L][i][N-1-i]));
  }
  // 空間対角線4本 (層を貫く角→角)
  lines.push(Array.from({length:LEVELS},(_,i)=>grid[i+1][i][i]));
  lines.push(Array.from({length:LEVELS},(_,i)=>grid[i+1][i][N-1-i]));
  lines.push(Array.from({length:LEVELS},(_,i)=>grid[i+1][N-1-i][i]));
  lines.push(Array.from({length:LEVELS},(_,i)=>grid[i+1][N-1-i][N-1-i]));
  for(let r=0;r<N;r++){
    for(let c=0;c<N;c++){
      lines.push(Array.from({length:LEVELS},(_,i)=>grid[i+1][r][c]));
    }
  }
  const allCorrect = lines.every(line => line.reduce((a,b)=>a+b,0) === TARGET);
  if(allCorrect){
    if(clearedSeconds === null){
      clearedSeconds = startTime ? Math.round((Date.now()-startTime)/1000) : 0;
    }
    const timeText = `${Math.floor(clearedSeconds/60)}分${clearedSeconds%60}秒`;
    showClearCelebration(timeText);
    saveToLocal(); // persist the cleared state immediately so a reload doesn't resume the timer
  } else {
    showToast('まだ揃っていません。赤/黄の数字の列を見直してください。', 'fail');
  }
}

// ---- clear celebration ----

function showClearCelebration(timeText){
  const overlay = document.createElement('div');
  overlay.className = 'clear-overlay';

  const card = document.createElement('div');
  card.className = 'clear-card';
  const diffText = isSurrender ? `降参(${currentDifficultyLabel})` : currentDifficultyLabel;
  const rec = maybeRecordBest(currentDifficultyLabel, clearedSeconds);
  let bestLine = '';
  if(!isSurrender && rec.best !== null){
    bestLine = rec.isNew
      ? `<div class="clear-best new">🏆 ベスト記録更新！</div>`
      : `<div class="clear-best">ベスト: ${formatSeconds(rec.best)}</div>`;
  }
  card.innerHTML = `
    <div class="clear-title">${isSurrender ? '降参' : '達成'}</div>
    <div class="clear-sub">すべての行・列・対角線・縦列が315で揃いました</div>
    <div class="clear-diff">難易度: ${diffText}</div>
    ${timeText ? `<div class="clear-time">${timeText}</div>` : ''}
    ${bestLine}
    <button class="ghost clear-close">閉じる</button>
  `;
  overlay.appendChild(card);

  const colors = ['#c23b4a', '#b08d57', '#5a8f6b', '#3ee8ff', '#e8c977'];
  for(let i=0; i<60; i++){
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random()*100 + 'vw';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = (Math.random()*0.6) + 's';
    piece.style.animationDuration = (2.2 + Math.random()*1.6) + 's';
    piece.style.transform = `rotate(${Math.random()*360}deg)`;
    overlay.appendChild(piece);
  }

  document.body.appendChild(overlay);
  const raf = window.requestAnimationFrame || function(cb){ return setTimeout(cb, 16); };
  raf(()=> overlay.classList.add('show'));

  const close = ()=>{
    overlay.classList.remove('show');
    setTimeout(()=> overlay.remove(), 250);
  };
  card.querySelector('.clear-close').addEventListener('click', close);
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
}

// ---- toast notifications ----

let lastToastMsg = '', lastToastAt = 0;
function showToast(message, type){
  const container = document.getElementById('toastContainer');
  if(!container) return;
  // 同一メッセージの連打を抑制 (クリア後ロックの案内などのスパム防止)
  const now = Date.now();
  if(message === lastToastMsg && now - lastToastAt < 1500) return;
  lastToastMsg = message; lastToastAt = now;
  // 積み上がりすぎたら古いものから間引く
  while(container.children.length >= 4) container.firstChild.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  const raf = window.requestAnimationFrame || function(cb){ return setTimeout(cb, 16); };
  raf(()=> toast.classList.add('show'));
  const duration = type === 'fail' ? 8000 : 6500;
  setTimeout(()=>{
    toast.classList.remove('show');
    setTimeout(()=> toast.remove(), 250);
  }, duration);
}

// ---- toggle wiring ----

function setupToggles(){
  const segBtns = document.querySelectorAll('.seg-btn');
  segBtns.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      labelMode = btn.dataset.labelmode; // 'sum' | 'remaining' | 'fillcount' | 'off'
      segBtns.forEach(b=> b.classList.toggle('active', b === btn));
      renderAll();
      saveLayout();
    });
  });
}

// ---- shared "bring to front" z-index management for all floating panels ----
let topZIndex = 20;
const frontOrder = []; // 最前面固定パネルのid列 (末尾ほど優先=上)

function enforceFrontPinned(){
  frontOrder.forEach((id, i)=>{
    const p = document.getElementById(id);
    if(p) p.style.zIndex = String(400 + i);
  });
}

function setFrontPinned(id, on){
  const idx = frontOrder.indexOf(id);
  if(idx !== -1) frontOrder.splice(idx, 1);
  if(on) frontOrder.push(id); // 後から固定したものほど上
  const p = document.getElementById(id);
  if(p){
    p.dataset.front = on ? 'true' : 'false';
    if(!on){
      // 固定解除: 通常バンドに戻す
      topZIndex += 1;
      p.style.zIndex = String(topZIndex);
    }
  }
  enforceFrontPinned();
}

function bringToFront(el){
  topZIndex += 1;
  // panels must stay below the overlays (tutorial modal, clear screen at z:500,
  // mobile notice at z:900). Renormalize when the counter creeps up, preserving
  // the panels' relative stacking order.
  if(topZIndex > 380){
    const panels = LAYOUT_PANEL_IDS.map(id=>document.getElementById(id)).filter(Boolean);
    panels.sort((a,b)=> (parseInt(a.style.zIndex,10)||0) - (parseInt(b.style.zIndex,10)||0));
    topZIndex = 20;
    panels.forEach(p=>{ topZIndex += 1; p.style.zIndex = String(topZIndex); });
    topZIndex += 1;
  }
  // 最前面固定パネルのクリックは固定グループ内での順位を最上位へ更新するだけ
  if(el.dataset && el.dataset.front === 'true'){
    const idx = frontOrder.indexOf(el.id);
    if(idx !== -1){ frontOrder.splice(idx, 1); frontOrder.push(el.id); }
    enforceFrontPinned();
    return;
  }
  el.style.zIndex = String(topZIndex);
  enforceFrontPinned(); // 固定パネルは常に通常パネルより上を維持
}

// ---- shared collapse/expand toggle (keeps an explicit width so the CSS transition
// always has a real from/to value, instead of animating from/to "auto") ----
function setupCollapseToggle(panel, toggleBtn, collapsedWidth){
  toggleBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const collapsing = !panel.classList.contains('collapsed');
    if(collapsing){
      // 計測値(px)を保存するとズーム等でサイズが変わったとき展開時に崩れるため、
      // 元のインラインwidth(通常は空=CSS/自動に任せる)をそのまま復元する
      panel.dataset.naturalWidth = panel.style.width || '';
      panel.classList.add('collapsed');
      panel.style.width = collapsedWidth + 'px';
    } else {
      panel.classList.remove('collapsed');
      panel.style.width = panel.dataset.naturalWidth || '';
    }
    saveLayout();
  });
}

// ---- shared draggable-panel setup (pointer events: works with both mouse and touch) ----
function makeDraggable(panel, handle, toggleBtn, opts){
  opts = opts || {};
  setupCollapseToggle(panel, toggleBtn, 210);
  panel.addEventListener('pointerdown', ()=> bringToFront(panel));

  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  handle.addEventListener('pointerdown', (e)=>{
    if(e.target === toggleBtn || (e.target.classList && (e.target.classList.contains('pin-btn') || e.target.classList.contains('front-btn')))) return;
    if(panel.dataset.pinned === 'true') return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    if(opts.clearRight) panel.style.right = 'auto';
    if(opts.clearBottom) panel.style.bottom = 'auto';
    if(opts.clearTransform) panel.style.transform = 'none';
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';
    document.body.style.userSelect = 'none';
    if(handle.setPointerCapture){ try{ handle.setPointerCapture(e.pointerId); }catch(err){} }
    e.preventDefault();
  });
  const onMove = (e)=>{
    if(!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    let newLeft = startLeft + dx, newTop = startTop + dy;
    if(opts.clamp === 'handle'){
      // the panel may be larger than the screen (board): allow partial off-screen
      // placement but ALWAYS keep the drag handle reachable.
      newLeft = Math.max(-(panel.offsetWidth - 80), Math.min(window.innerWidth - 80, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
    } else {
      newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, newTop));
    }
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
  };
  const onUp = ()=>{
    if(dragging) saveLayout(); // ③: persist panel position after every drag
    dragging = false;
    document.body.style.userSelect = '';
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function setupSidebar(){
  makeDraggable(
    document.getElementById('sidebar'),
    document.getElementById('sidebarHead'),
    document.getElementById('sidebarToggle'),
    {}
  );
}

function setupPoolDrag(){
  makeDraggable(
    document.getElementById('poolPanel'),
    document.getElementById('poolPanelHead'),
    document.getElementById('poolToggle'),
    { clearBottom: true }
  );
}

// ---- tutorial ----
function buildTutDiagram(containerId, highlightFn){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '';
  for(let r=0;r<5;r++){
    for(let c=0;c<5;c++){
      const cell = document.createElement('div');
      cell.className = 'tut-cell' + (highlightFn(r,c) ? ' hl' : '');
      el.appendChild(cell);
    }
  }
}
function setupTutorial(){
  buildTutDiagram('tutDiagRow', (r,c)=> r===2);
  buildTutDiagram('tutDiagCol', (r,c)=> c===2);
  buildTutDiagram('tutDiagDiag', (r,c)=> r===c || r+c===4);
  buildTutDiagram('tutDiagDepth', (r,c)=> r===2 && c===2);
  buildTutDiagram('tutDiagTriag', (r,c)=> r===c); // 各層で(i,i)を通過するイメージ

  const modal = document.getElementById('tutorialModal');
  document.getElementById('tutorialBtn').addEventListener('click', ()=>{
    modal.style.zIndex = '700'; // always above every floating panel (panels stay <=381)
    modal.style.display = 'flex';
  });
  document.getElementById('closeTutorial').addEventListener('click', ()=>{ modal.style.display = 'none'; });
  modal.addEventListener('click', (e)=>{ if(e.target === modal) modal.style.display = 'none'; });
}

function setupMiniStack(){
  makeDraggable(
    document.getElementById('miniStack'),
    document.getElementById('miniStackHead'),
    document.getElementById('miniStackToggle'),
    { clearRight: true }
  );
}

function setupComboPanel(){
  makeDraggable(
    document.getElementById('comboPanel'),
    document.getElementById('comboPanelHead'),
    document.getElementById('comboToggle'),
    { clearRight: true }
  );
}

document.getElementById('newPuzzleBtn').addEventListener('click', newPuzzle);
document.getElementById('resetBtn').addEventListener('click', restartSamePuzzle);
document.getElementById('assistBtn').addEventListener('click', assistFill);
document.getElementById('surrenderBtn').addEventListener('click', surrenderPuzzle);
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);
document.getElementById('saveToURLBtn').addEventListener('click', shareCurrentStateURL);
document.getElementById('sharePuzzleBtn').addEventListener('click', shareProblemURL);
document.getElementById('layoutResetBtn').addEventListener('click', resetPanelLayout);
window.addEventListener('keydown', (e)=>{
  if(!(e.ctrlKey || e.metaKey)) return;
  const tag = (e.target && e.target.tagName) || '';
  if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // 入力欄の取り消しと競合させない
  const key = e.key.toLowerCase();
  if(key === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
  else if(key === 'y' || (key === 'z' && e.shiftKey)){ e.preventDefault(); redo(); }
});

// ---- keyboard number entry: select a cell, type digits, press Enter to place ----
window.addEventListener('keydown', (e)=>{
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if(e.key === 'Escape'){
    const tutModal = document.getElementById('tutorialModal');
    if(tutModal && tutModal.style.display === 'flex'){
      tutModal.style.display = 'none';
      return;
    }
    if(selected !== null || selectedCell !== null || typingBuffer){
      selected = null; selectedCell = null; typingBuffer = '';
      renderAll();
    }
    return;
  }
  if(!selectedCell) return;
  if(/^[0-9]$/.test(e.key)){
    if(typingBuffer.length < 3) typingBuffer += e.key;
    renderAll();
    e.preventDefault();
  } else if(e.key === 'Backspace'){
    typingBuffer = typingBuffer.slice(0, -1);
    renderAll();
    e.preventDefault();
  } else if(e.key === 'Enter'){
    commitTypedValue();
    e.preventDefault();
  }
});

// keyboard entry is confirmed by clicking ANYWHERE outside the typing cell
// (cell clicks are handled -- and also committed -- inside onCellClick).
document.addEventListener('pointerdown', (e)=>{
  if(!typingBuffer || !selectedCell) return;
  const cellEl = e.target && e.target.closest ? e.target.closest('.iso-cell') : null;
  if(cellEl) return;
  commitTypedValue();
}, true);

function commitTypedValue(){
  if(!selectedCell || !typingBuffer) return;
  if(guardCleared()){ typingBuffer = ''; selectedCell = null; renderAll(); return; }
  const value = parseInt(typingBuffer, 10);
  typingBuffer = '';
  if(!allPlayableValues.includes(value)){
    showToast(`${value} はこの問題の候補プールにありません。`, 'fail');
    renderAll(); return;
  }
  if(findPlacement(value)){
    showToast(`${value} はすでに盤面に置かれています。`, 'fail');
    renderAll(); return;
  }
  grid[selectedCell.L][selectedCell.r][selectedCell.c] = value;
  tentative[selectedCell.L][selectedCell.r][selectedCell.c] = false;
  selectedCell = null; selected = null;
  pushHistory();
  renderAll();
  if(isBoardFull()) checkAnswer();
}
document.getElementById('comboSearchBtn').addEventListener('click', runComboSearch);
// 2: accordion sections in the sidebar
document.querySelectorAll('.side-section.acc .side-h').forEach(h=>{
  h.addEventListener('click', ()=>{
    h.parentElement.classList.toggle('closed');
    saveLayout();
  });
});

// ③ 全体キューブ/候補プール/組み合わせ検索の表示切替
const PANEL_TOGGLE_IDS = ['miniStack','poolPanel','comboPanel'];
PANEL_TOGGLE_IDS.forEach(id=>{
  const cb = document.getElementById(`panelToggle-${id}`);
  const panel = document.getElementById(id);
  if(!cb || !panel) return;
  cb.addEventListener('change', ()=>{
    panel.style.display = cb.checked ? '' : 'none';
    saveLayout();
  });
});
document.querySelectorAll('.diff-btn[data-diff]').forEach(b=>{
  b.addEventListener('click', ()=> applyDifficultyPreset(b.dataset.diff));
});
setupToggles();
setupSidebar();
setupMiniStack();
setupComboPanel();
setupPoolDrag();
setupTutorial();

function setupFrontButtons(){
  document.querySelectorAll('.front-btn').forEach(btn=>{
    const panel = document.getElementById(btn.dataset.frontTarget);
    if(!panel) return;
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const nowOn = panel.dataset.front !== 'true';
      setFrontPinned(panel.id, nowOn);
      btn.classList.toggle('active', nowOn);
      btn.title = nowOn ? '最前面固定中(クリックで解除)' : '最前面に固定(他のウィンドウの下に隠れなくなる)';
      saveLayout();
    });
  });
}
setupFrontButtons();

function setupPinButtons(){
  document.querySelectorAll('.pin-btn').forEach(btn=>{
    const panel = document.getElementById(btn.dataset.pinTarget);
    if(!panel) return;
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const nowPinned = panel.dataset.pinned !== 'true';
      panel.dataset.pinned = String(nowPinned);
      btn.classList.toggle('active', nowPinned);
      btn.title = nowPinned ? 'ピン留め中(クリックで解除)' : 'ピン留め(位置固定)';
      saveLayout();
    });
  });
}
setupPinButtons();

function updateTimerBadge(){
  const badge = document.getElementById('timerBadge');
  if(!badge || !startTime) return;
  const seconds = clearedSeconds !== null ? clearedSeconds : Math.floor((Date.now()-startTime)/1000);
  const h = Math.floor(seconds/3600), m = Math.floor(seconds/60)%60, s = seconds%60;
  badge.textContent = h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
  positionNgBadge();
}

// 保証なしバッジをタイマーの実寸直下に配置 (固定値だと余白が不均一になる)
function positionNgBadge(){
  const ng = document.getElementById('ngBadge');
  if(!ng || ng.style.display === 'none') return;
  const tb = document.getElementById('timerBadge');
  if(!tb) return;
  const rect = tb.getBoundingClientRect();
  if(rect.height > 0) ng.style.top = (rect.bottom + 5) + 'px';
}
setInterval(updateTimerBadge, 1000);

function setupBoardDrag(){
  // the board panel is intentionally NOT clamped to the viewport: it can be much
  // larger than the screen, so partial off-screen placement is a valid use case.
  makeDraggable(
    document.getElementById('boardPanel'),
    document.getElementById('boardDragHandle'),
    document.getElementById('boardToggle'),
    { clearTransform: true, clamp: 'handle' }
  );
}
setupBoardDrag();

function syncBoardZoomSize(){
  const slider = document.getElementById('zoomSlider');
  const wrap = document.getElementById('cubeWrap');
  const outer = document.getElementById('cubeWrapOuter');
  if(!slider || !wrap || !outer) return;
  const pct = parseInt(slider.value, 10) || 100;
  const scale = pct/100;
  const MARGIN = 14; // matches #cubeWrap's fixed top/left offset inside the outer box
  outer.style.width = 'auto';
  outer.style.height = 'auto';
  wrap.style.transform = `scale(${scale})`;
  const rect = wrap.getBoundingClientRect();
  outer.style.width = (rect.width + MARGIN*2) + 'px';
  outer.style.height = (rect.height + MARGIN*2) + 'px';
}

function setupZoomControl(){
  const slider = document.getElementById('zoomSlider');
  const valueLabel = document.getElementById('zoomValue');
  slider.addEventListener('input', ()=>{
    valueLabel.textContent = `${slider.value}%`;
    syncBoardZoomSize();
    saveLayout();
  });
}
setupZoomControl();

// keep floating panels reachable when the window is resized
function clampPanelsIntoView(){
  ['sidebar','poolPanel','miniStack','comboPanel','boardPanel'].forEach(id=>{
    const p = document.getElementById(id);
    if(!p) return;
    const rect = p.getBoundingClientRect();
    const minVisible = 60;
    let left = rect.left, top = rect.top, changed = false;
    if(rect.left > window.innerWidth - minVisible){ left = Math.max(0, window.innerWidth - minVisible); changed = true; }
    if(rect.width > 0 && rect.left + rect.width < minVisible){ left = minVisible - rect.width; changed = true; }
    if(rect.top > window.innerHeight - 40){ top = Math.max(0, window.innerHeight - 40); changed = true; }
    if(rect.top < 0){ top = 0; changed = true; }
    if(changed){
      if(id === 'boardPanel') p.style.transform = 'none';
      p.style.right = 'auto'; p.style.bottom = 'auto';
      p.style.left = left + 'px'; p.style.top = top + 'px';
    }
  });
}
window.addEventListener('resize', clampPanelsIntoView);

// dismissible "PC recommended" notice for small/touch screens (visibility is CSS media-query driven)
(function setupMobileNotice(){
  const notice = document.getElementById('mobileNotice');
  const btn = document.getElementById('mobileNoticeClose');
  if(!notice || !btn) return;
  btn.addEventListener('click', ()=> notice.classList.add('dismissed'));
})();

// restore priority: shared URL > local auto-save > fresh puzzle
if(!tryLoadFromURL() && !tryLoadFromLocal()){
  newPuzzle();
}

// ③: restore saved panel layout, then make sure nothing is stranded off-screen
restoreLayout();
clampPanelsIntoView();

// ---- 初回体験: レイアウト未保存なら盤面が画面に収まるズームを自動算出。
// さらに完全な初回(既読フラグなし)ならチュートリアルを一度だけ自動表示 ----
function autoFitInitialZoom(){
  try{ if(localStorage.getItem(LAYOUT_KEY)) return; }catch(err){}
  const wrap = document.getElementById('cubeWrap');
  const W = parseFloat(wrap && wrap.dataset.naturalWidth) || 1358;
  const H = parseFloat(wrap && wrap.dataset.naturalHeight) || 866;
  const availW = window.innerWidth - 310 - 470 - 40;   // sidebar+gap / 全体キューブ幅+余白
  const availH = window.innerHeight - 24 - 30 - 290 - 24; // 上余白/ハンドル/候補プール/下余白
  let pct = Math.floor(Math.min(availW / W, availH / H) * 100 / 5) * 5;
  pct = Math.max(60, Math.min(100, pct));
  const slider = document.getElementById('zoomSlider');
  if(slider && parseInt(slider.value,10) !== pct){
    slider.value = pct;
    const zv = document.getElementById('zoomValue');
    if(zv) zv.textContent = `${pct}%`;
    syncBoardZoomSize();
  }
}

function maybeShowFirstRunTutorial(){
  try{
    const KEY = 'fivefold-magic-cube-seen-v1';
    if(localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, '1');
    const modal = document.getElementById('tutorialModal');
    if(modal){
      modal.style.zIndex = '700';
      modal.style.display = 'flex';
    }
  }catch(err){}
}

(function firstRunSetup(){
  let tries = 0;
  const tick = ()=>{
    if(typeof isGenerating === 'function' && isGenerating() && tries++ < 300){
      setTimeout(tick, 100);
      return;
    }
    autoFitInitialZoom();
    clampPanelsIntoView();
    maybeShowFirstRunTutorial();
  };
  tick();
})();

