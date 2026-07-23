// policies/scripted-replay-policy.js
//
// Prototype 11.0の人間プレイセッション(保全済みevidence)から抽出した
// 「公開操作列」(選択pair・action_type自己申告・Undo・stuck)を、
// 指定された順序どおりに再生するだけのpolicy。
//
// restriction: 自律的な候補生成や交換選択を行わない。
//   - scriptに書かれた通りの手順を、書かれた通りの順序で実行するだけ。
//   - script自体はこのファイルの外(呼び出し側)から渡される。
//   - このpolicyが独自にpairを選んだり、action_typeを判断することはない。

'use strict';

function cellKey(z,y,x){ return `${z}-${y}-${x}`; }

// Prototype 11.0 (prototype11.html) セッションログ(保全済みevidence)から
// 機械的に抽出した公開操作列。ここに含まれるのは
// 「選択pairの座標」「action_typeの自己申告(すべてdeduction)」「undo」「stuck」のみ。
// reason/considered_pair_count/learned_from_changeなどの自由記述・内面情報は
// prototype11_log_use.forbidden範囲外の情報であり、ここでは一切使用しない。
const PROTOTYPE_11_0_SCRIPT = [
  { type: 'swap', pairCoords: [{z:4,y:0,x:3}, {z:0,y:0,x:2}], declaredActionType: 'deduction' },
  { type: 'swap', pairCoords: [{z:0,y:0,x:2}, {z:1,y:3,x:3}], declaredActionType: 'deduction' },
  { type: 'swap', pairCoords: [{z:3,y:3,x:0}, {z:1,y:3,x:4}], declaredActionType: 'deduction' },
  { type: 'swap', pairCoords: [{z:0,y:4,x:3}, {z:3,y:3,x:0}], declaredActionType: 'deduction' },
  { type: 'swap', pairCoords: [{z:4,y:0,x:3}, {z:4,y:1,x:2}], declaredActionType: 'deduction' },
  { type: 'undo' },
  { type: 'declare_stuck' },
];

// 各swapの前に「その2セルが属する行(row)ラインを見る」動作を機械的に添えることで、
// observation adapter / cognitive-state層が正しく機能することを検証する。
// これは自律判断ではなく、scriptに付随する固定の観測手順(再生の一部)。
function observeRowLinesForPair(cognitiveState, pairCoords){
  const seen = new Set();
  for(const c of pairCoords){
    const rowId = `row-${c.z}-${c.y}`;
    if(seen.has(rowId)) continue;
    seen.add(rowId);
    cognitiveState.observeLine(rowId);
  }
}

function createScriptedReplayPolicy(script){
  const steps = script || PROTOTYPE_11_0_SCRIPT;
  return {
    id: 'scripted_replay',
    run(cognitiveState, _ctx){
      for(const step of steps){
        if(step.type === 'swap'){
          const [a, b] = step.pairCoords;
          const idA = cellKey(a.z, a.y, a.x);
          const idB = cellKey(b.z, b.y, b.x);
          observeRowLinesForPair(cognitiveState, step.pairCoords);
          cognitiveState.considerPair(idA, idB);
          cognitiveState.executeSwap(idA, idB, step.declaredActionType, 'scripted_replay_from_prototype_11_0');
        } else if(step.type === 'undo'){
          cognitiveState.executeUndo();
        } else if(step.type === 'declare_stuck'){
          cognitiveState.executeDeclareStuck();
        } else {
          throw new Error(`unknown script step type: ${step.type}`);
        }
      }
    },
  };
}

module.exports = { createScriptedReplayPolicy, PROTOTYPE_11_0_SCRIPT };
