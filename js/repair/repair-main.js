// repair-main.js — 修復型プロトタイプの状態管理・描画・操作。
// generator.js / render.js の汎用部品(色定数・座標計算・SVG構築)だけを再利用し、
// 出題ロジック(generator.js)へは一切手を入れない。
//
// 操作:
//   左クリック(1回目・未確定セル) : 交換元として選択。まだ交換しない。
//   左クリック(2回目・別の未確定セル) : 選択中セルと交換(タイル面アニメーション付き)。
//   左クリック(選択中セルを再クリック) : 選択解除のみ。
//   左クリック(固定セル)         : 交換待ちを解除し、そのセルを観察対象にする。
//   右クリック                   : 何もしない(将来予約、contextmenuは抑止のみ)。
//   Escape                       : 選択・ラインフォーカスの解除。
//   Ctrl+Z / Cmd+Z                : 直前の有効交換をUndo(巻き戻しアニメーション付き)。
//
// ライン状態(＝/↑/↓)は測定操作ではなく、常に現在の盤面から自動計算する
// (measure.jsのmeasureLineをそのまま毎回呼ぶだけで「測定履歴」は持たない)。
// セルの常時diag輪郭(line-health)は未確定セルだけに付与し、固定セルには付けない。

const ALL_LINES = buildLines109();
const SWAP_ANIM_MS = 220;

// 「盤面の側面・角へ直接表示する60ライン(行・列・層内対角線)」と
// 「選択セル付近にバッジで表示する49ライン(柱・縦断面対角線・空間対角線)」を型で分ける。
const FLAT_LINE_TYPES = new Set(['row','col','xy-main','xy-anti']);
const CROSS_LEVEL_TYPES = new Set(['pillar','xz-main','xz-anti','yz-main','yz-anti','space']);

let repairState = createInitialRepairState();
let selectedCell = null;     // {L,r,c} | null — 観察対象 兼 交換元(未確定セルのときだけ交換元になる)
let highlightedLineKey = null; // 側面ラベル/立体バッジのクリックで選んだラインフォーカス対象
let history = [];            // 有効交換のみのUndoスナップショット({state, selectedCell, highlightedLineKey, cleared, swapPair})
let cleared = false;
let celebrating = false;     // クリア演出(連鎖発光)の最中かどうか
let animating = false;       // タイル交換アニメーション中は追加のクリック/Undo/Resetを無視する
let opGeneration = 0;        // Reset等で進行中の交換/Undo/演出を無効化するための世代番号
// 直前の成功交換で影響したライン別結果(Map<lineKey, 'unchanged'|'solved'|'closer'|'farther'> | null)。
// analyzeAffectedLineChangesの戻り値だけを保持し、正確な合計値・偏差量は持たない。
// セル選択・選択解除・Escapeでは消さない。Undo完了・Reset・次の成功交換の完了時にだけ更新/消去する。
let lastSwapFeedback = null;

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

// line-healthは未確定セルだけが対象(固定セルには一切付与しない)。
function computeCellHealth(lineStatuses){
  const health = {};
  for(const cell of REPAIR_CELLS){
    const key = cellDomKey(cell.L, cell.r, cell.c);
    const lines = CELL_LINE_INDEX[key] || [];
    const bad = lines.some(lk => lineStatuses.get(lk) !== '=');
    health[key] = bad ? 'bad' : 'ok';
  }
  return health;
}

// ---- ライン検索: type・座標から対応を作る(line keyの文字列決め打ちはしない) ----
function findRowLine(L, r){
  const z = L-1;
  return ALL_LINES.find(line => line.type==='row' && line.cells[0].z===z && line.cells[0].y===r);
}
function findColLine(L, c){
  const z = L-1;
  return ALL_LINES.find(line => line.type==='col' && line.cells[0].z===z && line.cells[0].x===c);
}
function findLayerDiagMain(L){
  const z = L-1;
  return ALL_LINES.find(line => line.type==='xy-main' && line.cells[0].z===z);
}
function findLayerDiagAnti(L){
  const z = L-1;
  return ALL_LINES.find(line => line.type==='xy-anti' && line.cells[0].z===z);
}

