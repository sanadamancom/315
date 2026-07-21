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
  globalThis.classifyDeviationBand = classifyDeviationBand;
  globalThis.DEVIATION_BAND_THRESHOLD = DEVIATION_BAND_THRESHOLD;
  globalThis.linesThroughCell = linesThroughCell;
  globalThis.classifyLineChange = classifyLineChange;
  globalThis.analyzeAffectedLineChanges = analyzeAffectedLineChanges;
  globalThis.autoDecodeSealedCells = autoDecodeSealedCells;
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
  check('未確定セル12件すべてが誤配置(固定点0)', correctCells.length === 0 && misplacedCells.length === 12);

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

console.log('== presentation state (Prototype 07 — candidate 106b01ad) ==');
{
  const lines = ctx.buildLines109();
  const REPAIR_CELLS = ctx.REPAIR_CELLS;
  const REVEALED_FIXED_CELLS = ctx.REVEALED_FIXED_CELLS;

  check('REVEALED_FIXED_CELLSが57件', REVEALED_FIXED_CELLS.length === 57);

  // 座標が全て固定セル・範囲内・一意であることを確認
  let outOfRange = 0, unlockedOverlap = 0;
  const coordKeySet = new Set();
  for(const cell of REVEALED_FIXED_CELLS){
    if(!(Number.isInteger(cell.L) && cell.L>=1 && cell.L<=5 &&
         Number.isInteger(cell.r) && cell.r>=0 && cell.r<5 &&
         Number.isInteger(cell.c) && cell.c>=0 && cell.c<5)) outOfRange++;
    if(ctx.isRepairUnlocked(cell.L,cell.r,cell.c)) unlockedOverlap++;
    coordKeySet.add(ctx.repairCellKey(cell.L,cell.r,cell.c));
  }
  check('全座標が範囲内', outOfRange === 0);
  check('movableと重複しない', unlockedOverlap === 0);
  check('座標が一意(57件)', coordKeySet.size === 57);

  // 全125セルを3状態へ分類し件数を確認
  let movable=0, revealed=0, sealed=0;
  for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++){
    const state = ctx.cellPresentationState(L,r,c);
    if(state==='movable') movable++;
    else if(state==='revealed-fixed') revealed++;
    else sealed++;
  }
  check('分類件数が12/57/56', movable===12 && revealed===57 && sealed===56);

  // LEVEL別revealed件数(12/11/11/11/12)
  const expectedPerLevel = {1:12, 2:11, 3:11, 4:11, 5:12};
  let perLevelOk = true;
  for(let L=1;L<=5;L++){
    const count = REVEALED_FIXED_CELLS.filter(c=>c.L===L).length;
    if(count !== expectedPerLevel[L]) perLevelOk = false;
  }
  check('LEVEL別revealed件数が12/11/11/11/12', perLevelOk);

  // LEVEL別M(未確定セル)件数が順序非依存で4・4・4・0・0であること
  const mPerLevel = [1,2,3,4,5].map(L => REPAIR_CELLS.filter(c=>c.L===L).length).sort((a,b)=>a-b);
  check('LEVEL別M件数が順序非依存で0/0/4/4/4', JSON.stringify(mPerLevel) === JSON.stringify([0,0,4,4,4]));

  // active line = 未確定セル(REPAIR_CELLS)を1個以上含む109ライン
  // inactive line = 未確定セルを含まない(固定セルのみの)109ライン
  const isUnconfirmedCoord = (cell) => REPAIR_CELLS.some(u => u.L===cell.z+1 && u.r===cell.y && u.c===cell.x);
  const activeLines = lines.filter(line => line.cells.some(isUnconfirmedCoord));
  const inactiveLines = lines.filter(line => !line.cells.some(isUnconfirmedCoord));
  const isRevealedCoord = (cell) => REVEALED_FIXED_CELLS.some(rv => rv.L===cell.z+1 && rv.r===cell.y && rv.c===cell.x);
  const isFixedCoord = (cell) => !ctx.isRepairUnlocked(cell.z+1, cell.y, cell.x);

  check('active line + inactive lineが109本を過不足なく分割する', activeLines.length + inactiveLines.length === 109);

  // 各active lineがR=2・S=1・M=2であること(Prototype07: 全ラインM=0またはM=2)
  let activeOk = true;
  for(const line of activeLines){
    const mIn = line.cells.filter(isUnconfirmedCoord).length;
    const fixedInLine = line.cells.filter(isFixedCoord);
    const rev = fixedInLine.filter(isRevealedCoord).length;
    const seal = fixedInLine.length - rev;
    if(!(mIn===2 && rev===2 && seal===1)) activeOk = false;
  }
  check('全active line(20本)がR=2・S=1・M=2', activeOk);

  // 各inactive lineがM=0かつS!=1であること
  let inactiveOk = true;
  for(const line of inactiveLines){
    const mIn = line.cells.filter(isUnconfirmedCoord).length;
    const rev = line.cells.filter(isRevealedCoord).length; // inactive lineは全セル固定
    const seal = 5 - rev;
    if(!(mIn===0 && seal!==1)) inactiveOk = false;
  }
  check('全inactive line(89本)がM=0かつS!=1', inactiveOk);

  // 各LEVELの全row・columnにrevealed-fixedとsealed-fixedの両方が存在(Variant B)
  let rowColBothOk = true;
  for(let L=1;L<=5;L++){
    for(let r=0;r<5;r++){
      const rowFixed = []; for(let c=0;c<5;c++){ if(!ctx.isRepairUnlocked(L,r,c)) rowFixed.push(c); }
      const rowRevealed = rowFixed.filter(c => REVEALED_FIXED_CELLS.some(rv=>rv.L===L&&rv.r===r&&rv.c===c)).length;
      if(rowFixed.length>0 && (rowRevealed===0 || rowRevealed===rowFixed.length)) rowColBothOk = false;
    }
    for(let c=0;c<5;c++){
      const colFixed = []; for(let r=0;r<5;r++){ if(!ctx.isRepairUnlocked(L,r,c)) colFixed.push(r); }
      const colRevealed = colFixed.filter(r => REVEALED_FIXED_CELLS.some(rv=>rv.L===L&&rv.r===r&&rv.c===c)).length;
      if(colFixed.length>0 && (colRevealed===0 || colRevealed===colFixed.length)) rowColBothOk = false;
    }
  }
  check('各LEVELの全row・columnにrevealedとsealedの両方が存在', rowColBothOk);

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

  let eqCountInit=0, band1=0, band2=0;
  overCount=0; underCount=0;
  let intraAbnormal=0, crossAbnormal=0;
  for(const line of lines){
    const sum = line.cells.reduce((a,cell)=>a+ctx.repairGridValue(initState, cell.z+1, cell.y, cell.x), 0);
    const r = ctx.measureLine(initState, line);
    if(r==='=') eqCountInit++;
    if(r==='↑') overCount++;
    if(r==='↓') underCount++;
    if(r!=='='){
      const dist = Math.abs(sum-315);
      if(dist<=55) band1++; else band2++;
      const zs = new Set(line.cells.map(cell=>cell.z));
      if(zs.size===1) intraAbnormal++; else crossAbnormal++;
    }
  }
  check('初期状態の成立数が89/109(active20本のみ不成立)', eqCountInit === 89);
  check('初期over/underが10/10', overCount===10 && underCount===10);
  check('初期band1/band2が11/9', band1===11 && band2===9);
  check('階層内と階層横断の不成立ラインが両方存在', intraAbnormal>0 && crossAbnormal>0);

  // 交換の影響ラインだけ測定結果が無効化される、という仕様は main側(Map管理)のロジックなので
  // ここでは「影響を受けるラインの集合」が正しく特定できることだけを検証する。
  const affectedCell = ctx.REPAIR_CELLS[4]; // 未確定8セルのうちの1つ(座標は問わない)
  const touching = ctx.linesThroughCell(lines, affectedCell.L, affectedCell.r, affectedCell.c);
  check('交換の影響ラインを正しく特定できる', touching.length > 0 && touching.every(l =>
    l.cells.some(c => c.z===affectedCell.L-1 && c.y===affectedCell.r && c.x===affectedCell.c)
  ));
}

