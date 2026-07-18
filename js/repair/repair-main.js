// repair-main.js — 修復型プロトタイプの状態管理・描画・操作。
// generator.js / render.js の汎用部品(色定数・座標計算・SVG構築)だけを再利用し、
// 出題ロジック(generator.js)へは一切手を入れない。
//
// 操作:
//   左クリック(1回目・未確定セル) : 交換元として選択。まだ交換しない。
//   左クリック(2回目・別の未確定セル) : 選択中セルと交換。
//   左クリック(選択中セルを再クリック) : 選択解除のみ。
//   左クリック(固定セル)         : 交換待ちを解除し、そのセルを観察対象にする。
//   右クリック                   : 何もしない(将来予約、contextmenuは抑止のみ)。
//   Escape                       : 選択・ライン強調の解除。
//   Ctrl+Z / Cmd+Z                : 直前の有効交換をUndo。
//
// ライン状態(＝/↑/↓)は測定操作ではなく、常に現在の盤面から自動計算する
// (measure.jsのmeasureLineをそのまま毎回呼ぶだけで「測定履歴」は持たない)。

const ALL_LINES = buildLines109();
const FLASH_DURATION_MS = 900;

let repairState = createInitialRepairState();
let selectedCell = null;     // {L,r,c} | null — 観察対象 兼 交換元(未確定セルのときだけ交換元になる)
let highlightedLineKey = null; // ライン診断一覧のクリックで選んだ強調中ライン
let history = [];            // 有効交換のみのUndoスナップショット
let cleared = false;
const flashTimers = new Map(); // cellKey -> timeoutId (交換フィードバックの自動解除用)

function cellKeyEq(a,b){ return !!a && !!b && a.L===b.L && a.r===b.r && a.c===b.c; }
function cellDomKey(L,r,c){ return `${L}-${r}-${c}`; }

function lineTouchesCell(line, L, r, c){
  const z = L-1, y = r, x = c;
  return line.cells.some(cell => cell.z===z && cell.y===y && cell.x===x);
}

// ---- 自動ライン診断 (常に現在の盤面から計算。過去の測定結果を記憶するMapは持たない) ----
function diagnoseLine(line){
  return measureLine(repairState, line); // '=' | '↑' | '↓'
}
function diagStatusClass(status){
  if(status === '=') return 'eq';
  if(status === '↑') return 'over';
  return 'under';
}

// ---- 盤面インタラクション ----
function onCellClick(L,r,c){
  const target = { L, r, c };

  if(cellKeyEq(selectedCell, target)){
    // 選択中セルの再クリック: 選択解除のみ。状態不変・Undo追加なし。
    selectedCell = null;
    renderAll();
    return;
  }

  const canSwap = selectedCell
    && isRepairUnlocked(selectedCell.L, selectedCell.r, selectedCell.c)
    && isRepairUnlocked(L, r, c);

  if(canSwap){
    performSwap(selectedCell, target);
    selectedCell = null; // 交換後は交換元選択を解除
  } else {
    // 1回目の未確定セルクリック、または固定セルクリック(観察対象への切り替え)。
    // どちらの場合も「交換待ち状態の解除」を兼ねる(前の選択を上書きするだけ)。
    selectedCell = target;
  }
  renderAll();
}

function onCellRightClick(){ /* 修復モードでは右クリックに新しい用途を割り当てない(noop) */ }

// ---- 交換 (可否判定はonCellClick側で確定済み。ここでは実行とUndo追加・フィードバックだけ) ----
function performSwap(a, b){
  // 交換前: 影響を受けうるライン(a・bどちらかを含む全ライン、重複なし)の状態を記録
  const affectedLines = ALL_LINES.filter(line => lineTouchesCell(line, a.L,a.r,a.c) || lineTouchesCell(line, b.L,b.r,b.c));
  const before = new Map(affectedLines.map(line => [line.key, diagnoseLine(line)]));

  history.push({
    state: repairState,
    selectedCell: a,
    highlightedLineKey,
    cleared,
  });

  repairState = swapRepairCells(repairState, a, b);

  // 交換後の状態と比較し、セル単位のフィードバック(ok/bad)を決める。
  // 同一セルが正常化ラインと異常ラインの両方に含まれる場合は異常(bad)を優先。
  const cellFlash = new Map(); // cellDomKey -> 'ok' | 'bad'
  for(const line of affectedLines){
    const beforeStatus = before.get(line.key);
    const afterStatus = diagnoseLine(line);
    let kind = null;
    if(beforeStatus !== '=' && afterStatus === '='){ kind = 'ok'; }
    else if(beforeStatus === '=' && afterStatus !== '='){ kind = 'bad'; }
    else if(beforeStatus !== '=' && afterStatus !== '=' && beforeStatus !== afterStatus){ kind = 'bad'; } // ↑<->↓反転
    if(!kind) continue;
    for(const cell of line.cells){
      const key = cellDomKey(cell.z+1, cell.y, cell.x);
      if(kind === 'bad' || cellFlash.get(key) !== 'bad'){
        cellFlash.set(key, kind);
      }
    }
  }
  flashCells(cellFlash);

  checkCompletion();
}

