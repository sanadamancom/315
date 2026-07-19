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

// Prototype 02 fixture: production(js/repair/puzzle.js)のREPAIR_CELLSは他Prototypeの
// 接続により内容が変わり得るため、本ファイルはそれに依存しない。代わりに保存済みの
// Prototype 02候補(tools/repair/prototype02-candidate.json)からセル座標・initialValueを
// 読み込み、correctValueはCUBE_DATAの対応位置(=候補選定時に固定された正解)から再構築する。
// ここでは「例外なく完走する」「型・不変条件を満たす」ことだけを検証し、
// 本fixture固有の正誤内訳・最短交換数などの具体値はassertしない
// (具体値のexactな検証は本ファイル後半のsynthetic fixtureで行う)。
function loadProductionCells(){
  const candidate = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tools/repair/prototype02-candidate.json'), 'utf8'
  ));
  const { CUBE_DATA } = A.loadCubeContext();
  return candidate.cells.map(cell => ({
    L: cell.z + 1, r: cell.y, c: cell.x,
    correctValue: CUBE_DATA[cell.z][cell.y][cell.x],
    initialValue: cell.initialValue,
  }));
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
  check('Prototype 02候補の初期値は正解値集合の順列', perm.isPermutation===true);

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
  check('Prototype 02候補は一意解(1通り、候補選定の必須条件)', result.solutionCount===1);
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

console.log('== analyzeDirectSubtraction: production fixture(Prototype 02) ==');
{
  const result = A.analyzeDirectSubtraction(CUBE_DATA, lines, productionCells);

  check('未確定セル数別ラインヒストグラムが0件74本・1件31本・2件4本',
    result.lineUnknownCountHistogram[0]===74 &&
    result.lineUnknownCountHistogram[1]===31 &&
    result.lineUnknownCountHistogram[2]===4);
  check('初期1未確定ライン数は31本', result.initialSingleUnknownLineCount===31);
  check('初回waveの直接確定セル数は8件(重複除外済み)', result.initialDirectCellCount===8);
  check('wave数は1', result.waves.length===1);
  check('総確定セル数は8件・比率100%', result.solvedCellCount===8 && result.solvedRatio===1);
  check('完走(matrix全確定・矛盾なし)', result.isComplete===true);
  check('矛盾は検出されない', result.contradictions.length===0);

  const uniqueCoordsInWave0 = new Set(result.waves[0].cells.map(c=>`${c.L}-${c.r}-${c.c}`));
  check('同一セルを複数ラインが導出しても1セルとして数える(8セル分のユニーク座標)', uniqueCoordsInWave0.size===8);
}

