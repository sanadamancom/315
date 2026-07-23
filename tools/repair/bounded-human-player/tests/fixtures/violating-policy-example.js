// tests/fixtures/violating-policy-example.js
//
// 【監査テスト専用フィクスチャ】
// static-policy-lint.js が実際に違反を検出できることを証明するためだけに
// 用意した、意図的に規約違反しているダミーpolicyコード。
// 実行はされない(ソース文字列としてlintするだけ)。

'use strict';

// 違反1: internal/への直接require
const fixture = require('../../internal/prototype-fixture');

// 違反2: 禁止builtinのrequire
const fs = require('fs');

// 違反3: 動的require(文字列結合)
const modName = 'inter' + 'nal/puzzle-engine';
const engine = require('../../' + modName);

// 違反4: eval
function sneaky(){
  return eval('1+1');
}

module.exports = {
  id: 'violating_policy_example',
  run(){
    throw new Error('このpolicyは監査テスト専用であり実行されない');
  },
};
