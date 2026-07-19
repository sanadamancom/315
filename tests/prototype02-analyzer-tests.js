// tests/prototype02-analyzer-tests.js
// tools/repair/prototype02-analyzer.js の検証。
// 実行: node tests/prototype02-analyzer-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('../tools/repair/prototype02-analyzer.js');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

// production fixture: 現在のpuzzle.js(本番REPAIR_CELLS、どのPrototypeが有効かは問わない)を
// そのまま読み込む。ここでは「例外なく完走する」「型・不変条件を満たす」ことだけを検証し、
// 本番候補固有の正誤内訳・最短交換数などの具体値はassertしない
// (具体値のexactな検証は本ファイル後半のsynthetic fixtureで行う)。
function loadProductionCells(){
  const ctx = {};
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js/repair/puzzle.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'puzzle.js' });
  vm.runInContext(`globalThis.REPAIR_CELLS = REPAIR_CELLS;`, ctx);
  // 元データを汚染しないよう深いコピーを返す
  return ctx.REPAIR_CELLS.map(c => Object.assign({}, c));
}

const { CUBE_DATA, lines } = A.loadCubeContext();
const productionCells = loadProductionCells();

console.log('== 座標検証: 重複・範囲外の拒否 ==');
{
  const dup = productionCells.map(c=>Object.assign({},c));
  dup[1] = Object.assign({}, dup[0]); // 座標を1件重複させる
  const r1 = A.validateCandidateCells(dup);
  check('重複座標を検出する', r1.valid===false && r1.duplicateCount>0);

  const oob = productionCells.map(c=>Object.assign({},c));
  oob[2] = Object.assign({}, oob[2], { L: 9 }); // 範囲外
  const r2 = A.validateCandidateCells(oob);
  check('範囲外座標を検出する', r2.valid===false && r2.outOfRangeCount>0);

  const ok = A.validateCandidateCells(productionCells);
  check('正常な8セルは合格する', ok.valid===true && ok.duplicateCount===0 && ok.outOfRangeCount===0);
}

console.log('== 値の重複・欠落の拒否 ==');
{
  const okBoard = A.buildBoard(CUBE_DATA, productionCells);
  const okResult = A.validateBoardCompleteness(okBoard);
  check('正常盤面は1〜125を重複欠落なく含む', okResult.valid===true && okResult.count===125 && okResult.uniqueCount===125);

  const brokenBoard = okBoard.map(plane=>plane.map(row=>row.slice()));
  brokenBoard[0][0][0] = brokenBoard[0][0][1]; // 値を重複させる(欠落も同時発生)
  const brokenResult = A.validateBoardCompleteness(brokenBoard);
  check('値の重複・欠落を検出する', brokenResult.valid===false && brokenResult.uniqueCount<125);
}

console.log('== 対象外セル変更の検出 ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const okFixed = A.validateFixedCellsUnchanged(CUBE_DATA, board, productionCells);
  check('固定セルが変更されていなければ合格', okFixed.valid===true && okFixed.mismatchCount===0 && okFixed.fixedCellCount===117);

  const tampered = board.map(plane=>plane.map(row=>row.slice()));
  tampered[0][0][0] = tampered[0][0][0] + 1000; // 固定セル(候補8件に含まれない位置)を破壊
  const badFixed = A.validateFixedCellsUnchanged(CUBE_DATA, tampered, productionCells);
  check('固定セルの変更を検出する', badFixed.valid===false && badFixed.mismatchCount===1);
}

console.log('== 初期値が正解値集合の順列か ==');
{
  const perm = A.validateInitialIsPermutationOfCorrect(productionCells);
  check('本番候補の初期値は正解値集合の順列', perm.isPermutation===true);

  const notPerm = productionCells.map(c=>Object.assign({},c));
  notPerm[0] = Object.assign({}, notPerm[0], { initialValue: 999999 });
  const bad = A.validateInitialIsPermutationOfCorrect(notPerm);
  check('順列でない場合を検出する', bad.isPermutation===false);
}

console.log('== 正解/誤配置集計・階層分布(production fixture: 不変条件のみ) ==');
{
  const status = A.countPlacementStatus(productionCells);
  check('placement集計の合計が未確定セル数と一致', status.correctCount + status.misplacedCount === productionCells.length);
  check('誤配置セルが候補基準(3LEVEL以上)に分散している', status.misplacedLevelCount>=3);
}

console.log('== 階層内／階層横断ラインの分類 ==');
{
  const intra = lines.filter(l=>A.classifyLine(l)==='intra').length;
  const cross = lines.filter(l=>A.classifyLine(l)==='cross').length;
  check('階層内60本・階層横断49本(計109本)', intra===60 && cross===49 && intra+cross===109);
}