console.log('== analyzeDirectSubtraction: 入力の非破壊性 ==');
{
  const cubeSnapshot = JSON.stringify(CUBE_DATA);
  const linesSnapshot = JSON.stringify(lines);
  const cellsSnapshot = JSON.stringify(productionCells);

  A.analyzeDirectSubtraction(CUBE_DATA, lines, productionCells);

  check('CUBE_DATAが変化しない', JSON.stringify(CUBE_DATA)===cubeSnapshot);
  check('linesが変化しない', JSON.stringify(lines)===linesSnapshot);
  check('cellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);
}

console.log('== analyzeDirectSubtraction: correctValueを推論に使用しない ==');
{
  const withCorrect = A.analyzeDirectSubtraction(CUBE_DATA, lines, productionCells);

  const stripped = productionCells.map(c => ({ L:c.L, r:c.r, c:c.c, initialValue:c.initialValue }));
  const withoutCorrect = A.analyzeDirectSubtraction(CUBE_DATA, lines, stripped);
  check('correctValueを除外しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withoutCorrect));

  const tampered = productionCells.map(c => Object.assign({}, c, { correctValue: c.correctValue + 999 }));
  const withTamperedCorrect = A.analyzeDirectSubtraction(CUBE_DATA, lines, tampered);
  check('correctValueを改変しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withTamperedCorrect));
}

console.log('== analyzeDirectSubtraction: synthetic fixture(production非依存、多wave伝播) ==');
{
  // 5x5x5のCUBE_DATAをすべて0で初期化した独立データを使う(productionのCUBE_DATAとは無関係)。
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));

  // cellA={L1,r0,c0}, cellB={L1,r0,c1} の2未確定セルを、2本の合成ラインで多wave伝播させる。
  // line1: cellA + 固定セル(z0,y0,x2=100) -> 315-100=215がcellAへ直接導出される(wave1)。
  // line2: cellA + cellB -> wave1でcellAが既知になった後、wave2でcellBが導出される(315-215=100)。
  syntheticCube[0][0][2] = 100;
  const line1 = { type:'synthetic', key:'syn-1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const line2 = { type:'synthetic', key:'syn-2', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:1} ] };
  const syntheticLines = [line1, line2];

  const cellA = { L:1, r:0, c:0, initialValue:100 }; // = cellBの導出値と一致させ、プール整合を取る
  const cellB = { L:1, r:0, c:1, initialValue:215 }; // = cellAの導出値と一致させ、プール整合を取る
  const cells = [cellA, cellB];

  const result = A.analyzeDirectSubtraction(syntheticCube, syntheticLines, cells);

  check('ヒストグラムはline1(1未確定)・line2(初期2未確定)', result.lineUnknownCountHistogram[1]===1 && result.lineUnknownCountHistogram[2]===1);
  check('初期1未確定ライン数は1本', result.initialSingleUnknownLineCount===1);
  check('初回waveでは1セル(cellA)のみ確定', result.initialDirectCellCount===1);
  check('wave数は2(多wave伝播)', result.waves.length===2);
  check('wave1でcellA=215が導出される', result.waves[0].cells.length===1 && result.waves[0].cells[0].derivedValue===215);
  check('wave2でcellB=100が導出される', result.waves[1].cells.length===1 && result.waves[1].cells[0].derivedValue===100);
  check('最終的に2セルとも確定・矛盾なし', result.solvedCellCount===2 && result.solvedRatio===1 && result.isComplete===true && result.contradictions.length===0);
}

console.log('== analyzeDirectSubtraction: synthetic fixture(初期1未確定ラインなし→0件確定) ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));

  // cellC, cellDの2未確定セルが常に同じラインへ2件セットで現れ、単独ラインが存在しない構造。
  const line1 = { type:'synthetic', key:'syn-3', cells:[ {z:0,y:1,x:0}, {z:0,y:1,x:1} ] };
  const syntheticLines = [line1];

  const cellC = { L:1, r:1, c:0, initialValue:10 };
  const cellD = { L:1, r:1, c:1, initialValue:20 };
  const cells = [cellC, cellD];

  const result = A.analyzeDirectSubtraction(syntheticCube, syntheticLines, cells);

  check('初期1未確定ラインは0本', result.initialSingleUnknownLineCount===0);
  check('初回waveの直接確定セル数は0件', result.initialDirectCellCount===0);
  check('waveが1件も発生しない', result.waves.length===0);
  check('確定セル数0件・完走しない', result.solvedCellCount===0 && result.isComplete===false);
}

console.log('== analyzeDirectSubtraction: synthetic fixture(矛盾する導出の検出) ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][2][1] = 50; // fixedX
  syntheticCube[0][2][2] = 60; // fixedY

  // cellEを含む2本のラインがそれぞれ異なる導出値(315-50=265 と 315-60=255)を出し、矛盾する。
  const line1 = { type:'synthetic', key:'syn-4', cells:[ {z:0,y:2,x:0}, {z:0,y:2,x:1} ] };
  const line2 = { type:'synthetic', key:'syn-5', cells:[ {z:0,y:2,x:0}, {z:0,y:2,x:2} ] };
  const syntheticLines = [line1, line2];

  const cellE = { L:1, r:2, c:0, initialValue:1 };
  const cells = [cellE];

  const result = A.analyzeDirectSubtraction(syntheticCube, syntheticLines, cells);

  check('矛盾が検出される', result.contradictions.some(c=>c.type==='conflicting-derivation'));
  check('矛盾したセルは確定されない', result.solvedCellCount===0);
  check('完走しない', result.isComplete===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: production fixture(Prototype 02) ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, lines, productionCells);

  check('全28交換候補を評価する', result.totalSwapCount===28 && result.results.length===28);
  check('compatible swap数は15件', result.compatibleSwapCount===15 && result.compatibleSwaps.length===15);
  check('各結果にi,j,improvedLineCount,worsenedLineCount,isCompatibleが揃っている', result.results.every(r =>
    typeof r.i==='number' && typeof r.j==='number' &&
    typeof r.improvedLineCount==='number' && typeof r.worsenedLineCount==='number' &&
    typeof r.isCompatible==='boolean'
  ));
  check('各結果にI側・J側の内訳フィールドが揃っている', result.results.every(r =>
    typeof r.improvedLineCountI==='number' && typeof r.improvedLineCountJ==='number' &&
    typeof r.worsenedLineCountI==='number' && typeof r.worsenedLineCountJ==='number'
  ));
  check('合計フィールドがI側・J側の和と一致する(全28件)', result.results.every(r =>
    r.improvedLineCount === r.improvedLineCountI + r.improvedLineCountJ &&
    r.worsenedLineCount === r.worsenedLineCountI + r.worsenedLineCountJ
  ));
  check('compatibleSwapsは全てisCompatible=true・worsenedLineCount=0・improvedLineCount>=1', result.compatibleSwaps.every(r =>
    r.isCompatible===true && r.worsenedLineCount===0 && r.improvedLineCount>=1
  ));

  const expectedCompatiblePairs = [[0,1],[0,2],[0,3],[0,6],[0,7],[1,7],[2,3],[2,4],[2,5],[3,4],[3,5],[4,6],[4,7],[5,6],[5,7]];
  const actualPairs = result.compatibleSwaps.map(r=>`${r.i}-${r.j}`).sort();
  const expectedKeys = expectedCompatiblePairs.map(([i,j])=>`${i}-${j}`).sort();
  check('compatible15件のペア内訳が読み取り調査結果と一致', JSON.stringify(actualPairs)===JSON.stringify(expectedKeys));
}

console.log('== analyzeSignOnlyCompatibleSwaps: correctValueを推論に使用しない ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const withCorrect = A.analyzeSignOnlyCompatibleSwaps(board, lines, productionCells);

  const stripped = productionCells.map(c => ({ L:c.L, r:c.r, c:c.c, initialValue:c.initialValue }));
  const withoutCorrect = A.analyzeSignOnlyCompatibleSwaps(board, lines, stripped);
  check('correctValueを除外しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withoutCorrect));

  const tampered = productionCells.map(c => Object.assign({}, c, { correctValue: c.correctValue + 999 }));
  const withTamperedCorrect = A.analyzeSignOnlyCompatibleSwaps(board, lines, tampered);
  check('correctValueを改変しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withTamperedCorrect));
}

console.log('== analyzeSignOnlyCompatibleSwaps: exact deviation量を順位付けに使わない ==');
{
  // 符号構造(↑↓の向き・delta方向)を保ったまま、絶対値だけを変えた合成データで
  // isCompatible/improvedLineCount/worsenedLineCountが変化しないことを確認する。
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 50;  // fixedX(cellI専用ラインの相手セル)
  syntheticCube[0][0][3] = 400; // fixedY(cellJ専用ラインの相手セル、↑にする)

  const lineForCellIOnly = { type:'synthetic', key:'syn-a', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] }; // ↓ライン想定
  const lineForCellJOnly  = { type:'synthetic', key:'syn-b', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:3} ] }; // ↑ライン想定
  const syntheticLines = [lineForCellIOnly, lineForCellJOnly];

  function run(valI, valJ){
    const cellI = { L:1, r:0, c:0, initialValue:valI };
    const cellJ = { L:1, r:0, c:1, initialValue:valJ };
    const cells = [cellI, cellJ];
    const board = A.buildBoard(syntheticCube, cells);
    return A.analyzeSignOnlyCompatibleSwaps(board, syntheticLines, cells);
  }

  const small = run(10, 20);   // delta=+10(小さい絶対値)
  const large = run(1, 2000);  // delta=+1990(大きい絶対値、符号は同じ)

  check('絶対値が大きく異なっても同じ符号構造ならisCompatible/カウントが一致',
    small.results[0].isCompatible===large.results[0].isCompatible &&
    small.results[0].improvedLineCount===large.results[0].improvedLineCount &&
    small.results[0].worsenedLineCount===large.results[0].worsenedLineCount);
}

console.log('== analyzeSignOnlyCompatibleSwaps: ↑へ小さい値・↓へ大きい値を改善として扱う ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 50;  // fixedX(↓ラインになるよう小さめ)

  // cellIのみが所属する1本のライン(↓)。delta>0(cellIが増加)なら改善のはず。
  const line1 = { type:'synthetic', key:'syn-c', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const cellIUp = { L:1, r:0, c:0, initialValue:10 };  // 増加する側(交換相手が大きい値)
  const cellJUp = { L:1, r:0, c:1, initialValue:200 }; // cellJはこのラインに属さない
  const board1 = A.buildBoard(syntheticCube, [cellIUp, cellJUp]);
  const result1 = A.analyzeSignOnlyCompatibleSwaps(board1, [line1], [cellIUp, cellJUp]);
  check('↓ラインでcellIの値が増加する交換は改善扱い', result1.results[0].improvedLineCount===1 && result1.results[0].worsenedLineCount===0);

  const syntheticCube2 = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube2[0][0][2] = 400; // fixedX(↑ラインになるよう大きめ)
  const line2 = { type:'synthetic', key:'syn-d', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const cellIDown = { L:1, r:0, c:0, initialValue:200 };
  const cellJDown = { L:1, r:0, c:1, initialValue:10 }; // cellIより小さい値 -> delta<0(cellIが減少)
  const board2 = A.buildBoard(syntheticCube2, [cellIDown, cellJDown]);
  const result2 = A.analyzeSignOnlyCompatibleSwaps(board2, [line2], [cellIDown, cellJDown]);
  check('↑ラインでcellIの値が減少する交換は改善扱い', result2.results[0].improvedLineCount===1 && result2.results[0].worsenedLineCount===0);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 改悪ラインを含むpairを除外する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 50;   // cellI専用ライン(↓) -> cellIの増加(delta>0)が改善
  syntheticCube[0][0][3] = 50;   // cellJ専用ライン(↓) -> cellJの増加(delta<0)が改善(delta>0と矛盾)

  const lineI = { type:'synthetic', key:'syn-e', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] }; // ↓、改善にはdelta>0が必要
  const lineJ = { type:'synthetic', key:'syn-f', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:3} ] }; // ↓、改善にはdelta<0が必要(矛盾)
  const syntheticLines = [lineI, lineJ];

  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:200 }; // delta=+190 -> lineIは改善、lineJは改悪
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, syntheticLines, [cellI, cellJ]);

  check('改悪ラインが1本でもあればisCompatible=false', result.results[0].worsenedLineCount>=1 && result.results[0].isCompatible===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 共有ラインを無視する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  // cellI・cellJの両方を含む1本のラインだけを用意する(交換しても合計不変のはず)。
  const sharedLine = { type:'synthetic', key:'syn-g', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:1}, {z:0,y:0,x:2} ] };
  syntheticCube[0][0][2] = 1; // 固定セル(このラインを↓等の異常にする値)

  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:20 };
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, [sharedLine], [cellI, cellJ]);

  check('両セルを含むラインは判定対象外(改善・改悪どちらにも計上されない)',
    result.results[0].improvedLineCount===0 && result.results[0].worsenedLineCount===0);
  check('判定対象ラインがなければimproved0件のためisCompatible=false', result.results[0].isCompatible===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 改善0件を除外する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  // cellI・cellJそれぞれの専用ラインを、両方とも既に成立(=)している状態にする。
  syntheticCube[0][0][2] = 305; // cellI(10)+305=315 -> 成立
  syntheticCube[0][0][3] = 295; // cellJ(20)+295=315 -> 成立

  const lineI = { type:'synthetic', key:'syn-h', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const lineJ = { type:'synthetic', key:'syn-i', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:3} ] };
  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:20 };
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, [lineI, lineJ], [cellI, cellJ]);

  check('異常ラインが1本もなければimprovedLineCount=0でisCompatible=false',
    result.results[0].improvedLineCount===0 && result.results[0].worsenedLineCount===0 && result.results[0].isCompatible===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 入力の非破壊性 ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const boardSnapshot = JSON.stringify(board);
  const linesSnapshot = JSON.stringify(lines);
  const cellsSnapshot = JSON.stringify(productionCells);

  A.analyzeSignOnlyCompatibleSwaps(board, lines, productionCells);

  check('boardが変化しない', JSON.stringify(board)===boardSnapshot);
  check('linesが変化しない', JSON.stringify(lines)===linesSnapshot);
  check('cellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);
}

console.log('== analyzeSignOnlyCompatibleSwaps: I側・J側の内訳分離(改善) ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 50;   // cellI専用ライン1(↓)
  syntheticCube[0][0][3] = 100;  // cellI専用ライン2(↓)
  syntheticCube[0][0][4] = 200;  // cellJ専用ライン(↑)

  const lineI1 = { type:'synthetic', key:'syn-j1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const lineI2 = { type:'synthetic', key:'syn-j2', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:3} ] };
  const lineJ1 = { type:'synthetic', key:'syn-j3', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:4} ] };
  const syntheticLines = [lineI1, lineI2, lineJ1];

  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:200 }; // delta=+190
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, syntheticLines, [cellI, cellJ]);
  const r = result.results[0];

  check('I側に複数(2件)の改善根拠が分離される', r.improvedLineCountI===2 && r.worsenedLineCountI===0);
  check('J側に1件の改善根拠が分離される', r.improvedLineCountJ===1 && r.worsenedLineCountJ===0);
  check('合計フィールドがI側・J側の和と一致する', r.improvedLineCount===3 && r.improvedLineCount===r.improvedLineCountI+r.improvedLineCountJ);
  check('両側に根拠があるケースでisCompatible=true', r.isCompatible===true);
}