// ---- 盤面インタラクション ----
function onCellClick(L,r,c){
  if(animating || celebrating) return;
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

// UndoボタンとResetボタンのdisabled状態を一元管理する。
function updateLockUI(){
  const locked = animating || celebrating;
  document.getElementById('undoBtn').disabled = locked || history.length === 0;
  document.getElementById('resetBtn').disabled = locked;
}

// ---- 交換 (アニメーション込み。可否判定はonCellClick側で確定済み) ----
function triggerSwap(a, b){
  animating = true;
  updateLockUI();
  const gen = ++opGeneration;

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
    if(gen !== opGeneration) return; // Resetなどで無効化された古い完了処理は反映しない
    const beforeGrid = repairState; // 交換直前のgrid(再代入前の参照)
    repairState = swapRepairCells(repairState, a, b);
    const feedback = analyzeAffectedLineChanges(ALL_LINES, beforeGrid, repairState, [a, b]);
    lastSwapFeedback = new Map(feedback.map(f => [f.line.key, f.change]));
    highlightedLineKey = null; // 交換確定で古いラインフォーカスを解除する
    animating = false;

    const solved = ALL_LINES.every(line => diagnoseLine(line) === '=');
    if(solved){
      runCelebration(gen);
    } else {
      cleared = false;
      document.getElementById('clearOverlay').classList.add('hidden');
      renderAll();
    }
  });
}

function undoSwap(){
  if(animating || celebrating || history.length === 0) return Promise.resolve();
  const snap = history.pop();
  const [a, b] = snap.swapPair;
  animating = true;
  updateLockUI();
  const gen = ++opGeneration;

  const valueA = repairGridValue(repairState, a.L, a.r, a.c); // 現在(交換後)の値を戻すアニメーション
  const valueB = repairGridValue(repairState, b.L, b.r, b.c);

  return animateSwap(a, b, valueA, valueB).then(()=>{
    if(gen !== opGeneration) return;
    repairState = snap.state;
    selectedCell = snap.selectedCell;
    highlightedLineKey = snap.highlightedLineKey;
    cleared = snap.cleared;
    celebrating = false;
    lastSwapFeedback = null; // Undo完了時は直前結果を消す
    document.getElementById('clearOverlay').classList.toggle('hidden', !cleared);
    animating = false;
    renderAll();
  });
}

// ---- クリア演出: 最後の交換確定後、盤面を一気に緑化するのではなく
// 成立ライン数・未確定セルの見た目切替 -> 上段/中央/下段の順に穏やかな発光 -> オーバーレイ、
// という短い連鎖(reduced-motion以外で約700〜900ms)を経てからクリア表示する。
function runCelebration(gen){
  celebrating = true;
  updateLockUI();
  renderAll(); // 成立ライン109/109・未確定セルの「修復完了」見た目をここで反映する

  const reduced = prefersReducedMotion();
  const stagger = reduced ? 0 : 220;
  const glowDuration = reduced ? 0 : 260;
  const tailWait = reduced ? 0 : 150;
  const groups = [ ['slot-5','slot-4'], ['slot-3'], ['slot-2','slot-1'] ];

  groups.forEach((ids, i) => {
    setTimeout(()=>{
      if(gen !== opGeneration) return;
      for(const id of ids){ const el = document.getElementById(id); if(el) el.classList.add('wave-glow'); }
      setTimeout(()=>{
        if(gen !== opGeneration) return;
        for(const id of ids){ const el = document.getElementById(id); if(el) el.classList.remove('wave-glow'); }
      }, glowDuration);
    }, i*stagger);
  });

  const totalWait = stagger*(groups.length-1) + glowDuration + tailWait;
  setTimeout(()=>{
    if(gen !== opGeneration) return;
    celebrating = false;
    cleared = true;
    document.getElementById('clearOverlay').classList.remove('hidden');
    updateLockUI();
    renderAll();
  }, totalWait);
}

