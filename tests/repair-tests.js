// tests/repair-tests.js — 修復型パズル(js/repair/*)のロジック検証。
// DOM非依存の部分(cube-data / lines109 / puzzle / measure)だけを対象にする。
// puzzle.jsのREPAIR_CELLS内容(座標・初期値)には依存しない汎用的な検証のみを行う。
// tools/repair(候補選定用の開発ツール群)への実行時依存は持たない。
// candidate.jsonとの由来・整合性検証はtests/prototype02-search-tests.js側で行う。
// 実行: node tests/repair-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = [
  'js/generator.js',        // N, LEVELS, TARGET, shuffled 等の共有定数(参照のみ、修復ロジックは混在させない)
  'js/repair/cube-data.js',
  'js/repair/lines109.js',
  'js/repair/puzzle.js',
  'js/repair/measure.js',
];

const ctx = {};
vm.createContext(ctx);
for(const f of files){
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}
// vmコンテキストのトップレベルconstはsandboxオブジェクトの自プロパティにならないため、
// 明示的にglobalThisへ書き出してNode側(ctx.X)から参照できるようにする。
vm.runInContext(`
  globalThis.CUBE_DATA = CUBE_DATA;
  globalThis.buildLines109 = buildLines109;
  globalThis.lineLabel = lineLabel;
  globalThis.REPAIR_CELLS = REPAIR_CELLS;
  globalThis.REVEALED_FIXED_CELLS = REVEALED_FIXED_CELLS;
  globalThis.cellPresentationState = cellPresentationState;
  globalThis.repairCellKey = repairCellKey;
  globalThis.isRepairUnlocked = isRepairUnlocked;
  globalThis.repairCellDef = repairCellDef;
  globalThis.repairGridValue = repairGridValue;
  globalThis.createInitialRepairState = createInitialRepairState;
  globalThis.swapRepairCells = swapRepairCells;
  globalThis.isRepairSolved = isRepairSolved;
  globalThis.measureLine = measureLine;
  globalThis.linesThroughCell = linesThroughCell;
  globalThis.classifyLineChange = classifyLineChange;
  globalThis.analyzeAffectedLineChanges = analyzeAffectedLineChanges;
`, ctx);

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

console.log('== cube-data / lines109 ==');
{
  const flat = [];
  for(let z=0;z<5;z++) for(let y=0;y<5;y++) for(let x=0;x<5;x++) flat.push(ctx.CUBE_DATA[z][y][x]);
  const uniq = new Set(flat);
  check('固定配列が1〜125を各1回含む', flat.length===125 && uniq.size===125 && Math.min(...flat)===1 && Math.max(...flat)===125);

  const lines = ctx.buildLines109();
  check('109ラインが構築される', lines.length === 109);
  const keySet = new Set(lines.map(l=>l.key));
  check('109ラインが重複なく構築される', keySet.size === 109);
  check('各ラインが5セル', lines.every(l=>l.cells.length===5));

  let bad = 0;
  for(const line of lines){
    const s = line.cells.reduce((a,c)=>a+ctx.CUBE_DATA[c.z][c.y][c.x],0);
    if(s!==315) bad++;
  }
  check('正解状態で109ラインすべて315', bad===0);
}