console.log('== analyzeSignOnlyCompatibleSwaps: I側・J側の内訳分離(改悪含む) ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 400; // cellI専用ライン(↑) -> delta>0では改悪
  syntheticCube[0][0][3] = 200; // cellJ専用ライン(↑) -> delta>0では改善

  const lineIWorsen = { type:'synthetic', key:'syn-k1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const lineJImprove = { type:'synthetic', key:'syn-k2', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:3} ] };
  const syntheticLines = [lineIWorsen, lineJImprove];

  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:200 }; // delta=+190
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, syntheticLines, [cellI, cellJ]);
  const r = result.results[0];

  check('I側の改悪ラインがworsenedLineCountIへ分離される', r.worsenedLineCountI===1 && r.improvedLineCountI===0);
  check('J側の改善ラインがimprovedLineCountJへ分離される', r.improvedLineCountJ===1 && r.worsenedLineCountJ===0);
  check('合計worsenedLineCountがI側・J側の和と一致する', r.worsenedLineCount===1 && r.worsenedLineCount===r.worsenedLineCountI+r.worsenedLineCountJ);
  check('改悪ラインが1本でもあればisCompatible=false(既存条件は変わらない)', r.isCompatible===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 片側だけに改善根拠があるケース ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 50; // cellI専用ライン(↓)のみ。cellJは所属ラインなし。

  const lineI = { type:'synthetic', key:'syn-l1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:200 };
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, [lineI], [cellI, cellJ]);
  const r = result.results[0];

  check('I側だけに改善根拠がある', r.improvedLineCountI===1 && r.improvedLineCountJ===0);
  check('J側は根拠0件のまま(worsenedも0)', r.worsenedLineCountJ===0 && r.improvedLineCountJ===0);
  check('片側だけの根拠でもisCompatible=true(既存条件は変わらない)', r.isCompatible===true);
}