// ---- 交換アニメーション: 2枚の「タイル面」が互いの位置へ移動して見えるようにする ----
// cube-face(菱形)とcube-labelを複製した一時SVGを2枚(ゴースト)作り、Web Animations APIで
// 移動させる。実セルはスロットとしてその場に残し、数字だけを一時的に隠して二重表示を防ぐ。
// 盤面stateはここでは一切変更しない(状態確定はPromise解決後、呼び出し側が行う)。
function prefersReducedMotion(){
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cellGroupEl(L,r,c){
  return document.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
}

// sealed-fixedセルへ小さな単色鍵穴(円+くさび形)を1回だけ追加する。数字や内部値は一切持たせない。
// 既に存在する場合は何もしない(renderAll/Reset/交換で連続呼び出しされても増殖しない)。
function ensureSealedKeyhole(g, labelEl){
  if(g.querySelector('.cell-keyhole')) return;
  if(!labelEl) return;
  const cx = parseFloat(labelEl.getAttribute('x'));
  const cy = parseFloat(labelEl.getAttribute('y'));
  if(Number.isNaN(cx) || Number.isNaN(cy)) return;

  const kh = document.createElementNS('http://www.w3.org/2000/svg','g');
  kh.setAttribute('class','cell-keyhole');
  kh.setAttribute('pointer-events','none');
  kh.setAttribute('aria-hidden','true');

  const hole = document.createElementNS('http://www.w3.org/2000/svg','circle');
  const holeR = 2.6, holeCy = cy - 2.4;
  hole.setAttribute('cx', cx);
  hole.setAttribute('cy', holeCy);
  hole.setAttribute('r', holeR);
  kh.appendChild(hole);

  const stemTopY = holeCy + holeR * 0.55, stemBottomY = cy + 6.5;
  const stemTopHalfW = 1.5, stemBottomHalfW = 3.2;
  const stem = document.createElementNS('http://www.w3.org/2000/svg','path');
  stem.setAttribute('d',
    `M ${cx - stemTopHalfW} ${stemTopY} `+
    `L ${cx + stemTopHalfW} ${stemTopY} `+
    `L ${cx + stemBottomHalfW} ${stemBottomY} `+
    `L ${cx - stemBottomHalfW} ${stemBottomY} Z`);
  kh.appendChild(stem);

  g.appendChild(kh);
}

function makeTileGhost(faceEl, labelEl, value, rect){
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','swap-ghost');
  let bbox;
  try{ bbox = faceEl.getBBox(); }catch(e){ bbox = { x:0, y:0, width:1, height:1 }; }
  const pad = Math.max(bbox.width, bbox.height) * 0.06;
  svg.setAttribute('viewBox', `${bbox.x-pad} ${bbox.y-pad} ${bbox.width+pad*2} ${bbox.height+pad*2}`);
  svg.style.left = rect.left + 'px';
  svg.style.top = rect.top + 'px';
  svg.style.width = rect.width + 'px';
  svg.style.height = rect.height + 'px';

  const face = faceEl.cloneNode(true);
  // 移動中に下の盤面が透けないよう、複製した面だけ不透明度を引き上げる(元セルには触れない)。
  face.setAttribute('fill-opacity', '0.96');
  svg.appendChild(face);
  const label = labelEl.cloneNode(true);
  label.textContent = value;
  svg.appendChild(label);
  return svg;
}

function animateSwap(a, b, valueA, valueB){
  const aEl = cellGroupEl(a.L,a.r,a.c);
  const bEl = cellGroupEl(b.L,b.r,b.c);
  const aFace = aEl && aEl.querySelector('.cube-face');
  const bFace = bEl && bEl.querySelector('.cube-face');
  const aLabel = aEl && aEl.querySelector('.cube-label');
  const bLabel = bEl && bEl.querySelector('.cube-label');

  const duration = prefersReducedMotion() ? 1 : SWAP_ANIM_MS;

  if(!aFace || !bFace || !aLabel || !bLabel || typeof aFace.getBoundingClientRect !== 'function'){
    return new Promise(resolve => setTimeout(resolve, duration));
  }

  const aRect = aFace.getBoundingClientRect();
  const bRect = bFace.getBoundingClientRect();

  const ghostA = makeTileGhost(aFace, aLabel, valueA, aRect);
  const ghostB = makeTileGhost(bFace, bLabel, valueB, bRect);
  document.body.appendChild(ghostA);
  document.body.appendChild(ghostB);
  aLabel.style.opacity = '0';
  bLabel.style.opacity = '0';

  const dx = bRect.left - aRect.left, dy = bRect.top - aRect.top;

  const cleanup = () => {
    ghostA.remove();
    ghostB.remove();
    aLabel.style.opacity = '';
    bLabel.style.opacity = '';
  };

  if(typeof ghostA.animate !== 'function'){
    return new Promise(resolve => setTimeout(()=>{ cleanup(); resolve(); }, duration));
  }

  // 中間点でscaleを少し上げ、上下に互い違いへずらして完全な重なりを避ける。
  const midLiftA = -12, midLiftB = 12;
  try{
    const kfA = [
      { transform:'translate(0px,0px) scale(1)', offset:0 },
      { transform:`translate(${dx/2}px, ${dy/2 + midLiftA}px) scale(1.1)`, offset:0.5 },
      { transform:`translate(${dx}px, ${dy}px) scale(1)`, offset:1 },
    ];
    const kfB = [
      { transform:'translate(0px,0px) scale(1)', offset:0 },
      { transform:`translate(${-dx/2}px, ${-dy/2 + midLiftB}px) scale(1.1)`, offset:0.5 },
      { transform:`translate(${-dx}px, ${-dy}px) scale(1)`, offset:1 },
    ];
    const animA = ghostA.animate(kfA, { duration, easing:'ease-in-out', fill:'forwards' });
    const animB = ghostB.animate(kfB, { duration, easing:'ease-in-out', fill:'forwards' });
    return Promise.race([
      Promise.all([animA.finished, animB.finished]).catch(()=>{}),
      new Promise(resolve => setTimeout(resolve, duration + 60)), // finished未対応/失敗時の保険
    ]).then(cleanup);
  }catch(err){
    return new Promise(resolve => setTimeout(()=>{ cleanup(); resolve(); }, duration));
  }
}

// ---- ラインフォーカスのトグル(側面ラベル・ヒットボックス・立体バッジ共通) ----
function toggleLineHighlight(lineKey){
  highlightedLineKey = (highlightedLineKey === lineKey) ? null : lineKey;
  renderAll();
}

function resetPuzzle(){
  if(animating || celebrating) return; // 進行中の交換/演出を壊さない
  opGeneration++;        // 残っている完了処理・演出タイマーを無効化する安全弁
  repairState = createInitialRepairState();
  selectedCell = null;
  highlightedLineKey = null;
  history = [];
  cleared = false;
  celebrating = false;
  lastSwapFeedback = null; // Reset時は直前結果を消す
  document.querySelectorAll('.swap-ghost').forEach(el => el.remove());
  document.querySelectorAll('.level-slot.wave-glow').forEach(el => el.classList.remove('wave-glow'));
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
  renderFlatLineLabels(lineStatuses);
  renderCrossLevelBadges(lineStatuses);
  renderLastSwapFeedback();
  renderProgress(lineStatuses);
  updateLockUI();
}

function renderBoard(lineStatuses, cellHealth){
  const highlightLine = highlightedLineKey ? ALL_LINES.find(l=>l.key===highlightedLineKey) : null;
  const finalized = cleared || celebrating; // クリア(演出中含む)後は診断輪郭を消し、修復完了の見た目にする

  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++){
      for(let c=0;c<N;c++){
        const g = cellGroupEl(L,r,c);
        if(!g) continue;
        const key = cellDomKey(L,r,c);
        g.dataset.key = key;

        const state = cellPresentationState(L,r,c); // 'movable' | 'revealed-fixed' | 'sealed-fixed'
        const unlocked = state === 'movable';
        const value = repairGridValue(repairState, L, r, c);
        const label = g.querySelector('.cube-label');
        if(label) label.textContent = state === 'sealed-fixed' ? '' : value;

        if(state === 'sealed-fixed'){
          ensureSealedKeyhole(g, label);
        } else {
          const existingKeyhole = g.querySelector('.cell-keyhole');
          if(existingKeyhole) existingKeyhole.remove();
        }

        g.classList.remove('empty');
        g.classList.toggle('given', !unlocked);
        g.classList.toggle('repair-unlocked', unlocked);
        g.classList.toggle('repair-revealed-fixed', state === 'revealed-fixed');
        g.classList.toggle('repair-completed', unlocked && finalized);
        g.classList.toggle('cell-selected', cellKeyEq(selectedCell, {L,r,c}));

        g.classList.toggle('line-health-ok', !finalized && cellHealth[key] === 'ok');
        g.classList.toggle('line-health-bad', !finalized && cellHealth[key] === 'bad');

        g.classList.remove('line-focus-target','line-focus-dimmed');
        if(highlightLine){
          g.classList.add(lineTouchesCell(highlightLine, L, r, c) ? 'line-focus-target' : 'line-focus-dimmed');
        }
      }
    }
  }
}

