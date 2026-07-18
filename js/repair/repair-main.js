// repair-main.js — 修復型プロトタイプの状態管理・描画・操作。
// generator.js / render.js の汎用部品(色定数・座標計算・SVG構築)だけを再利用し、
// 出題ロジック(generator.js)へは一切手を入れない。
//
// 操作:
//   左クリック(1回目・未確定セル) : 交換元として選択。まだ交換しない。
//   左クリック(2回目・別の未確定セル) : 選択中セルと交換(移動アニメーション付き)。
//   左クリック(選択中セルを再クリック) : 選択解除のみ。
//   左クリック(固定セル)         : 交換待ちを解除し、そのセルを観察対象にする。
//   右クリック                   : 何もしない(将来予約、contextmenuは抑止のみ)。
//   Escape                       : 選択・ライン強調の解除。
//   Ctrl+Z / Cmd+Z                : 直前の有効交換をUndo(巻き戻しアニメーション付き)。
//
// ライン状態(＝/↑/↓)は測定操作ではなく、常に現在の盤面から自動計算する
// (measure.jsのmeasureLineをそのまま毎回呼ぶだけで「測定履歴」は持たない)。
// セルの常時着色(line-health)も同様に、正解配列とは一切比較せず、
// 「そのセルを通る全ラインの合計が315かどうか」だけで決める。

const ALL_LINES = buildLines109();
const SWAP_ANIM_MS = 210;

let repairState = createInitialRepairState();
let selectedCell = null;     // {L,r,c} | null — 観察対象 兼 交換元(未確定セルのときだけ交換元になる)
let highlightedLineKey = null; // HUD診断チップのクリックで選んだ強調中ライン
let history = [];            // 有効交換のみのUndoスナップショット({state, selectedCell, highlightedLineKey, cleared, swapPair})
let cleared = false;
let animating = false;       // 交換アニメーション中は追加のクリック/Undoを無視する

function cellKeyEq(a,b){ return !!a && !!b && a.L===b.L && a.r===b.r && a.c===b.c; }
function cellDomKey(L,r,c){ return `${L}-${r}-${c}`; }

function lineTouchesCell(line, L, r, c){
  const z = L-1, y = r, x = c;
  return line.cells.some(cell => cell.z===z && cell.y===y && cell.x===x);
}

// ---- セル -> 所属ライン一覧の索引 (109ラインの構造自体は変更せず、参照だけ先に作る) ----
function buildCellLineIndex(){
  const idx = {};
  for(const line of ALL_LINES){
    for(const cell of line.cells){
      const key = cellDomKey(cell.z+1, cell.y, cell.x);
      (idx[key] || (idx[key] = [])).push(line.key);
    }
  }
  return idx;
}
const CELL_LINE_INDEX = buildCellLineIndex();

// ---- 自動ライン診断 (常に現在の盤面から計算。過去の測定結果を記憶するMapは持たない) ----
function diagnoseLine(line){
  return measureLine(repairState, line); // '=' | '↑' | '↓'
}
function diagStatusClass(status){
  if(status === '=') return 'eq';
  if(status === '↑') return 'over';
  return 'under';
}

// 109ライン全部の現在状態(key -> '=' | '↑' | '↓')。描画のたびに作り直す(記憶しない)。
function computeAllLineStatuses(){
  const map = new Map();
  for(const line of ALL_LINES) map.set(line.key, diagnoseLine(line));
  return map;
}

// 全125セルの line-health ('ok' | 'bad')。正解配列とのセル単位比較は一切使わない。
function computeCellHealth(lineStatuses){
  const health = {};
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        const key = cellDomKey(L,r,c);
        const lines = CELL_LINE_INDEX[key] || [];
        const bad = lines.some(lk => lineStatuses.get(lk) !== '=');
        health[key] = bad ? 'bad' : 'ok';
      }
    }
  }
  return health;
}

// ---- 盤面インタラクション ----
function onCellClick(L,r,c){
  if(animating) return;
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
    const source = selectedCell;
    selectedCell = null; // 交換後は交換元選択を解除
    triggerSwap(source, target);
  } else {
    // 1回目の未確定セルクリック、または固定セルクリック(観察対象への切り替え)。
    // どちらの場合も「交換待ち状態の解除」を兼ねる(前の選択を上書きするだけ)。
    selectedCell = target;
    renderAll();
  }
}

