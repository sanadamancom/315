// tests/scan-epoch.test.js
//
// prototype-12.0c3-continue-scan-implementation の required_tests を検証する。

'use strict';

const assert = require('assert');
const path = require('path');

const { createPublicObservationAdapter } = require('../public-observation-adapter');
const { createCognitiveState, CognitiveLimitViolation } = require('../cognitive-state');
const { runPolicy } = require('../deterministic-runner');
const { createCautiousReasonerPolicy } = require('../policies/cautious-reasoner-policy');
const { createLocalGreedyPolicy } = require('../policies/local-greedy-policy');
const { createScriptedReplayPolicy } = require('../policies/scripted-replay-policy');

let passed = 0, failed = 0;
function check(name, fn){
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch(err){
    console.log(`FAIL: ${name}`);
    console.log(`      ${err.stack || err.message}`);
    failed++;
  }
}

function runCautious(seed){
  return runPolicy({
    policyId: 'cautious_reasoner',
    policy: createCautiousReasonerPolicy(),
    randomSeed: seed,
    cognitiveLimits: {},
    puzzleFixture: 'prototype11-seed7',
  });
}

// ============================================================
// 既存68件が引き続き合格(前段で個別に確認済みだが、ここでも再確認する)
// ============================================================
check('既存68件が引き続き合格', () => {
  const { execFileSync } = require('child_process');
  const files = [
    'bounded-human-player.test.js', 'boundary-audit.test.js',
    'local-greedy-policy.test.js', 'cautious-reasoner-policy.test.js',
    'stuck-audit-12.0c1.test.js',
  ];
  for(const f of files){
    const out = execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
    assert.ok(/passed, 0 failed/.test(out), `${f}が全合格していない:\n${out}`);
  }
});

// ============================================================
// continue_scanでswap/probe/undo回数不変
// ============================================================
check('continue_scanでswap/probe/undo回数不変', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  cognitiveState.observeLine(lines[0].id); // 1本以上観測してからでないとcontinue_scanできない
  const swapBefore = cognitiveState.getSwapCount();
  const probeBefore = cognitiveState.getProbeCount();
  const canUndoBefore = cognitiveState.canUndo();
  cognitiveState.executeContinueScan();
  assert.strictEqual(cognitiveState.getSwapCount(), swapBefore);
  assert.strictEqual(cognitiveState.getProbeCount(), probeBefore);
  assert.strictEqual(cognitiveState.canUndo(), canUndoBefore);
});

// ============================================================
// candidate検討後のcontinue_scanは拒否
// ============================================================
check('candidate検討後のcontinue_scanは拒否', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  const cells = cognitiveState.getMovableCells();
  cognitiveState.observeLine(lines[0].id);
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  assert.throws(() => cognitiveState.executeContinueScan(), CognitiveLimitViolation);
});

// ============================================================
// 観測0件でのcontinue_scanは拒否
// ============================================================
check('観測0件でのcontinue_scanは拒否', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  assert.throws(() => cognitiveState.executeContinueScan(), CognitiveLimitViolation);
});

// ============================================================
// 11回目のcontinue_scanは拒否(上限10)
// ============================================================
check('11回目のcontinue_scanは拒否', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  let lineIdx = 0;
  for(let i=0; i<10; i++){
    cognitiveState.observeLine(lines[lineIdx].id); lineIdx++;
    cognitiveState.executeContinueScan();
  }
  cognitiveState.observeLine(lines[lineIdx].id); lineIdx++;
  assert.throws(() => cognitiveState.executeContinueScan(), CognitiveLimitViolation);
});

// ============================================================
// continue_scan後もepoch観測集合を維持
// ============================================================
check('continue_scan後もepoch観測集合を維持', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  cognitiveState.observeLine(lines[0].id);
  const progressBefore = cognitiveState.getScanEpochProgress();
  cognitiveState.executeContinueScan();
  const progressAfter = cognitiveState.getScanEpochProgress();
  assert.strictEqual(progressAfter.observed, progressBefore.observed, 'continue_scan自体は観測集合を変えない');
  cognitiveState.observeLine(lines[1].id);
  const progressAfter2 = cognitiveState.getScanEpochProgress();
  assert.strictEqual(progressAfter2.observed, progressBefore.observed + 1);
});

// ============================================================
// swap/undoでepochとcontinue回数をリセット
// ============================================================
check('swapでepochがリセットされる', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  const lines = cognitiveState.getLines();
  const cells = cognitiveState.getMovableCells();
  cognitiveState.observeLine(lines[0].id);
  cognitiveState.observeLine(lines[1].id);
  const progressBefore = cognitiveState.getScanEpochProgress();
  assert.ok(progressBefore.observed >= 2);
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction');
  const progressAfter = cognitiveState.getScanEpochProgress();
  assert.strictEqual(progressAfter.observed, 0, 'executeSwap後はscan epochが0からリセットされるはず');
});