// 直接の子テキストノードだけを書き換える(<title>子要素をtextContent代入で巻き込んで消さない)。
function setDirectText(el, text){
  let node = null;
  for(const child of el.childNodes){
    if(child.nodeType === 3){ node = child; break; }
  }
  if(node) node.textContent = text;
  else el.insertBefore(document.createTextNode(text), el.firstChild);
}

// Prototype 06: 現在偏差の2段階bandを、テキストラベル脇の縦積み点(SVG円)で表示する。
// 位置はテキストの実測bbox(getBBox)から算出する(推定幅には依存しない)。
// jsdom等getBBox非対応環境ではtry/catchでフォールバックし、例外を投げない。
// 直前交換のcloser/fartherは、点列の外側(上下)へ向き付きの山形(SVG path)で示す。
// closer: 上山形は下向き、下山形は上向き(点列へ収束)。farther: 逆向き(点列から拡散)。
// 山形はband(点の縦配置)の外側位置に置くだけで、横位置(x)・インジケーター幅は変えない。
const BAND_DOT_GAP = 5;
const BAND_DOT_OFFSET = 4.6; // band2: 中央から上下への点オフセット(半径2.8に対し縁が明確に分離するよう設定)
const CHEVRON_HALF_W = 3.6, CHEVRON_H = 2.3, CHEVRON_GAP = 3.6;
// 矢印＋余白＋点列の複合記号全体をライン中央へ配置するため、indicator-group全体をこの分だけ
// 左へシフトする(band1/2で横幅を変えないよう、実測ではなく固定の予約幅を使う)。
const INDICATOR_COLUMN_WIDTH = CHEVRON_HALF_W * 2;
const COMPOSITE_HALF_SHIFT = (BAND_DOT_GAP + INDICATOR_COLUMN_WIDTH) / 2;
// ＝記号(水平線2本)の寸法。フォント文字の＝(黒いstrokeで潰れる)を置き換える。
const EQ_HALF_W = 7, EQ_GAP = 3;

