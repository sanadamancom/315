// repair-main.js — 修復型プロトタイプの状態管理・描画・操作。
// generator.js / render.js の汎用部品(色定数・座標計算・SVG構築)だけを再利用し、
// 出題ロジック(generator.js)へは一切手を入れない。
//
// 操作:
//   左クリック            : 観察のみ(選択・ライン一覧表示)。交換は起きない。
//   中クリック / Shift+クリック : 選択中セルと交換先を交換(同じ関数を共有)。
//   右クリック            : 何もしない(将来予約、contextmenuは抑止のみ)。
//   Escape                : 選択・ライン強調の解除(測定履歴は消さない)。
//   Ctrl+Z / Cmd+Z         : 直前の有効交換をUndo。

const ALL_LINES = buildLines109();

let repairState = createInitialRepairState();
let selectedCell = null;   // {L,r,c} | null — 観察対象 兼 交換元
let measured = new Map();  // lineKey -> '=' | '↑' | '↓'
let highlightedLineKey = null;
let history = [];          // 有効交換のみのUndoスナップショット
let cleared = false;

function cellKeyEq(a,b){ return !!a && !!b && a.L===b.L && a.r===b.r && a.c===b.c; }

function lineTouchesCell(line, L, r, c){
  const z = L-1, y = r, x = c;
  return line.cells.some(cell => cell.z===z && cell.y===y && cell.x===x);
}

// 交換の影響を受けたラインの測定結果だけを無効化する(未測定へ戻す)。
function invalidateMeasurementsForCell(L,r,c){
  for(const line of ALL_LINES){
    if(measured.has(line.key) && lineTouchesCell(line, L, r, c)){
      measured.delete(line.key);
    }
  }
}

// ---- 交換 (中クリック・Shift+クリックの共有関数。可否判定・Undo追加・測定無効化を一箇所に集約) ----
function attemptSwap(L,r,c){
  const target = { L, r, c };

  if(!selectedCell){ selectedCell = target; renderAll(); return; }
  if(cellKeyEq(selectedCell, target)) return; // 同一セル: 何もしない

  const bothUnlocked = isRepairUnlocked(selectedCell.L,selectedCell.r,selectedCell.c) && isRepairUnlocked(L,r,c);
  if(!bothUnlocked){
    // 固定セルが絡む場合は交換せず、選択のみ更新する(選択中が固定/交換先が固定のどちらも同じ扱い)。
    selectedCell = target;
    renderAll();
    return;
  }

  // ---- ここから有効交換 ----
  history.push({
    state: repairState,
    measured: new Map(measured),
    selectedCell,
    highlightedLineKey,
    cleared,
  });

  repairState = swapRepairCells(repairState, selectedCell, target);
  invalidateMeasurementsForCell(selectedCell.L, selectedCell.r, selectedCell.c);
  invalidateMeasurementsForCell(L, r, c);
  if(highlightedLineKey && !measured.has(highlightedLineKey)){
    highlightedLineKey = null; // 強調中ラインが今回の交換で無効化された場合だけ解除
  }
  selectedCell = target; // 有効交換後は交換先を選択状態にする

  checkCompletion();
  renderAll();
}

// ---- 盤面インタラクション (render.js の buildLevelCard から呼ばれるグローバル関数) ----
function onCellClick(L,r,c,e){
  if(e && e.button !== undefined && e.button !== 0) return; // 左クリック以外はここでは扱わない(防御的)
  if(e && e.shiftKey){
    attemptSwap(L,r,c); // Shift+左クリック: 中クリックと同じ交換関数
    return;
  }
  // 通常の左クリック: 観察のみ。交換は起きない。
  selectedCell = { L, r, c };
  renderAll();
}

function onCellRightClick(){ /* 修復モードでは右クリックに新しい用途を割り当てない(noop) */ }

function onCellMiddleDown(e){
  if(e.button === 1) e.preventDefault(); // 中クリックのオートスクロールを抑止
}

function onCellAuxClick(L,r,c,e){
  if(e.button !== 1) return; // 中クリック以外のauxclick(存在すれば)は無視
  e.preventDefault();
  attemptSwap(L,r,c);
}