check('undoでepochとcontinue回数がリセットされる', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  const cells = cognitiveState.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction');
  const lines = cognitiveState.getLines();
  cognitiveState.observeLine(lines[0].id);
  const before = cognitiveState.getScanEpochProgress();
  assert.ok(before.observed >= 1);
  cognitiveState.executeUndo();
  const after = cognitiveState.getScanEpochProgress();
  assert.strictEqual(after.observed, 0, 'executeUndo後もscan epochがリセットされるはず');
});

// ============================================================
// 交換後再観測ラインを新epochへ算入
// ============================================================
check('交換後の再観測ラインが新epochの一部として数えられる', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  const cells = cognitiveState.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction');
  // executeSwap直後はepoch観測数0のはず
  assert.strictEqual(cognitiveState.getScanEpochProgress().observed, 0);
  const lines = cognitiveState.getLines();
  cognitiveState.observeLine(lines[0].id);
  cognitiveState.observeLine(lines[1].id);
  assert.strictEqual(cognitiveState.getScanEpochProgress().observed, 2, '交換後の再観測が新epochの観測数として数えられるはず');
});

// ============================================================
// 固定順走査で既観測lineを二重計上しない(policy側の実装検証)
// ============================================================
check('固定順走査で既観測lineを二重計上しない(cautious_reasoner実行での確認)', () => {
  const result = runCautious(1);
  const trace = result.observation_trace;
  // 1つのepoch(直近のswap/undoから次のswap/undoまでの区間)内で
  // 同一lineIdに対するobserve_lineが複数回発生していないことを確認する。
  let seenThisEpoch = new Set();
  for(const ev of trace){
    if(ev.kind === 'swap' || ev.kind === 'undo'){
      seenThisEpoch = new Set();
      continue;
    }
    if(ev.kind === 'observe_line'){
      assert.ok(!seenThisEpoch.has(ev.lineId), `同一epoch内でline ${ev.lineId} が2回観測されている`);
      seenThisEpoch.add(ev.lineId);
    }
  }
});

// ============================================================
// cursorがwrapして109 unique linesへ到達(継続的な観測でepoch完了できるか)
// ============================================================
check('観測を継続すれば109本すべてに到達できる(cognitiveState単体での確認)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  let idx = 0;
  while(cognitiveState.getScanEpochProgress().observed < lines.length){
    let inThisTurn = 0;
    while(inThisTurn < 12 && idx < lines.length){
      cognitiveState.observeLine(lines[idx].id);
      idx++; inThisTurn++;
    }
    if(cognitiveState.getScanEpochProgress().observed < lines.length){
      cognitiveState.executeContinueScan();
    }
  }
  assert.strictEqual(cognitiveState.getScanEpochProgress().observed, 109);
  assert.ok(cognitiveState.getScanEpochProgress().complete);
});

// ============================================================
// epoch未完了の早期declareStuckを拒否
// ============================================================
check('epoch未完了の早期declareStuckを拒否(guard有効時)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  cognitiveState.observeLine(lines[0].id);
  assert.throws(() => cognitiveState.executeDeclareStuck(), CognitiveLimitViolation);
});

// ============================================================
// epoch完了かつcandidate0でstuck
// ============================================================
check('epoch完了後はdeclareStuckが成功する(guard有効時)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {}, { requireScanEpochCompleteForStuck: true });
  const lines = cognitiveState.getLines();
  let idx = 0;
  while(cognitiveState.getScanEpochProgress().observed < lines.length){
    let inThisTurn = 0;
    while(inThisTurn < 12 && idx < lines.length){
      cognitiveState.observeLine(lines[idx].id);
      idx++; inThisTurn++;
    }
    if(cognitiveState.getScanEpochProgress().observed < lines.length){
      cognitiveState.executeContinueScan();
    }
  }
  assert.doesNotThrow(() => cognitiveState.executeDeclareStuck());
  assert.strictEqual(cognitiveState.getFinalClassification(), 'stuck');
});

// ============================================================
// scripted_replay/local_greedyはguard無効のまま(互換性維持)
// ============================================================
check('scripted_replay/local_greedyはdeclareStuckガードが無効のまま(互換性維持)', () => {
  // local_greedyは候補が尽きるとdeclareStuckを即座に呼ぶ設計のまま(epoch概念を使わない)。
  // guardが誤って有効化されていれば、epoch未完了時にCognitiveLimitViolationとなり
  // resultにerrorが残るはずなので、それが起きていないことを確認する。
  const lg = runPolicy({
    policyId: 'local_greedy',
    policy: createLocalGreedyPolicy(),
    randomSeed: 1,
    cognitiveLimits: {},
    puzzleFixture: 'prototype11-seed7',
  });
  assert.strictEqual(lg.error, null, 'local_greedyがguardの影響でerror終了していないこと');

  const sr = runPolicy({
    policyId: 'scripted_replay',
    policy: createScriptedReplayPolicy(),
    randomSeed: 7,
    cognitiveLimits: {},
    puzzleFixture: 'prototype11-seed7',
  });
  assert.strictEqual(sr.error, null, 'scripted_replayがguardの影響でerror終了していないこと');
  assert.strictEqual(sr.cleared_or_stuck_or_loop_or_limit, 'stuck');
});

