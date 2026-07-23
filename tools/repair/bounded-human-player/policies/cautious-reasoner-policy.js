// policies/cautious-reasoner-policy.js
//
// cautious_reasoner policy (12.0c6: bounded committed-history追加版)
//
// candidate_generation.base: local_greedyの一般規則(公開トポロジー固定順で
// 逐次観測し、up/downラインに属するmovableセルから局所的に候補を具体化する)
// に、以下を追加している。
//
//   1) 交換後に公開された結果を見て、悪化していればUndoする(12.0cから継続)。
//   2) 1ターンの観測上限を守ったまま、盤面変更が起きるまでの間「scan epoch」
//      として109ライン全体を複数ターンにまたいで走査する。候補が0件でも
//      epochが完了していなければ、永続的なdeclare_stuckではなくcontinue_scan
//      (交換なしで次の観測ターンへ進む、swap/probe/undoとして数えない操作)
//      を使う。epoch完了後もなお候補0件の場合だけdeclare_stuckする。(12.0c3)
//   3) 「直近Undo済みpair」による除外時、対象ペアの両セルを即座にプールから
//      失わないpairing_fix(down側を末尾へrotateして他候補との組合せを試す)
//      を採用する。(12.0c3)
//   4) 交換後の関連ライン再観測(after_swap check)は、それ自体が新しいepoch
//      の最初の観測として、policy側のepoch追跡状態にも明示的に登録する。(12.0c3)
//   5) bounded committed-history(12.0c6, active_reverse_risk案): kept_unchanged
//      またはkept_improvedとして確定したpairを最大5件、FIFOで記憶し、同じpairの
//      再適用(reverse swap cycle)を候補段階で拒否する。kept_improvedが起きると
//      履歴全体をclearして今回pairだけを残す(strict improvementを探索局面の
//      更新境界とする)。新しいcommitted pairのいずれかのセルへ既存entryの
//      セルが触れていた場合、そのentryは(outcome確定後に)無効化する。
//      worsenedしてUndoされたpairはcommitted-historyへは一切触れない
//      (recentlyUndoneの既存規約に完全に任せる)。
//
// このファイルはcognitiveStateのpublic APIだけを使い、
// adapter/engine/internal/fixture/filesystemへは一切アクセスしない。
// requireは一切使わない。
//
// forbidden(実装しないこと):
//   - 22セルの全231組生成、movableセルの直積生成
//   - 全pairに対するmap/filter/reduce/sort
//   - considerPairより前のスコア計算
//   - exact line sum / exact deviation / 315との差の計算
//   - fixtureまたは正解情報の利用
//   - 盤面fingerprintや内部状態の保存
//   - 1ターンでの109ライン観測、観測上限の緩和
//   - 全盤面231pairの生成・採点
//   - committed-historyへのboard fingerprint/正解値/正解交換/未観測ライン/
//     全候補採点結果の保存

'use strict';

function qualitativeCost(state){
  if(state.status === 'equal') return 0;
  return state.band === 'large' ? 2 : 1;
}
function pairKey(idA, idB){
  return [idA, idB].sort().join('|');
}

const HISTORY_LIMIT = 20;
const RECENTLY_UNDONE_LIMIT = 5;
const POOL_LIMIT = 12; // up側・down側それぞれの保持上限(FIFO)
const COMMITTED_HISTORY_CAPACITY = 5; // bounded committed-history(12.0c6)

function pushBounded(pool, item, limit){
  pool.push(item);
  if(pool.length > limit) pool.shift(); // 古い方から捨てる
}

function createCautiousReasonerPolicy(){
  return {
    id: 'cautious_reasoner',
    run(cognitiveState, _ctx){
      runCautiousReasoner(cognitiveState);
    },
  };
}