console.log('== analyzeSignOnlyCompatibleSwaps: 共有ライン・成立ラインはI側/J側どちらにも計上しない ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 1;   // 共有ライン用の固定セル
  syntheticCube[0][0][3] = 305; // cellI専用ライン用固定セル(成立させる: 10+305=315)
  syntheticCube[0][0][4] = 295; // cellJ専用ライン用固定セル(成立させる: 20+295=315)

  const sharedLine = { type:'synthetic', key:'syn-m1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:1}, {z:0,y:0,x:2} ] };
  const solvedLineI = { type:'synthetic', key:'syn-m2', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:3} ] };
  const solvedLineJ = { type:'synthetic', key:'syn-m3', cells:[ {z:0,y:0,x:1}, {z:0,y:0,x:4} ] };
  const syntheticLines = [sharedLine, solvedLineI, solvedLineJ];

  const cellI = { L:1, r:0, c:0, initialValue:10 };
  const cellJ = { L:1, r:0, c:1, initialValue:20 };
  const board = A.buildBoard(syntheticCube, [cellI, cellJ]);
  const result = A.analyzeSignOnlyCompatibleSwaps(board, syntheticLines, [cellI, cellJ]);
  const r = result.results[0];

  check('共有ライン・成立ラインはI側/J側いずれの件数にも含まれない',
    r.improvedLineCountI===0 && r.worsenedLineCountI===0 &&
    r.improvedLineCountJ===0 && r.worsenedLineCountJ===0);
  check('根拠0件のためisCompatible=false', r.isCompatible===false);
}

