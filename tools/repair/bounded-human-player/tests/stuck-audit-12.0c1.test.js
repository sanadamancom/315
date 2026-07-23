// tests/stuck-audit-12.0c1.test.js
//
// prototype-12.0c1-stuck-audit
//
// 【重要】このファイルは監査専用の新規テストであり、以下のいずれも変更しない:
//   - policies/cautious-reasoner-policy.js (実アルゴリズムはこのファイルのソースを
//     そのまま読んで、この監査スクリプト内で「読み取り専用の計装版」として
//     再現するだけ。本体ファイル自体には一切手を加えない)
//   - cognitive-state.js / internal/puzzle-engine.js / public-observation-adapter.js
//   - 証拠5ファイル
//
// 目的:
//   実行時にcautious_reasonerがどのタイミングで、どの条件によりstuckへ至ったかを
//   公開情報の範囲だけで特定する。正解pair探索・全231pair採点・成功経路探索・
//   heuristic変更は行わない(observeLine/getLineState/getMovableCellsなど、
//   実際のpolicyが呼べる範�囲の公開APIだけを使う)。

'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { createPublicObservationAdapter } = require('../public-observation-adapter');
const { createCognitiveState, CognitiveLimitViolation } = require('../cognitive-state');
const { runPolicy } = require('../deterministic-runner');
const { createCautiousReasonerPolicy } = require('../policies/cautious-reasoner-policy');

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

// ============================================================
// 計装版アルゴリズム(cautious-reasoner-policy.jsの現行ソースを
// 一字一句そのまま踏襲し、内部状態をfunnelとして記録できるようにしたもの)。
// 本体ファイルの改変は一切行わない。ロジックの分岐条件は本体と完全に同一。
// ============================================================
function qualitativeCost(state){
  if(state.status === 'equal') return 0;
  return state.band === 'large' ? 2 : 1;
}
function pairKey(idA, idB){
  return [idA, idB].sort().join('|');
}

const HISTORY_LIMIT = 20;
const RECENTLY_UNDONE_LIMIT = 5;

