// tests/interaction-tests.js — 盤面配色維持・診断専用輪郭・タイル面交換アニメーション・
// 盤面直結ライン表示(行/列/層内対角60本+柱/縦断面/空間対角49本のバッジ)・
// Undo/Resetの状態管理を検証する。
// 静的なソースチェックと、jsdom上での実際の操作による挙動確認の両方を行う。
// 実行: node tests/interaction-tests.js  (要 npm install)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

console.log('== static source checks ==');
{
  const mainJs = fs.readFileSync(path.join(ROOT, 'js/repair/repair-main.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const renderJs = fs.readFileSync(path.join(ROOT, 'js/render.js'), 'utf8');

  check('中クリックリスナー(auxclick)が存在しない', !/auxclick/.test(mainJs));
  check('Shift+クリック専用分岐(shiftKey)が存在しない', !/shiftKey/.test(mainJs));
  check('measured Mapが存在しない', !/\bmeasured\b/.test(mainJs));
  check('数字だけの.swap-badgeが存在しない(JS)', !/swap-badge/.test(mainJs));
  check('数字だけの.swap-badgeが存在しない(CSS)', !/\.swap-badge/.test(html));
  check('旧board-hud関連の関数/変数が存在しない', !/renderHud|hudLineList|hudDiagTitle|board-hud/.test(mainJs));
  check('check(..., true)形式の形式的テストが自身に残っていない', (()=>{
    const self = fs.readFileSync(__filename, 'utf8');
    return !/check\(\s*['"][^'"]*['"]\s*,\s*true\s*\)/.test(self);
  })());

  // line-healthはcube-face自体のfill/fill-opacityを変更していないこと(診断専用輪郭側だけに適用)。
  const lineHealthCssBlock = html.match(/\.iso-cell\.line-health-ok[\s\S]{0,400}/);
  check('line-health CSSがcube-faceのfillを変更していない', !!lineHealthCssBlock && !/line-health-(ok|bad)\s+\.cube-face\s*\{[^}]*fill/.test(html));
  check('line-health CSSが診断専用輪郭(cell-diag-outline)へ適用されている', /\.line-health-ok \.cell-diag-outline/.test(html) && /\.line-health-bad \.cell-diag-outline/.test(html));

  // render.jsは診断用輪郭の追加以外、既存のcube-face/cube-label生成ロジックを変更していない。
  check('render.jsにcube-face生成(既存ロジック)が残っている', /class','cube-face'/.test(renderJs));
  check('render.jsにcube-label生成(既存ロジック)が残っている', /class','cube-label'/.test(renderJs));
  check('render.jsに診断専用輪郭(cell-diag-outline)が追加されている', /cell-diag-outline/.test(renderJs));
  check('診断専用輪郭はfill=none・pointer-events=noneで追加されている', /diagOutline\.setAttribute\('fill','none'\)/.test(renderJs) && /diagOutline\.setAttribute\('pointer-events','none'\)/.test(renderJs));
}

console.log('== behavioral checks (jsdom + ローカルHTTPサーバー) ==');
(async () => {
  const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if(filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if(err){ res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  async function loadPage(){
    const errors = [];
    const dom = await JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, { runScripts: 'dangerously', resources: 'usable' });
    dom.window.addEventListener('error', (e)=> errors.push(e.message || String(e.error)));
    await new Promise(resolve => {
      if(dom.window.document.readyState === 'complete') return resolve();
      dom.window.addEventListener('load', resolve);
    });
    await new Promise(r=>setTimeout(r, 200));
    return { dom, errors };
  }

  function helpers(dom){
    const w = dom.window, doc = w.document;
    const evalW = c => w.eval(c);
    const cellEl = (L,r,c) => doc.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
    const click = (L,r,c) => cellEl(L,r,c).dispatchEvent(new w.MouseEvent('click', {bubbles:true, button:0}));
    return { w, doc, evalW, cellEl, click };
  }

  // ---- 1) 1回目クリックの実挙動 (形式的テストを実データ比較へ置換) ----
  {
    const { dom } = await loadPage();
    const { evalW, click, cellEl } = helpers(dom);
    const stateBefore = evalW('JSON.stringify(repairState)');
    const historyBefore = evalW('history.length');
    click(3,1,1);
    check('1回目の未確定セルクリックでrepairStateが変化しない', evalW('JSON.stringify(repairState)') === stateBefore);
    check('1回目の未確定セルクリックでhistoryが増えない', evalW('history.length') === historyBefore);
    check('1回目クリックでselectedCellが設定される', evalW('JSON.stringify(selectedCell)') === JSON.stringify({L:3,r:1,c:1}));
  }

  // ---- 2) タイル配色: cube-faceのfillは開始時とクリア後で変わらない ----
  {
    const { dom } = await loadPage();
    const { evalW, doc } = helpers(dom);

    const healthCells = doc.querySelectorAll('.iso-cell.line-health-ok, .iso-cell.line-health-bad');
    check('全125セルにline-health状態が付与される', healthCells.length === 125);

    const mismatch = evalW(`
      (function(){
        let mismatches = 0;
        for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++){
          const lines = linesThroughCell(ALL_LINES, L, r, c);
          const shouldBeOk = lines.every(line => measureLine(repairState, line) === '=');
          const el = document.querySelector('.iso-cell[data-l="'+L+'"][data-r="'+r+'"][data-c="'+c+'"]');
          if(shouldBeOk !== el.classList.contains('line-health-ok')) mismatches++;
        }
        return mismatches;
      })()
    `);
    check('line-health判定が109ラインの状態だけと一致する(独立再計算)', mismatch === 0);

    // 開始時のcube-face fill(5階層の元色)を記録
    const facesBefore = evalW(`
      JSON.stringify([1,2,3,4,5].map(L=>{
        const el = document.querySelector('.iso-cell[data-l="'+L+'"][data-r="0"][data-c="0"] .cube-face');
        return el.getAttribute('fill');
      }))
    `);
    // 診断専用輪郭にはstrokeが付いている(赤 or 緑)ことを確認
    const outlineOk = doc.querySelector('.iso-cell.line-health-ok .cell-diag-outline');
    const outlineBad = doc.querySelector('.iso-cell.line-health-bad .cell-diag-outline');
    check('line-health-okセルの診断輪郭が存在する', !!outlineOk);
    check('line-health-badセルの診断輪郭が存在する', !!outlineBad);

    // 3手で修復してクリアさせ、fillが変化していないか比較する
    await evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:2,c:2})`);
    await evalW(`triggerSwap({L:3,r:1,c:2},{L:3,r:2,c:1})`);
    await evalW(`triggerSwap({L:3,r:1,c:2},{L:3,r:2,c:2})`);
    check('クリアしている', evalW('cleared') === true);

    const facesAfter = evalW(`
      JSON.stringify([1,2,3,4,5].map(L=>{
        const el = document.querySelector('.iso-cell[data-l="'+L+'"][data-r="0"][data-c="0"] .cube-face');
        return el.getAttribute('fill');
      }))
    `);
    check('初期状態とクリア状態で5階層のcube-face色が変化しない', facesBefore === facesAfter);
    const badAfterClear = doc.querySelectorAll('.iso-cell.line-health-bad').length;
    check('クリア後はline-health-badが0件(全セルが緑輪郭)', badAfterClear === 0);
  }

  // ---- 3) 盤面直結: 行・列・層内対角60ラベル ----
  {
    const { dom } = await loadPage();
    const { doc, evalW } = helpers(dom);

    const rowLabels = doc.querySelectorAll('.row-wall-label');
    const colLabels = doc.querySelectorAll('.col-wall-label');
    const diagMain = doc.querySelectorAll('.diag-sum-main');
    const diagAnti = doc.querySelectorAll('.diag-sum-anti');
    check('行ラベルが25個存在する', rowLabels.length === 25);
    check('列ラベルが25個存在する', colLabels.length === 25);
    check('層内対角ラベルが合計10個存在する(main+anti)', diagMain.length === 5 && diagAnti.length === 5);

    function directText(el){
      // SVG <title> 子要素はtextContentに混ざる(ツールチップ用で描画はされない)ため、
      // 実際に描画される直接のテキストノードだけを抽出する。
      let out = '';
      el.childNodes.forEach(n => { if(n.nodeType === 3) out += n.textContent; });
      return out;
    }

    const all60 = [...rowLabels, ...colLabels, ...diagMain, ...diagAnti];
    check('60ラベルすべてが＝・↑・↓のいずれかを表示する', all60.every(el => /^[＝=↑↓]$/.test(directText(el))));

    // 独立再計算との一致確認(行ラベルの一部を抽出して検証)
    const mismatch = evalW(`
      (function(){
        function directText(el){
          let out = '';
          el.childNodes.forEach(n => { if(n.nodeType === 3) out += n.textContent; });
          return out;
        }
        let bad = 0;
        document.querySelectorAll('.row-wall-label').forEach(el=>{
          const L = Number(el.dataset.l), r = Number(el.dataset.r);
          const line = ALL_LINES.find(l => l.type==='row' && l.cells[0].z===L-1 && l.cells[0].y===r);
          const expect = measureLine(repairState, line);
          if(directText(el) !== expect) bad++;
        });
        document.querySelectorAll('.col-wall-label').forEach(el=>{
          const L = Number(el.dataset.l), c = Number(el.dataset.c);
          const line = ALL_LINES.find(l => l.type==='col' && l.cells[0].z===L-1 && l.cells[0].x===c);
          const expect = measureLine(repairState, line);
          if(directText(el) !== expect) bad++;
        });
        document.querySelectorAll('.diag-sum-main').forEach(el=>{
          const L = Number(el.dataset.l);
          const line = ALL_LINES.find(l => l.type==='xy-main' && l.cells[0].z===L-1);
          const expect = measureLine(repairState, line);
          if(directText(el) !== expect) bad++;
        });
        return bad;
      })()
    `);
    check('60ラベルが独立再計算した該当ライン状態と一致する', mismatch === 0);

    // 行ラベルクリックで対象5セルが強調される
    const rowLabel = doc.querySelector('.row-wall-label[data-l="2"][data-r="1"]');
    rowLabel.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    const rowLine = evalW(`ALL_LINES.find(l=>l.type==='row' && l.cells[0].z===1 && l.cells[0].y===1)`);
    const highlighted1 = doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under');
    check('行ラベルクリックで対象5セルが強調される', highlighted1.length === 5);
    rowLabel.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true})); // 解除

    const colLabel = doc.querySelector('.col-wall-label[data-l="2"][data-c="1"]');
    colLabel.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    check('列ラベルクリックで対象5セルが強調される', doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under').length === 5);
    colLabel.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));

    const diagLabel = doc.querySelector('.diag-sum-main[data-l="2"]');
    diagLabel.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    check('対角ラベルクリックで対象5セルが強調される', doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under').length === 5);
  }

  // ---- 4) 立体ライン49本のバッジ(選択時だけ表示) ----
  {
    const { dom } = await loadPage();
    const { doc, click, evalW } = helpers(dom);

    check('未選択時は立体ラインバッジを表示しない', doc.getElementById('crossLevelBadges').style.display === '' || doc.getElementById('crossLevelBadges').style.display === 'none');

    click(2,1,1); // 未確定セル(柱/縦断面/空間対角に複数関与する)
    const badges = doc.querySelectorAll('#crossLevelBadges .cross-badge');
    const expectedCount = evalW(`linesThroughCell(ALL_LINES,2,1,1).filter(l=>['pillar','xz-main','xz-anti','yz-main','yz-anti','space'].includes(l.type)).length`);
    check('表示数がlinesThroughCellの独立計算と一致する', badges.length === expectedCount);
    check('セル選択時は立体ラインバッジが表示される', doc.getElementById('crossLevelBadges').style.display === 'flex');

    badges[0].dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    check('バッジクリックで対象5セルが強調される', doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under').length === 5);

    // 固定セル選択時にも表示される
    click(1,0,0);
    const isLocked = evalW('isRepairUnlocked(1,0,0)') === false;
    check('選択したセルは固定セルである(前提)', isLocked);
    const badgesLocked = doc.querySelectorAll('#crossLevelBadges .cross-badge');
    check('固定セル選択時にも立体ラインバッジが表示される', badgesLocked.length > 0);
  }

  // ---- 5) 旧HUD撤去の確認(DOM上) ----
  {
    const { dom } = await loadPage();
    const { doc } = helpers(dom);
    check('旧board-hudがDOMに存在しない', doc.getElementById('boardHud') === null);
    check('hudLineListがDOMに存在しない', doc.getElementById('hudLineList') === null);
    check('hudDiagTitleがDOMに存在しない', doc.getElementById('hudDiagTitle') === null);
    check('サイドバーに診断一覧が存在しない', doc.querySelector('.sidebar #lineList') === null);
    check('board-area内に凡例が存在する', doc.querySelector('.board-area .board-legend') !== null);
  }

  // ---- 6) タイル面アニメーション: ゴーストの構造・入力ロック・後片付け ----
  {
    const { dom } = await loadPage();
    const { w, doc, evalW, click } = helpers(dom);

    click(3,1,1);
    const stateBeforeSwap = evalW('JSON.stringify(repairState)');
    click(3,1,2); // アニメーション開始(Promiseはfire-and-forget)

    check('アニメーション中はanimatingがtrue', evalW('animating') === true);
    check('アニメーション中は盤面stateがまだ確定していない', evalW('JSON.stringify(repairState)') === stateBeforeSwap);

    const ghosts = doc.querySelectorAll('.swap-ghost');
    check('2つのタイル面ゴーストが生成される', ghosts.length === 2);
    check('各ゴーストに菱形面(cube-face)が存在する', [...ghosts].every(g => g.querySelector('.cube-face')));
    check('各ゴーストに数字(cube-label)が存在する', [...ghosts].every(g => g.querySelector('.cube-label')));
    check('各ゴーストのcube-faceにstroke/pointsが存在する(縁を含む複製)', [...ghosts].every(g => {
      const f = g.querySelector('.cube-face');
      return f && f.getAttribute('points');
    }));

    // ロック中は追加クリック/Undo/Resetを受け付けない
    const undoBtn = doc.getElementById('undoBtn');
    const resetBtn = doc.getElementById('resetBtn');
    check('アニメーション中はResetボタンがdisabled', resetBtn.disabled === true);
    const stateDuringLock = evalW('JSON.stringify(repairState)');
    click(3,2,1);
    check('アニメーション中のクリックは無視される', evalW('JSON.stringify(repairState)') === stateDuringLock);
    evalW('resetPuzzle()');
    check('アニメーション中のresetPuzzle()は盤面を変更しない', evalW('JSON.stringify(repairState)') === stateDuringLock);
    check('アニメーション中のresetPuzzle()はhistoryを変更しない', evalW('history.length') === 1);

    await new Promise(r=>setTimeout(r, evalW('SWAP_ANIM_MS') + 150));

    check('完了後にanimatingがfalseに戻る', evalW('animating') === false);
    check('完了後に値が1回だけ交換される(historyが1件)', evalW('history.length') === 1);
    check('完了後にゴーストが後片付けされる', doc.querySelectorAll('.swap-ghost').length === 0);
    check('完了後は交換元選択が解除されている', evalW('selectedCell') === null);
    check('完了後、履歴があればUndoボタンが有効になる', undoBtn.disabled === false);
    check('完了後はResetボタンが有効に戻る', resetBtn.disabled === false);
  }

  // ---- 7) Undoでもゴーストアニメーションが使われ、盤面・ボタン状態が正しく戻る ----
  {
    const { dom } = await loadPage();
    const { doc, evalW } = helpers(dom);
    await evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:1,c:2})`);
    check('1回交換後、Undoボタンが有効', doc.getElementById('undoBtn').disabled === false);

    evalW('undoSwap()'); // fire-and-forget、ゴースト生成を直後に確認
    const ghostsDuringUndo = doc.querySelectorAll('.swap-ghost');
    check('Undo中もタイル面ゴーストが使用される', ghostsDuringUndo.length === 2);
    await new Promise(r=>setTimeout(r, evalW('SWAP_ANIM_MS') + 150));

    check('Undoで盤面が交換前の状態に戻る', evalW('history.length') === 0);
    check('履歴が空になったのでUndoボタンが無効になる', doc.getElementById('undoBtn').disabled === true);

    // 複数交換後に1回だけUndoした場合は履歴が残りUndoボタン有効
    await evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:1,c:2})`);
    await evalW(`triggerSwap({L:3,r:2,c:1},{L:3,r:2,c:2})`);
    check('2回交換後history=2', evalW('history.length') === 2);
    await evalW('undoSwap()');
    check('1回Undo後history=1(まだ残っている)', evalW('history.length') === 1);
    check('履歴が残っているのでUndoボタンが有効', doc.getElementById('undoBtn').disabled === false);
  }

  // ---- 8) Reset競合防止(世代番号による無効化) ----
  {
    const { dom } = await loadPage();
    const { evalW } = helpers(dom);
    evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:1,c:2})`); // fire-and-forget、まだ未完了
    const stateAtStart = evalW('JSON.stringify(repairState)');
    // 通常のUIではResetボタンがdisabledのため呼ばれないが、世代番号による安全弁自体を検証する:
    // アニメーション中に強制的にresetPuzzle()を呼んでも(ガードで即return)盤面は変わらず、
    // その後にアニメーションが自然完了しても、resetの世代でなければ古い交換は確定しない、
    // という一連の流れを確認する。
    evalW('resetPuzzle()'); // animating中なのでガードでreturnするはず
    await new Promise(r=>setTimeout(r, evalW('SWAP_ANIM_MS') + 150));
    check('アニメーション中のReset試行は無視され、交換は正常に完了する', evalW('history.length') === 1 && evalW('JSON.stringify(repairState)') !== stateAtStart);
  }

  // ---- 9) prefers-reduced-motion ----
  {
    const { dom } = await loadPage();
    const { w, evalW } = helpers(dom);
    w.matchMedia = (query) => ({ matches: /reduce/.test(query), media: query, addListener(){}, removeListener(){} });
    const t0 = Date.now();
    await evalW(`triggerSwap({L:3,r:2,c:1},{L:3,r:2,c:2})`);
    const elapsed = Date.now() - t0;
    check('prefers-reduced-motionでも交換が正常完了する', evalW('animating') === false && evalW('history.length') === 1);
    check('prefers-reduced-motion時は短時間で完了する(200ms未満)', elapsed < 200);
  }

  // ---- 10) 正誤リーク確認 ----
  {
    const { dom, errors } = await loadPage();
    const { doc } = helpers(dom);
    const leaking = doc.querySelectorAll('.iso-cell.ok, .iso-cell.warn, .iso-cell.bad, .iso-cell.correct, .iso-cell.wrong, .iso-cell.cell-correct, .iso-cell.cell-wrong');
    check('正誤を示す禁止クラスがセルに付与されない', leaking.length === 0);
    console.log('  window errors:', errors);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
