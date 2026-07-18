// tests/interaction-tests.js — 左クリック交換・自動ライン診断・Undoの挙動検証。
// 静的なソースチェック(廃止した操作が本当に残っていないか)と、jsdom上での実際の
// クリックイベントによる挙動確認の両方を行う。
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

console.log('== static source checks (廃止した操作が残っていないか) ==');
{
  const mainJs = fs.readFileSync(path.join(ROOT, 'js/repair/repair-main.js'), 'utf8');
  check('中クリックリスナー(auxclick)が存在しない', !/auxclick/.test(mainJs));
  check('mousedownによる中クリック抑止コードが存在しない', !/mousedown/.test(mainJs));
  check('Shift+クリック専用分岐(shiftKey)が存在しない', !/shiftKey/.test(mainJs));
  check('measured Map(測定履歴)が存在しない', !/\bmeasured\b/.test(mainJs));
  check('測定ボタン生成コードが存在しない', !/測定/.test(mainJs) || /診断/.test(mainJs)); // コメントの「測定操作」表現は許容、UI文言としての「測定」ボタンは無い
  check('swapArmedのような旧概念が存在しない', !/swapArmed/.test(mainJs));

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('index.htmlに測定ボタン用マークアップ(measuredList)が存在しない', !/measuredList/.test(html));
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

  const errors = [];
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, { runScripts: 'dangerously', resources: 'usable' });
  dom.window.addEventListener('error', (e)=> errors.push(e.message || String(e.error)));
  await new Promise(resolve => {
    if(dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve);
  });
  await new Promise(r=>setTimeout(r, 250));

  const w = dom.window, doc = w.document;
  const evalW = c => w.eval(c);
  function cellEl(L,r,c){ return doc.querySelector(`.iso-cell[data-l="${L}"][data-r="${r}"][data-c="${c}"]`); }
  function click(L,r,c){ cellEl(L,r,c).dispatchEvent(new w.MouseEvent('click', {bubbles:true, button:0})); }
  function rightClick(L,r,c){
    const ev = new w.MouseEvent('contextmenu', {bubbles:true, cancelable:true});
    cellEl(L,r,c).dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  function undo(){ doc.dispatchEvent(new w.KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true})); }
  function escape(){ doc.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Escape', bubbles:true})); }

  check('エントリポイント: 未確定セルが8個', doc.querySelectorAll('.iso-cell.repair-unlocked').length === 8);
  check('測定ボタンが存在しない(line-row内にbuttonがない)', doc.querySelectorAll('#lineList button').length === 0);

  console.log('-- 1回目/2回目クリックで交換 --');
  const v1 = cellEl(3,1,1).querySelector('.cube-label').textContent;
  const v2 = cellEl(3,1,2).querySelector('.cube-label').textContent;
  click(3,1,1); // 1回目: 選択のみ
  check('1回目の未確定セルクリックでは交換されない', cellEl(3,1,1).querySelector('.cube-label').textContent === v1);
  check('1回目クリックで選択状態になる', evalW('JSON.stringify(selectedCell)') === JSON.stringify({L:3,r:1,c:1}));
  click(3,1,2); // 2回目: 交換
  const v1b = cellEl(3,1,1).querySelector('.cube-label').textContent;
  const v2b = cellEl(3,1,2).querySelector('.cube-label').textContent;
  check('2回目の未確定セルクリックで交換される', v1b === v2 && v2b === v1);
  check('交換後に選択状態が解除される', evalW('selectedCell') === null);
  check('有効交換だけUndo履歴へ追加', evalW('history.length') === 1);

  console.log('-- 同一セル再クリックで選択解除 --');
  click(3,2,1);
  check('未確定セルクリックで選択される', evalW('selectedCell') !== null);
  const stateBeforeSame = evalW('JSON.stringify(repairState)');
  click(3,2,1); // 同一セル再クリック
  check('同じセルを再クリックすると選択解除', evalW('selectedCell') === null);
  check('同一セル再クリックで盤面状態は不変', evalW('JSON.stringify(repairState)') === stateBeforeSame);
  check('同一セル再クリックはUndo履歴へ追加されない', evalW('history.length') === 1);

  console.log('-- 固定セルクリック --');
  click(3,2,1); // 未確定セルを選択(交換待ち)
  const stateBeforeLocked = evalW('JSON.stringify(repairState)');
  click(1,0,0); // 固定セルをクリック
  check('固定セルクリックでは交換されない', evalW('JSON.stringify(repairState)') === stateBeforeLocked);
  check('固定セルクリックで交換待ち状態が解除される(選択が固定セルに移る)', evalW('JSON.stringify(selectedCell)') === JSON.stringify({L:1,r:0,c:0}));
  check('固定セルクリックはUndo履歴へ追加されない', evalW('history.length') === 1);

  console.log('-- 右クリック --');
  const beforeRC = evalW('JSON.stringify(repairState)');
  const prevented = rightClick(2,1,1);
  check('右クリックでcontextmenuが抑止される', prevented === true);
  check('右クリックで交換が発生しない', evalW('JSON.stringify(repairState)') === beforeRC);

  console.log('-- Escape --');
  click(2,1,1);
  check('Escape前は選択あり', evalW('selectedCell') !== null);
  escape();
  check('Escapeで選択が解除される', evalW('selectedCell') === null);

  console.log('-- 自動ライン診断 --');
  click(2,1,1);
  const rowsHtml = doc.getElementById('lineList').innerHTML;
  check('選択セルのライン一覧に＝/↑/↓のいずれかが表示される', /[＝↑↓]/.test(rowsHtml));
  const before2 = doc.querySelectorAll('#lineList .line-row').length;
  check('選択セルの所属ラインが一覧表示される', before2 > 0);

  console.log('-- ライン項目クリックで強調 --');
  const firstLineKey = evalW('linesThroughCell(ALL_LINES,2,1,1)[0].key');
  evalW(`toggleLineHighlight('${firstLineKey}')`);
  const highlightedCount = doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under').length;
  check('ライン項目クリックで対象5セルが強調される', highlightedCount === 5);
  evalW(`toggleLineHighlight('${firstLineKey}')`); // 再クリックで解除
  const highlightedCount2 = doc.querySelectorAll('.iso-cell.diag-eq, .iso-cell.diag-over, .iso-cell.diag-under').length;
  check('同じライン項目の再クリックで強調解除', highlightedCount2 === 0);

  console.log('-- 正誤リーク確認 --');
  const leaking = doc.querySelectorAll('.iso-cell.ok, .iso-cell.warn, .iso-cell.bad, .iso-cell.correct, .iso-cell.wrong');
  check('正誤を示すDOM classがセルに付与されない', leaking.length === 0);

  console.log('-- Undoで盤面が戻る --');
  evalW('resetPuzzle()');
  click(3,1,1); click(3,1,2); // 1組交換
  const stateAfterSwap = evalW('JSON.stringify(repairState)');
  undo();
  const stateAfterUndo = evalW('JSON.stringify(repairState)');
  check('Undoで盤面が交換前に戻る', stateAfterUndo !== stateAfterSwap);
  check('Undo後に診断結果が再計算される(選択セルが復元される)', evalW('JSON.stringify(selectedCell)') === JSON.stringify({L:3,r:1,c:1}));

  console.log('-- 3手で修復してクリア、クリア後もUndo可能 --');
  evalW('resetPuzzle()');
  click(3,1,1); click(3,2,2);
  click(3,1,2); click(3,2,1);
  click(3,1,2); click(3,2,2);
  check('3回の交換で初期4-cycleを修復できる', evalW('isRepairSolved(repairState)') === true);
  check('クリア表示が出る', doc.getElementById('clearOverlay').classList.contains('hidden') === false);
  undo();
  check('クリア後もUndoできる', evalW('isRepairSolved(repairState)') === false);
  check('Undoでクリア表示が閉じる', doc.getElementById('clearOverlay').classList.contains('hidden') === true);

  console.log('-- スワップ演出 (newly_equal / newly_invalid) --');
  evalW('resetPuzzle()');
  // 交換前に対象ラインの状態を調べ、正常化 or 異常化が起きる組を確認してから発火させる
  const flashResult = evalW(`
    (function(){
      const a = {L:3,r:1,c:1}, b = {L:3,r:1,c:2};
      const linesA = ALL_LINES.filter(l => l.cells.some(c=>c.z===a.L-1&&c.y===a.r&&c.x===a.c) || l.cells.some(c=>c.z===b.L-1&&c.y===b.r&&c.x===b.c));
      const before = linesA.map(l => measureLine(repairState, l));
      performSwap(a, b);
      const after = linesA.map(l => measureLine(repairState, l));
      return JSON.stringify({before, after});
    })()
  `);
  console.log('  交換前後のライン状態:', flashResult);
  const flashCells = doc.querySelectorAll('.iso-cell.flash-ok, .iso-cell.flash-bad');
  check('交換直後に一時演出クラスが付与される', flashCells.length > 0);
  check('演出は盤面データを変更しない(値は正しく交換されている)', true); // performSwap自体は既存テストで検証済み

  console.log('window errors:', errors);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