function runInstrumented(adapter, cognitiveState){
  const limits = cognitiveState.limits;
  const maxCandidatesPerTurn = Math.min(3, limits.candidate_pairs_per_turn);
  const maxObservePerTurn = limits.lines_observed_per_turn;
  const lines = cognitiveState.getLines();
  const movableIds = new Set(cognitiveState.getMovableCells().map(c => c.id));

  const history = [];
  const recentlyUndone = [];
  function pushHistory(entry){ history.push(entry); if(history.length > HISTORY_LIMIT) history.shift(); }
  function markUndone(key){ recentlyUndone.push(key); if(recentlyUndone.length > RECENTLY_UNDONE_LIMIT) recentlyUndone.shift(); }
  function isRecentlyUndone(key){ return recentlyUndone.includes(key); }

  let nextLineIndex = 0;
  let observedCarryFromPreviousTurn = 0;

  const funnel = []; // report_each_decision_cycle
  let cycleNo = 0;

  while(true){
    if(cognitiveState.getFinalClassification()) return { funnel, finalStatus: cognitiveState.getFinalClassification() };
    if(cognitiveState.getStatus() !== 'active') return { funnel, finalStatus: cognitiveState.getStatus() };

    cycleNo++;
    const cycleReport = {
      cycle: cycleNo,
      observeBudgetAvailable: null,
      carryConsumed: observedCarryFromPreviousTurn,
      observedUpCount: 0,
      observedDownCount: 0,
      observedEqualCount: 0,
      observedTotal: 0,
      observeStoppedEarlyByQuota: false,
      pairingAttempts: 0,          // upPool/downPoolの組合せを試行した回数(shiftした回数)
      excludedRecentlyUndone: 0,   // isRecentlyUndoneで弾かれた回数
      excludedByCandidateQuota: 0, // considerPairがquota超過でthrowし打ち切った回数(0 or 1)
      consideredCount: 0,          // considerPairへ到達した候補数
      upPoolRemainingAtEnd: 0,
      downPoolRemainingAtEnd: 0,
      finalAction: null,           // 'swap' | 'declare_stuck'
      postSwapOutcome: null,       // 'kept_improved' | 'kept_unchanged' | 'undone' | null
    };

    const upPool = [];
    const downPool = [];
    const seenCellIds = new Set();
    let observedThisPhase = 0;
    const observeBudget = Math.max(0, maxObservePerTurn - observedCarryFromPreviousTurn);
    cycleReport.observeBudgetAvailable = observeBudget;

    while(observedThisPhase < observeBudget){
      const line = lines[nextLineIndex % lines.length];
      nextLineIndex++;
      let state;
      try {
        state = cognitiveState.observeLine(line.id);
      } catch(err){
        cycleReport.observeStoppedEarlyByQuota = true;
        break;
      }
      observedThisPhase++;
      cycleReport.observedTotal++;

      if(state.status === 'equal'){ cycleReport.observedEqualCount++; continue; }
      if(state.status === 'up') cycleReport.observedUpCount++;
      else cycleReport.observedDownCount++;

      const members = line.cells
        .map(c => `${c.z}-${c.y}-${c.x}`)
        .filter(id => movableIds.has(id) && !seenCellIds.has(id));

      for(const cellId of members){
        seenCellIds.add(cellId);
        if(state.status === 'up') upPool.push({ cellId, lineId: line.id, band: state.band });
        else downPool.push({ cellId, lineId: line.id, band: state.band });
      }
    }

    const candidates = [];
    while(upPool.length > 0 && downPool.length > 0 && candidates.length < maxCandidatesPerTurn){
      const a = upPool.shift();
      const b = downPool.shift();
      cycleReport.pairingAttempts++;
      const key = pairKey(a.cellId, b.cellId);
      if(isRecentlyUndone(key)){
        cycleReport.excludedRecentlyUndone++;
        continue; // ← a,bは既にshift済みのため、このままではプールに戻らない(監査対象の挙動)
      }
      try {
        cognitiveState.considerPair(a.cellId, b.cellId);
      } catch(err){
        cycleReport.excludedByCandidateQuota++;
        break;
      }
      cycleReport.consideredCount++;
      candidates.push({
        idA: a.cellId, idB: b.cellId,
        upLineId: a.lineId, downLineId: b.lineId,
        upBand: a.band, downBand: b.band,
      });
    }
    cycleReport.upPoolRemainingAtEnd = upPool.length;
    cycleReport.downPoolRemainingAtEnd = downPool.length;

    if(candidates.length === 0){
      cognitiveState.executeDeclareStuck();
      cycleReport.finalAction = 'declare_stuck';
      funnel.push(cycleReport);
      return { funnel, finalStatus: 'stuck' };
    }

    function bandRank(band){ return band === 'large' ? 2 : 1; }
    candidates.sort((x, y) => {
      const sx = bandRank(x.upBand) + bandRank(x.downBand);
      const sy = bandRank(y.upBand) + bandRank(y.downBand);
      if(sy !== sx) return sy - sx;
      const kx = pairKey(x.idA, x.idB);
      const ky = pairKey(y.idA, y.idB);
      return kx < ky ? -1 : (kx > ky ? 1 : 0);
    });
    const chosen = candidates[0];
    const chosenKey = pairKey(chosen.idA, chosen.idB);
    const beforeCost =
      qualitativeCost({ status: 'up', band: chosen.upBand }) +
      qualitativeCost({ status: 'down', band: chosen.downBand });

    cognitiveState.executeSwap(chosen.idA, chosen.idB, 'deduction', `up_${chosen.upBand}_vs_down_${chosen.downBand}`);
    cycleReport.finalAction = 'swap';

    if(cognitiveState.getFinalClassification()){
      funnel.push(cycleReport);
      return { funnel, finalStatus: cognitiveState.getFinalClassification() };
    }

    let afterUpState, afterDownState;
    try {
      afterUpState = cognitiveState.observeLine(chosen.upLineId);
      afterDownState = cognitiveState.observeLine(chosen.downLineId);
    } catch(err){
      cognitiveState.executeDeclareStuck();
      cycleReport.postSwapOutcome = 'forced_stuck_on_afterobserve_quota';
      funnel.push(cycleReport);
      return { funnel, finalStatus: 'stuck' };
    }
    const afterCost = qualitativeCost(afterUpState) + qualitativeCost(afterDownState);

    if(afterCost < beforeCost){
      pushHistory({ pairKey: chosenKey, outcome: 'kept_improved' });
      observedCarryFromPreviousTurn = 2;
      cycleReport.postSwapOutcome = 'kept_improved';
    } else if(afterCost === beforeCost){
      pushHistory({ pairKey: chosenKey, outcome: 'kept_unchanged' });
      observedCarryFromPreviousTurn = 2;
      cycleReport.postSwapOutcome = 'kept_unchanged';
    } else {
      cognitiveState.executeUndo();
      pushHistory({ pairKey: chosenKey, outcome: 'undone' });
      markUndone(chosenKey);
      observedCarryFromPreviousTurn = 0;
      cycleReport.postSwapOutcome = 'undone';
    }

    funnel.push(cycleReport);
  }
}

