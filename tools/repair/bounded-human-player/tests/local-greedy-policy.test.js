// tests/local-greedy-policy.test.js
//
// prototype-12.0b-local-greedy の required_tests のうち、
// local_greedy固有の項目を検証する。
// (12.0a境界監査13件・既存16件は個別のテストファイルで再確認する)

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { runPolicy } = require('../deterministic-runner');
const { createLocalGreedyPolicy } = require('../policies/local-greedy-policy');
const { lintFile } = require('../audit/static-policy-lint');

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

function runLocalGreedy(seed){
  return runPolicy({
    policyId: 'local_greedy',
    policy: createLocalGreedyPolicy(),
    randomSeed: seed,
    cognitiveLimits: {},
    puzzleFixture: 'prototype11-seed7',
  });
}

// ============================================================
// local_greedyがcognitiveState以外へアクセスしない(静的検査)
// ============================================================
check('local_greedyがcognitiveState以外へアクセスしない(静的検査)', () => {
  const filepath = path.join(__dirname, '..', 'policies', 'local-greedy-policy.js');
  const violations = lintFile(filepath);
  assert.strictEqual(violations.length, 0, `local-greedy-policy.jsに違反がある: ${JSON.stringify(violations)}`);
  const src = fs.readFileSync(filepath, 'utf8');
  assert.ok(!src.includes('require('), 'local-greedy-policy.jsはrequireを一切使わない設計のはず');
});