function chevronPath(cx, cy, pointing){
  // pointing:'up' => ^ 形状(頂点が上), 'down' => v 形状(頂点が下)
  const apexY = pointing === 'up' ? cy - CHEVRON_H : cy + CHEVRON_H;
  const baseY = pointing === 'up' ? cy + CHEVRON_H : cy - CHEVRON_H;
  return `M ${cx - CHEVRON_HALF_W} ${baseY} L ${cx} ${apexY} L ${cx + CHEVRON_HALF_W} ${baseY}`;
}

// indicator-group全体の中央揃えtransformを設定する。text-anchor='middle'の要素だけを
// COMPOSITE_HALF_SHIFT分左へシフトし、複合記号(矢印+点列)の全体中心を元のアンカー位置へ揃える。
// text-anchor='start'(diag-sum-anti)は元々アンカーが開始位置のため、シフトしない。
// dots/chevronを表示しない状態(＝表示または非表示)ではシフトを解除する。
function updateCompositeCentering(group, textEl, showDots){
  if(!group) return;
  const anchorMode = textEl.getAttribute('text-anchor');
  if(showDots && anchorMode === 'middle'){
    group.setAttribute('transform', `translate(${-COMPOSITE_HALF_SHIFT},0)`);
  } else {
    group.removeAttribute('transform');
  }
}

// ＝記号(水平線2本)の表示/非表示・位置を更新する。テキストのx/y属性(アンカー)を基準に置く。
// text-anchor='start'の場合はアンカーから右へ、'middle'の場合はアンカーを中心に描く。
function updateEqSymbol(eqEl, textEl, show){
  if(!eqEl) return;
  if(!show){ eqEl.style.display = 'none'; return; }
  const ax = parseFloat(textEl.getAttribute('x'));
  const ay = parseFloat(textEl.getAttribute('y'));
  const anchorMode = textEl.getAttribute('text-anchor');
  const x1 = anchorMode === 'start' ? ax : ax - EQ_HALF_W;
  const x2 = anchorMode === 'start' ? ax + EQ_HALF_W * 2 : ax + EQ_HALF_W;
  const bar1 = eqEl.querySelector('.eq-bar-1');
  const bar2 = eqEl.querySelector('.eq-bar-2');
  if(bar1){ bar1.setAttribute('x1', x1); bar1.setAttribute('x2', x2); bar1.setAttribute('y1', ay - EQ_GAP); bar1.setAttribute('y2', ay - EQ_GAP); }
  if(bar2){ bar2.setAttribute('x1', x1); bar2.setAttribute('x2', x2); bar2.setAttribute('y1', ay + EQ_GAP); bar2.setAttribute('y2', ay + EQ_GAP); }
  eqEl.style.display = '';
}