console.log('== classifyDeviationBand ==');
{
  const f = ctx.classifyDeviationBand;

  check('315 → equal/band0', JSON.stringify(f(315)) === JSON.stringify({direction:'equal', band:0}));
  check('316 → over/band1', JSON.stringify(f(316)) === JSON.stringify({direction:'over', band:1}));
  check('370 → over/band1(境界55)', JSON.stringify(f(370)) === JSON.stringify({direction:'over', band:1}));
  check('371 → over/band2(境界56)', JSON.stringify(f(371)) === JSON.stringify({direction:'over', band:2}));
  check('314 → under/band1', JSON.stringify(f(314)) === JSON.stringify({direction:'under', band:1}));
  check('260 → under/band1(境界55)', JSON.stringify(f(260)) === JSON.stringify({direction:'under', band:1}));
  check('259 → under/band2(境界56)', JSON.stringify(f(259)) === JSON.stringify({direction:'under', band:2}));
  check('315から同距離のover/underで同じband(370/260)', f(370).band === f(260).band);
  check('315から同距離のover/underで同じband(371/259)', f(371).band === f(259).band);
  check('既定閾値はDEVIATION_BAND_THRESHOLDと一致', ctx.DEVIATION_BAND_THRESHOLD === 55);
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

console.log('== autoDecodeSealedCells(自動解読・固定点反復) ==');
{
  // 合成fixtureのライン(1本5セル、cellKeyOfはそのままcellをkey化する簡易版)。
  // CUBE_DATA/candidate値には一切触れない。
  const cellKeyOf = cell => cell; // fixtureでは文字列セルkeyをそのままcellとして使う
  function line(key, cells){ return { key, cells }; }

  {
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '↑']]); // 非成立
    const known = new Map([['a',1],['b',2],['c',3],['d',4]]);
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('非成立ラインからは解読しない', decoded.size === 0);
  }
  {
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',10],['b',20],['c',30],['d',40]]); // 315-100=215
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('未解読鍵が2個以上なら解読しない', decoded.size === 0);
  }
  {
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',50],['b',50],['c',50],['d',65]]); // 315-215=100
    const { decoded, contributingLineKeys } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('成立ラインの未解読鍵1個を315との差から解読する', decoded.get('e') === 100);
    check('解読に使ったラインをcontributingLineKeysへ含める', contributingLineKeys.has('L1'));
  }
  {
    // L1解読でx=100が判明 -> L2がy以外4個既知になり伝播解読される。
    const lines = [
      line('L1', ['a','b','c','d','x']),
      line('L2', ['x','p','q','r','y']),
    ];
    const statuses = new Map([['L1','='],['L2','=']]);
    const known = new Map([['a',54],['b',54],['c',54],['d',53], ['p',60],['q',60],['r',60]]); // L1: 215+x=315→x=100 / L2: 100+180+y=315→y=35
    const { decoded, contributingLineKeys } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('解読値が別ラインへ伝播する固定点処理', decoded.get('x') === 100 && decoded.get('y') === 35);
    check('伝播元・伝播先の両方がcontributingLineKeysへ入る', contributingLineKeys.has('L1') && contributingLineKeys.has('L2'));
  }
  {
    // 2本のラインが同じ未解読セルzについて同じ値を算出する場合は受理する。
    const lines = [
      line('L1', ['a','b','c','d','z']),
      line('L2', ['p','q','r','s','z']),
    ];
    const statuses = new Map([['L1','='],['L2','=']]);
    const known = new Map([['a',50],['b',50],['c',50],['d',65], ['p',40],['q',40],['r',40],['s',35]]); // 両方とも315-215=100
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('複数ラインの一致結果を受理する', decoded.get('z') === 100);
  }
  {
    // 2本のラインが同じ未解読セルzについて異なる値を算出する場合は競合として受理しない。
    const lines = [
      line('L1', ['a','b','c','d','z']),
      line('L2', ['p','q','r','s','z']),
    ];
    const statuses = new Map([['L1','='],['L2','=']]);
    const known = new Map([['a',50],['b',50],['c',50],['d',65], ['p',60],['q',60],['r',60],['s',45]]); // L1→100 / L2→90(いずれも範囲内だが不一致)
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('競合結果を受理しない', !decoded.has('z'));
  }
  {
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',100],['b',100],['c',100],['d',100]]); // 315-400=-85 (範囲外)
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('範囲外の算出値を受理しない', decoded.size === 0);
  }
  {
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',1.5],['b',2],['c',3],['d',4]]); // 非整数を含む合計 -> 非整数の算出値
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('非整数の算出値を受理しない', decoded.size === 0);
  }
  {
    // 既に解読済みの値を上書きしない: knownValuesに既にeが含まれていれば、別解が出ても上書きしない
    // (unknownKeysが0件になるため、そもそも再算出の対象外になることを確認する)。
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',10],['b',20],['c',30],['d',40],['e',999]]); // 全既知(矛盾した値でも上書き対象外)
    const { decoded } = ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf);
    check('既に解読済み(=全既知)の値を後から上書きしない', decoded.size === 0);
  }
  {
    // 未解読値・correctValueを一切渡さずに動作することの確認(引数はlines/status/knownValues/cellKeyOfだけ)。
    const lines = [ line('L1', ['a','b','c','d','e']) ];
    const statuses = new Map([['L1', '=']]);
    const known = new Map([['a',60],['b',60],['c',60],['d',60]]);
    let threw = false;
    try{ ctx.autoDecodeSealedCells(lines, statuses, known, cellKeyOf); }catch(e){ threw = true; }
    check('未解読値やcorrectValueなしで動作する(例外なし)', !threw);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