function runCautiousReasoner(cognitiveState){
  const limits = cognitiveState.limits;
  const maxCandidatesPerTurn = Math.min(3, limits.candidate_pairs_per_turn);
  const maxObservePerTurn = limits.lines_observed_per_turn;
  const lines = cognitiveState.getLines(); // 公開トポロジー固定順(109本)
  const movableIds = new Set(cognitiveState.getMovableCells().map(c => c.id));

  // history: 実行済みpair・交換後の公開結果分類・Undo済みpairだけを保持する。
  // 盤面fingerprintや内部状態は一切保存しない。保存量には明示的上限。
  const history = [];
  const recentlyUndone = [];
  function pushHistory(entry){ history.push(entry); if(history.length > HISTORY_LIMIT) history.shift(); }
  function markUndone(key){ recentlyUndone.push(key); if(recentlyUndone.length > RECENTLY_UNDONE_LIMIT) recentlyUndone.shift(); }
  function isRecentlyUndone(key){ return recentlyUndone.includes(key); }

  // ------------------------------------------------------------
  // bounded committed-history(12.0c6): {a, b, key, outcome, order}の配列。
  // 盤面fingerprintは保持しない。normalized pair key + outcome + 追加順だけ。
  // ------------------------------------------------------------
  const committedHistory = [];
  let committedOrderCounter = 0;

  function isCommitted(key){
    return committedHistory.some(e => e.key === key);
  }

  // endpoint一致(セルID単位)で既存entryを無効化する。
  // outcome確定後にのみ呼び出すこと(swap実行前や、worsened+Undoの場合には呼ばない)。
  function invalidateOverlapping(cellA, cellB){
    for(let i = committedHistory.length - 1; i >= 0; i--){
      const e = committedHistory[i];
      if(e.a === cellA || e.a === cellB || e.b === cellA || e.b === cellB){
        committedHistory.splice(i, 1);
      }
    }
  }

  function commitKeptUnchanged(cellA, cellB){
    // 1) 今回pairのendpointへ触れる既存entryを無効化
    invalidateOverlapping(cellA, cellB);
    // 2) 今回pairを末尾へ追加
    committedOrderCounter++;
    committedHistory.push({ a: cellA, b: cellB, key: pairKey(cellA, cellB), outcome: 'kept_unchanged', order: committedOrderCounter });
    // 3) capacity超過時のみ最古entryを削除(FIFO)
    if(committedHistory.length > COMMITTED_HISTORY_CAPACITY) committedHistory.shift();
  }

  function commitKeptImproved(cellA, cellB){
    // 1) 履歴全体をclear
    committedHistory.length = 0;
    // 2) 今回pairだけを追加
    committedOrderCounter++;
    committedHistory.push({ a: cellA, b: cellB, key: pairKey(cellA, cellB), outcome: 'kept_improved', order: committedOrderCounter });
  }
  // worsened_then_undoの場合はcommitted-historyへ一切触れない(呼び出し元で何も呼ばない)。

  // ------------------------------------------------------------
  // epochコンテキスト: 「最後の盤面変更以降」に持ち越せる情報一式。
  // 盤面変更(executeSwap/executeUndo)のたびにfreshEpochContext()で
  // 明示的に作り直す。continue_scanでは作り直さない(維持する)。
  // ------------------------------------------------------------
  function freshEpochContext(){
    return {
      upPool: [],
      downPool: [],
      skipSet: new Set(),          // このepoch内で既に判定済みのpair key
      observedLineIdsThisEpoch: new Set(), // 二重観測を避けるための追跡集合
      cursor: 0,                    // 固定順走査カーソル(このepoch内)
    };
  }
  function markObservedInEpoch(epoch, lineId){
    epoch.observedLineIdsThisEpoch.add(lineId);
  }
  function isEpochComplete(epoch){
    return epoch.observedLineIdsThisEpoch.size >= lines.length;
  }

  // ------------------------------------------------------------
  // pairing_fix: upPool先頭を固定してdownPoolを一巡させる。
  // recentlyUndone・committed-history該当・同一epoch内skipSet該当なら、
  // down要素を末尾へrotateして捨てない。downPoolを一巡しても有効pairが
  // 無い場合だけup先頭を破棄する。有効pair具体化時だけ両要素をpoolから消費する。
  // ------------------------------------------------------------
  function tryFormCandidates(upPool, downPool, skipSet, maxCandidates){
    const candidates = [];
    while(upPool.length > 0 && downPool.length > 0 && candidates.length < maxCandidates){
      const u = upPool[0]; // 覗くだけ、まだ消費しない
      const rotations = downPool.length; // 1つのup要素につき最大downPool.size回
      let matched = false;
      let quotaExceeded = false;
      for(let i = 0; i < rotations; i++){
        const d = downPool[0];
        const key = pairKey(u.cellId, d.cellId);
        if(skipSet.has(key) || isRecentlyUndone(key) || isCommitted(key) || u.cellId === d.cellId){
          // 捨てずに末尾へrotate。同一epoch内で再検討しないようskipSetへ記録。
          // (committed-history照合だけではconsiderPair quotaを消費しない)
          downPool.push(downPool.shift());
          skipSet.add(key);
          continue;
        }
        // 有効pair -> ここで初めて両要素をpoolから消費する
        upPool.shift();
        downPool.shift();
        try {
          cognitiveState.considerPair(u.cellId, d.cellId); // ← 具体化直後、比較より前
          candidates.push({
            idA: u.cellId, idB: d.cellId,
            upLineId: u.lineId, downLineId: d.lineId,
            upBand: u.band, downBand: d.band,
          });
        } catch(err){
          quotaExceeded = true; // candidate_pairs_per_turnのquotaを使い切った
        }
        matched = true;
        break;
      }
      if(quotaExceeded) break; // このターンの具体化を打ち切る
      if(!matched){
        // downPoolを一巡しても有効pairが無かった -> up先頭を諦めて破棄
        upPool.shift();
      }
    }
    return candidates;
  }

  // ------------------------------------------------------------
  // 1ターン分の観測: 固定順で、まだこのepochで観測していないラインだけを
  // 対象に、最大maxObservePerTurn本まで観測する(quota厳守)。
  // ------------------------------------------------------------
  function observeOneTurn(epoch){
    let observedThisTurn = 0;
    while(observedThisTurn < maxObservePerTurn && epoch.cursor < lines.length){
      const line = lines[epoch.cursor];
      if(epoch.observedLineIdsThisEpoch.has(line.id)){
        epoch.cursor++; // 既に観測済み(このepoch内、交換後の再観測分も含む)なので飛ばす
        continue;
      }
      let state;
      try {
        state = cognitiveState.observeLine(line.id);
      } catch(err){
        break; // 観測quotaを使い切った
      }
      epoch.cursor++;
      observedThisTurn++;
      markObservedInEpoch(epoch, line.id);

      if(state.status === 'equal') continue;

      const members = line.cells
        .map(c => `${c.z}-${c.y}-${c.x}`)
        .filter(id => movableIds.has(id));

      for(const cellId of members){
        if(state.status === 'up') pushBounded(epoch.upPool, { cellId, lineId: line.id, band: state.band }, POOL_LIMIT);
        else pushBounded(epoch.downPool, { cellId, lineId: line.id, band: state.band }, POOL_LIMIT);
      }
    }
  }

  // ------------------------------------------------------------
  // メインループ: epochコンテキストは、盤面変更(executeSwap/executeUndo)の
  // 直後だけ明示的に作り直す。continue_scanやkept判定では維持する。
  // ------------------------------------------------------------
  let epoch = freshEpochContext();

  while(true){
    if(cognitiveState.getFinalClassification()) return;
    if(cognitiveState.getStatus() !== 'active') return;

    observeOneTurn(epoch);
    const epochComplete = isEpochComplete(epoch);
    const candidates = tryFormCandidates(epoch.upPool, epoch.downPool, epoch.skipSet, maxCandidatesPerTurn);

    if(candidates.length === 0){
      if(!epochComplete){
        try {
          cognitiveState.executeContinueScan();
        } catch(err){
          // continue_scanの前提条件を満たせない場合(理論上は稀)は、
          // 安全側でこのままdeclareStuckを試みる(epoch完了扱いに委ねる)。
        }
        continue; // 同じepochコンテキストのまま次のターンへ
      }
      cognitiveState.executeDeclareStuck();
      return;
    }

    // ------------------------------------------------------------
    // 決定: considerPair済みの候補だけから選ぶ。
    // band(公開情報)の合計が大きいものを優先し、同点はid安定順。
    // ------------------------------------------------------------
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

    // ------------------------------------------------------------
    // 実行: 未実行結果のpreviewではなく、実際にswapを行った上での確認。
    // executeSwapは盤面変更としてscan epochをリセットする(cognitiveState側)。
    // (critical_semantics: overlapping無効化はswap実行前には一切行わない)
    // ------------------------------------------------------------
    cognitiveState.executeSwap(
      chosen.idA, chosen.idB, 'deduction',
      `up_${chosen.upBand}_vs_down_${chosen.downBand}`
    );

    if(cognitiveState.getFinalClassification()){
      return; // cleared/limit/loopのいずれかで既に終了
    }

    // 盤面変更が起きたので、policy側のepochコンテキストも作り直す。
    epoch = freshEpochContext();

    // after_swap: 交換前に観測した関連ラインだけを再観測する。
    // これは新しいepochの最初の観測であり、必ずepoch追跡集合へ登録する
    // (これを怠ると直後の固定順走査が同じラインを二重にobserveLineしてしまう)。
    const afterUpState = cognitiveState.observeLine(chosen.upLineId);
    markObservedInEpoch(epoch, chosen.upLineId);
    const afterDownState = cognitiveState.observeLine(chosen.downLineId);
    markObservedInEpoch(epoch, chosen.downLineId);
    const afterCost = qualitativeCost(afterUpState) + qualitativeCost(afterDownState);

    if(afterCost < beforeCost){
      pushHistory({ pairKey: chosenKey, outcome: 'kept_improved' });
      // outcome確定後にcommitted-historyを更新(strict improvement -> 全体reset)
      commitKeptImproved(chosen.idA, chosen.idB);
      // 盤面変更はこれ以上起きていないため、同じepochコンテキストのまま続行する。
    } else if(afterCost === beforeCost){
      pushHistory({ pairKey: chosenKey, outcome: 'kept_unchanged' });
      // outcome確定後にcommitted-historyを更新(overlapping無効化 -> 追加)
      commitKeptUnchanged(chosen.idA, chosen.idB);
    } else {
      cognitiveState.executeUndo(); // 盤面変更 → scan epochが再度リセットされる
      pushHistory({ pairKey: chosenKey, outcome: 'undone' });
      markUndone(chosenKey);
      // worsened_then_undo: committed-historyには一切触れない(既存entryも無効化しない)。
      epoch = freshEpochContext(); // Undoも盤面変更なので、epochコンテキストを作り直す
    }
  }
}

module.exports = { createCautiousReasonerPolicy };
