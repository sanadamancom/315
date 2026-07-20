// tests/prototype03-search-tests.js
// tools/repair/search-prototype03.js の検証。
// 実行: node tests/prototype03-search-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const A = require('../tools/repair/prototype02-analyzer.js');
const S3 = require('../tools/repair/search-prototype03.js');

let pass = 0, fail = 0;
function check(name, cond){
  if(cond){ pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

const { CUBE_DATA, lines } = A.loadCubeContext();

const SEED = 20260719;
const SMALL_SAMPLES = 300;
const LARGER_SAMPLES = 2000;

console.log('== buildPrototype03CellSets: 重複除外24構造・12セル・singleton0・決定性 ==');
{
  const cellSets1 = S3.buildPrototype03CellSets(lines);
  const cellSets2 = S3.buildPrototype03CellSets(lines);

  check('重複除外24構造が生成される', cellSets1.length === 24);
  check('各構造が12セルちょうど', cellSets1.every(cs => cs.cellSetBase.length === 12));
  check('全構造でstructuralOk=true(未確定1件ラインが0本)', cellSets1.every(cs => cs.structuralOk === true));
  check('同じ入力で生成順・内容が完全一致する(決定性)', JSON.stringify(cellSets1) === JSON.stringify(cellSets2));
}

console.log('== runPrototype03Search: 決定論的サンプリング(seed=20260719, maximumSamples=300) ==');
{
  const r1 = S3.runPrototype03Search({ seed: SEED, maximumSamples: SMALL_SAMPLES });
  const r2 = S3.runPrototype03Search({ seed: SEED, maximumSamples: SMALL_SAMPLES });

  check('evaluatedSamplesが288になる', r1.evaluatedSamples === 288);
  check('同条件を2回実行しても結果が完全一致する(決定論性)', JSON.stringify(r1) === JSON.stringify(r2));
  check('cellSetCount=24・structurallyValidCellSetCount=24', r1.cellSetCount === 24 && r1.structurallyValidCellSetCount === 24);
}

console.log('== runPrototype03Search: maximumSamples=2000でpassed候補とselected候補が存在する ==');
// 同一プロセス内でこの結果(2000件探索)をrecheck/comparator/artifactテストへ再利用する。
const searchResult = S3.runPrototype03Search({ seed: SEED, maximumSamples: LARGER_SAMPLES });
{
  check('passedCandidateが1件以上存在する', searchResult.passedCount >= 1);
  check('selectedCandidateがnullでない', searchResult.selectedCandidate !== null);
}

console.log('== runPrototype03Search: 同一seed・同一sample上限でselected候補とartifactがbyte相当で一致する ==');
{
  const searchResultAgain = S3.runPrototype03Search({ seed: SEED, maximumSamples: LARGER_SAMPLES });
  check('selectedCandidateが完全一致する', JSON.stringify(searchResult.selectedCandidate) === JSON.stringify(searchResultAgain.selectedCandidate));

  const artifact1 = S3.buildPrototype03Artifact(searchResult);
  const artifact2 = S3.buildPrototype03Artifact(searchResultAgain);
  check('artifactが完全一致する(byte相当)', JSON.stringify(artifact1) === JSON.stringify(artifact2));
}

console.log('== selected_candidate_recheck: 全hard gateをAnalyzer関数で独立に再検証する ==');
{
  const cand = searchResult.selectedCandidate;
  const cells = cand.cellSetBase.map((c, i) => ({
    L: c.L, r: c.r, c: c.c,
    correctValue: cand.correctValues[i],
    initialValue: cand.initialValues[i],
  }));

  check('repairCellsが12件', cells.length === 12);

  // 未確定1件ラインが0本(構造のみ、値非依存)
  const idx = new Set(cells.map(c => `${c.L}-${c.r}-${c.c}`));
  let hasSingletonLine = false;
  for(const line of lines){
    let unknownCount = 0;
    for(const cell of line.cells){ if(idx.has(`${cell.z+1}-${cell.y}-${cell.x}`)) unknownCount++; }
    if(unknownCount === 1){ hasSingletonLine = true; break; }
  }
  check('未確定1件ラインが0本', hasSingletonLine === false);

  const direct = A.analyzeDirectSubtraction(CUBE_DATA, lines, cells);
  check('analyzeDirectSubtractionのsolvedCellCountが0', direct.solvedCellCount === 0);

  const correctCount = cells.filter(c => c.initialValue === c.correctValue).length;
  check('正しい位置に残るセルが1件以上', correctCount >= 1);

  const misplacedLevels = new Set(cells.filter(c => c.initialValue !== c.correctValue).map(c => c.L));
  check('誤配置が複数LEVELへ分散する', misplacedLevels.size >= 2);

  const board = A.buildBoard(CUBE_DATA, cells);
  const summary = A.summarizeLines(board, lines);
  check('↑と↓が両方存在する', summary.over > 0 && summary.under > 0);
  check('階層内と階層横断の異常ラインが両方存在する', summary.byClass.intra.abnormal > 0 && summary.byClass.cross.abnormal > 0);

  const stagedPath = A.analyzeStrongStagedPath(CUBE_DATA, lines, cells);
  check('analyzeStrongStagedPathのhasPathがtrue', stagedPath.hasPath === true);
  check('rootStrongCompatibleCountが1〜3', stagedPath.rootStrongCompatibleCount >= 1 && stagedPath.rootStrongCompatibleCount <= 3);
  check('pathLengthが7または8', stagedPath.pathLength === 7 || stagedPath.pathLength === 8);

  const uniqueness = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells);
  check('countLineConstrainedSolutionsのisUniqueがtrue', uniqueness.isUnique === true);
}

console.log('== comparePrototype03Candidates: 優先順位を1段ずつ検証する ==');
{
  function makeCand(overrides){
    return Object.assign({
      cellSetIndex: 0,
      sampleIndex: 0,
      metrics: {
        nonPositiveProgressStepCount: 1,
        finalStepGainShare: 0.2,
        rootStrongCompatibleCount: 2,
        witnessStrongCompatibleSum: 10,
        pathLength: 7,
      },
    }, overrides);
  }

  // 1. nonPositiveProgressStepCountが最優先
  {
    const better = makeCand({ metrics: Object.assign({}, makeCand({}).metrics, { nonPositiveProgressStepCount: 0 }) });
    const worse = makeCand({ metrics: Object.assign({}, makeCand({}).metrics, { nonPositiveProgressStepCount: 2 }) });
    check('nonPositiveProgressStepCountが少ない方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 2. 同点ならfinalStepGainShare
  {
    const base = makeCand({}).metrics;
    const better = makeCand({ metrics: Object.assign({}, base, { finalStepGainShare: 0.1 }) });
    const worse = makeCand({ metrics: Object.assign({}, base, { finalStepGainShare: 0.5 }) });
    check('nonPositiveProgressStepCount同点ならfinalStepGainShareが小さい方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 3. 同点ならrootStrongCompatibleCountの2への近さ
  {
    const base = makeCand({}).metrics;
    const better = makeCand({ metrics: Object.assign({}, base, { rootStrongCompatibleCount: 2 }) });
    const worse = makeCand({ metrics: Object.assign({}, base, { rootStrongCompatibleCount: 3 }) }); // |3-2|=1 > |2-2|=0
    check('同点ならrootStrongCompatibleCountが2に近い方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 4. 同点ならwitnessStrongCompatibleSum
  {
    const base = makeCand({}).metrics;
    const better = makeCand({ metrics: Object.assign({}, base, { witnessStrongCompatibleSum: 5 }) });
    const worse = makeCand({ metrics: Object.assign({}, base, { witnessStrongCompatibleSum: 20 }) });
    check('同点ならwitnessStrongCompatibleSumが少ない方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 5. 同点ならpathLength
  {
    const base = makeCand({}).metrics;
    const better = makeCand({ metrics: Object.assign({}, base, { pathLength: 7 }) });
    const worse = makeCand({ metrics: Object.assign({}, base, { pathLength: 8 }) });
    check('同点ならpathLengthが短い方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 6. 全metrics同点ならcellSetIndex
  {
    const better = makeCand({ cellSetIndex: 1 });
    const worse = makeCand({ cellSetIndex: 5 });
    check('metrics完全同点ならcellSetIndexが小さい方を優先する', S3.comparePrototype03Candidates(better, worse) < 0);
  }

  // 7. cellSetIndexも同点ならsampleIndexで必ず決着する
  {
    const better = makeCand({ sampleIndex: 3 });
    const worse = makeCand({ sampleIndex: 9 });
    check('cellSetIndexも同点ならsampleIndexが小さい方を優先し、必ず決着する', S3.comparePrototype03Candidates(better, worse) < 0);
    check('完全同一のcandidateは同値(0)として扱われる', S3.comparePrototype03Candidates(makeCand({}), makeCand({})) === 0);
  }
}

console.log('== buildPrototype03Artifact: metadata・candidate契約とprivacy制約 ==');
{
  const artifact = S3.buildPrototype03Artifact(searchResult);

  check('artifactがnullでない', artifact !== null);
  check('metadataにprototype/seed/maximumSamples/evaluatedSamples/selectionGateVersionがある',
    artifact.prototype === 'repair-prototype-03' &&
    typeof artifact.source.seed === 'number' &&
    typeof artifact.source.maximumSamples === 'number' &&
    typeof artifact.source.evaluatedSamples === 'number' &&
    typeof artifact.source.selectionGateVersion === 'number'
  );
  check('candidateにrepairCells(cells)が12件ある', Array.isArray(artifact.cells) && artifact.cells.length === 12);
  check('cellsの各要素はz/y/x/initialValueのみを持つ(最小限)', artifact.cells.every(c => {
    const keys = Object.keys(c).sort();
    return JSON.stringify(keys) === JSON.stringify(['initialValue','x','y','z']);
  }));
  check('必要最小限のaggregate metricsを持つ', artifact.metrics &&
    typeof artifact.metrics.nonPositiveProgressStepCount === 'number' &&
    typeof artifact.metrics.rootStrongCompatibleCount === 'number' &&
    typeof artifact.metrics.pathLength === 'number'
  );

  const artifactString = JSON.stringify(artifact);
  check('witnessPathを含まない', !Object.prototype.hasOwnProperty.call(artifact, 'witnessPath') && !artifactString.includes('witnessPath'));
  check('正解交換手順(correctValues)を含まない', !artifactString.includes('correctValue'));
  check('交換pair(i/jペア列)を含まない', !Object.prototype.hasOwnProperty.call(artifact, 'witnessPath'));
  check('exact deviation順位(devDelta/rank)を含まない', !artifactString.includes('devDelta') && !artifactString.includes('"rank"'));
}

console.log('== saved_artifact: 保存済み候補JSONのschema・hash確認 ==');
const CANDIDATE_PATH = path.join(__dirname, '..', 'tools', 'repair', 'prototype03-candidate.json');
const EXPECTED_SHA256 = '37aa1ebec0a65a797e06685591d5a3b569859630ce264bee1f754140d7eaa0f1';
let savedRaw = null, savedArtifact = null;
{
  check('tools/repair/prototype03-candidate.jsonが存在する', fs.existsSync(CANDIDATE_PATH));

  savedRaw = fs.readFileSync(CANDIDATE_PATH, 'utf8');
  let parseError = null;
  try{ savedArtifact = JSON.parse(savedRaw); } catch(e){ parseError = e; }
  check('JSONとして読込可能', parseError === null && savedArtifact !== null);

  check('schemaVersionが1', savedArtifact.schemaVersion === 1);
  check('prototypeがrepair-prototype-03', savedArtifact.prototype === 'repair-prototype-03');
  check('seedが20260719', savedArtifact.source.seed === 20260719);
  check('maximumSamplesが10000', savedArtifact.source.maximumSamples === 10000);
  check('evaluatedSamplesが9984', savedArtifact.source.evaluatedSamples === 9984);
  check('selectionGateVersionが1', savedArtifact.source.selectionGateVersion === 1);
  check('cellsが12件', Array.isArray(savedArtifact.cells) && savedArtifact.cells.length === 12);

  const actualSha256 = crypto.createHash('sha256').update(savedRaw).digest('hex');
  check('sha256が期待値と一致する', actualSha256 === EXPECTED_SHA256);

  check('witnessPath、correctValue、devDelta、rankキーを含まない',
    !savedRaw.includes('witnessPath') && !savedRaw.includes('correctValue') &&
    !savedRaw.includes('devDelta') && !savedRaw.includes('"rank"'));
}

console.log('== saved_artifact_prototype04: 保存済みPrototype04候補JSONのschema・hash確認 ==');
const CANDIDATE_PATH_P04 = path.join(__dirname, '..', 'tools', 'repair', 'prototype04-candidate.json');
const EXPECTED_SHA256_P04 = '3c1d0c7c66bc1b547074ce21e322fef28db2f846c923b37c1cd41c4d3c0842f0';
let savedRawP04 = null, savedArtifactP04 = null;
{
  check('tools/repair/prototype04-candidate.jsonが存在する', fs.existsSync(CANDIDATE_PATH_P04));

  savedRawP04 = fs.readFileSync(CANDIDATE_PATH_P04, 'utf8');
  let parseError = null;
  try{ savedArtifactP04 = JSON.parse(savedRawP04); } catch(e){ parseError = e; }
  check('JSONとして読込可能', parseError === null && savedArtifactP04 !== null);

  check('schemaVersionが1', savedArtifactP04.schemaVersion === 1);
  check('seedが20260720', savedArtifactP04.source.seed === 20260720);
  check('maximumSamplesが10000', savedArtifactP04.source.maximumSamples === 10000);
  check('selectionGateVersionが1(Prototype03と同一)', savedArtifactP04.source.selectionGateVersion === 1);
  check('cellsが12件', Array.isArray(savedArtifactP04.cells) && savedArtifactP04.cells.length === 12);

  const actualSha256P04 = crypto.createHash('sha256').update(savedRawP04).digest('hex');
  check('sha256が期待値と一致する', actualSha256P04 === EXPECTED_SHA256_P04);

  check('witnessPath、correctValue、devDelta、rankキーを含まない',
    !savedRawP04.includes('witnessPath') && !savedRawP04.includes('correctValue') &&
    !savedRawP04.includes('devDelta') && !savedRawP04.includes('"rank"'));

  check('Prototype 03とPrototype 04のartifactが異なる(byte単位)', savedRaw !== null && savedRaw !== savedRawP04);
}

console.log('== full_reproduction_test: full条件(seed=20260719, maximumSamples=10000)での再生成一致 ==');
// このプロセス内でfull探索は1回だけ実行し、以降のindependent_candidate_recheckでも再利用する。
const fullResult = S3.runPrototype03Search({ seed: 20260719, maximumSamples: 10000 });
{
  check('passedCountが34', fullResult.passedCount === 34);
  check('selectedCandidateが存在する', fullResult.selectedCandidate !== null);

  const regeneratedArtifact = S3.buildPrototype03Artifact(fullResult);
  const regeneratedRaw = JSON.stringify(regeneratedArtifact, null, 2) + '\n';
  check('保存済みJSONとbyte単位で完全一致する', savedRaw !== null && regeneratedRaw === savedRaw);
}

console.log('== independent_candidate_recheck: Searchの合否フラグを信用せずAnalyzer関数で直接再検証する ==');
{
  // 保存JSONのcellsから検証用cellsを構築し、correctValueはCUBE_DATAの対応位置から内部補完する
  // (Searchが保持していたcorrectValues配列はここでは一切参照しない)。
  const cells = savedArtifact.cells.map(cell => ({
    L: cell.z + 1, r: cell.y, c: cell.x,
    correctValue: CUBE_DATA[cell.z][cell.y][cell.x],
    initialValue: cell.initialValue,
  }));

  check('12セルちょうど', cells.length === 12);

  const board = A.buildBoard(CUBE_DATA, cells);
  const completeness = A.validateBoardCompleteness(board);
  check('1〜125の値集合に重複欠落を発生させない', completeness.valid === true && completeness.count === 125 && completeness.uniqueCount === 125);

  const fixedCheck = A.validateFixedCellsUnchanged(CUBE_DATA, board, cells);
  check('固定113セルがCUBE_DATAのまま', fixedCheck.valid === true && fixedCheck.fixedCellCount === 113 && fixedCheck.mismatchCount === 0);

  const idx = new Set(cells.map(c => `${c.L}-${c.r}-${c.c}`));
  let hasBadUnknownCount = false, hasSingletonLine = false;
  for(const line of lines){
    let unknownCount = 0;
    for(const cell of line.cells){ if(idx.has(`${cell.z+1}-${cell.y}-${cell.x}`)) unknownCount++; }
    if(!(unknownCount === 0 || unknownCount >= 2)) hasBadUnknownCount = true;
    if(unknownCount === 1) hasSingletonLine = true;
  }
  check('全109ラインで未確定セル数が0または2件以上', hasBadUnknownCount === false);
  check('未確定1件ラインが0本', hasSingletonLine === false);

  const direct = A.analyzeDirectSubtraction(CUBE_DATA, lines, cells);
  check('analyzeDirectSubtractionのsolvedCellCountが0', direct.solvedCellCount === 0);

  const correctCount = cells.filter(c => c.initialValue === c.correctValue).length;
  check('正しい位置に残る未確定セルが1件以上', correctCount >= 1);

  const misplacedLevels = new Set(cells.filter(c => c.initialValue !== c.correctValue).map(c => c.L));
  check('誤配置が複数LEVELへ分散する', misplacedLevels.size >= 2);

  const summary = A.summarizeLines(board, lines);
  check('↑と↓が両方存在する', summary.over > 0 && summary.under > 0);
  check('階層内と階層横断の異常ラインが両方存在する', summary.byClass.intra.abnormal > 0 && summary.byClass.cross.abnormal > 0);

  const stagedPath = A.analyzeStrongStagedPath(CUBE_DATA, lines, cells);
  check('analyzeStrongStagedPathのhasPathがtrue', stagedPath.hasPath === true);
  check('rootStrongCompatibleCountが1〜3', stagedPath.rootStrongCompatibleCount >= 1 && stagedPath.rootStrongCompatibleCount <= 3);
  check('pathLengthが7または8', stagedPath.pathLength === 7 || stagedPath.pathLength === 8);

  const uniqueness = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells);
  check('countLineConstrainedSolutionsのisUniqueがtrue', uniqueness.isUnique === true);
}

console.log('== production_sanity_tests: production REPAIR_CELLSの構造的健全性(特定Prototypeへ固定依存しない) ==');
{
  const ctx = {};
  vm.createContext(ctx);
  for(const f of ['js/repair/cube-data.js', 'js/repair/puzzle.js']){
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext('globalThis.CUBE_DATA = CUBE_DATA; globalThis.REPAIR_CELLS = REPAIR_CELLS;', ctx);
  const productionCells = ctx.REPAIR_CELLS.map(c => Object.assign({}, c));
  const productionCubeData = ctx.CUBE_DATA;

  check('production REPAIR_CELLSが12件', productionCells.length === 12);

  const correctValueMismatchCount = productionCells.filter(c =>
    c.correctValue !== productionCubeData[c.L - 1][c.r][c.c]
  ).length;
  check('productionのcorrectValueがCUBE_DATAの対応位置と完全一致', correctValueMismatchCount === 0);

  const productionBoard = A.buildBoard(productionCubeData, productionCells);
  const productionCompleteness = A.validateBoardCompleteness(productionBoard);
  check('production初期盤面が1〜125の重複欠落なし',
    productionCompleteness.valid === true && productionCompleteness.count === 125 && productionCompleteness.uniqueCount === 125);

  const productionFixedCheck = A.validateFixedCellsUnchanged(productionCubeData, productionBoard, productionCells);
  check('固定113セルがCUBE_DATAと一致(production)',
    productionFixedCheck.valid === true && productionFixedCheck.fixedCellCount === 113 && productionFixedCheck.mismatchCount === 0);

  const puzzleJsSource = fs.readFileSync(path.join(__dirname, '..', 'js/repair/puzzle.js'), 'utf8');
  check('productionにcandidate.jsonのruntime読込依存がない',
    !/candidate\.json/.test(puzzleJsSource.replace(/\/\/.*$/gm, '')) &&
    !/require\s*\(/.test(puzzleJsSource) && !/fetch\s*\(/.test(puzzleJsSource));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
