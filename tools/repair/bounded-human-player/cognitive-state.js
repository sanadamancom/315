// cognitive-state.js
//
// policy層が実際に触れるのはこのオブジェクトだけ。
// public-observation-adapterへの参照はこのモジュール内部に閉じ込め、
// policyへは一切渡さない(policyはこのモジュールが返す関数だけを呼ぶ)。
//
// 認知制限:
//   recent_line_memory      : 直近に観測したラインのうち記憶していられる本数
//   lines_observed_per_turn : 1ターンあたり新規observeできるライン数
//   candidate_pairs_per_turn: 1ターンあたり検討できるペア数
//   lookahead_depth         : 0固定。未実行swapの結果を先読みする関数は存在しない
//   probe_limit             : probe上限
//   repeated_state_limit    : 同一盤面状態への遷移許容回数(ループ検知)
//   maximum_swaps           : 総swap数上限
//
// 認知制限に違反した場合は例外を投げて即座に停止する(黙って丸めない)。
//
// scan epoch(12.0c3で追加):
//   「最後の盤面変更(executeSwapまたはexecuteUndo)以降、重複なく観測したライン集合」
//   をscanEpochSeenLineIdsとして追跡する。executeContinueScan()は、swap/probe/undo
//   としては数えずにturn境界(observeLine/considerPairのquotaリセット)だけを行う。
//   これにより、1ターンの観測上限を守ったまま複数ターンにまたがって109ライン全体を
//   走査できる。scanEpochが完了する(全ライン観測済み)前の永続的なdeclareStuckは、
//   guardが有効な場合に拒否される。

'use strict';

class CognitiveLimitViolation extends Error {
  constructor(message, code){
    super(message);
    this.name = 'CognitiveLimitViolation';
    this.code = code;
  }
}

const MAX_CONTINUE_SCAN_PER_EPOCH = 10;