console.log('== puzzle (static repair definition) ==');
{
  const REPAIR_CELLS = ctx.REPAIR_CELLS;
  check('REPAIR_CELLSが12件', REPAIR_CELLS.length === 12);

  const coordKeySet = new Set(REPAIR_CELLS.map(c => `${c.L}-${c.r}-${c.c}`));
  const coordsInRange = REPAIR_CELLS.every(c =>
    Number.isInteger(c.L) && c.L>=1 && c.L<=5 &&
    Number.isInteger(c.r) && c.r>=0 && c.r<5 &&
    Number.isInteger(c.c) && c.c>=0 && c.c<5
  );
  check('全座標が範囲内かつ重複なし', coordsInRange && coordKeySet.size === REPAIR_CELLS.length);

  check('correctValueとinitialValueが1〜125範囲内', REPAIR_CELLS.every(c =>
    Number.isInteger(c.correctValue) && c.correctValue>=1 && c.correctValue<=125 &&
    Number.isInteger(c.initialValue) && c.initialValue>=1 && c.initialValue<=125
  ));

  const initState = ctx.createInitialRepairState();
  const correctCells = REPAIR_CELLS.filter(c => initState[ctx.repairCellKey(c.L,c.r,c.c)] === c.correctValue);
  const misplacedCells = REPAIR_CELLS.filter(c => initState[ctx.repairCellKey(c.L,c.r,c.c)] !== c.correctValue);
  check('正しい位置に残る未確定セルと誤配置セルが両方存在する', correctCells.length >= 1 && misplacedCells.length >= 1);

  // 未確定セルの初期値集合が、その位置の正解値集合と一致すること(順列であること)。
  const correctValueMultiset = REPAIR_CELLS.map(c=>c.correctValue).slice().sort((a,b)=>a-b);
  const initialValueMultiset = REPAIR_CELLS.map(c=>initState[ctx.repairCellKey(c.L,c.r,c.c)]).slice().sort((a,b)=>a-b);
  check('未確定セルの初期値集合が正解値集合と一致', correctValueMultiset.length===initialValueMultiset.length &&
    correctValueMultiset.every((v,i)=>v===initialValueMultiset[i]));

  // 固定113セルはCUBE_DATAと一致すること(repairGridValueのlocked分岐を経由して確認)。
  let fixedMismatch = 0, fixedCount = 0;
  for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++){
    if(ctx.isRepairUnlocked(L,r,c)) continue;
    fixedCount++;
    if(ctx.repairGridValue(initState, L, r, c) !== ctx.CUBE_DATA[L-1][r][c]) fixedMismatch++;
  }
  check('固定113セルがCUBE_DATAと一致', fixedCount===113 && fixedMismatch===0);

  // 初期破損状態でも1〜125が各1回であること(盤面全体で確認)
  const flatInit = [];
  for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++) flatInit.push(ctx.repairGridValue(initState, L, r, c));
  check('初期破損状態でも1〜125が各1回', flatInit.length===125 && new Set(flatInit).size===125);

  // 固定セルは交換できない(REPAIR_CELLSに含まれない座標を動的に1つ選ぶ)
  let lockedA = null;
  outer: for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++){
    if(!ctx.isRepairUnlocked(L,r,c)){ lockedA = { L, r, c }; break outer; }
  }
  const unlockedA = { L:REPAIR_CELLS[0].L, r:REPAIR_CELLS[0].r, c:REPAIR_CELLS[0].c };
  const afterLockedSwap = ctx.swapRepairCells(initState, lockedA, unlockedA);
  check('固定セルを交換できない(状態が変化しない)', lockedA !== null && JSON.stringify(afterLockedSwap) === JSON.stringify(initState));

  // 未確定セル同士は交換できる
  const b = { L:REPAIR_CELLS[1].L, r:REPAIR_CELLS[1].r, c:REPAIR_CELLS[1].c };
  const afterUnlockedSwap = ctx.swapRepairCells(initState, unlockedA, b);
  const ka = ctx.repairCellKey(unlockedA.L,unlockedA.r,unlockedA.c), kb = ctx.repairCellKey(b.L,b.r,b.c);
  check('未確定セル同士を交換できる', afterUnlockedSwap[ka]===initState[kb] && afterUnlockedSwap[kb]===initState[ka]);

  check('初期破損状態はまだ未クリア', ctx.isRepairSolved(initState) === false);

  const correctState = {};
  for(const c of REPAIR_CELLS) correctState[ctx.repairCellKey(c.L,c.r,c.c)] = c.correctValue;
  check('正解復元時のみクリアする', ctx.isRepairSolved(correctState) === true);
}