function updateBandIndicator(indicatorEl, textEl, band, statClass, change){
  if(!indicatorEl) return;
  const chevronTop = indicatorEl.querySelector('.band-chevron-top');
  const chevronBottom = indicatorEl.querySelector('.band-chevron-bottom');
  if(!band){
    indicatorEl.style.display = 'none';
    if(chevronTop) chevronTop.style.display = 'none';
    if(chevronBottom) chevronBottom.style.display = 'none';
    return;
  }
  indicatorEl.style.display = '';
  indicatorEl.classList.remove('stat-over','stat-under');
  if(statClass) indicatorEl.classList.add(`stat-${statClass}`);

  let bbox;
  try{ bbox = textEl.getBBox(); }catch(e){ bbox = { x:0, y:0, width:0, height:0 }; }
  const dotX = bbox.x + bbox.width + BAND_DOT_GAP;
  const centerY = bbox.y + bbox.height/2;
  const dot1 = indicatorEl.querySelector('.band-dot-1');
  const dot2 = indicatorEl.querySelector('.band-dot-2');
  let topY, bottomY;
  if(band === 1){
    if(dot1){ dot1.setAttribute('cx', dotX); dot1.setAttribute('cy', centerY); dot1.style.display = ''; }
    if(dot2) dot2.style.display = 'none';
    topY = centerY; bottomY = centerY;
  } else {
    if(dot1){ dot1.setAttribute('cx', dotX); dot1.setAttribute('cy', centerY - BAND_DOT_OFFSET); dot1.style.display = ''; }
    if(dot2){ dot2.setAttribute('cx', dotX); dot2.setAttribute('cy', centerY + BAND_DOT_OFFSET); dot2.style.display = ''; }
    topY = centerY - BAND_DOT_OFFSET; bottomY = centerY + BAND_DOT_OFFSET;
  }

  const showChevrons = change === 'closer' || change === 'farther';
  if(!showChevrons){
    if(chevronTop) chevronTop.style.display = 'none';
    if(chevronBottom) chevronBottom.style.display = 'none';
    return;
  }
  const topPointing = change === 'closer' ? 'down' : 'up';
  const bottomPointing = change === 'closer' ? 'up' : 'down';
  if(chevronTop){
    chevronTop.setAttribute('d', chevronPath(dotX, topY - CHEVRON_GAP, topPointing));
    chevronTop.style.display = '';
  }
  if(chevronBottom){
    chevronBottom.setAttribute('d', chevronPath(dotX, bottomY + CHEVRON_GAP, bottomPointing));
    chevronBottom.style.display = '';
  }
}

// 行・列・層内対角線(60本): 315のラインは記号非表示・操作不能にし、不成立(↑/↓)だけ
// 記号とヒットボックス(側面区画/対角線ハンドル)をクリック可能にする。
function applyFlatLabel(el, hit, line, lineStatuses, indicator, eqSymbol, group){
  if(!line) return;
  const status = lineStatuses.get(line.key);
  const change = lastSwapFeedback ? lastSwapFeedback.get(line.key) : undefined;
  el.classList.remove('stat-over','stat-under');

  if(status === '=' && change === undefined){
    setDirectText(el, '');
    el.style.pointerEvents = 'none';
    delete el.dataset.lineKey;
    delete el.dataset.swapChange;
    if(hit){ hit.style.pointerEvents = 'none'; delete hit.dataset.lineKey; }
    const title = el.querySelector('title');
    if(title) title.remove();
    updateBandIndicator(indicator, el, 0, null, undefined);
    updateEqSymbol(eqSymbol, el, false);
    updateCompositeCentering(group, el, false);
    return;
  }

  if(status !== '='){
    el.classList.add(`stat-${diagStatusClass(status)}`);
  }

  // ＝は黒く潰れやすいフォント文字ではなく、eq-symbol(水平線2本)で表す。↑/↓は従来どおり文字。
  setDirectText(el, status === '=' ? '' : status);
  if(change !== undefined) el.dataset.swapChange = change;
  else delete el.dataset.swapChange;

  if(status === '='){
    // 通常は非表示の成立ラインだが、直前結果がある間だけ一時的に表示する(クリック対象にはしない)。
    el.style.pointerEvents = 'none';
    delete el.dataset.lineKey;
    if(hit){ hit.style.pointerEvents = 'none'; delete hit.dataset.lineKey; }
    const title = el.querySelector('title');
    if(title) title.remove();
    updateBandIndicator(indicator, el, 0, null, undefined);
    updateEqSymbol(eqSymbol, el, true);
    updateCompositeCentering(group, el, false);
    return;
  }

  el.style.pointerEvents = 'auto';
  el.dataset.lineKey = line.key;
  if(hit){ hit.style.pointerEvents = 'auto'; hit.dataset.lineKey = line.key; }

  let title = el.querySelector('title');
  if(!title){
    title = document.createElementNS('http://www.w3.org/2000/svg','title');
    el.appendChild(title);
  }
  const meaning = status === '↑' ? '315超過' : '315未満';
  title.textContent = `${lineLabel(line)}: ${meaning} — クリックで対象5マスを強調`;

  const band = classifyDeviationBand(lineSum(repairState, line)).band;
  updateBandIndicator(indicator, el, band, diagStatusClass(status), change);
  updateEqSymbol(eqSymbol, el, false);
  updateCompositeCentering(group, el, true);
}

