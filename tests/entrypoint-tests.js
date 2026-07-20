// tests/entrypoint-tests.js — index.html統合とライン表示名の検証(静的解析、DOM非依存)。
// 実行: node tests/entrypoint-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

console.log('== entrypoint (index.html) ==');
{
  const root = path.join(__dirname, '..');
  const indexPath = path.join(root, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  check('index.htmlが修復型モジュールを読み込む', /js\/repair\/repair-main\.js/.test(html));
  check('index.htmlが旧js\\/main.jsを読み込まない', !/js\/main\.js/.test(html));
  check('repair.htmlが削除されている', !fs.existsSync(path.join(root, 'repair.html')));

  const forbidden = ['ふつう','むずかしい','とても難しい','難易度選択','新しい問題','候補プール','組み合わせ検索','お助け機能','ランダム問題生成','中クリック','Shift＋クリック','測定履歴','測定機','id="boardHud"','id="hudLineList"','id="hudDiagTitle"'];
  check('index.htmlに旧3難易度ボタン等・旧HUDが存在しない', forbidden.every(s => !html.includes(s)));

  const required = ['修復型パズル','未確定12','解読済み15','封印98','リセット','Undo'];
  check('index.htmlに必須表記が揃っている', required.every(s => html.includes(s)));

  const staleCounts = ['固定セル117個','未確定セル8個'];
  check('Prototype 01由来の古い件数表記(117/8)が残っていない', staleCounts.every(s => !html.includes(s)));

  check('近・遠・成立・同の簡潔な説明が存在する', ['近','遠','成立','同'].every(s => html.includes(s)) && /315に近づいた/.test(html) && /315から離れた/.test(html));

  // Prototype 05: 3状態(未確定/解読済み固定/封印固定)の凡例・交換可否・開始指針。
  check('未確定マス(金色)の交換可否が説明されている', /金色の数字は交換できる未確定マス/.test(html));
  check('解読済み固定マス(淡い数字)が交換不可と説明されている', /淡い数字は解読済みの固定マス/.test(html) && /交換できません/.test(html));
  check('封印固定マス(鍵穴)が交換不可と説明されている', /鍵穴は封印された固定マス/.test(html));
  check('開始指針(↑が重なる大きめ/↓が重なる小さめ)が存在する', /複数の↑が重なる大きめ/.test(html) && /複数の↓が重なる小さめ/.test(html) && /交換候補/.test(html));
  check('Prototype 04時代の「数字が見えない113マスは固定」という古い説明が残っていない', !html.includes('数字が見えない113マスは固定'));
  check('固定セル113個・未確定セル12個という2状態表記が残っていない', !html.includes('固定セル113個') && !html.includes('未確定セル12個'));
  check('解読・解除機能が実装済みと誤認させる文言がない', !/(解読する|解除する|解読権|解除条件|開放機能|封印を解く|鍵を開ける)/.test(html));

  // 診断一覧(旧board-hud)がサイドバーへ戻されていないこと、盤面内の凡例(board-legend)が存在すること。
  const asideMatch = html.match(/<aside[\s\S]*?<\/aside>/);
  const asideHtml = asideMatch ? asideMatch[0] : '';
  check('サイドバーに診断一覧・測定履歴が存在しない', !/id="lineList"|id="hudLineList"|id="measuredList"/.test(asideHtml));
  check('board-area内に凡例(board-legend)が存在する', /class="board-legend"/.test(html));
  check('board-area内に立体ラインバッジ用コンテナ(crossLevelBadges)が存在する', /id="crossLevelBadges"/.test(html));
  check('board-area内に直前交換結果panelコンテナ(lastSwapFeedback)が存在する', /id="lastSwapFeedback"/.test(html));
  check('直前交換結果panel内に項目コンテナ(lastSwapFeedbackItems)が存在する', /id="lastSwapFeedbackItems"/.test(html));
  check('直前交換結果panelがaria-live=polite', /id="lastSwapFeedback"[^>]*aria-live="polite"/.test(html));
  check('直前交換結果panelが初期状態で非表示', /id="lastSwapFeedback"[^>]*class="[^"]*hidden[^"]*"/.test(html));
  check('repair-main.jsがlastSwapFeedback/lastSwapFeedbackItemsを参照している', (()=>{
    const mainJs = fs.readFileSync(path.join(root,'js/repair/repair-main.js'),'utf8');
    return /getElementById\('lastSwapFeedback'\)/.test(mainJs) && /getElementById\('lastSwapFeedbackItems'\)/.test(mainJs);
  })());

  // LEVEL表示CSSの復元
  const tierBlock = html.match(/\.tier-label\s*\{[^}]*\}/);
  check('.tier-label専用CSSが存在する', !!tierBlock);
  if(tierBlock){
    const css = tierBlock[0];
    check('.tier-labelのfont-familyがvar(--serif)', /font-family:\s*var\(--serif\)/.test(css));
    check('.tier-labelのfont-sizeが30px', /font-size:\s*30px/.test(css));
    check('.tier-labelのfont-styleがitalic', /font-style:\s*italic/.test(css));
    check('.tier-labelのfillが明るい白系', /fill:\s*rgba\(255,\s*255,\s*255,\s*0\.85\)/.test(css));
  }
  check('LEVEL文字列(NLEVEL生成)へ成立ライン数を追加していない(render.js側)', (()=>{
    const renderJs = fs.readFileSync(path.join(root,'js/render.js'),'utf8');
    const m = renderJs.match(/tierLabel\.textContent\s*=\s*`[^`]*`/);
    return !!m && m[0] === 'tierLabel.textContent = `${L}LEVEL`';
  })());

  // pointer-events復元
  check('.level-svgがpointer-events:noneを含む', /\.level-svg\s*\{[^}]*pointer-events:\s*none/.test(html));
  check('.iso-cellがpointer-events:noneを含む(cube-face以外はクリック不能)', /\.iso-cell\s*\{[^}]*pointer-events:\s*none/.test(html));
  check('.iso-cell .cube-faceがpointer-events:autoを含む', /\.iso-cell \.cube-face\s*\{[^}]*pointer-events:\s*auto/.test(html));

  // z-index/DOM追加順/GAPはrender.js側で維持されているか(数値の決め打ちを確認)
  const renderJsSrc = fs.readFileSync(path.join(root,'js/render.js'),'utf8');
  check('zIndexが{5:1,4:1,3:2,2:3,1:3}のまま', /zIndex\s*=\s*\{\s*5:1,\s*4:1,\s*3:2,\s*2:3,\s*1:3\s*\}/.test(renderJsSrc));
  check('DOM追加順が[5,4,3,2,1]のまま', /\[5,4,3,2,1\]\.forEach/.test(renderJsSrc));
  check('GAPが110のまま', /const GAP = 110/.test(renderJsSrc));

  // サイドバーの成立ライン進捗・旧凡例撤去
  check('サイドバーに成立ライン進捗(lineProgress/solvedLineCount)がある', /id="lineProgress"/.test(asideHtml) && /id="solvedLineCount"/.test(asideHtml));
  check('サイドバーに旧凡例(＝：315 / ↑：315超過 / ↓：315未満)が存在しない', !asideHtml.includes('＝：315'));
}

console.log('== line labels (109本の表示名) ==');
{
  const files = ['js/generator.js', 'js/repair/cube-data.js', 'js/repair/lines109.js'];
  const ctx = {};
  vm.createContext(ctx);
  for(const f of files){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'), ctx, { filename: f });
  }
  vm.runInContext('globalThis.buildLines109 = buildLines109; globalThis.lineLabel = lineLabel;', ctx);

  const lines = ctx.buildLines109();
  check('109ラインが構築される(構造は不変)', lines.length === 109);

  const labels = lines.map(ctx.lineLabel);
  check('109本すべて表示名が空でない', labels.every(l => typeof l === 'string' && l.length > 0));
  check('109本すべて表示名が一意', new Set(labels).size === 109);

  // 同種ライン(row)が位置で区別できる例
  const rowLabels = lines.filter(l=>l.type==='row').map(ctx.lineLabel);
  check('同種ライン(行)も位置で区別できる', new Set(rowLabels).size === rowLabels.length);
  const xyMainLabels = lines.filter(l=>l.type==='xy-main').map(ctx.lineLabel);
  check('同種ライン(平面対角↘)も層で区別できる', new Set(xyMainLabels).size === xyMainLabels.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