console.log('== analyzeSignOnlyCompatibleSwaps: I/J内訳もcorrectValue非依存・入力非破壊 ==');
{
  const board = A.buildBoard(CUBE_DATA, productionCells);
  const boardSnapshot = JSON.stringify(board);
  const cellsSnapshot = JSON.stringify(productionCells);

  const withCorrect = A.analyzeSignOnlyCompatibleSwaps(board, lines, productionCells);
  const stripped = productionCells.map(c => ({ L:c.L, r:c.r, c:c.c, initialValue:c.initialValue }));
  const withoutCorrect = A.analyzeSignOnlyCompatibleSwaps(board, lines, stripped);

  check('I/J内訳を含む結果全体がcorrectValue除外でも同一', JSON.stringify(withCorrect)===JSON.stringify(withoutCorrect));
  check('呼び出し後もboardが変化しない', JSON.stringify(board)===boardSnapshot);
  check('呼び出し後もcellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);
}

console.log('== countLineConstrainedSolutions: Prototype 02とexhaustiveUniqueSolutionCountのcross-check ==');
{
  const existing = A.exhaustiveUniqueSolutionCount(CUBE_DATA, lines, productionCells);
  const counted = A.countLineConstrainedSolutions(CUBE_DATA, lines, productionCells);

  check('solutionCountが一致する', counted.solutionCount===existing.solutionCount);
  check('isUnique分類が一致する', counted.isUnique===existing.isUnique);
  check('Prototype 02候補はmaxSolutions未打ち切りで一意', counted.isUnique===true && counted.reachedLimit===false);
}

console.log('== countLineConstrainedSolutions: 12セル(2x2x3構造)fixtureを現実的時間で判定できる ==');
{
  // 中心対称な軸部分集合の直積(z:{0,4}, y:{0,4}, x:{0,2,4})の実座標12セル。
  const cellSetBase = [];
  for(const z of [0,4]) for(const y of [0,4]) for(const x of [0,2,4]) cellSetBase.push({ L:z+1, r:y, c:x });
  check('12セルちょうど生成できる', cellSetBase.length===12);

  // domainは正解値そのもの(=識別性のためinitialValue=correctValueとし、少なくとも1解の存在を保証する)。
  const cells12 = cellSetBase.map(coord => {
    const v = CUBE_DATA[coord.L-1][coord.r][coord.c];
    return { L:coord.L, r:coord.r, c:coord.c, correctValue:v, initialValue:v };
  });

  const t0 = Date.now();
  const result = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells12);
  const elapsedMs = Date.now()-t0;

  check('12セルでも5秒以内に判定が完了する', elapsedMs < 5000);
  check('探索ノードが実際に展開される', result.nodesExplored>0);
  check('解が少なくとも1件見つかる(識別代入が有効解のため)', result.solutionCount>=1);
  check('isUniqueはsolutionCount===1かつ非打ち切りの時だけtrue', result.isUnique===(result.solutionCount===1 && result.reachedLimit===false));
  console.log(`  (elapsed: ${elapsedMs}ms, solutionCount: ${result.solutionCount}, nodesExplored: ${result.nodesExplored})`);
}

console.log('== countLineConstrainedSolutions: 一意解ケースを1件として返す(synthetic fixture) ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2] = 215; // posA専用ライン: 315-215=100 -> domain中100しか満たせない

  const lineOnlyA = { type:'synthetic', key:'syn-u1', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:2} ] };
  const posA = { L:1, r:0, c:0, initialValue:100 };
  const posB = { L:1, r:0, c:1, initialValue:215 }; // posBには関連ラインなし(all-differentのみで確定)

  const result = A.countLineConstrainedSolutions(syntheticCube, [lineOnlyA], [posA, posB]);
  check('一意解ケースはsolutionCount=1', result.solutionCount===1);
  check('isUnique=true・reachedLimit=false', result.isUnique===true && result.reachedLimit===false);
}