function renderFlatLineLabels(lineStatuses){
  document.querySelectorAll('.row-wall-label').forEach(el=>{
    const L = Number(el.dataset.l), r = Number(el.dataset.r);
    const hit = document.querySelector(`.row-wall-hit[data-l="${L}"][data-r="${r}"]`);
    const group = el.parentNode;
    const indicator = group.querySelector('.row-wall-band');
    const eqSymbol = group.querySelector('.row-wall-eq');
    applyFlatLabel(el, hit, findRowLine(L, r), lineStatuses, indicator, eqSymbol, group);
  });
  document.querySelectorAll('.col-wall-label').forEach(el=>{
    const L = Number(el.dataset.l), c = Number(el.dataset.c);
    const hit = document.querySelector(`.col-wall-hit[data-l="${L}"][data-c="${c}"]`);
    const group = el.parentNode;
    const indicator = group.querySelector('.col-wall-band');
    const eqSymbol = group.querySelector('.col-wall-eq');
    applyFlatLabel(el, hit, findColLine(L, c), lineStatuses, indicator, eqSymbol, group);
  });
  document.querySelectorAll('.diag-sum-main').forEach(el=>{
    const L = Number(el.dataset.l);
    const hit = document.querySelector(`.diag-hit-main[data-l="${L}"]`);
    const group = el.parentNode;
    const indicator = group.querySelector('.diag-band-main');
    const eqSymbol = group.querySelector('.diag-eq-main');
    applyFlatLabel(el, hit, findLayerDiagMain(L), lineStatuses, indicator, eqSymbol, group);
  });
  document.querySelectorAll('.diag-sum-anti').forEach(el=>{
    const L = Number(el.dataset.l);
    const hit = document.querySelector(`.diag-hit-anti[data-l="${L}"]`);
    const group = el.parentNode;
    const indicator = group.querySelector('.diag-band-anti');
    const eqSymbol = group.querySelector('.diag-eq-anti');
    applyFlatLabel(el, hit, findLayerDiagAnti(L), lineStatuses, indicator, eqSymbol, group);
  });
}

// wall-label/edge-label/ヒットボックスのクリックリスナーはDOM要素が使い回されるため
// 一度だけ登録する。クリック時点のdataset.lineKeyを参照するので、後から状態が
// 変わっても(315に戻って操作不能になっても)正しく追従する。
function wireFlatLineLabels(){
  const selectors = ['.row-wall-label','.col-wall-label','.diag-sum-main','.diag-sum-anti','.row-wall-hit','.col-wall-hit','.diag-hit'];
  document.querySelectorAll(selectors.join(',')).forEach(el=>{
    el.addEventListener('click', ()=>{
      const key = el.dataset.lineKey;
      if(key) toggleLineHighlight(key);
    });
  });
}

// 階層横断badge(HTML)向け: 矢印(または＝のbar要素)・band点・(必要なら)closer/farther山形を
// まとめて組み立てる共通helper。SVG側(updateBandIndicator/updateEqSymbol)と同じ規則:
// closerは上=下向き/下=上向き(収束)、fartherは逆(拡散)。＝は黒く潰れやすいフォント文字ではなく
// bar要素2本(eq-symbol-html)で表す。changeがcloser/fartherでない場合は山形を出さない。
// 正確な合計・偏差量は一切含めない。
function buildCbResultHtml(status, band, change){
  if(status === '='){
    return `<span class="eq-symbol-html"><span class="eq-bar-html"></span><span class="eq-bar-html"></span></span>`;
  }
  const arrowHtml = `<span class="cb-arrow">${status}</span>`;
  if(!band) return arrowHtml;
  const dotsClass = band === 2 ? 'show-2' : 'show-1';
  const showChevrons = change === 'closer' || change === 'farther';
  const topDir = change === 'closer' ? 'down' : 'up';
  const bottomDir = change === 'closer' ? 'up' : 'down';
  const chevronTopHtml = showChevrons ? `<span class="band-chevron-html ${topDir}"></span>` : '';
  const chevronBottomHtml = showChevrons ? `<span class="band-chevron-html ${bottomDir}"></span>` : '';
  return `${arrowHtml}<span class="band-indicator ${dotsClass}">${chevronTopHtml}<span class="band-dot band-dot-1"></span><span class="band-dot band-dot-2"></span>${chevronBottomHtml}</span>`;
}