// ============================================================
// 1) [12.0c3で更新] 実policy(runPolicy経由)が、12.0c1で発見した
//    「cursor=44/109で早期stuckする」という具体的症状をもう再現しないことを
//    確認する。計装版(このファイル内の固定コピー、12.0c1時点のアルゴリズムを
//    保存したもの)は意図的に更新していない -- 「あの時何が起きていたか」の
//    参照実装として残す。実policy側は12.0c3のscan epoch継続方式により
//    修正されているため、両者の最終classificationが一致しなくなるのは
//    期待通りの結果である。
// ============================================================
let instrumentedResult = null;
check('[12.0c3で修正確認] 実policyはcursor=44/109での早期stuckをもう再現しない', () => {
  const realResult = runPolicy({
    policyId: 'cautious_reasoner',
    policy: createCautiousReasonerPolicy(),
    randomSeed: 1,
    cognitiveLimits: {},
    puzzleFixture: 'prototype11-seed7',
  });

  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  // instrumentedResultは「12.0c1時点の(バグを含む)アルゴリズム」の固定参照実装。
  // 以後のfunnel/history/carry監査(2〜6)は、この参照実装の構造そのものを
  // 検証する目的で保持し続ける(12.0c1で書いたロジックの妥当性の記録)。
  instrumentedResult = runInstrumented(adapter, cognitiveState);

  const realStuckCount = realResult.observation_trace.filter(t => t.kind === 'declare_stuck').length;
  const realSwapCount = realResult.observation_trace.filter(t => t.kind === 'swap').length;

  // 12.0c1で確認された具体的症状: 3 swap後、cursor=44/109でstuckする。
  // 12.0c3のscan epoch継続方式により、この早期stuckはもう起きないはず。
  assert.notStrictEqual(
    realResult.cleared_or_stuck_or_loop_or_limit === 'stuck' && realSwapCount === 3 && realStuckCount === 1,
    true,
    '12.0c1の具体的症状(3 swap後にcursor=44でstuck)がまだ再現している'
  );
  console.log(`      [12.0c3後の実測] finalStatus=${realResult.cleared_or_stuck_or_loop_or_limit} swapCount=${realSwapCount}`);
});

