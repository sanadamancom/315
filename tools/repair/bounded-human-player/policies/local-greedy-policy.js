// policies/local-greedy-policy.js
//
// bounded local_greedy policy。
//
// decision_rule(要約):
//   - 公開トポロジー(getLines()が返す固定順)でラインを逐次観測する。
//   - equalラインは交換候補の材料にしない。
//   - 観測済みup/downラインに属するmovableセルの局所的な組合せから、
//     1ターンにつき最大3組までの候補を具体化する。
//   - 候補を具体化した直後(比較・採点より前)にconsiderPair()を呼ぶ。
//   - considerPair済みの候補だけを比較し、1つをexecuteSwapする。
//   - 候補が1つも作れない場合はdeclare_stuckする。
//   - 同点(bandの合計が同じ)の場合は、pairの正規化id文字列の安定順で決定する。
//   - ランダム分岐は使わない(seed未使用)。probeも使わない。
//
// forbidden(実装しないこと):
//   - 22セルの全231組生成、movableセルの直積生成
//   - 全pairに対するmap/filter/reduce/sort
//   - considerPairより前のスコア計算
//   - 正解データに基づく順序付け
//
// このファイルはcognitiveStateのpublic APIだけを使い、
// adapter/engine/internal/fixture/filesystemへは一切アクセスしない。

'use strict';

function bandRank(band){
  if(band === 'large') return 2;
  if(band === 'small') return 1;
  return 0; // equalラインは候補生成に使わないため通常ここには来ない
}

function pairSortKey(idA, idB){
  return [idA, idB].sort().join('|');
}

function createLocalGreedyPolicy(){
  return {
    id: 'local_greedy',
    run(cognitiveState, _ctx){
      // getLines()/getMovableCells()はmeta情報の一括取得であり、
      // "全movable pairの一括列挙"や"全pairのscore計算"には該当しない
      // (ラインの構造とmovableセルのidを知ること自体は許可された公開情報)。
      const lines = cognitiveState.getLines();
      const movableIds = new Set(cognitiveState.getMovableCells().map(c => c.id));

      const maxCandidatesPerTurn = Math.min(3, cognitiveState.limits.candidate_pairs_per_turn);
      const maxObservePerTurn = cognitiveState.limits.lines_observed_per_turn;

      let nextLineIndex = 0;
      let stuckDeclared = false;

      while(true){
        if(cognitiveState.getFinalClassification()) break;
        if(cognitiveState.getStatus() !== 'active') break;

        // ------------------------------------------------------------
        // 1ターン分の観測: 固定順で最大 maxObservePerTurn 本だけ観測する。
        // ------------------------------------------------------------
        const upPool = [];   // {cellId, band}
        const downPool = []; // {cellId, band}
        const seenCellIds = new Set();
        let observedThisTurn = 0;
        let anyNonEqual = false;

        while(observedThisTurn < maxObservePerTurn){
          const line = lines[nextLineIndex % lines.length];
          nextLineIndex++;
          const state = cognitiveState.observeLine(line.id);
          observedThisTurn++;

          if(state.status === 'equal') continue; // equalラインは候補生成に使わない
          anyNonEqual = true;

          const members = line.cells
            .map(c => `${c.z}-${c.y}-${c.x}`)
            .filter(id => movableIds.has(id) && !seenCellIds.has(id));

          for(const cellId of members){
            seenCellIds.add(cellId);
            if(state.status === 'up') upPool.push({ cellId, band: state.band });
            else downPool.push({ cellId, band: state.band });
          }
        }

        // ------------------------------------------------------------
        // 候補の具体化: up×downの局所組合せを優先し、
        // 足りなければ同方向同士(up×up / down×down)で埋める。
        // 具体化した直後に必ずconsiderPair()を呼ぶ(比較・採点より前)。
        // ------------------------------------------------------------
        const candidates = [];

        function tryFormPair(poolUp, poolDown){
          while(poolUp.length > 0 && poolDown.length > 0 && candidates.length < maxCandidatesPerTurn){
            const a = poolUp.shift();
            const b = poolDown.shift();
            cognitiveState.considerPair(a.cellId, b.cellId); // ← 具体化直後、比較より前
            candidates.push({
              idA: a.cellId,
              idB: b.cellId,
              reasonCode: `up_${a.band}_vs_down_${b.band}`,
              scoreForTieBreakOnly: bandRank(a.band) + bandRank(b.band),
            });
          }
        }

        function tryFormPairsWithinSamePool(pool, isUp){
          while(pool.length >= 2 && candidates.length < maxCandidatesPerTurn){
            const a = pool.shift();
            const b = pool.shift();
            cognitiveState.considerPair(a.cellId, b.cellId); // ← 具体化直後、比較より前
            candidates.push({
              idA: a.cellId,
              idB: b.cellId,
              reasonCode: `${isUp ? 'up' : 'down'}_${a.band}_vs_${isUp ? 'up' : 'down'}_${b.band}`,
              scoreForTieBreakOnly: bandRank(a.band) + bandRank(b.band),
            });
          }
        }

        tryFormPair(upPool, downPool);
        if(candidates.length < maxCandidatesPerTurn) tryFormPairsWithinSamePool(upPool, true);
        if(candidates.length < maxCandidatesPerTurn) tryFormPairsWithinSamePool(downPool, false);

        if(candidates.length === 0){
          // このターンでは非公開データに頼らず候補を作れなかった。
          // (anyNonEqualがfalse、または非equalラインがmovableセルを含んでいなかった場合)
          cognitiveState.executeDeclareStuck();
          stuckDeclared = true;
          break;
        }

        // ------------------------------------------------------------
        // 比較: considerPair済みの候補(最大3件)だけを対象にする。
        // band(公開情報)の合計が大きいものを優先し、
        // 同点なら正規化idの安定順で決定する。
        // ------------------------------------------------------------
        candidates.sort((x, y) => {
          if(y.scoreForTieBreakOnly !== x.scoreForTieBreakOnly){
            return y.scoreForTieBreakOnly - x.scoreForTieBreakOnly;
          }
          const kx = pairSortKey(x.idA, x.idB);
          const ky = pairSortKey(y.idA, y.idB);
          return kx < ky ? -1 : (kx > ky ? 1 : 0);
        });

        const chosen = candidates[0];
        cognitiveState.executeSwap(chosen.idA, chosen.idB, 'deduction', chosen.reasonCode);
      }

      return { stuckDeclared };
    },
  };
}

module.exports = { createLocalGreedyPolicy };