function onCellRightClick(){ /* 修復モードでは右クリックに新しい用途を割り当てない(noop) */ }

// ---- 交換 (アニメーション込み。可否判定はonCellClick側で確定済み) ----
function triggerSwap(a, b){
  animating = true;
  document.getElementById('undoBtn').disabled = true;
  history.push({
    state: repairState,
    selectedCell: a,
    highlightedLineKey,
    cleared,
    swapPair: [a, b],
  });

  const valueA = repairGridValue(repairState, a.L, a.r, a.c);
  const valueB = repairGridValue(repairState, b.L, b.r, b.c);

  return animateSwap(a, b, valueA, valueB).then(()=>{
    repairState = swapRepairCells(repairState, a, b);
    checkCompletion();
    renderAll();
    animating = false;
  });
}

function undoSwap(){
  if(animating || history.length === 0) return Promise.resolve();
  const snap = history.pop();
  const [a, b] = snap.swapPair;
  animating = true;
  document.getElementById('undoBtn').disabled = true;

  const valueA = repairGridValue(repairState, a.L, a.r, a.c); // 現在(交換後)の値を戻すアニメーション
  const valueB = repairGridValue(repairState, b.L, b.r, b.c);

  return animateSwap(a, b, valueA, valueB).then(()=>{
    repairState = snap.state;
    selectedCell = snap.selectedCell;
    highlightedLineKey = snap.highlightedLineKey;
    cleared = snap.cleared;
    document.getElementById('clearOverlay').classList.toggle('hidden', !cleared);
    renderAll();
    animating = false;
  });
}

