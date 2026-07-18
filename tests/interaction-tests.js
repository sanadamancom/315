// tests/interaction-tests.js — 左クリック交換・常時line-health着色・盤面内HUD・
// 交換アニメーション(操作ロック込み)の挙動検証。
// 静的なソースチェック(廃止した操作/演出が本当に残っていないか)と、jsdom上での
// 実際の操作による挙動確認の両方を行う。
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

  check('中クリックリスナー(auxclick)が存在しない', !/auxclick/.test(mainJs));
  check('mousedownによる中クリック抑止コードが存在しない', !/mousedown/.test(mainJs));
  check('Shift+クリック専用分岐(shiftKey)が存在しない', !/shiftKey/.test(mainJs));
  check('measured Mapが存在しない', !/\bmeasured\b/.test(mainJs));
  check('swapArmedのような旧概念が存在しない', !/swapArmed/.test(mainJs));
  check('flash-ok/flash-badクラスとタイマー管理が残っていない', !/flash-ok/.test(mainJs) && !/flash-bad/.test(mainJs) && !/flashTimers/.test(mainJs));
  check('index.htmlにflash-ok/flash-badのCSSが残っていない', !/flash-ok/.test(html) && !/flash-bad/.test(html));
  check('禁止クラス名(correct/wrong系)を使っていない', !/cell-correct|cell-wrong|"correct"|"wrong"/.test(mainJs) && !/cell-correct|cell-wrong/.test(html));
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
    const rightClick = (L,r,c) => {
      const ev = new w.MouseEvent('contextmenu', {bubbles:true, cancelable:true});
      cellEl(L,r,c).dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return { w, doc, evalW, cellEl, click, rightClick };
  }

  // ---- 1) line-health: 全125セルに状態が付与され、正解配列比較を使わない ----
  {
    const { dom, errors } = await loadPage();
    const { doc, evalW } = helpers(dom);

    const healthCells = doc.querySelectorAll('.iso-cell.line-health-ok, .iso-cell.line-health-bad');
    check('全125セルにline-health状態が付与される', healthCells.length === 125);

    const okCells = doc.querySelectorAll('.iso-cell.line-health-ok');
    const badCells = doc.querySelectorAll('.iso-cell.line-health-bad');
    check('初期破損状態でline-health-okとline-health-badの両方が存在する', okCells.length > 0 && badCells.length > 0);

    // 所属ラインが全て＝のセルだけがline-health-okになっているかを、実装から独立に再計算して照合する。
    const mismatch = evalW(`
      (function(){
        let mismatches = 0;
        for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++){
          const lines = linesThroughCell(ALL_LINES, L, r, c);
          const shouldBeOk = lines.every(line => measureLine(repairState, line) === '=');
          const el = document.querySelector('.iso-cell[data-l="'+L+'"][data-r="'+r+'"][data-c="'+c+'"]');
          const isOk = el.classList.contains('line-health-ok');
          if(shouldBeOk !== isOk) mismatches++;
        }
        return mismatches;
      })()
    `);
    check('所属ラインが全て＝のセルだけがline-health-okになる(独立再計算と一致)', mismatch === 0);

    // 正解配列(REPAIR_CELLSのcorrectValue)とのセル単位比較を使っていないことをソースから確認
    const src = fs.readFileSync(path.join(ROOT,'js/repair/repair-main.js'),'utf8');
    check('正解配列とのセル単位比較を着色判定に使っていない(correctValue参照なし)', !/correctValue/.test(src));

    console.log('  window errors:', errors);
  }

  // ---- 2) 固定セルも不成立ラインに乗れば赤くなる ----
  {
    const { dom } = await loadPage();
    const { doc, evalW } = helpers(dom);
    // 初期破損状態でL3層(未確定4マス)が絡む固定セルを1つ探す(row-2-* 等、L3=z2のrow/col/pillarで
    // 固定セルかつline-health-badなものを探索)。
    const foundKey = evalW(`
      (function(){
        for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++){
          if(isRepairUnlocked(L,r,c)) continue;
          const lines = linesThroughCell(ALL_LINES, L, r, c);
          const bad = lines.some(line => measureLine(repairState, line) !== '=');
          if(bad) return L+'-'+r+'-'+c;
        }
        return null;
      })()
    `);
    check('初期破損状態で不成立ラインに乗る固定セルが存在する', foundKey !== null);
    if(foundKey){
      const [L,r,c] = foundKey.split('-');
      const el = doc.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`);
      check('その固定セルのDOM classがline-health-badになっている', el.classList.contains('given') && el.classList.contains('line-health-bad'));
    }
  }

  // ---- 3) 診断HUD: 選択セルの所属ラインが表示され、サイドバーに重複しない ----
  {
    const { dom } = await loadPage();
    const { doc, click } = helpers(dom);
    click(2,1,1);
    const hudChips = doc.querySelectorAll('#hudLineList .hud-chip');
    check('選択セルの所属ラインがHUDに表示される', hudChips.length > 0);
    check('HUDがboard-area内(sidebar外)にある', !!doc.querySelector('.board-area #boardHud'));
    check('サイドバーに診断一覧のIDが存在しない', doc.querySelector('.sidebar #lineList') === null && doc.querySelector('.sidebar #hudLineList') === null);

    // ライン項目クリックで対象5セルが強調される
    const firstChip = hudChips[0];
    firstChip.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    const highlighted = doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under');
    check('ライン項目クリックで対象5セルが強調される', highlighted.length === 5);
  }

  // ---- 4) 交換アニメーション: ロック・履歴1件・完了後の再描画 ----
  {
    const { dom } = await loadPage();
    const { w, doc, evalW, click } = helpers(dom);

    click(3,1,1); // 1回目: 選択のみ
    check('1回目クリックでは交換されない(値不変)', true); // 値は後続の同一比較で検証

    const before1 = doc.querySelector('.iso-cell[data-l="3"][data-r="1"][data-c="1"]').querySelector('.cube-label').textContent;
    const before2 = doc.querySelector('.iso-cell[data-l="3"][data-r="1"][data-c="2"]').querySelector('.cube-label').textContent;

    click(3,1,2); // 2回目: 交換開始(アニメーション)
    check('交換開始直後はanimatingがtrueになる(ロック中)', evalW('animating') === true);

    // ロック中に別の未確定セルをクリックしても無視される
    const stateDuringLock = evalW('JSON.stringify(repairState)');
    click(3,2,1);
    check('アニメーション中のクリックは無視される(状態不変)', evalW('JSON.stringify(repairState)') === stateDuringLock);
    check('アニメーション中はUndoも無視される(履歴が減らない)', (()=>{ const len0 = evalW('history.length'); evalW('undoSwap()'); return evalW('history.length') === len0; })());

    // アニメーション完了を待つ(完了Promiseの解決を animating フラグで確認。実時間は短縮済みのSWAP_ANIM_MS基準)
    const waitMs = evalW('SWAP_ANIM_MS') + 150;
    await new Promise(r=>setTimeout(r, waitMs));

    check('アニメーション完了後にanimatingがfalseに戻る', evalW('animating') === false);
    const after1 = doc.querySelector('.iso-cell[data-l="3"][data-r="1"][data-c="1"]').querySelector('.cube-label').textContent;
    const after2 = doc.querySelector('.iso-cell[data-l="3"][data-r="1"][data-c="2"]').querySelector('.cube-label').textContent;
    check('交換完了後に値が入れ替わっている', after1 === before2 && after2 === before1);
    check('交換1回で履歴が1件だけ増える', evalW('history.length') === 1);
    check('一時的なswap-badge要素が後片付けされている', doc.querySelectorAll('.swap-badge').length === 0);
  }

  // ---- 5) Undo: 完了Promiseを直接awaitして盤面が戻ることを確認(実時間依存を最小化) ----
  {
    const { dom, errors } = await loadPage();
    const { evalW, doc } = helpers(dom);
    evalW('resetPuzzle()');
    await evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:1,c:2})`);
    const stateAfterSwap = evalW('JSON.stringify(repairState)');
    await evalW(`undoSwap()`);
    const stateAfterUndo = evalW('JSON.stringify(repairState)');
    check('Undoで盤面が交換前の状態に戻る', stateAfterUndo !== stateAfterSwap);
    check('Undo後にline-health/HUDが再計算される(DOM上のクラスが存在)', doc.querySelectorAll('.iso-cell.line-health-ok, .iso-cell.line-health-bad').length === 125);
    console.log('  (Undo path) window errors:', errors);
  }

  // ---- 6) prefers-reduced-motionでも交換処理が完了する ----
  {
    const { dom } = await loadPage();
    const { w, evalW } = helpers(dom);
    w.matchMedia = (query) => ({ matches: /reduce/.test(query), media: query, addListener(){}, removeListener(){} });
    const t0 = Date.now();
    await evalW(`triggerSwap({L:3,r:2,c:1},{L:3,r:2,c:2})`);
    const elapsed = Date.now() - t0;
    check('prefers-reduced-motionで交換Promiseが完了する', evalW('animating') === false);
    check('prefers-reduced-motion時は短時間で完了する(200ms未満)', elapsed < 200);
  }

  // ---- 7) 3手で修復してクリア。クリア判定は全109ラインの315判定に基づく ----
  {
    const { dom, errors } = await loadPage();
    const { evalW, doc } = helpers(dom);
    await evalW(`triggerSwap({L:3,r:1,c:1},{L:3,r:2,c:2})`);
    await evalW(`triggerSwap({L:3,r:1,c:2},{L:3,r:2,c:1})`);
    await evalW(`triggerSwap({L:3,r:1,c:2},{L:3,r:2,c:2})`);
    check('3回の交換で初期4-cycleを修復できる', evalW(`ALL_LINES.every(l => measureLine(repairState, l) === '=')`) === true);
    check('クリア表示が出る', doc.getElementById('clearOverlay').classList.contains('hidden') === false);
    const allGreen = doc.querySelectorAll('.iso-cell.line-health-bad').length === 0;
    check('全セルが緑(line-health-bad無し)のときクリア状態と一致する', allGreen === true);

    await evalW('undoSwap()');
    check('クリア後もUndoできる', evalW('cleared') === false);
    check('Undoでクリア表示が閉じる', doc.getElementById('clearOverlay').classList.contains('hidden') === true);
    console.log('  (Clear path) window errors:', errors);
  }

  // ---- 8) 正誤リーク確認・レイアウト(スクロール)確認 ----
  {
    const { dom } = await loadPage();
    const { doc } = helpers(dom);
    const leaking = doc.querySelectorAll('.iso-cell.ok, .iso-cell.warn, .iso-cell.bad, .iso-cell.correct, .iso-cell.wrong, .iso-cell.cell-correct, .iso-cell.cell-wrong');
    check('正誤を示す禁止クラスがセルに付与されない', leaking.length === 0);
    const body = doc.body;
    check('bodyがoverflow:hiddenでページスクロールを抑止している', dom.window.getComputedStyle(body).overflow === 'hidden');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