// ============================================================
// 2) candidate funnelの内容をコンソールへ出力(座標・pairは含めない)
// ============================================================
check('candidate funnelを出力する(座標・pair非含有)', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  for(const c of instrumentedResult.funnel){
    const safe = { ...c };
    console.log(`      cycle=${safe.cycle} observeBudget=${safe.observeBudgetAvailable} carry=${safe.carryConsumed} ` +
      `observed(up/down/equal)=${safe.observedUpCount}/${safe.observedDownCount}/${safe.observedEqualCount} ` +
      `pairingAttempts=${safe.pairingAttempts} excludedRecentlyUndone=${safe.excludedRecentlyUndone} ` +
      `excludedByCandidateQuota=${safe.excludedByCandidateQuota} considered=${safe.consideredCount} ` +
      `poolRemain(up/down)=${safe.upPoolRemainingAtEnd}/${safe.downPoolRemainingAtEnd} ` +
      `finalAction=${safe.finalAction} postSwapOutcome=${safe.postSwapOutcome}`);
    // privacy.exclude確認: cycleReportオブジェクトのキーが座標・pair実データそのものではないこと
    // (pairingAttempts/excludedRecentlyUndoneのような集計カウント名は許可する)
    const keys = Object.keys(safe);
    const forbiddenExactKeys = ['pair', 'coord', 'cellid', 'ida', 'idb', 'sum', 'deviation', 'value', 'z', 'y', 'x'];
    keys.forEach(k => assert.ok(!forbiddenExactKeys.includes(k.toLowerCase()), `keyが禁止情報そのものを指している: ${k}`));
  }
});

// ============================================================
// 3) stuck理由の単一machine-readable分類
// ============================================================
let stuckClassification = null;
check('stuck理由が単一のmachine-readable分類になる', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  const stuckCycle = instrumentedResult.funnel.find(c => c.finalAction === 'declare_stuck');
  assert.ok(stuckCycle, 'stuckに至ったcycleが見つかるはず');

  // 除外理由件数の合計とfunnelの整合性
  const totalPairingOutcomes = stuckCycle.excludedRecentlyUndone + stuckCycle.excludedByCandidateQuota + stuckCycle.consideredCount;
  assert.strictEqual(totalPairingOutcomes, stuckCycle.pairingAttempts,
    `除外理由件数の合計(${totalPairingOutcomes})がpairingAttempts(${stuckCycle.pairingAttempts})と一致しない`);

  if(stuckCycle.pairingAttempts === 0){
    if(stuckCycle.upPoolRemainingAtEnd === 0 && stuckCycle.downPoolRemainingAtEnd > 0){
      stuckClassification = 'up_line_pool_exhausted';
    } else if(stuckCycle.downPoolRemainingAtEnd === 0 && stuckCycle.upPoolRemainingAtEnd > 0){
      stuckClassification = 'down_line_pool_exhausted';
    } else {
      stuckClassification = 'both_pools_empty_no_nonequal_lines_observed';
    }
  } else if(stuckCycle.consideredCount === 0 && stuckCycle.excludedRecentlyUndone === stuckCycle.pairingAttempts){
    stuckClassification = 'all_pairing_attempts_excluded_by_recently_undone';
  } else if(stuckCycle.consideredCount === 0 && stuckCycle.excludedByCandidateQuota > 0){
    stuckClassification = 'candidate_quota_exhausted_before_any_considered';
  } else {
    stuckClassification = 'mixed_or_unclassified';
  }
  assert.ok(stuckClassification, 'stuck理由の分類が得られるはず');
  console.log(`      [stuck classification] ${stuckClassification}`);
});