console.log('== countLineConstrainedSolutions: 複数解ケースをmaxSolutionsで打ち切る ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  const posA = { L:1, r:0, c:0, initialValue:1 };
  const posB = { L:1, r:0, c:1, initialValue:2 };
  const posC = { L:1, r:0, c:2, initialValue:3 };
  // 関連ラインを与えない(lines=[])ため、3値の並べ替え3!=6通り全てが解になる。
  const result = A.countLineConstrainedSolutions(syntheticCube, [], [posA, posB, posC]); // maxSolutionsデフォルト2

  check('デフォルトmaxSolutions=2で2件に打ち切られる', result.solutionCount===2 && result.reachedLimit===true);
  check('複数解ケースはisUnique=false', result.isUnique===false);
}

console.log('== countLineConstrainedSolutions: 解なしケースを0件として返す ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][1] = 1; // 固定セル
  // domainは100の1件のみだが、ラインの必要値は315-1=314であり、100は絶対に満たせない。
  const lineImpossible = { type:'synthetic', key:'syn-u2', cells:[ {z:0,y:0,x:0}, {z:0,y:0,x:1} ] };
  const posA = { L:1, r:0, c:0, initialValue:100 };

  const result = A.countLineConstrainedSolutions(syntheticCube, [lineImpossible], [posA]);
  check('解なしケースはsolutionCount=0', result.solutionCount===0);
  check('解なしケースはisUnique=false・reachedLimit=false', result.isUnique===false && result.reachedLimit===false);
}

console.log('== countLineConstrainedSolutions: correctValue非依存 ==');
{
  const withCorrect = A.countLineConstrainedSolutions(CUBE_DATA, lines, productionCells);

  const stripped = productionCells.map(c => ({ L:c.L, r:c.r, c:c.c, initialValue:c.initialValue }));
  const withoutCorrect = A.countLineConstrainedSolutions(CUBE_DATA, lines, stripped);
  check('correctValueを除外しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withoutCorrect));

  const tampered = productionCells.map(c => Object.assign({}, c, { correctValue: c.correctValue + 999 }));
  const withTamperedCorrect = A.countLineConstrainedSolutions(CUBE_DATA, lines, tampered);
  check('correctValueを改変しても結果が同一', JSON.stringify(withCorrect)===JSON.stringify(withTamperedCorrect));
}

console.log('== countLineConstrainedSolutions: domainはinitialValue集合(位置ごとの初期値には依存しない) ==');
{
  const reordered = productionCells.map((c, i, arr) => Object.assign({}, c, {
    initialValue: arr[(i+1) % arr.length].initialValue, // 各セルの初期表示値を1つずらして再配置(集合としては不変)
  }));
  const original = A.countLineConstrainedSolutions(CUBE_DATA, lines, productionCells);
  const shifted = A.countLineConstrainedSolutions(CUBE_DATA, lines, reordered);
  check('initialValue集合が同じであれば、どのセルが初期にどの値を持つかに関わらずsolutionCountが一致する',
    original.solutionCount===shifted.solutionCount);
}

console.log('== countLineConstrainedSolutions: 未確定位置のCUBE_DATA値を推論へ使用しない ==');
{
  const tamperedCube = CUBE_DATA.map(plane=>plane.map(row=>row.slice()));
  for(const cell of productionCells) tamperedCube[cell.L-1][cell.r][cell.c] = 999999; // 未確定位置だけを破壊

  const original = A.countLineConstrainedSolutions(CUBE_DATA, lines, productionCells);
  const withTamperedCube = A.countLineConstrainedSolutions(tamperedCube, lines, productionCells);
  check('未確定位置のCUBE_DATAを破壊しても結果が変わらない', JSON.stringify(original)===JSON.stringify(withTamperedCube));
}

console.log('== countLineConstrainedSolutions: maxSolutions設定を尊重する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  const posA = { L:1, r:0, c:0, initialValue:1 };
  const posB = { L:1, r:0, c:1, initialValue:2 };
  const posC = { L:1, r:0, c:2, initialValue:3 };

  const cap1 = A.countLineConstrainedSolutions(syntheticCube, [], [posA, posB, posC], { maxSolutions:1 });
  check('maxSolutions=1では1件で打ち切られる', cap1.solutionCount===1 && cap1.reachedLimit===true);

  const cap10 = A.countLineConstrainedSolutions(syntheticCube, [], [posA, posB, posC], { maxSolutions:10 });
  check('maxSolutionsが真の解数(3!=6)を上回れば打ち切られず全件(6件)返る', cap10.solutionCount===6 && cap10.reachedLimit===false);
}

console.log('== countLineConstrainedSolutions: 入力の非破壊性 ==');
{
  const cubeSnapshot = JSON.stringify(CUBE_DATA);
  const linesSnapshot = JSON.stringify(lines);
  const cellsSnapshot = JSON.stringify(productionCells);
  const options = { maxSolutions: 2 };
  const optionsSnapshot = JSON.stringify(options);

  A.countLineConstrainedSolutions(CUBE_DATA, lines, productionCells, options);

  check('CUBE_DATAが変化しない', JSON.stringify(CUBE_DATA)===cubeSnapshot);
  check('linesが変化しない', JSON.stringify(lines)===linesSnapshot);
  check('cellsが変化しない', JSON.stringify(productionCells)===cellsSnapshot);
  check('optionsが変化しない', JSON.stringify(options)===optionsSnapshot);
}

console.log('== analyzeStrongStagedPath: 正解状態を0手成功として扱う ==');
{
  const cellSolved = { L:1, r:0, c:0, correctValue:100, initialValue:100 };
  const res = A.analyzeStrongStagedPath(CUBE_DATA, [], [cellSolved]);
  check('正解状態はhasPath=true・pathLength=0', res.hasPath===true && res.pathLength===0);
  check('witnessPathは空配列', Array.isArray(res.witnessPath) && res.witnessPath.length===0);
  check('statesVisitedは1', res.statesVisited===1);
}

console.log('== analyzeStrongStagedPath: staged path成功ケースを正しく完走する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100;   // cellI専用down×2
  syntheticCube[0][0][4]=200; syntheticCube[0][1][0]=200;  // cellJ専用up×2
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const lineJ2 = { cells:[{z:0,y:0,x:1},{z:0,y:1,x:0}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };
  const syntheticLines = [lineI1, lineI2, lineJ1, lineJ2];

  const res = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ]);

  check('staged pathが完走する(hasPath=true・pathLength=1)', res.hasPath===true && res.pathLength===1);
  check('witnessPathの長さがpathLengthと一致', res.witnessPath.length===1);
  check('witness stepでdistanceAfter=distanceBefore-1', res.witnessPath[0].distanceBefore - res.witnessPath[0].distanceAfter === 1);
  check('非terminal stepでstrongCompatibleCountが1〜3の範囲内', res.witnessPath[0].strongCompatibleCount>=1 && res.witnessPath[0].strongCompatibleCount<=3);
  check('witness stepにoptimalStrongCountが1件以上含まれる', res.witnessPath[0].optimalStrongCount>=1);
  check('rootStrongCompatibleCountが1', res.rootStrongCompatibleCount===1);
  check('失敗理由は記録されない', Object.keys(res.failureReasonCounts).length===0);

  console.log('== analyzeStrongStagedPath: 同じ入力で同じwitness pathを返す ==');
  const res2 = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ]);
  check('2回呼び出しても結果が完全一致(決定論的)', JSON.stringify(res)===JSON.stringify(res2));
}