// render.js の buildLevelCard は click/contextmenu しか登録しないため、
// 中クリック用のリスナーだけをこちらで後付けする(render.js自体は変更しない)。
function wireMiddleClickHandlers(){
  document.querySelectorAll('.iso-cell').forEach(g=>{
    const L = Number(g.dataset.l), r = Number(g.dataset.r), c = Number(g.dataset.c);
    g.addEventListener('mousedown', onCellMiddleDown);
    g.addEventListener('auxclick', (e)=> onCellAuxClick(L,r,c,e));
  });
}

// ---- 測定 ----
function measureSelectedLine(lineKey){
  const line = ALL_LINES.find(l => l.key === lineKey);
  if(!line) return;
  const result = measureLine(repairState, line);
  measured.set(lineKey, result);
  highlightedLineKey = lineKey;
  renderAll();
}

function resultClass(result){
  if(result === '=') return 'eq';
  if(result === '↑') return 'over';
  return 'under';
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
  measured = snap.measured;
  selectedCell = snap.selectedCell;
  highlightedLineKey = snap.highlightedLineKey;
  cleared = snap.cleared;
  document.getElementById('clearOverlay').classList.toggle('hidden', !cleared);
  renderAll();
}

function resetPuzzle(){
  repairState = createInitialRepairState();
  selectedCell = null;
  measured.clear();
  highlightedLineKey = null;
  history = [];
  cleared = false;
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
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        const g = document.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
        if(!g) continue;
        const value = repairGridValue(repairState, L, r, c);
        const label = g.querySelector('.cube-label');
        if(label) label.textContent = value;

        const unlocked = isRepairUnlocked(L,r,c);
        g.classList.remove('empty');
        g.classList.toggle('given', !unlocked);
        g.classList.toggle('repair-unlocked', unlocked);
        g.classList.toggle('cell-selected', cellKeyEq(selectedCell, {L,r,c}));
        g.classList.toggle('line-highlight', !!highlightLine && lineTouchesCell(highlightLine, L, r, c));
      }
    }
  }
}

function renderSidebar(){
  const infoEl = document.getElementById('selectedCellInfo');
  const lineListEl = document.getElementById('lineList');
  const measuredListEl = document.getElementById('measuredList');
  const undoBtn = document.getElementById('undoBtn');
  undoBtn.disabled = history.length === 0;

  if(!selectedCell){
    infoEl.textContent = '盤面のマスをクリックしてください';
    lineListEl.innerHTML = '<div class="lines-empty">マス未選択</div>';
  } else {
    const { L, r, c } = selectedCell;
    const unlocked = isRepairUnlocked(L,r,c);
    infoEl.innerHTML = `L${L} 行${r+1} 列${c+1}<span class="tag ${unlocked?'unlocked':''}">${unlocked ? '未確定' : '固定'}</span>`;

    const lines = linesThroughCell(ALL_LINES, L, r, c);
    lineListEl.innerHTML = '';
    for(const line of lines){
      const row = document.createElement('div');
      row.className = 'line-row';
      const result = measured.get(line.key);
      row.innerHTML = `
        <span class="line-type">${lineLabel(line)}</span>
        <span class="result ${result ? resultClass(result) : ''}">${result || '?'}</span>
      `;
      const btn = document.createElement('button');
      btn.textContent = '測定';
      btn.addEventListener('click', ()=> measureSelectedLine(line.key));
      row.appendChild(btn);
      lineListEl.appendChild(row);
    }
  }

  measuredListEl.innerHTML = '';
  if(measured.size === 0){
    measuredListEl.innerHTML = '<div class="measured-empty">まだ測定していません</div>';
  } else {
    for(const [key, result] of measured.entries()){
      const line = ALL_LINES.find(l=>l.key===key);
      const row = document.createElement('div');
      row.className = 'line-row';
      row.innerHTML = `
        <span class="line-type">${line ? lineLabel(line) : key}</span>
        <span class="result ${resultClass(result)}">${result}</span>
      `;
      measuredListEl.appendChild(row);
    }
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
  wireMiddleClickHandlers();
  renderAll();
  document.getElementById('resetBtn').addEventListener('click', resetPuzzle);
  document.getElementById('undoBtn').addEventListener('click', undoSwap);
  document.getElementById('clearCloseBtn').addEventListener('click', ()=>{
    document.getElementById('clearOverlay').classList.add('hidden');
  });
  document.addEventListener('keydown', onKeyDown);
});