// ============================================================
// 全pair列挙または一括score処理がない(静的検査: ソース内に231/22*21等の全列挙パターンが無いこと)
// ============================================================
check('全pair列挙または一括score処理がない', () => {
  const filepath = path.join(__dirname, '..', 'policies', 'local-greedy-policy.js');
  const src = fs.readFileSync(filepath, 'utf8');
  // 22セル同士の直積(二重ループでmovableCells全体を回すパターン)が無いこと
  assert.ok(!/for\s*\(.*movable.*\)[\s\S]{0,200}for\s*\(.*movable.*\)/i.test(src),
    'movableセル同士の二重ループ(直積生成)らしきコードが見つかった');
  // getMovableCells()の戻り値全体を並べ替えたり、ペアの一括スコアリングに使っていないこと
  // (idを抽出してSetにするだけの `.map(c => c.id)` は許可される正当な用途)
  assert.ok(!/getMovableCells\(\)\s*\.\s*(filter|reduce|sort)/.test(src),
    'getMovableCells()の全件に対するfilter/reduce/sortが見つかった');
  assert.ok(!/getMovableCells\(\)[\s\S]{0,80}\.sort\(/.test(src),
    'getMovableCells()の結果を並べ替えている(全候補の大域ランキングの疑い)');
});

// ============================================================
// 候補具体化直後にconsiderPairが呼ばれる / 未considerPair候補を比較・実行しない
//   → 実行結果のtraceを検査し、'consider_pair'イベントの直後(同時か前)に
//     対応する'swap'イベントのpairが必ずconsider_pair済みであることを確認する。
// ============================================================
check('候補具体化直後にconsiderPairが呼ばれる/未consider候補を実行しない', () => {
  const result = runLocalGreedy(1);
  const trace = result.observation_trace;

  // ターン(swapイベント)ごとに、そのswap直前までのconsider_pairイベント集合を
  // 集計し、swapのpairがconsider_pair済み集合に含まれることを確認する。
  let consideredSinceLastSwap = new Set();
  let checkedSwaps = 0;
  for(const ev of trace){
    if(ev.kind === 'consider_pair'){
      consideredSinceLastSwap.add([ev.idA, ev.idB].sort().join('|'));
    } else if(ev.kind === 'swap'){
      const key = [...ev.pair].sort().join('|');
      assert.ok(consideredSinceLastSwap.has(key), `swap pair ${key} がconsiderPairを経ずに実行された`);
      checkedSwaps++;
      consideredSinceLastSwap = new Set(); // ターン境界でリセット
    }
  }
  assert.ok(checkedSwaps > 0, '検証対象のswapが1件も無かった');
});

// ============================================================
// 1ターンの具体化候補数が上限以内(considerPairイベントをターンごとに数える)
// ============================================================
check('1ターンの具体化候補数が上限以内(3件)', () => {
  const result = runLocalGreedy(1);
  const trace = result.observation_trace;
  let countThisTurn = 0;
  for(const ev of trace){
    if(ev.kind === 'consider_pair') countThisTurn++;
    else if(ev.kind === 'swap'){
      assert.ok(countThisTurn <= 3, `1ターンのconsiderPair回数が3を超えている: ${countThisTurn}`);
      countThisTurn = 0;
    }
  }
});

// ============================================================
// observeLine上限を超えない(ターンごとのobserve_line件数を確認)
// ============================================================
check('observeLine上限を超えない(ターンごとに既定の12件以内)', () => {
  const result = runLocalGreedy(1);
  const trace = result.observation_trace;
  let countThisTurn = 0;
  for(const ev of trace){
    if(ev.kind === 'observe_line') countThisTurn++;
    else if(ev.kind === 'swap' || ev.kind === 'declare_stuck'){
      assert.ok(countThisTurn <= 12, `1ターンのobserveLine回数が上限(12)を超えている: ${countThisTurn}`);
      countThisTurn = 0;
    }
  }
});

// ============================================================
// probeを実行しない
// ============================================================
check('probeを実行しない', () => {
  const result = runLocalGreedy(1);
  assert.strictEqual(result.probe_count, 0, 'local_greedyはprobeを一切使わないはず');
  assert.ok(result.declared_action_type.every(t => t === 'deduction'), '全swapがdeduction宣言のはず');
});

// ============================================================
// exact sum/deviationを計算しない(静的検査 + traceに数値合計が出ないこと)
// ============================================================
check('exact sum/deviationを計算しない', () => {
  const filepath = path.join(__dirname, '..', 'policies', 'local-greedy-policy.js');
  const src = fs.readFileSync(filepath, 'utf8');
  assert.ok(!/lineSum|getExactDeviation|\bsum\b/i.test(src.replace(/\/\/.*$/gm,'')), 'ソースコードにline_sum/deviation計算らしき記述が見つかった');

  const result = runLocalGreedy(1);
  const traceStr = JSON.stringify(result.observation_trace);
  // observe_lineのstateはstatus/bandのみのはず(数値の合計や偏差フィールドが無いこと)
  const sample = result.observation_trace.find(t => t.kind === 'observe_line');
  assert.ok(sample, 'observe_lineイベントが存在するはず');
  assert.deepStrictEqual(Object.keys(sample.state).sort(), ['band','id','status'].sort());
});

// ============================================================
// 同一初期状態でtrace完全一致
// ============================================================
check('同一初期状態でtrace完全一致(2回実行)', () => {
  const r1 = runLocalGreedy(1);
  const r2 = runLocalGreedy(1);
  assert.deepStrictEqual(r1, r2, '同一seed・同一policyで完全一致するはず');
});

// ============================================================
// 禁止情報がtrace、console、errorへ漏れない
// ============================================================
check('禁止情報がtraceへ漏れない', () => {
  const result = runLocalGreedy(1);
  const resultStr = JSON.stringify(result);
  const forbidden = ['groupA','groupB','decoy','line_sum','exact_deviation','cell_correctness','cycle_group','decoy_flag','solution_pair','solution_path','minimum_moves'];
  forbidden.forEach(f => assert.ok(!resultStr.includes(f), `traceに禁止語が含まれている: ${f}`));
  assert.strictEqual(result.error, null, 'CognitiveLimitViolation等のエラーは発生していないはず');
});

// ============================================================
// 実行結果の分類が想定範囲内(cleared/stuck/loop/limitのいずれか)
// ============================================================
check('最終分類がcleared/stuck/loop/limitのいずれか', () => {
  const result = runLocalGreedy(1);
  assert.ok(['cleared','stuck','loop','limit'].includes(result.cleared_or_stuck_or_loop_or_limit));
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
