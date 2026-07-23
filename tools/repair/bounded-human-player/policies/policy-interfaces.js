// policies/policy-interfaces.js
//
// define_interface_only: local_greedy, cautious_reasoner, bounded_probe
//
// この工程(bounded-human-player-12.0a)では自律判断ポリシーを実装しない。
// ここにあるのは「policyはcognitiveStateとctxを受け取りrun()を実装する」という
// 契約(インターフェース)の型だけであり、呼び出すと明示的に未実装エラーを返す。
//
// 12.0bで「単純局所型(local_greedy)」だけを実装する予定。

'use strict';

const { createLocalGreedyPolicy: createRealLocalGreedyPolicy } = require('./local-greedy-policy');
const { createCautiousReasonerPolicy: createRealCautiousReasonerPolicy } = require('./cautious-reasoner-policy');

class NotImplementedError extends Error {
  constructor(policyId){
    super(`policy "${policyId}" はインターフェースのみ定義されており、本体は未実装(12.0aの対象外)`);
    this.name = 'NotImplementedError';
    this.policyId = policyId;
  }
}

/**
 * local_greedy policy (12.0bで実装済み)
 * 実体は ./local-greedy-policy.js を参照。
 */
function createLocalGreedyPolicy(){
  return createRealLocalGreedyPolicy();
}

/**
 * cautious_reasoner policy (12.0cで実装済み)
 * 実体は ./cautious-reasoner-policy.js を参照。
 */
function createCautiousReasonerPolicy(){
  return createRealCautiousReasonerPolicy();
}

/**
 * bounded_probe policy interface (未実装)
 *
 * 想定契約:
 *   run(cognitiveState, ctx)
 *     - probeを積極的に使い、observeLine/recallLineの制限内で
 *       情報獲得を優先する方針を想定
 */
function createBoundedProbePolicy(){
  return {
    id: 'bounded_probe',
    run(_cognitiveState, _ctx){
      throw new NotImplementedError('bounded_probe');
    },
  };
}

module.exports = {
  NotImplementedError,
  createLocalGreedyPolicy,
  createCautiousReasonerPolicy,
  createBoundedProbePolicy,
};