console.log('== presentation state (Prototype 05) ==');
{
  const lines = ctx.buildLines109();
  const REPAIR_CELLS = ctx.REPAIR_CELLS;
  const REVEALED_FIXED_CELLS = ctx.REVEALED_FIXED_CELLS;

  check('REVEALED_FIXED_CELLSが15件', REVEALED_FIXED_CELLS.length === 15);

  // 全125セルを3状態へ分類し件数を確認。同時に座標範囲・重複・movableとの非重複も確認。
  let movable=0, revealed=0, sealed=0, outOfPuzzleRange=0, revealedDup=0;
  const revealedKeySet = new Set();
  for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++){
    const state = ctx.cellPresentationState(L,r,c);
    if(state==='movable') movable++;
    else if(state==='revealed-fixed'){
      revealed++;
      const k = ctx.repairCellKey(L,r,c);
      if(revealedKeySet.has(k)) revealedDup++;
      revealedKeySet.add(k);
      if(ctx.isRepairUnlocked(L,r,c)) outOfPuzzleRange++; // revealed-fixedがmovableと重複してはならない
    }
    else sealed++;
  }
  check('分類件数が12/15/98', movable===12 && revealed===15 && sealed===98);
  check('revealed-fixedは全て固定セル(movableと非重複)かつ座標重複なし', outOfPuzzleRange===0 && revealedDup===0);

  // 各LEVEL 3個、LEVEL内でrow・column重複なし
  let levelCountOk = true, rowColDupOk = true;
  for(let L=1;L<=5;L++){
    const cellsInLevel = REVEALED_FIXED_CELLS.filter(c=>c.L===L);
    if(cellsInLevel.length !== 3) levelCountOk = false;
    const rowSet = new Set(cellsInLevel.map(c=>c.r));
    const colSet = new Set(cellsInLevel.map(c=>c.c));
    if(rowSet.size !== cellsInLevel.length || colSet.size !== cellsInLevel.length) rowColDupOk = false;
  }
  check('各LEVEL 3個', levelCountOk);
  check('各LEVEL内でrow・columnが重複しない', rowColDupOk);

  // active line = 未確定セル(REPAIR_CELLS)を1個以上含む109ライン
  const isUnconfirmedCoord = (cell) => REPAIR_CELLS.some(u => u.L===cell.z+1 && u.r===cell.y && u.c===cell.x);
  const activeLines = lines.filter(line => line.cells.some(isUnconfirmedCoord));
  const isRevealedCoord = (cell) => REVEALED_FIXED_CELLS.some(rv => rv.L===cell.z+1 && rv.r===cell.y && rv.c===cell.x);
  const isFixedCoord = (cell) => !ctx.isRepairUnlocked(cell.z+1, cell.y, cell.x);

  // 各LEVELで最低1個はactive line上のrevealed-fixed
  let levelActiveOk = true;
  for(let L=1;L<=5;L++){
    const hasActiveRevealed = REVEALED_FIXED_CELLS.some(rv => rv.L===L &&
      activeLines.some(line => line.cells.some(cell => cell.z===rv.L-1 && cell.y===rv.r && cell.x===rv.c)));
    if(!hasActiveRevealed) levelActiveOk = false;
  }
  check('各LEVELで最低1個がactive line上', levelActiveOk);

  // 全active lineでrevealed-fixed最大1、sealed-fixed(固定セルのうち非表示)最低2
  let maxRevealedInLine = 0, minSealedInLine = 99;
  for(const line of activeLines){
    const fixedInLine = line.cells.filter(isFixedCoord);
    const revealedInLine = fixedInLine.filter(isRevealedCoord).length;
    const sealedInLine = fixedInLine.length - revealedInLine;
    maxRevealedInLine = Math.max(maxRevealedInLine, revealedInLine);
    minSealedInLine = Math.min(minSealedInLine, sealedInLine);
  }
  check('全active lineでrevealed-fixed最大1', maxRevealedInLine <= 1);
  check('全active lineでsealed-fixed最低2', minSealedInLine >= 2);

  // 既存の問題配置・109ライン・交換可否が変わっていないことの確認
  check('既存REPAIR_CELLSは12件のまま', REPAIR_CELLS.length === 12);
  check('109ラインは変わらず109本', lines.length === 109);
}

console.log('== measure ==');
{
  const lines = ctx.buildLines109();
  const correctState = {};
  for(const c of ctx.REPAIR_CELLS) correctState[ctx.repairCellKey(c.L,c.r,c.c)] = c.correctValue;
  const initState = ctx.createInitialRepairState();

  let eqCount=0, overCount=0, underCount=0;
  for(const line of lines){
    const r = ctx.measureLine(correctState, line);
    if(r==='=') eqCount++;
  }
  check('正解状態では全ラインが＝', eqCount === lines.length);

  let intraAbnormal=0, crossAbnormal=0;
  for(const line of lines){
    const r = ctx.measureLine(initState, line);
    if(r==='↑') overCount++;
    if(r==='↓') underCount++;
    if(r!=='='){
      const zs = new Set(line.cells.map(cell=>cell.z));
      if(zs.size===1) intraAbnormal++; else crossAbnormal++;
    }
  }
  check('測定結果が正常・過剰・不足で正しい(初期破損状態に↑/↓が両方存在)', overCount>0 && underCount>0);
  check('階層内と階層横断の不成立ラインが両方存在', intraAbnormal>0 && crossAbnormal>0);

  // 交換の影響ラインだけ測定結果が無効化される、という仕様は main側(Map管理)のロジックなので
  // ここでは「影響を受けるラインの集合」が正しく特定できることだけを検証する。
  const affectedCell = ctx.REPAIR_CELLS[4]; // 未確定8セルのうちの1つ(座標は問わない)
  const touching = ctx.linesThroughCell(lines, affectedCell.L, affectedCell.r, affectedCell.c);
  check('交換の影響ラインを正しく特定できる', touching.length > 0 && touching.every(l =>
    l.cells.some(c => c.z===affectedCell.L-1 && c.y===affectedCell.r && c.x===affectedCell.c)
  ));
}