// ---- 交換アニメーション: 2枚のタイルが互いの位置へ移動して見えるようにする ----
// 実SVG要素は動かさず、一時的なfixedバッジをクローンとして重ね、Web Animations APIで
// 移動させる(対応環境がなければ即座にresolveする)。盤面stateはここでは一切変更しない。
function prefersReducedMotion(){
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cellGroupEl(L,r,c){
  return document.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
}

function makeSwapBadge(value, rect){
  const el = document.createElement('div');
  el.className = 'swap-badge';
  el.textContent = value;
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  return el;
}

function animateSwap(a, b, valueA, valueB){
  const aEl = cellGroupEl(a.L,a.r,a.c);
  const bEl = cellGroupEl(b.L,b.r,b.c);
  const aLabel = aEl && aEl.querySelector('.cube-label');
  const bLabel = bEl && bEl.querySelector('.cube-label');

  const duration = prefersReducedMotion() ? 1 : SWAP_ANIM_MS;

  // getBoundingClientRect/animate が使えない環境(一部のテスト環境含む)では、
  // 見た目の演出だけスキップしてタイマーで同じ時間だけ待つ。
  if(!aLabel || !bLabel || typeof aLabel.getBoundingClientRect !== 'function'){
    return new Promise(resolve => setTimeout(resolve, duration));
  }

  const aRect = aLabel.getBoundingClientRect();
  const bRect = bLabel.getBoundingClientRect();

  const cloneA = makeSwapBadge(valueA, aRect);
  const cloneB = makeSwapBadge(valueB, bRect);
  document.body.appendChild(cloneA);
  document.body.appendChild(cloneB);
  aLabel.style.opacity = '0';
  bLabel.style.opacity = '0';

  const dx = bRect.left - aRect.left, dy = bRect.top - aRect.top;

  const cleanup = () => {
    cloneA.remove();
    cloneB.remove();
    aLabel.style.opacity = '';
    bLabel.style.opacity = '';
  };

  if(typeof cloneA.animate !== 'function'){
    return new Promise(resolve => setTimeout(()=>{ cleanup(); resolve(); }, duration));
  }

  try{
    const animA = cloneA.animate(
      [{ transform:'translate(0,0)' }, { transform:`translate(${dx}px, ${dy}px)` }],
      { duration, easing:'ease-in-out', fill:'forwards' }
    );
    const animB = cloneB.animate(
      [{ transform:'translate(0,0)' }, { transform:`translate(${-dx}px, ${-dy}px)` }],
      { duration, easing:'ease-in-out', fill:'forwards' }
    );
    return Promise.race([
      Promise.all([animA.finished, animB.finished]).catch(()=>{}),
      new Promise(resolve => setTimeout(resolve, duration + 60)), // finishedが未対応/失敗した場合の保険
    ]).then(cleanup);
  }catch(err){
    return new Promise(resolve => setTimeout(()=>{ cleanup(); resolve(); }, duration));
  }
}

// ---- HUD診断一覧: チップクリックで強調のトグル ----
function toggleLineHighlight(lineKey){
  highlightedLineKey = (highlightedLineKey === lineKey) ? null : lineKey;
  renderAll();
}

// ---- クリア判定: 全109ラインが315かどうかだけで決める(セル単位の正解比較は使わない) ----
function checkCompletion(){
  const overlay = document.getElementById('clearOverlay');
  const allOk = ALL_LINES.every(line => diagnoseLine(line) === '=');
  cleared = allOk;
  overlay.classList.toggle('hidden', !allOk);
}

function resetPuzzle(){
  repairState = createInitialRepairState();
  selectedCell = null;
  highlightedLineKey = null;
  history = [];
  cleared = false;
  animating = false;
  document.querySelectorAll('.swap-badge').forEach(el => el.remove());
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
  const lineStatuses = computeAllLineStatuses();
  const cellHealth = computeCellHealth(lineStatuses);
  renderBoard(lineStatuses, cellHealth);
  renderHud(lineStatuses);
  document.getElementById('undoBtn').disabled = history.length === 0 || animating;
}

function renderBoard(lineStatuses, cellHealth){
  const highlightLine = highlightedLineKey ? ALL_LINES.find(l=>l.key===highlightedLineKey) : null;
  const highlightClass = highlightLine ? `diag-${diagStatusClass(lineStatuses.get(highlightLine.key))}` : null;

  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        const g = cellGroupEl(L,r,c);
        if(!g) continue;
        const key = cellDomKey(L,r,c);
        g.dataset.key = key;

        const value = repairGridValue(repairState, L, r, c);
        const label = g.querySelector('.cube-label');
        if(label) label.textContent = value;

        const unlocked = isRepairUnlocked(L,r,c);
        g.classList.remove('empty');
        g.classList.toggle('given', !unlocked);
        g.classList.toggle('repair-unlocked', unlocked);
        g.classList.toggle('cell-selected', cellKeyEq(selectedCell, {L,r,c}));

        g.classList.toggle('line-health-ok', cellHealth[key] === 'ok');
        g.classList.toggle('line-health-bad', cellHealth[key] === 'bad');

        g.classList.remove('diag-eq','diag-over','diag-under');
        if(highlightLine && lineTouchesCell(highlightLine, L, r, c)){
          g.classList.add(highlightClass);
        }
      }
    }
  }
}

function renderHud(lineStatuses){
  const titleEl = document.getElementById('hudDiagTitle');
  const linesEl = document.getElementById('hudLineList');

  if(!selectedCell){
    titleEl.innerHTML = 'マスをクリックすると、ここに所属ラインの状態(＝/↑/↓)が表示されます';
    linesEl.innerHTML = '<div class="hud-empty">マス未選択</div>';
    return;
  }

  const { L, r, c } = selectedCell;
  const unlocked = isRepairUnlocked(L,r,c);
  titleEl.innerHTML = `選択中: L${L} 行${r+1} 列${c+1}<span class="tag ${unlocked?'unlocked':''}">${unlocked ? '未確定' : '固定'}</span>`;

  const lines = linesThroughCell(ALL_LINES, L, r, c);
  linesEl.innerHTML = '';
  for(const line of lines){
    const status = lineStatuses.get(line.key);
    const chip = document.createElement('div');
    chip.className = 'hud-chip';
    if(highlightedLineKey === line.key) chip.classList.add('active');
    chip.innerHTML = `<span class="chip-label">${lineLabel(line)}</span><span class="chip-result ${diagStatusClass(status)}">${status}</span>`;
    chip.addEventListener('click', ()=> toggleLineHighlight(line.key));
    linesEl.appendChild(chip);
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
