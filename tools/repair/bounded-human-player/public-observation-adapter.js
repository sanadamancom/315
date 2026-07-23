// public-observation-adapter.js
//
// policy層(および認知制限レイヤー)が触れてよい唯一の窓口。
// 内部エンジン(internal/puzzle-engine.js, internal/prototype-fixture.js)への
// 参照はこのモジュールの外へは一切渡さない。
//
// expose_only:
//   - movableセルの座標と現在の表示値
//   - 各公開ラインのIDと種別
//   - 各公開ラインの状態: equal_or_up_or_down (+ 偏差帯)
//   - 現在選択可能な操作
//   - swap回数 / probe使用回数 / Undo可能か
//
// never_expose:
//   - line_sum / exact_deviation
//   - 正規CUBE_DATAとのセル単位比較(cell_correctness)
//   - cycle_group / decoy_flag
//   - solution_pair / solution_path / minimum_moves
//   - 未実行swapの結果(プレビュー・シミュレーション)

'use strict';

const { createPuzzleEngine, cellKey } = require('./internal/puzzle-engine');

const PROBE_HARD_CAP_DEFAULT = 2; // adapter自体は「利用可能か」の判定材料としてのみ使う

function createPublicObservationAdapter(options){
  const opts = options || {};
  const probeLimit = typeof opts.probeLimit === 'number' ? opts.probeLimit : PROBE_HARD_CAP_DEFAULT;

  const engine = createPuzzleEngine(); // ← internal参照はここだけに閉じ込める

  function getMovableCells(){
    return [...engine.movableMap.entries()].map(([key, m]) => ({
      id: key,
      z: m.coord.z, y: m.coord.y, x: m.coord.x,
      value: engine.boardValue(m.coord.z, m.coord.y, m.coord.x),
    }));
  }

  function getLines(){
    return engine.lines.map(l => ({ id: l.id, type: l.type, cells: l.cells.map(c => ({...c})) }));
  }

  function getLineState(lineId){
    if(!engine.linesById.has(lineId)) throw new Error(`unknown line id: ${lineId}`);
    const st = engine.lineStatus(lineId); // {status, band} のみ。合計・厳密偏差は含まない
    return { id: lineId, status: st.status, band: st.band };
  }

  function getSwapCount(){ return engine.getSwapCount(); }
  function getProbeCount(){ return engine.getProbeCount(); }
  function canUndo(){ return engine.canUndo(); }
  function getStatus(){ return engine.getStatus(); }

  function listAvailableActions(){
    const actions = [];
    if(engine.getStatus() === 'active'){
      actions.push('swap');
      if(engine.getProbeCount() < probeLimit) actions.push('probe_swap');
      if(engine.canUndo()) actions.push('undo');
      actions.push('reset');
      actions.push('declare_stuck');
    }
    return actions;
  }

  function applySwap(idA, idB, meta){
    if(engine.getStatus() !== 'active') throw new Error('active状態でのみswap可能');
    const declaredActionType = meta && meta.declaredActionType;
    if(declaredActionType !== 'deduction' && declaredActionType !== 'probe'){
      throw new Error('declaredActionTypeはdeductionまたはprobeが必須');
    }
    if(declaredActionType === 'probe' && engine.getProbeCount() >= probeLimit){
      throw new Error('probe上限に達しているため実行できない');
    }
    engine.applySwap(idA, idB);
    if(declaredActionType === 'probe') engine.registerProbe();
    return {
      success: true,
      status: engine.getStatus(), // 'active' | 'cleared' | 'stuck' — これは合否ではなく進行状態
      swapCount: engine.getSwapCount(),
      probeCount: engine.getProbeCount(),
    };
  }

  function applyUndo(){
    engine.applyUndo();
    return { success: true, swapCount: engine.getSwapCount() };
  }

  function declareStuck(){
    engine.declareStuck();
    return { success: true, status: engine.getStatus() };
  }

  // ------------------------------------------------------------
  // 内部専用: loop検知のためだけにcognitive-state層へ「不透明なハッシュ文字列」を渡す。
  // 盤面の値そのものではなく比較専用の識別子として扱うことを想定しているが、
  // 念のためadapterの公開APIとしては極力最小の関数名に留める。
  // ------------------------------------------------------------
  function _internalStateFingerprint(){
    return engine.boardStateHash();
  }

  return Object.freeze({
    getMovableCells,
    getLines,
    getLineState,
    getSwapCount,
    getProbeCount,
    canUndo,
    getStatus,
    listAvailableActions,
    applySwap,
    applyUndo,
    declareStuck,
    _internalStateFingerprint,
  });
}

module.exports = { createPublicObservationAdapter };