function createCognitiveState(adapter, limits, options){
  const cfg = Object.assign({
    recent_line_memory: 8,
    lines_observed_per_turn: 12,
    candidate_pairs_per_turn: 6,
    lookahead_depth: 0,
    probe_limit: 2,
    repeated_state_limit: 2,
    maximum_swaps: 30,
  }, limits || {});

  // declareStuckガードの有効/無効はpolicyの実行時判断ではなく、
  // cognitiveStateを生成する側(runner/harness)が固定的に決める。
  // policyが自分でこのフラグを参照・変更する手段は一切公開しない。
  const opts = Object.assign({
    requireScanEpochCompleteForStuck: false,
  }, options || {});
  const guardStuckOnScanEpoch = !!opts.requireScanEpochCompleteForStuck;

  if(cfg.lookahead_depth !== 0){
    // この基盤ではlookahead_depth=0だけをサポートする。
    // 値を変えても未実行swapの先読み関数自体を追加しない。
    throw new CognitiveLimitViolation('lookahead_depth=0のみサポートされている', 'unsupported_lookahead');
  }

  const totalLineCount = adapter.getLines().length; // メタ情報の取得のみ、quota消費なし

  // 直近観測ライン(新しい順、重複なし、最大 recent_line_memory 件)
  let memory = []; // [{id, state}]
  // 現在ターンでobserveした件数
  let observedThisTurn = 0;
  // 現在ターンでconsiderPairした件数
  let consideredThisTurn = 0;
  // 現在ターンでconsiderPair済みのペア(このセットに無いペアはexecuteSwapを拒否する)
  let consideredPairsThisTurn = new Set();
  // 現在ターンで新規にscan epochへ追加したライン数(continue_scanの前提条件判定用)
  let newEpochLinesObservedThisTurn = 0;
  // 盤面状態の遷移回数カウンタ(loop検知用、内部フィンガープリントごとの出現数)
  const stateVisitCounts = new Map();
  let turnIndex = 0;
  let finalClassification = null; // 'cleared'|'stuck'|'loop'|'limit'|null

  // scan epoch: 最後の盤面変更以降に観測済みのline id集合
  let scanEpochSeenLineIds = new Set();
  let continueScanCountSinceBoardChange = 0;

  function assertActive(){
    if(finalClassification){
      throw new CognitiveLimitViolation(`セッションは既に終了している(${finalClassification})`, 'session_closed');
    }
  }

  function rememberLine(lineId, state){
    memory = memory.filter(m => m.id !== lineId);
    memory.unshift({ id: lineId, state });
    if(memory.length > cfg.recent_line_memory){
      memory = memory.slice(0, cfg.recent_line_memory);
    }
  }

  function recallFromMemory(lineId){
    return memory.find(m => m.id === lineId) || null;
  }

  function isScanEpochComplete(){
    return scanEpochSeenLineIds.size >= totalLineCount;
  }

  function resetScanEpoch(){
    scanEpochSeenLineIds = new Set();
    continueScanCountSinceBoardChange = 0;
  }

  // ------------------------------------------------------------
  // 観測系(quota消費あり)
  // ------------------------------------------------------------
  function observeLine(lineId){
    assertActive();
    if(observedThisTurn >= cfg.lines_observed_per_turn){
      throw new CognitiveLimitViolation(
        `1ターンあたりのライン観測上限(${cfg.lines_observed_per_turn})を超えている`,
        'lines_observed_per_turn_exceeded'
      );
    }
    const state = adapter.getLineState(lineId);
    observedThisTurn++;
    rememberLine(lineId, state);
    if(!scanEpochSeenLineIds.has(lineId)){
      scanEpochSeenLineIds.add(lineId);
      newEpochLinesObservedThisTurn++;
    }
    return state;
  }

  // ------------------------------------------------------------
  // 記憶からの再利用(quota消費なし)。記憶にない場合は例外(再観測が必要)。
  // ------------------------------------------------------------
  function recallLine(lineId){
    assertActive();
    const found = recallFromMemory(lineId);
    if(!found){
      throw new CognitiveLimitViolation(
        `ライン ${lineId} は記憶されていない(忘却済みか未観測)。observeLineが必要`,
        'line_not_in_memory'
      );
    }
    return found.state;
  }

  // ------------------------------------------------------------
  // 候補ペアの検討(quota消費あり)。一括列挙は禁止。
  // ------------------------------------------------------------
  function pairKey(idA, idB){
    // 順序に依存しない正規化キー
    return [idA, idB].sort().join('|');
  }

  function considerPair(idA, idB){
    assertActive();
    if(consideredThisTurn >= cfg.candidate_pairs_per_turn){
      throw new CognitiveLimitViolation(
        `1ターンあたりの候補ペア検討上限(${cfg.candidate_pairs_per_turn})を超えている`,
        'candidate_pairs_per_turn_exceeded'
      );
    }
    consideredThisTurn++;
    consideredPairsThisTurn.add(pairKey(idA, idB));
    return { idA, idB, consideredThisTurn };
  }

  // ------------------------------------------------------------
  // 明示的に「先読み禁止」を可視化するための関数。
  // 呼び出すと必ず失敗する(lookahead_depth=0の可視化用)。
  // ------------------------------------------------------------
  function previewSwap(){
    throw new CognitiveLimitViolation('lookahead_depth=0のためswap結果の事前先読みはできない', 'lookahead_forbidden');
  }

  function listAllMovablePairs(){
    throw new CognitiveLimitViolation('全movable pairの一括列挙は禁止されている', 'bulk_enumeration_forbidden');
  }

  // ------------------------------------------------------------
  // 素通し(quota対象外の meta 情報)
  // ------------------------------------------------------------
  function getMovableCells(){ assertActive(); return adapter.getMovableCells(); }
  function getLines(){ assertActive(); return adapter.getLines(); }
  function listAvailableActions(){ assertActive(); return adapter.listAvailableActions(); }
  function getSwapCount(){ return adapter.getSwapCount(); }
  function getProbeCount(){ return adapter.getProbeCount(); }
  function canUndo(){ return adapter.canUndo(); }
  function getStatus(){ return adapter.getStatus(); }
  function getTurnIndex(){ return turnIndex; }
  function getFinalClassification(){ return finalClassification; }
  function getScanEpochProgress(){
    // policyから見える範囲は「件数」だけ(どのラインを見たかの集合自体は返さない)。
    return { observed: scanEpochSeenLineIds.size, total: totalLineCount, complete: isScanEpochComplete() };
  }

  function endTurn(){
    turnIndex++;
    observedThisTurn = 0;
    consideredThisTurn = 0;
    consideredPairsThisTurn = new Set();
    newEpochLinesObservedThisTurn = 0;
  }

  function recordStateVisitAndCheckLoop(){
    const fp = adapter._internalStateFingerprint();
    const count = (stateVisitCounts.get(fp) || 0) + 1;
    stateVisitCounts.set(fp, count);
    if(count > cfg.repeated_state_limit){
      finalClassification = 'loop';
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------
  // continue_scan: swap/probe/undoとしては数えない、観測専用のturn境界アクション。
  // ------------------------------------------------------------
  function executeContinueScan(){
    assertActive();
    if(newEpochLinesObservedThisTurn < 1){
      throw new CognitiveLimitViolation(
        'このturnでscan epochへ新規追加されたラインが無いためcontinue_scanできない',
        'continue_scan_requires_new_epoch_observation'
      );
    }
    if(consideredThisTurn !== 0){
      throw new CognitiveLimitViolation(
        'このturnでconsiderPairを行った後はcontinue_scanできない',
        'continue_scan_after_consider_pair_forbidden'
      );
    }
    if(isScanEpochComplete()){
      throw new CognitiveLimitViolation(
        'scan epochは既に完了している(continue_scanは不要)',
        'continue_scan_after_epoch_complete_forbidden'
      );
    }
    if(continueScanCountSinceBoardChange >= MAX_CONTINUE_SCAN_PER_EPOCH){
      throw new CognitiveLimitViolation(
        `continue_scanの上限(${MAX_CONTINUE_SCAN_PER_EPOCH})に達している`,
        'continue_scan_limit_exceeded'
      );
    }
    continueScanCountSinceBoardChange++;
    const progress = getScanEpochProgress();
    endTurn(); // swapCount/probeCount/undoStack/historyには一切触れない
    return {
      success: true,
      scan_epoch_observed: progress.observed,
      scan_epoch_total: progress.total,
      continue_scan_count: continueScanCountSinceBoardChange,
      reason_code: 'no_candidate_continue_scan',
    };
  }

  // ------------------------------------------------------------
  // 実行系(quota消費なし。だが上限判定・分類はここで行う)
  // ------------------------------------------------------------
  function executeSwap(idA, idB, declaredActionType){
    assertActive();
    if(!consideredPairsThisTurn.has(pairKey(idA, idB))){
      throw new CognitiveLimitViolation(
        `pair (${idA}, ${idB}) はconsiderPair()を経ていないため実行候補として提出できない`,
        'pair_not_considered'
      );
    }
    if(declaredActionType === 'probe' && adapter.getProbeCount() >= cfg.probe_limit){
      throw new CognitiveLimitViolation(`probe上限(${cfg.probe_limit})に達している`, 'probe_limit_exceeded');
    }
    const result = adapter.applySwap(idA, idB, { declaredActionType });

    if(result.status === 'cleared'){
      finalClassification = 'cleared';
    } else if(adapter.getSwapCount() >= cfg.maximum_swaps){
      finalClassification = 'limit';
    } else {
      const looped = recordStateVisitAndCheckLoop();
      if(looped){
        // finalClassificationはrecordStateVisitAndCheckLoop内で設定済み
      }
    }
    resetScanEpoch(); // 盤面変更 → scan epochを明示的に再開始
    endTurn();
    return result;
  }

  function executeUndo(){
    assertActive();
    const result = adapter.applyUndo();
    resetScanEpoch(); // 盤面変更 → scan epochを明示的に再開始
    endTurn();
    return result;
  }

  function executeDeclareStuck(){
    assertActive();
    if(guardStuckOnScanEpoch && !isScanEpochComplete()){
      throw new CognitiveLimitViolation(
        `scan epoch未完了(${scanEpochSeenLineIds.size}/${totalLineCount})のためdeclareStuckは拒否される。continue_scanで走査を継続すること。`,
        'declare_stuck_before_scan_epoch_complete'
      );
    }
    const result = adapter.declareStuck();
    finalClassification = 'stuck';
    endTurn();
    return result;
  }

  return Object.freeze({
    limits: Object.freeze({ ...cfg }),
    observeLine,
    recallLine,
    considerPair,
    previewSwap,
    listAllMovablePairs,
    getMovableCells,
    getLines,
    listAvailableActions,
    getSwapCount,
    getProbeCount,
    canUndo,
    getStatus,
    getTurnIndex,
    getFinalClassification,
    getScanEpochProgress,
    executeSwap,
    executeUndo,
    executeDeclareStuck,
    executeContinueScan,
  });
}

module.exports = { createCognitiveState, CognitiveLimitViolation };