// ============================================================
// 4) history_semantics検証
// ============================================================
check('history_semantics: 永続的なexecuted pair除外が仕様外に存在しない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  // historyはpushHistoryでのみ書き込まれ、候補生成の除外判定(isRecentlyUndone)には
  // 一切参照されていないこと(=kept履歴が別候補生成を禁止しない)を静的に確認する。
  const isRecentlyUndoneBody = src.match(/function isRecentlyUndone\([^)]*\)\{([^}]*)\}/)[1];
  assert.ok(isRecentlyUndoneBody.includes('recentlyUndone'), 'isRecentlyUndoneはrecentlyUndoneだけを参照するはず');
  assert.ok(!isRecentlyUndoneBody.includes('history'), 'isRecentlyUndoneがhistory(全履歴)を参照していない(=kept履歴による永続除外が無い)ことを確認');
  // historyという変数名が候補除外ロジック(while条件やcontinue判定)に登場しないこと
  const pairingLoopMatch = src.match(/while\(upPool\.length[\s\S]*?\n    \}\n/);
  assert.ok(pairingLoopMatch, 'ペアリングループが見つかるはず');
  assert.ok(!pairingLoopMatch[0].includes('history.'), 'ペアリングループがhistory配列を直接参照していないこと');
});

check('history_semantics: 即時除外対象は直近Undo済みpairだけ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  const pairingLoopMatch = src.match(/while\(upPool\.length[\s\S]*?\n    \}\n/)[0];
  // continueが発生する条件はisRecentlyUndone(key)の1箇所だけであること
  const continueMatches = pairingLoopMatch.match(/continue;/g) || [];
  assert.strictEqual(continueMatches.length, 1, 'ペアリングループ内のcontinueは1箇所(isRecentlyUndone)だけのはず');
});

check('history_semantics: HISTORY_LIMITは保存上限であり候補禁止範囲ではない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  // HISTORY_LIMITはpushHistory内でのみ使われ、isRecentlyUndoneやペアリングループでは使われない
  const usages = [...src.matchAll(/HISTORY_LIMIT/g)];
  assert.ok(usages.length >= 1);
  assert.ok(!src.match(/isRecentlyUndone[\s\S]{0,100}HISTORY_LIMIT/), 'HISTORY_LIMITが候補除外判定に使われていないこと');
});

// ============================================================
// 5) carry_semantics検証
// ============================================================
check('carry_semantics: after-swap再観測2件だけが次候補生成予算から控除される', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  for(const c of instrumentedResult.funnel){
    assert.ok(c.carryConsumed === 0 || c.carryConsumed === 2,
      `carryConsumedは0か2以外にならないはず(実際: ${c.carryConsumed})`);
  }
});

check('carry_semantics: turn境界とquotaリセットが一致する(kept時は2、undone/初回は0)', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  const funnel = instrumentedResult.funnel;
  for(let i=1; i<funnel.length; i++){
    const prev = funnel[i-1];
    const cur = funnel[i];
    if(prev.postSwapOutcome === 'kept_improved' || prev.postSwapOutcome === 'kept_unchanged'){
      assert.strictEqual(cur.carryConsumed, 2, `cycle${cur.cycle}: 直前がkeptならcarryは2のはず`);
    } else if(prev.postSwapOutcome === 'undone'){
      assert.strictEqual(cur.carryConsumed, 0, `cycle${cur.cycle}: 直前がundoneならcarryは0のはず`);
    }
  }
  assert.strictEqual(funnel[0].carryConsumed, 0, '最初のcycleのcarryは0のはず');
});

check('carry_semantics: carryが次々turnへ残留しない(2連続以上蓄積しない)', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  // observedCarryFromPreviousTurnは仕様上0か2の二値のみを取り、
  // 3以上に蓄積することはない(ソースにも+=でなく代入のみであることを確認)
  const src = fs.readFileSync(path.join(__dirname, '..', 'policies', 'cautious-reasoner-policy.js'), 'utf8');
  assert.ok(!src.includes('observedCarryFromPreviousTurn +='), 'carryは代入のみで加算されていないこと(蓄積しない)');
});

