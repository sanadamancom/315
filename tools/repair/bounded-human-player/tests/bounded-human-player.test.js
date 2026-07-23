// tests/bounded-human-player.test.js
//
// bounded-human-player-12.0a の required_tests を機械的に検証する。
// 実行: node tools/repair/bounded-human-player/tests/bounded-human-player.test.js

'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { createPublicObservationAdapter } = require('../public-observation-adapter');
const { createCognitiveState, CognitiveLimitViolation } = require('../cognitive-state');
const { runPolicy } = require('../deterministic-runner');
const { createScriptedReplayPolicy, PROTOTYPE_11_0_SCRIPT } = require('../policies/scripted-replay-policy');
const {
  createLocalGreedyPolicy, createCautiousReasonerPolicy, createBoundedProbePolicy,
} = require('../policies/policy-interfaces');

let passed = 0, failed = 0;
function check(name, fn){
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch(err){
    console.log(`FAIL: ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ============================================================
// 1. 公開情報adapterの許可フィールド確認
// ============================================================
check('公開情報adapterの許可フィールド確認', () => {
  const adapter = createPublicObservationAdapter({});
  const cells = adapter.getMovableCells();
  assert.strictEqual(cells.length, 22, 'movable cells should be 22');
  for(const c of cells){
    assert.ok('id' in c && 'z' in c && 'x' in c && 'y' in c && 'value' in c);
  }
  const lines = adapter.getLines();
  assert.strictEqual(lines.length, 109, 'lines should be 109');
  for(const l of lines){
    assert.ok('id' in l && 'type' in l && 'cells' in l);
  }
  const st = adapter.getLineState(lines[0].id);
  assert.ok(['equal','up','down'].includes(st.status));
  assert.ok(st.band === null || st.band === 'small' || st.band === 'large');
  assert.strictEqual(typeof adapter.getSwapCount(), 'number');
  assert.strictEqual(typeof adapter.getProbeCount(), 'number');
  assert.strictEqual(typeof adapter.canUndo(), 'boolean');
  assert.ok(Array.isArray(adapter.listAvailableActions()));
});

// ============================================================
// 2. 禁止フィールド不存在
// ============================================================
check('禁止フィールド不存在(adapter返却値)', () => {
  const adapter = createPublicObservationAdapter({});
  const lines = adapter.getLines();
  const st = adapter.getLineState(lines[0].id);
  const forbiddenKeys = ['line_sum','sum','exact_deviation','deviation','cell_correctness','correct','cycle_group','decoy_flag','decoy','solution_pair','solution_path','minimum_moves'];
  const stStr = JSON.stringify(st);
  forbiddenKeys.forEach(k => assert.ok(!stStr.includes(k), `line state leaked forbidden key: ${k}`));

  const cellsStr = JSON.stringify(adapter.getMovableCells());
  forbiddenKeys.forEach(k => assert.ok(!cellsStr.includes(k), `movable cells leaked forbidden key: ${k}`));

  // applySwapの戻り値にも禁止情報が無いこと
  const cells = adapter.getMovableCells();
  const res = adapter.applySwap(cells[0].id, cells[1].id, { declaredActionType: 'deduction' });
  const resStr = JSON.stringify(res);
  forbiddenKeys.forEach(k => assert.ok(!resStr.includes(k), `applySwap result leaked forbidden key: ${k}`));
});

// ============================================================
// 3. policyから内部fixtureへ直接アクセスできない
// ============================================================
check('policyから内部fixtureへ直接アクセスできない(cognitiveStateに内部参照が無い)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  // cognitiveStateのプロパティ一覧に internal / fixture / CUBE_DATA 等の参照が無いこと
  const keys = Object.keys(cognitiveState);
  const forbiddenNames = ['fixture','CUBE_DATA','movableMap','engine','board','internal'];
  keys.forEach(k => {
    forbiddenNames.forEach(f => assert.ok(!k.toLowerCase().includes(f.toLowerCase())));
  });
  // require経路上、policies配下のファイルが internal/ を直接requireしていないことをソース走査で確認
  const policiesDir = path.join(__dirname, '..', 'policies');
  const files = fs.readdirSync(policiesDir).filter(f => f.endsWith('.js'));
  for(const f of files){
    const src = fs.readFileSync(path.join(policiesDir, f), 'utf8');
    assert.ok(!src.includes("require('../internal") && !src.includes('require("../internal'),
      `${f} が internal/ を直接requireしている`);
  }
});

// ============================================================
// 4. 正確な合計と偏差を取得できない
// ============================================================
check('正確な合計と偏差を取得できない', () => {
  const adapter = createPublicObservationAdapter({});
  assert.strictEqual(typeof adapter.lineSum, 'undefined', 'adapterにlineSumが公開されていてはならない');
  assert.strictEqual(typeof adapter.getExactDeviation, 'undefined');
  const lines = adapter.getLines();
  const st = adapter.getLineState(lines[0].id);
  assert.ok(!('sum' in st));
  assert.ok(!('deviation' in st));
  assert.ok(!('exactDeviation' in st));
});

// ============================================================
// 5. 全pair列挙要求を拒否する
// ============================================================
check('全pair列挙要求を拒否する', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  assert.throws(() => cognitiveState.listAllMovablePairs(), CognitiveLimitViolation);
});

// ============================================================
// 6. lookahead_depth=0で未実行swapを評価できない
// ============================================================
check('lookahead_depth=0で未実行swapを評価できない', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { lookahead_depth: 0 });
  assert.throws(() => cognitiveState.previewSwap('0-0-0','0-0-1'), CognitiveLimitViolation);
  // lookahead_depth != 0 を要求した場合は生成自体が拒否される
  assert.throws(() => createCognitiveState(adapter, { lookahead_depth: 1 }), CognitiveLimitViolation);
});

// ============================================================
// 7. ライン観測数上限
// ============================================================
check('ライン観測数上限(lines_observed_per_turn)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { lines_observed_per_turn: 3 });
  const lines = adapter.getLines();
  cognitiveState.observeLine(lines[0].id);
  cognitiveState.observeLine(lines[1].id);
  cognitiveState.observeLine(lines[2].id);
  assert.throws(() => cognitiveState.observeLine(lines[3].id), CognitiveLimitViolation);
});

// ============================================================
// 8. recent line memoryの忘却
// ============================================================
check('recent line memoryの忘却', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { recent_line_memory: 2, lines_observed_per_turn: 100 });
  const lines = adapter.getLines();
  cognitiveState.observeLine(lines[0].id);
  cognitiveState.observeLine(lines[1].id);
  cognitiveState.observeLine(lines[2].id); // これでlines[0]は記憶から追い出される
  assert.throws(() => cognitiveState.recallLine(lines[0].id), CognitiveLimitViolation, '追い出されたラインはrecallできないはず');
  assert.doesNotThrow(() => cognitiveState.recallLine(lines[2].id), '直近のラインはrecallできるはず');
});

// ============================================================
// 9. 候補数上限
// ============================================================
check('候補数上限(candidate_pairs_per_turn)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { candidate_pairs_per_turn: 2 });
  const cells = adapter.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.considerPair(cells[2].id, cells[3].id);
  assert.throws(() => cognitiveState.considerPair(cells[4].id, cells[5].id), CognitiveLimitViolation);
});

// ============================================================
// 10. probe上限
// ============================================================
check('probe上限', () => {
  const adapter = createPublicObservationAdapter({ probeLimit: 2 });
  const cognitiveState = createCognitiveState(adapter, { probe_limit: 2 });
  const cells = adapter.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'probe');
  cognitiveState.considerPair(cells[2].id, cells[3].id);
  cognitiveState.executeSwap(cells[2].id, cells[3].id, 'probe');
  cognitiveState.considerPair(cells[4].id, cells[5].id);
  assert.throws(() => cognitiveState.executeSwap(cells[4].id, cells[5].id, 'probe'), CognitiveLimitViolation);
});

// ============================================================
// 11. swap上限
// ============================================================
check('swap上限(maximum_swaps)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { maximum_swaps: 2 });
  const cells = adapter.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction');
  assert.strictEqual(cognitiveState.getFinalClassification(), null);
  cognitiveState.considerPair(cells[0].id, cells[1].id); // 元に戻すswapでも回数は加算される
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction');
  assert.strictEqual(cognitiveState.getFinalClassification(), 'limit');
});

// ============================================================
// 12. 同一seedでtrace完全一致
// ============================================================
check('同一seedでtrace完全一致', () => {
  const policyFactory = () => createScriptedReplayPolicy();
  const result1 = runPolicy({
    policyId: 'scripted_replay', policy: policyFactory(), randomSeed: 42,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const result2 = runPolicy({
    policyId: 'scripted_replay', policy: policyFactory(), randomSeed: 42,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  assert.deepStrictEqual(result1, result2, '同一入力なら結果は完全一致するはず');
});

// ============================================================
// 13. 異なるseedを受け入れられる
// ============================================================
check('異なるseedを受け入れられる(scripted_replayはseedに依存しないが、seed自体は拒否されない)', () => {
  const result1 = runPolicy({
    policyId: 'scripted_replay', policy: createScriptedReplayPolicy(), randomSeed: 1,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const result2 = runPolicy({
    policyId: 'scripted_replay', policy: createScriptedReplayPolicy(), randomSeed: 999999,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  assert.strictEqual(result1.randomSeed, 1);
  assert.strictEqual(result2.randomSeed, 999999);
  // scripted_replayは決定的なscriptを再生するだけなので、seed以外の中身は一致してよい
  assert.strictEqual(result1.cleared_or_stuck_or_loop_or_limit, result2.cleared_or_stuck_or_loop_or_limit);
});

// ============================================================
// 14. scripted replayで5 swap、1 undo、stuckを再生可能
// ============================================================
check('scripted replayで5 swap、1 undo、stuckを再生可能', () => {
  const result = runPolicy({
    policyId: 'scripted_replay', policy: createScriptedReplayPolicy(), randomSeed: 7,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const swapCount = result.observation_trace.filter(t => t.kind === 'swap').length;
  const undoCount = result.observation_trace.filter(t => t.kind === 'undo').length;
  const stuckCount = result.observation_trace.filter(t => t.kind === 'declare_stuck').length;
  assert.strictEqual(swapCount, 5, `swap回数が5であること(実際:${swapCount})`);
  assert.strictEqual(undoCount, 1, `undo回数が1であること(実際:${undoCount})`);
  assert.strictEqual(stuckCount, 1, `stuck回数が1であること(実際:${stuckCount})`);
  assert.strictEqual(result.cleared_or_stuck_or_loop_or_limit, 'stuck');
  assert.strictEqual(result.error, null, 'scripted replayはCognitiveLimitViolationを起こさず完走するはず');
});

// ============================================================
// 15. Prototype 11.0証拠ファイル不変(3ファイル+セッションJSON)
// ============================================================
check('Prototype 11.0/11.1/11.2証拠ファイル不変', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const targets = [
    path.join(repoRoot, 'prototype11.html'),
    path.join(repoRoot, 'prototype11-access.html'),
    path.join(repoRoot, 'prototype11-lite.html'),
  ];
  const expectedHashes = {
    'prototype11.html': '05cfa1496bdefcdab75a2f35e7cb35a9a1aa198639fe44119e8bf8752fa48fdc',
    'prototype11-access.html': '9313dc6f4d5047c0a4af274bf7676d79f46e9a592eda6624fe344a52622aeba6',
    'prototype11-lite.html': '7bbd8ac7590d8e7285040f1abf3ac76dd93ebc7866ef0dd3ab4f614d8b4e67e8',
  };
  for(const t of targets){
    const name = path.basename(t);
    const data = fs.readFileSync(t);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    assert.strictEqual(hash, expectedHashes[name], `${name} のSHA-256が変化している`);
  }
  const evidenceLog = '/home/claude/evidence/prototype11.0-session-log.jsonl';
  const logHash = crypto.createHash('sha256').update(fs.readFileSync(evidenceLog)).digest('hex');
  assert.strictEqual(logHash, 'a2574f65bdc1173718845e80235d103435aecb39725433a8ce26ce4851f5c471', 'セッションJSONのSHA-256が変化している');
});

// ============================================================
// 16. 出力、console、errorへの禁止情報漏洩なし
// ============================================================
check('出力・console・errorへの禁止情報漏洩なし', () => {
  const result = runPolicy({
    policyId: 'scripted_replay', policy: createScriptedReplayPolicy(), randomSeed: 7,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const resultStr = JSON.stringify(result);
  const forbidden = ['groupA','groupB','decoy','line_sum','exact_deviation','cell_correctness','cycle_group','decoy_flag','solution_pair','solution_path','minimum_moves'];
  forbidden.forEach(f => assert.ok(!resultStr.includes(f), `runPolicy結果に禁止語が含まれている: ${f}`));

  // policy-interfaces.js の未実装policy(bounded_probe)が
  // エラーメッセージに内部情報を含まないこと。
  // local_greedy(12.0b)・cautious_reasoner(12.0c)は実装済みのため、
  // この未実装チェックの対象から外れる(それぞれ専用テストファイルで検証する)。
  try {
    createBoundedProbePolicy().run({}, {});
    assert.fail('bounded_probeはNotImplementedErrorを投げるはず');
  } catch(err){
    forbidden.forEach(f => assert.ok(!err.message.includes(f)));
  }
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