function flashCells(cellFlash){
  for(const [key, kind] of cellFlash.entries()){
    const el = document.querySelector(`.iso-cell[data-key="${key}"]`);
    if(!el) continue;
    const cls = kind === 'ok' ? 'flash-ok' : 'flash-bad';
    el.classList.remove('flash-ok','flash-bad');
    // reflow強制でアニメーションを確実に再トリガーする
    void el.offsetWidth;
    el.classList.add(cls);
    if(flashTimers.has(key)) clearTimeout(flashTimers.get(key));
    const timer = setTimeout(()=>{ el.classList.remove('flash-ok','flash-bad'); flashTimers.delete(key); }, FLASH_DURATION_MS);
    flashTimers.set(key, timer);
  }
}

// ---- ライン診断一覧: 項目クリックで強調のトグル ----
function toggleLineHighlight(lineKey){
  highlightedLineKey = (highlightedLineKey === lineKey) ? null : lineKey;
  renderAll();
}

// ---- クリア判定 ----
function checkCompletion(){
  const overlay = document.getElementById('clearOverlay');
  if(isRepairSolved(repairState)){
    cleared = true;
    overlay.classList.remove('hidden');
  } else {
    cleared = false;
    overlay.classList.add('hidden');
  }
}

// ---- Undo (有効交換のみ) ----
function undoSwap(){
  if(history.length === 0) return;
  const snap = history.pop();
  repairState = snap.state;
  selectedCell = snap.selectedCell;
  highlightedLineKey = snap.highlightedLineKey;
  cleared = snap.cleared;
  document.getElementById('clearOverlay').classList.toggle('hidden', !cleared);
  renderAll();
}

function resetPuzzle(){
  repairState = createInitialRepairState();
  selectedCell = null;
  highlightedLineKey = null;
  history = [];
  cleared = false;
  for(const [key, timer] of flashTimers.entries()){
    clearTimeout(timer);
    const el = document.querySelector(`.iso-cell[data-key="${key}"]`);
    if(el) el.classList.remove('flash-ok','flash-bad');
  }
  flashTimers.clear();
  document.getElementById('clearOverlay').classList.add('hidden');
  renderAll();
}

function clearSelection(){
  selectedCell = null;
  highlightedLineKey = null;
  renderAll();
}

// ---- 描画 ----
function renderAll(){
  renderBoard();
  renderSidebar();
}

function renderBoard(){
  const highlightLine = highlightedLineKey ? ALL_LINES.find(l=>l.key===highlightedLineKey) : null;
  const highlightClass = highlightLine ? `diag-${diagStatusClass(diagnoseLine(highlightLine))}` : null;

  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        const g = document.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
        if(!g) continue;
        g.dataset.key = cellDomKey(L,r,c);

        const value = repairGridValue(repairState, L, r, c);
        const label = g.querySelector('.cube-label');
        if(label) label.textContent = value;

        const unlocked = isRepairUnlocked(L,r,c);
        g.classList.remove('empty');
        g.classList.toggle('given', !unlocked);
        g.classList.toggle('repair-unlocked', unlocked);
        g.classList.toggle('cell-selected', cellKeyEq(selectedCell, {L,r,c}));

        g.classList.remove('diag-eq','diag-over','diag-under');
        if(highlightLine && lineTouchesCell(highlightLine, L, r, c)){
          g.classList.add(highlightClass);
        }
      }
    }
  }
}

function renderSidebar(){
  const infoEl = document.getElementById('selectedCellInfo');
  const lineListEl = document.getElementById('lineList');
  const undoBtn = document.getElementById('undoBtn');
  undoBtn.disabled = history.length === 0;

  if(!selectedCell){
    infoEl.textContent = '盤面のマスをクリックしてください';
    lineListEl.innerHTML = '<div class="lines-empty">マス未選択</div>';
    return;
  }

  const { L, r, c } = selectedCell;
  const unlocked = isRepairUnlocked(L,r,c);
  infoEl.innerHTML = `L${L} 行${r+1} 列${c+1}<span class="tag ${unlocked?'unlocked':''}">${unlocked ? '未確定' : '固定'}</span>`;

  const lines = linesThroughCell(ALL_LINES, L, r, c);
  lineListEl.innerHTML = '';
  for(const line of lines){
    const status = diagnoseLine(line);
    const row = document.createElement('div');
    row.className = 'line-row line-row-clickable';
    if(highlightedLineKey === line.key) row.classList.add('active');
    row.innerHTML = `
      <span class="line-type">${lineLabel(line)}</span>
      <span class="result ${diagStatusClass(status)}">${status}</span>
    `;
    row.addEventListener('click', ()=> toggleLineHighlight(line.key));
    lineListEl.appendChild(row);
  }
}

// ---- キーボード操作 ----
function isTypingTarget(el){
  if(!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function onKeyDown(e){
  if(isTypingTarget(document.activeElement)) return;

  if(e.key === 'Escape'){
    clearSelection();
    return;
  }
  const isUndoCombo = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z');
  if(isUndoCombo){
    e.preventDefault();
    undoSwap();
  }
}

// ---- 初期化 ----
document.addEventListener('DOMContentLoaded', ()=>{
  buildCube();
  renderAll();
  document.getElementById('resetBtn').addEventListener('click', resetPuzzle);
  document.getElementById('undoBtn').addEventListener('click', undoSwap);
  document.getElementById('clearCloseBtn').addEventListener('click', ()=>{
    document.getElementById('clearOverlay').classList.add('hidden');
  });
  document.addEventListener('keydown', onKeyDown);
});