console.log('== analyzeStrongStagedPath: strong pair数0件でstrong-out-of-rangeになる ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100; // cellI専用down×2
  syntheticCube[0][0][4]=200;                            // cellJ専用up×1のみ(2未満で不足)
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };

  const res = A.analyzeStrongStagedPath(syntheticCube, [lineI1, lineI2, lineJ1], [cellI, cellJ]);
  check('strong pairが0件でhasPath=false', res.hasPath===false && res.rootStrongCompatibleCount===0);
  check('失敗理由はstrong-out-of-range', res.failureReasonCounts['strong-out-of-range']===1);
}

console.log('== analyzeStrongStagedPath: strong pair数がmaxを超えるとstrong-out-of-rangeになる ==');
{
  // 前掲の1件strongなfixtureを再利用し、maxStrongCompatibleを0に絞って上限超過を発生させる。
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100;
  syntheticCube[0][0][4]=200; syntheticCube[0][1][0]=200;
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const lineJ2 = { cells:[{z:0,y:0,x:1},{z:0,y:1,x:0}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };
  const syntheticLines = [lineI1, lineI2, lineJ1, lineJ2];

  const res = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ], { maxStrongCompatible: 0 });
  check('rootStrongCompatibleCount(1)がmaxStrongCompatible(0)を超え失敗する', res.hasPath===false && res.rootStrongCompatibleCount===1);
  check('失敗理由はstrong-out-of-range', res.failureReasonCounts['strong-out-of-range']===1);
}

console.log('== analyzeStrongStagedPath: strong範囲内でもoptimal strongが0件ならno-optimal-in-strangeになる ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][3]=50; syntheticCube[0][0][4]=100;  // P0専用down×2
  syntheticCube[0][1][0]=290; syntheticCube[0][1][1]=290; // P2専用up×2
  const lineA = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineB = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:4}] };
  const lineC = { cells:[{z:0,y:0,x:2},{z:0,y:1,x:0}] };
  const lineD = { cells:[{z:0,y:0,x:2},{z:0,y:1,x:1}] };
  // P0<->P1が真の最短経路(1手)だが、P1には所属ラインが1本もないためP0-P1・P1-P2は常にstrong化しない。
  // P0<->P2はstrongだが実際には距離を悪化させる(非optimal)交換になるよう仕組む。
  const P0 = { L:1, r:0, c:0, correctValue:10, initialValue:20 };
  const P1 = { L:1, r:0, c:1, correctValue:20, initialValue:10 };
  const P2 = { L:1, r:0, c:2, correctValue:30, initialValue:30 };

  const res = A.analyzeStrongStagedPath(syntheticCube, [lineA, lineB, lineC, lineD], [P0, P1, P2]);
  check('strong pairは範囲内(1件)だが失敗する', res.hasPath===false && res.rootStrongCompatibleCount===1);
  check('失敗理由はno-optimal-in-strong', res.failureReasonCounts['no-optimal-in-strong']===1);
}

