// deterministic-runner.js
//
// policy_id, random_seed, cognitive_limits, puzzle_fixture を入力に取り、
// 同じ入力なら必ず同じ結果(trace)を返す実行基盤。
//
// 重要: traceには壁時計時刻(Date.now())を含めない。real-timeに依存する値は
// 決定性を壊すため、synthetic sequence counter(tick)だけを使う。

'use strict';

const { createPublicObservationAdapter } = require('./public-observation-adapter');
const { createCognitiveState, CognitiveLimitViolation } = require('./cognitive-state');

// puzzle_fixture: 現状は "prototype11-seed7" 固定候補のみサポート。
// 将来複数fixtureを扱う場合もここでidだけを受け取り、内部実装(internal/*)を
// 直接policyへ渡さない構造を維持する。
function resolveAdapterForFixture(puzzleFixtureId, probeLimit){
  if(puzzleFixtureId !== 'prototype11-seed7'){
    throw new Error(`unknown puzzle_fixture: ${puzzleFixtureId}`);
  }
  return createPublicObservationAdapter({ probeLimit });
}

function runPolicy(input){
  const {
    policyId,
    policy,           // policyオブジェクト: { run(cognitiveState, ctx) }
    randomSeed,
    cognitiveLimits,
    puzzleFixture,    // 例: 'prototype11-seed7'
    requireScanEpochCompleteForStuck, // 未指定ならpolicyIdで既定値を決める(policy自身は変更不可)
  } = input;

  if(typeof policy?.run !== 'function'){
    throw new Error('policyはrun(cognitiveState, ctx)を実装する必要がある');
  }

  const adapter = resolveAdapterForFixture(puzzleFixture, cognitiveLimits && cognitiveLimits.probe_limit);

  // declareStuckガードの既定値: cautious_reasonerだけscan epoch完了を必須にする。
  // scripted_replay/local_greedyの既存挙動(いつでもdeclareStuck可能)は変えない。
  // この値はrunPolicy呼び出し側(harness/テスト)が決めるものであり、
  // policy.run()の内部からは一切参照・変更できない。
  const guardOption = typeof requireScanEpochCompleteForStuck === 'boolean'
    ? requireScanEpochCompleteForStuck
    : (policyId === 'cautious_reasoner');

  const cognitiveState = createCognitiveState(adapter, cognitiveLimits, {
    requireScanEpochCompleteForStuck: guardOption,
  });

  let tick = 0;
  const trace = [];

  function recordTrace(kind, payload){
    trace.push({ tick: tick++, kind, ...payload });
  }

  // policyへ渡す「観測できたことをtraceに残すための」計装済みcognitiveState。
  // policyから見える関数の集合はcognitiveStateと同一(ラップして記録するだけ)。
  const instrumented = {
    limits: cognitiveState.limits,
    observeLine: (lineId) => {
      const state = cognitiveState.observeLine(lineId);
      recordTrace('observe_line', { lineId, state });
      return state;
    },
    recallLine: (lineId) => {
      const state = cognitiveState.recallLine(lineId);
      recordTrace('recall_line', { lineId, state });
      return state;
    },
    considerPair: (idA, idB) => {
      const result = cognitiveState.considerPair(idA, idB);
      recordTrace('consider_pair', { idA, idB });
      return result;
    },
    previewSwap: (...args) => cognitiveState.previewSwap(...args),
    listAllMovablePairs: (...args) => cognitiveState.listAllMovablePairs(...args),
    getMovableCells: () => cognitiveState.getMovableCells(),
    getLines: () => cognitiveState.getLines(),
    listAvailableActions: () => cognitiveState.listAvailableActions(),
    getSwapCount: () => cognitiveState.getSwapCount(),
    getProbeCount: () => cognitiveState.getProbeCount(),
    canUndo: () => cognitiveState.canUndo(),
    getStatus: () => cognitiveState.getStatus(),
    getFinalClassification: () => cognitiveState.getFinalClassification(),
    getScanEpochProgress: () => cognitiveState.getScanEpochProgress(),
    executeSwap: (idA, idB, declaredActionType, reasonCode) => {
      const result = cognitiveState.executeSwap(idA, idB, declaredActionType);
      recordTrace('swap', {
        pair: [idA, idB],
        declaredActionType,
        reasonCode: reasonCode || null,
        result: { status: result.status, swapCount: result.swapCount, probeCount: result.probeCount },
      });
      return result;
    },
    executeUndo: () => {
      const result = cognitiveState.executeUndo();
      recordTrace('undo', { result });
      return result;
    },
    executeDeclareStuck: () => {
      const result = cognitiveState.executeDeclareStuck();
      recordTrace('declare_stuck', { result });
      return result;
    },
    executeContinueScan: () => {
      const result = cognitiveState.executeContinueScan();
      recordTrace('continue_scan', {
        scan_epoch_observed: result.scan_epoch_observed,
        scan_epoch_total: result.scan_epoch_total,
        continue_scan_count: result.continue_scan_count,
        reason_code: result.reason_code,
      });
      return result;
    },
  };

  const ctx = {
    policyId,
    randomSeed,
    puzzleFixture,
  };

  let runError = null;
  try {
    policy.run(instrumented, ctx);
  } catch(err){
    if(err instanceof CognitiveLimitViolation){
      recordTrace('cognitive_limit_violation', { code: err.code, message: err.message });
      runError = { code: err.code, message: err.message };
    } else {
      throw err; // 想定外のエラーは握りつぶさない
    }
  }

  const finalClassification = cognitiveState.getFinalClassification() ||
    (runError ? 'error' : 'incomplete');

  // non_315_line_count_as_publicly_observable:
  // 公開されている状態(status/band)だけから「＝でないライン数」を数える。
  // 合計や正確な偏差そのものは一切参照しない。
  const lines = adapter.getLines();
  let non315Count = 0;
  for(const line of lines){
    const st = adapter.getLineState(line.id);
    if(st.status !== 'equal') non315Count++;
  }

  return {
    policyId,
    randomSeed,
    puzzleFixture,
    observation_trace: trace,
    considered_candidate_count: trace.filter(t => t.kind === 'consider_pair').length,
    selected_action: trace.filter(t => t.kind === 'swap' || t.kind === 'undo' || t.kind === 'declare_stuck').map(t => t.kind),
    declared_action_type: trace.filter(t => t.kind === 'swap').map(t => t.declaredActionType),
    reason_code: trace.filter(t => t.kind === 'swap').map(t => t.reasonCode),
    probe_count: adapter.getProbeCount(),
    non_315_line_count_as_publicly_observable: non315Count,
    cleared_or_stuck_or_loop_or_limit: finalClassification,
    error: runError,
  };
}

module.exports = { runPolicy };
