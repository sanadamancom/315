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
  globalThis.repairCellKey = repairCellKey;
  globalThis.isRepairUnlocked = isRepairUnlocked;
  globalThis.repairCellDef = repairCellDef;
  globalThis.repairGridValue = repairGridValue;
  globalThis.createInitialRepairState = createInitialRepairState;
  globalThis.swapRepairCells = swapRepairCells;
  globalThis.isRepairSolved = isRepairSolved;
  globalThis.measureLine = measureLine;
  globalThis.linesThroughCell = linesThroughCell;
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