console.log('== analyzeStrongStagedPath: minImprovedLinesPerEndpoint設定を尊重する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100;
  syntheticCube[0][0][4]=200; syntheticCube[0][1][0]=200;
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const lineJ2 = { cells:[{z:0,y:0,x:1},{z:0,y:1,x:0}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };
  const syntheticLines = [lineI1, lineI2, lineJ1, lineJ2];

  const strict = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ], { minImprovedLinesPerEndpoint: 3 });
  check('各端点2本しかない状況でminImprovedLinesPerEndpoint=3にすると不成立になる', strict.hasPath===false && strict.rootStrongCompatibleCount===0);

  const lenient = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ], { minImprovedLinesPerEndpoint: 1 });
  check('minImprovedLinesPerEndpoint=1では成立する(各端点2本は1本以上を満たす)', lenient.hasPath===true && lenient.rootStrongCompatibleCount===1);
}

console.log('== analyzeStrongStagedPath: min/maxStrongCompatible設定を尊重する ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100;
  syntheticCube[0][0][4]=200; syntheticCube[0][1][0]=200;
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const lineJ2 = { cells:[{z:0,y:0,x:1},{z:0,y:1,x:0}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };
  const syntheticLines = [lineI1, lineI2, lineJ1, lineJ2];

  const minTooHigh = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ], { minStrongCompatible: 2 });
  check('minStrongCompatible=2では1件しかないため不成立', minTooHigh.hasPath===false && minTooHigh.failureReasonCounts['strong-out-of-range']===1);

  const defaultRange = A.analyzeStrongStagedPath(syntheticCube, syntheticLines, [cellI, cellJ], { minStrongCompatible: 1, maxStrongCompatible: 3 });
  check('既定範囲(1〜3)では成立する', defaultRange.hasPath===true);
}

console.log('== analyzeStrongStagedPath: 実在12セルfixtureで現実的時間内に完走する ==');
{
  const cellSetBase = [];
  for(const z of [0,4]) for(const y of [0,4]) for(const x of [0,2,4]) cellSetBase.push({ L:z+1, r:y, c:x });
  const cells12 = cellSetBase.map(coord => {
    const v = CUBE_DATA[coord.L-1][coord.r][coord.c];
    return { L:coord.L, r:coord.r, c:coord.c, correctValue:v, initialValue:v }; // 正解状態(距離0)で完走を確認
  });

  const t0 = Date.now();
  const res = A.analyzeStrongStagedPath(CUBE_DATA, lines, cells12);
  const elapsedMs = Date.now()-t0;

  check('12セルの正解状態はhasPath=true・pathLength=0で即完走', res.hasPath===true && res.pathLength===0);
  check('5秒以内に完走する', elapsedMs<5000);
  console.log(`  (elapsed: ${elapsedMs}ms)`);
}

console.log('== analyzeStrongStagedPath: Prototype 02の8セルfixtureでも現実的時間内に完走(パス有無は問わない) ==');
{
  const t0 = Date.now();
  const res = A.analyzeStrongStagedPath(CUBE_DATA, lines, productionCells);
  const elapsedMs = Date.now()-t0;
  check('Prototype 02の8セルでも5秒以内に完走する', elapsedMs<5000);
  check('結果オブジェクトの必須フィールドが揃っている', typeof res.hasPath==='boolean' && typeof res.statesVisited==='number' && typeof res.rootStrongCompatibleCount==='number' && typeof res.failureReasonCounts==='object');
  console.log(`  (elapsed: ${elapsedMs}ms, hasPath: ${res.hasPath})`);
}

console.log('== analyzeStrongStagedPath: 入力の非破壊性 ==');
{
  const syntheticCube = Array.from({length:5}, ()=>Array.from({length:5}, ()=>Array.from({length:5}, ()=>0)));
  syntheticCube[0][0][2]=50; syntheticCube[0][0][3]=100;
  syntheticCube[0][0][4]=200; syntheticCube[0][1][0]=200;
  const lineI1 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:2}] };
  const lineI2 = { cells:[{z:0,y:0,x:0},{z:0,y:0,x:3}] };
  const lineJ1 = { cells:[{z:0,y:0,x:1},{z:0,y:0,x:4}] };
  const lineJ2 = { cells:[{z:0,y:0,x:1},{z:0,y:1,x:0}] };
  const cellI = { L:1, r:0, c:0, correctValue:215, initialValue:100 };
  const cellJ = { L:1, r:0, c:1, correctValue:100, initialValue:215 };
  const syntheticLines = [lineI1, lineI2, lineJ1, lineJ2];
  const cells = [cellI, cellJ];
  const options = { minStrongCompatible:1, maxStrongCompatible:3, minImprovedLinesPerEndpoint:2 };

  const cubeSnapshot = JSON.stringify(syntheticCube);
  const linesSnapshot = JSON.stringify(syntheticLines);
  const cellsSnapshot = JSON.stringify(cells);
  const optionsSnapshot = JSON.stringify(options);

  A.analyzeStrongStagedPath(syntheticCube, syntheticLines, cells, options);

  check('CUBE_DATA(synthetic)が変化しない', JSON.stringify(syntheticCube)===cubeSnapshot);
  check('linesが変化しない', JSON.stringify(syntheticLines)===linesSnapshot);
  check('cellsが変化しない', JSON.stringify(cells)===cellsSnapshot);
  check('optionsが変化しない', JSON.stringify(options)===optionsSnapshot);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