// 柱・縦断面対角線・空間対角線(49本): 選択セルを通るものだけを、セル付近のバッジで表示する。
// 位置は推定サイズではなく、実際に生成したバッジのgetBoundingClientRect()で測って
// board-areaの矩形内(上下左右8px以上の余白)へ収まるようclampする。
function renderCrossLevelBadges(lineStatuses){
  const container = document.getElementById('crossLevelBadges');
  container.innerHTML = '';

  if(!selectedCell){
    container.style.display = 'none';
    return;
  }
  const { L, r, c } = selectedCell;
  const lines = linesThroughCell(ALL_LINES, L, r, c).filter(line => CROSS_LEVEL_TYPES.has(line.type));
  if(lines.length === 0){
    container.style.display = 'none';
    return;
  }

  const cellEl = cellGroupEl(L,r,c);
  const face = cellEl && cellEl.querySelector('.cube-face');
  const boardArea = document.querySelector('.board-area');
  if(!face || !boardArea || typeof face.getBoundingClientRect !== 'function'){
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  for(const line of lines){
    const status = lineStatuses.get(line.key);
    const badge = document.createElement('div');
    badge.className = 'cross-badge';
    if(highlightedLineKey === line.key) badge.classList.add('active');
    const band = status === '=' ? 0 : classifyDeviationBand(lineSum(repairState, line)).band;
    badge.innerHTML = `<span class="cb-label">${lineLabel(line)}</span><span class="cb-result ${diagStatusClass(status)}">${buildCbResultHtml(status, band, undefined)}</span>`;
    const meaning = status === '=' ? '315(整合)' : status === '↑' ? '315超過' : '315未満';
    badge.title = `${lineLabel(line)}: ${meaning}`;
    badge.addEventListener('click', ()=> toggleLineHighlight(line.key));
    container.appendChild(badge);
  }

  const faceRect = face.getBoundingClientRect();
  const boardRect = boardArea.getBoundingClientRect();
  const badgeRect = container.getBoundingClientRect(); // 実測サイズ(推定幅には依存しない)
  const MARGIN = 8;
  const w = badgeRect.width, h = badgeRect.height;

  let left = faceRect.right - boardRect.left + 10;
  let top = faceRect.top - boardRect.top;

  if(left + w > boardRect.width - MARGIN){
    left = faceRect.left - boardRect.left - w - 10; // 右に収まらないので左側へ
  }
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, boardRect.width - MARGIN - w));

  if(top + h > boardRect.height - MARGIN){
    top = boardRect.height - MARGIN - h;
  }
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, boardRect.height - MARGIN - h));

  container.style.left = left + 'px';
  container.style.top = top + 'px';
}

// 直前の成功交換で影響した「階層横断49ライン」だけを、selectedCellに依存しない固定panelへ表示する。
// 通常のcrossLevelBadges(選択セル追従・毎回全消去)とは別要素・別ライフサイクル。
// lastSwapFeedbackが更新/消去されるたびにrenderAll経由で呼ばれ、そのまま追従する。
function renderLastSwapFeedback(){
  const panel = document.getElementById('lastSwapFeedback');
  const itemsContainer = document.getElementById('lastSwapFeedbackItems');
  itemsContainer.innerHTML = '';

  const crossEntries = lastSwapFeedback
    ? [...lastSwapFeedback.entries()]
        .map(([lineKey, change]) => ({ line: ALL_LINES.find(l=>l.key===lineKey), change }))
        .filter(e => e.line && CROSS_LEVEL_TYPES.has(e.line.type))
    : [];

  if(crossEntries.length === 0){
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  for(const { line, change } of crossEntries){
    const status = diagnoseLine(line);
    const badge = document.createElement('div');
    badge.className = 'cross-badge';
    badge.dataset.lineKey = line.key;
    badge.dataset.swapChange = change;
    const label = document.createElement('span');
    label.className = 'cb-label';
    label.textContent = lineLabel(line);
    const result = document.createElement('span');
    result.className = `cb-result ${diagStatusClass(status)}`;
    const band = status === '=' ? 0 : classifyDeviationBand(lineSum(repairState, line)).band;
    result.innerHTML = buildCbResultHtml(status, band, change);
    badge.appendChild(label);
    badge.appendChild(result);
    badge.addEventListener('click', ()=> toggleLineHighlight(line.key));
    itemsContainer.appendChild(badge);
  }
}

// サイドバーの成立ライン総数(ALL_LINESの独立集計。盤面/LEVEL表示へは出さない)。
function renderProgress(lineStatuses){
  const solved = ALL_LINES.reduce((acc, line) => acc + (lineStatuses.get(line.key) === '=' ? 1 : 0), 0);
  const countEl = document.getElementById('solvedLineCount');
  const container = document.getElementById('lineProgress');
  if(countEl) countEl.textContent = solved;
  if(container) container.classList.toggle('complete', solved === ALL_LINES.length);
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
  wireFlatLineLabels();
  renderAll();
  document.getElementById('resetBtn').addEventListener('click', resetPuzzle);
  document.getElementById('undoBtn').addEventListener('click', undoSwap);
  document.getElementById('clearCloseBtn').addEventListener('click', ()=>{
    document.getElementById('clearOverlay').classList.add('hidden');
  });
  document.addEventListener('keydown', onKeyDown);
});
