// repair-main.js — 修復型プロトタイプの状態管理・描画・操作。
// generator.js / render.js の汎用部品(色定数・座標計算・SVG構築)だけを再利用し、
// 出題ロジック(generator.js)へは一切手を入れない。

const ALL_LINES = buildLines109();

let repairState = createInitialRepairState();
let swapArmed = null;      // {L,r,c} | null — 交換待ちの未確定セル
let focusedCell = null;    // {L,r,c} | null — ライン一覧表示の対象
let measured = new Map();  // lineKey -> '=' | '↑' | '↓'
let highlightedLineKey = null;
let history = [];          // 交換操作のUndo用スタック(stateのスナップショット)
let cleared = false;

function cellKeyEq(a,b){ return !!a && !!b && a.L===b.L && a.r===b.r && a.c===b.c; }

function lineTouchesCell(line, L, r, c){
  const z = L-1, y = r, x = c;
  return line.cells.some(cell => cell.z===z && cell.y===y && cell.x===x);
}

// 交換の影響を受けたラインの測定結果を無効化する(未測定へ戻す)。
function invalidateMeasurementsForCell(L,r,c){
  for(const line of ALL_LINES){
    if(measured.has(line.key) && lineTouchesCell(line, L, r, c)){
      measured.delete(line.key);
    }
  }
}

// ---- 盤面インタラクション (render.js の buildLevelCard から呼ばれるグローバル関数) ----
function onCellClick(L,r,c){
  if(cleared) return;
  focusedCell = { L, r, c };

  if(isRepairUnlocked(L,r,c)){
    if(swapArmed && cellKeyEq(swapArmed,{L,r,c})){
      swapArmed = null; // 同じマスをもう一度クリック -> 選択解除
    } else if(swapArmed){
      history.push(repairState);
      repairState = swapRepairCells(repairState, swapArmed, {L,r,c});
      invalidateMeasurementsForCell(swapArmed.L, swapArmed.r, swapArmed.c);
      invalidateMeasurementsForCell(L, r, c);
      swapArmed = null;
      checkCompletion();
    } else {
      swapArmed = { L, r, c };
    }
  }
  renderAll();
}

function onCellRightClick(){ /* 修復モードでは右クリック操作なし */ }

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
  if(isRepairSolved(repairState)){
    cleared = true;
    document.getElementById('clearOverlay').classList.remove('hidden');
  }
}

// ---- Undo ----
function undoSwap(){
  if(history.length === 0) return;
  repairState = history.pop();
  measured.clear(); // どのラインが影響を受けたか遡って追うより、安全側で全て未測定に戻す
  highlightedLineKey = null;
  cleared = false;
  document.getElementById('clearOverlay').classList.add('hidden');
  renderAll();
}

function resetPuzzle(){
  repairState = createInitialRepairState();
  swapArmed = null;
  focusedCell = null;
  measured.clear();
  highlightedLineKey = null;
  history = [];
  cleared = false;
  document.getElementById('clearOverlay').classList.add('hidden');
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
        g.classList.toggle('given', !unlocked);
        g.classList.toggle('repair-unlocked', unlocked);
        g.classList.toggle('cell-selected', cellKeyEq(swapArmed, {L,r,c}));
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

  if(!focusedCell){
    infoEl.textContent = '盤面のマスをクリックしてください';
    lineListEl.innerHTML = '<div class="lines-empty">マス未選択</div>';
  } else {
    const { L, r, c } = focusedCell;
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

// ---- 初期化 ----
document.addEventListener('DOMContentLoaded', ()=>{
  buildCube();
  renderAll();
  document.getElementById('resetBtn').addEventListener('click', resetPuzzle);
  document.getElementById('undoBtn').addEventListener('click', undoSwap);
  document.getElementById('clearCloseBtn').addEventListener('click', ()=>{
    document.getElementById('clearOverlay').classList.add('hidden');
  });
});