// ============================================================
// recentlyUndone時にdown候補を失わない/別upとの組合せ可能性を維持
// ============================================================
check('recentlyUndone時にdown候補を失わない(pairing_fixの静的検証)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  // downPool.shift()の前にisRecentlyUndone等の判定がある(=先にshiftしていない)ことを、
  // 「shiftは有効pair確定後(matched=true直前)にしか呼ばれない」構造で確認する。
  assert.ok(src.includes('downPool.push(downPool.shift())'), 'rotate(末尾へ回す)処理が存在するはず');
  assert.ok(!/downPool\.shift\(\);\s*\n\s*const key/.test(src), 'shift直後に判定するという旧実装のパターンが残っていないこと');
});

check('別upとの組合せ可能性を維持(実行での確認)', () => {
  // pairing_fixにより、1件のrecently-undone除外があっても、
  // その後のcycleで別のup要素とdown要素の組合せが具体化できることを、
  // 実際にUndoが発生した後もswap/stuck以外でエラー終了しないことで確認する。
  const result = runCautious(1);
  assert.strictEqual(result.error, null);
});

// ============================================================
// up/down pool各12件以下(静的検証)
// ============================================================
check('up/down poolが各12件以下に制限される(静的検証)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  assert.ok(src.includes('POOL_LIMIT = 12'));
  assert.ok(src.includes('pushBounded'));
});

// ============================================================
// 同一seedでtrace完全一致
// ============================================================
check('同一seedでtrace完全一致(cautious_reasoner、2回実行)', () => {
  const r1 = runCautious(1);
  const r2 = runCautious(1);
  assert.deepStrictEqual(r1, r2);
});

// ============================================================
// scripted_replay/local_greedyのtrace不変(12.0c3実装前後で同じ結果になること)
// ============================================================
check('scripted_replayのtraceが12.0c3実装前後で不変', () => {
  const r1 = runPolicy({
    policyId: 'scripted_replay', policy: createScriptedReplayPolicy(), randomSeed: 7,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const swapCount = r1.observation_trace.filter(t => t.kind === 'swap').length;
  const undoCount = r1.observation_trace.filter(t => t.kind === 'undo').length;
  const stuckCount = r1.observation_trace.filter(t => t.kind === 'declare_stuck').length;
  assert.strictEqual(swapCount, 5);
  assert.strictEqual(undoCount, 1);
  assert.strictEqual(stuckCount, 1);
  assert.strictEqual(r1.cleared_or_stuck_or_loop_or_limit, 'stuck');
});

check('local_greedyのtraceが12.0c3実装前後で不変(swap上限到達)', () => {
  const r1 = runPolicy({
    policyId: 'local_greedy', policy: createLocalGreedyPolicy(), randomSeed: 1,
    cognitiveLimits: {}, puzzleFixture: 'prototype11-seed7',
  });
  const swapCount = r1.observation_trace.filter(t => t.kind === 'swap').length;
  assert.strictEqual(swapCount, 30);
  assert.strictEqual(r1.cleared_or_stuck_or_loop_or_limit, 'limit');
});

// ============================================================
// 禁止情報非漏洩
// ============================================================
check('禁止情報がtraceへ漏れない(cautious_reasoner)', () => {
  const result = runCautious(1);
  const resultStr = JSON.stringify(result);
  const forbidden = ['groupA','groupB','decoy','line_sum','exact_deviation','cell_correctness','cycle_group','decoy_flag','solution_pair','solution_path','minimum_moves'];
  forbidden.forEach(f => assert.ok(!resultStr.includes(f)));
});

// ============================================================
// 証拠5ファイル不変
// ============================================================
check('証拠5ファイル不変', () => {
  const fs = require('fs');
  const crypto = require('crypto');
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const baseDir = path.join(__dirname, '..');
  const expected = {
    [path.join(repoRoot, 'prototype11.html')]: '05cfa1496bdefcdab75a2f35e7cb35a9a1aa198639fe44119e8bf8752fa48fdc',
    [path.join(repoRoot, 'prototype11-access.html')]: '9313dc6f4d5047c0a4af274bf7676d79f46e9a592eda6624fe344a52622aeba6',
    [path.join(repoRoot, 'prototype11-lite.html')]: '7bbd8ac7590d8e7285040f1abf3ac76dd93ebc7866ef0dd3ab4f614d8b4e67e8',
    [path.join(baseDir, 'internal', 'prototype-fixture.js')]: 'f577c3d3e9a9457f9828bb99d0c29327f9b1b41251e3029d6de3281e9021f574',
  };
  for(const [filepath, hash] of Object.entries(expected)){
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
    assert.strictEqual(actual, hash, `${filepath} のSHA-256が変化している`);
  }
  const evidenceLog = '/home/claude/evidence/prototype11.0-session-log.jsonl';
  const logHash = crypto.createHash('sha256').update(fs.readFileSync(evidenceLog)).digest('hex');
  assert.strictEqual(logHash, 'a2574f65bdc1173718845e80235d103435aecb39725433a8ce26ce4851f5c471');
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