console.log('== 109ライン集計(成立/↑/↓ + 階層内外) ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const summary = A.summarizeLines(board, lines);
  check('集計の合計が109本と一致', summary.eq+summary.over+summary.under===109);
  check('階層内訳の合計も109本と一致',
    summary.byClass.intra.total+summary.byClass.cross.total===109);
  check('初期破損状態で不成立ラインが存在する', summary.over>0 && summary.under>0);
}

console.log('== 未確定セルごとの所属不成立ライン数 ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const perCell = A.perCellAbnormalLineCounts(board, lines, productionCells);
  check('8セル分の集計が得られる', perCell.length===8);
  check('各セルの所属ライン数は正の値', perCell.every(p=>p.touchingLineCount>0));
}

console.log('== 巡回構造による最短交換数(production fixture: 候補基準のみ) ==');
{
  const result = A.minSwapsFromCycles(productionCells);
  check('順列として正しく巡回分解できる', result.validDecomposition===true);
  check('最短交換数が候補基準(4以上)を満たす', result.minSwaps>=4);
}

console.log('== 交換候補28通りの分析(非破壊性含む) ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const boardSnapshot = JSON.stringify(board);
  const cellsSnapshot = JSON.stringify(productionCells);

  const results = A.analyzeAllSwaps(board, lines, productionCells);
  check('28通り(8C2)の交換候補が得られる', results.length===28);
  check('各交換結果に必要な指標が揃っている', results.every(r =>
    typeof r.eqDelta==='number' && typeof r.devDelta==='number' &&
    typeof r.improvedLineCount==='number' && typeof r.worsenedLineCount==='number' &&
    typeof r.newlyEqualCount==='number' && typeof r.newlyUnequalCount==='number'
  ));
  check('交換分析後も元のboardが変化しない', JSON.stringify(board)===boardSnapshot);
  check('交換分析後も元のcellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);

  // 正解へ向かう交換(idx4-5, idx4-6, idx4-7等)のいずれかで成立数が増えるはず
  check('少なくとも1つの交換で成立ライン数が増加する', results.some(r=>r.eqDelta>0));
}

console.log('== 8!全探索で成立配置数を取得 ==');
{
  const t0 = Date.now();
  const result = A.exhaustiveUniqueSolutionCount(CUBE_DATA, lines, productionCells);
  const elapsedMs = Date.now()-t0;
  check('40320通りを全探索する', result.permutationsChecked===40320);
  check('本番候補は一意解(1通り、候補選定の必須条件)', result.solutionCount===1);
  console.log(`  (elapsed: ${elapsedMs}ms, relevantLines: ${result.relevantLineCount})`);
}

console.log('== exhaustiveUniqueSolutionCountのisUnique契約 ==');
{
  const normal = A.exhaustiveUniqueSolutionCount(CUBE_DATA, lines, productionCells);
  check('isUniqueが常にboolean', typeof normal.isUnique === 'boolean');
  check('成立配置数1件ならisUnique=true', normal.solutionCount===1 && normal.isUnique===true);

  // 縮退synthetic fixture(production非依存): 2セルのcorrectValueを意図的に同一化すると、
  // どの並べ替えでも実際のCUBE_DATA値と食い違うため成立配置数が1以外(0件)になる。
  function arbitraryCoords(n){
    const coords=[];
    findCoords: for(let L=1;L<=5;L++) for(let r=0;r<5;r++) for(let c=0;c<5;c++){
      coords.push({L,r,c});
      if(coords.length===n) break findCoords;
    }
    return coords;
  }
  const degenerateCoords = arbitraryCoords(2);
  const degenerate = degenerateCoords.map(coord => ({ L:coord.L, r:coord.r, c:coord.c, correctValue: CUBE_DATA[coord.L-1][coord.r][coord.c] }));
  degenerate[1] = Object.assign({}, degenerate[1], { correctValue: degenerate[0].correctValue }); // 縮退
  degenerate[0].initialValue = degenerate[0].correctValue;
  degenerate[1].initialValue = degenerate[1].correctValue;

  const brokenResult = A.exhaustiveUniqueSolutionCount(CUBE_DATA, lines, degenerate);
  check('人工ケースの前提(成立配置数が1件以外になっている)', brokenResult.solutionCount !== 1);
  check('0件または複数件ならisUnique=false', typeof brokenResult.isUnique === 'boolean' && brokenResult.isUnique === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