console.log('== classifyLineChange ==');
{
  const f = ctx.classifyLineChange;

  // 非成立状態で距離が同じならunchanged(315をまたぐ対称ケースも含む)
  check('距離が同じ(未満側→超過側、絶対距離同じ)はunchanged', f(310, 320) === 'unchanged');
  check('距離が同じ(値が変わらない)はunchanged', f(300, 300) === 'unchanged');

  // 交換前後とも315ならunchanged
  check('交換前後とも315ならunchanged', f(315, 315) === 'unchanged');

  // 非成立から315ならsolved
  check('超過側から315に到達したらsolved', f(320, 315) === 'solved');
  check('未満側から315に到達したらsolved', f(300, 315) === 'solved');

  // 接近(closer)
  check('超過側で315に接近したらcloser', f(325, 320) === 'closer');
  check('未満側で315に接近したらcloser', f(295, 300) === 'closer');
  check('315をまたいで接近したらcloser(超過側→未満側で距離縮小)', f(322, 310) === 'closer');
  check('315をまたいで接近したらcloser(未満側→超過側で距離縮小)', f(305, 318) === 'closer');

  // 離反(farther)
  check('315から離れたらfarther', f(316, 330) === 'farther');
  check('距離が増える交差ならfarther(超過側→未満側で距離拡大)', f(317, 295) === 'farther');
  check('距離が増える交差ならfarther(未満側→超過側で距離拡大)', f(313, 340) === 'farther');
}

console.log('== analyzeAffectedLineChanges ==');
{
  // productionのREPAIR_CELLS座標をキーの生成源としてのみ使う(座標・数字自体はハードコードしない、
  // candidate固有の正解値/初期値は一切参照しない)。値は本テストが独自に割り当てる。
  const cells = ctx.REPAIR_CELLS.slice(0, 6).map(c => ({ L:c.L, r:c.r, c:c.c }));
  const [A, B, OA, OB, U1, U2] = cells;
  const toXYZ = (cell) => ({ z: cell.L-1, y: cell.r, x: cell.c });
  const key = (cell) => ctx.repairCellKey(cell.L, cell.r, cell.c);

  const lineOnlyA   = { key:'test-only-a',   cells:[toXYZ(A), toXYZ(OA)] };
  const lineOnlyB   = { key:'test-only-b',   cells:[toXYZ(B), toXYZ(OB)] };
  const lineShared  = { key:'test-shared',   cells:[toXYZ(A), toXYZ(B)] };
  const lineUnrelated = { key:'test-unrelated', cells:[toXYZ(U1), toXYZ(U2)] };

  const structGrid = () => ({
    [key(A)]:10, [key(B)]:20, [key(OA)]:5, [key(OB)]:7, [key(U1)]:1, [key(U2)]:2,
  });
  const linesInput = [lineOnlyB, lineUnrelated, lineShared, lineOnlyA];
  const before = structGrid();
  const after = structGrid();
  const swapped = [A, B];

  const linesSnapshot = JSON.parse(JSON.stringify(linesInput));
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const afterSnapshot = JSON.parse(JSON.stringify(after));

  const result = ctx.analyzeAffectedLineChanges(linesInput, before, after, swapped);

  check('片方(A)だけを含むラインを抽出する', result.some(r => r.line === lineOnlyA));
  check('もう片方(B)だけを含むラインを抽出する', result.some(r => r.line === lineOnlyB));
  check('両セルを含む共有ラインを1件だけ返す', result.filter(r => r.line === lineShared).length === 1);
  check('無関係なラインを除外する', result.every(r => r.line !== lineUnrelated));
  check('入力linesの順序を維持する', result.map(r=>r.line.key).join(',') === [lineOnlyB, lineShared, lineOnlyA].map(l=>l.key).join(','));
  check('戻り値に正確な合計や偏差量を含めない', result.every(r => {
    const keys = Object.keys(r);
    return keys.every(k => k==='line' || k==='change') && typeof r.change === 'string';
  }));
  check('入力linesを変更しない', JSON.stringify(linesInput) === JSON.stringify(linesSnapshot));
  check('入力gridを変更しない', JSON.stringify(before) === JSON.stringify(beforeSnapshot) && JSON.stringify(after) === JSON.stringify(afterSnapshot));

  // ---- 質的変化(unchanged/solved/closer/farther)の伝播確認 ----
  // 1セルだけのラインで計算を単純化する(合成fixtureであり、CUBE_DATA/candidate値には触れない)。
  function changeCase(beforeVal, afterVal){
    const line = { key:'test-single', cells:[toXYZ(A)] };
    const r = ctx.analyzeAffectedLineChanges([line], { [key(A)]: beforeVal }, { [key(A)]: afterVal }, [A, B]);
    return r[0].change;
  }
  check('unchangedを返す', changeCase(310, 320) === 'unchanged');
  check('solvedを返す', changeCase(300, 315) === 'solved');
  check('closerを返す', changeCase(300, 310) === 'closer');
  check('fartherを返す', changeCase(310, 290) === 'farther');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