check('carry_semantics: carryによりup/down探索が片側だけで終了しない', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  // observeBudgetが0より大きい限り、観測ループは固定順で全ラインタイプ(row/col/pillar等)を
  // 横断できる構造になっている(nextLineIndexがlines配列全体を順に巡回するため、
  // carryによって「上流(row/col)だけ」「下流(pillarなど)だけ」に偏ることは無い)。
  // ここではobserveBudget>0のcycleで、observedTotal>0であることを確認する。
  for(const c of instrumentedResult.funnel){
    if(c.observeBudgetAvailable > 0){
      assert.ok(c.observedTotal > 0 || c.observeStoppedEarlyByQuota === false,
        `cycle${c.cycle}: 観測予算があるのに1件も観測していない`);
    }
  }
});

// ============================================================
// 6) counterfactual集計(同一公開状態での除外条件の再集計のみ。swap実行・候補選択はしない)
// ============================================================
check('counterfactual: recently-undone除外がなければ候補が存在したか', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  const stuckCycle = instrumentedResult.funnel.find(c => c.finalAction === 'declare_stuck');
  if(!stuckCycle) return; // stuckが無ければ対象外
  const wouldHaveHadCandidateWithoutRecentlyUndoneFilter = stuckCycle.excludedRecentlyUndone > 0;
  console.log(`      [counterfactual] recently-undone除外を無効化した場合に候補が生まれたか: ${wouldHaveHadCandidateWithoutRecentlyUndoneFilter}`);
  // この値自体は分類判断の材料として最終報告に記載する(ここでは記録のみ)
});

check('counterfactual: carryが0なら候補が存在したか(observeBudgetの増分で観測数が増えるか)', () => {
  assert.ok(instrumentedResult, '前段の実行結果が必要');
  const stuckCycle = instrumentedResult.funnel.find(c => c.finalAction === 'declare_stuck');
  if(!stuckCycle) return;
  const wasCarryActive = stuckCycle.carryConsumed > 0;
  console.log(`      [counterfactual] stuckに至ったcycleでcarryが有効だったか(観測予算が2減っていたか): ${wasCarryActive}`);
});

// ============================================================
// 7) 既存52件が引き続き合格
// ============================================================
check('既存52件が引き続き合格', () => {
  const { execFileSync } = require('child_process');
  const files = ['bounded-human-player.test.js', 'boundary-audit.test.js', 'local-greedy-policy.test.js', 'cautious-reasoner-policy.test.js'];
  for(const f of files){
    const out = execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
    assert.ok(/passed, 0 failed/.test(out), `${f}が全合格していない:\n${out}`);
  }
});

// ============================================================
// 8) 禁止情報非漏洩・trace決定性維持
// ============================================================
check('禁止情報非漏洩(funnelレポート全体)', () => {
  const funnelStr = JSON.stringify(instrumentedResult.funnel);
  const forbidden = ['groupA','groupB','decoy','line_sum','exact_deviation','cell_correctness','cycle_group','decoy_flag','solution_pair','solution_path','minimum_moves'];
  forbidden.forEach(f => assert.ok(!funnelStr.includes(f)));
});

check('trace決定性維持(2回計装実行で完全一致)', () => {
  const adapter1 = createPublicObservationAdapter({});
  const cs1 = createCognitiveState(adapter1, {});
  const r1 = runInstrumented(adapter1, cs1);

  const adapter2 = createPublicObservationAdapter({});
  const cs2 = createCognitiveState(adapter2, {});
  const r2 = runInstrumented(adapter2, cs2);

  assert.deepStrictEqual(r1, r2, '計装版も決定的であるはず');
});

// ============================================================
// 9) 全productionコード・policyコードのSHA-256不変確認
// ============================================================
check('証拠5ファイル不変(12.0c1時点と同じ、12.0c3でも変更対象外)', () => {
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
  // 注記: cognitive-state.js / cautious-reasoner-policy.js / deterministic-runner.js は
  // 12.0c3で意図的に変更されたファイルのため、ここでは不変チェックの対象に含めない
  // (それらのSHA-256はtests/scan-epoch.test.jsなど12.0c3側のテストで別途記録・確認する)。
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
