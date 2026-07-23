// audit/static-policy-lint.js
//
// policies/配下(および任意で指定したファイル)のソースを静的に走査し、
// 以下を検出する:
//   - internal/ への直接require(相対パス表記のバリエーションを含む)
//   - 動的require(変数・文字列結合によるrequire呼び出し)
//   - 危険なNode.js組み込みモジュール(fs, child_process, module, vm, path経由でのinternal到達)
//
// 【重要な限定事項】
// これは静的な文字列/AST的パターン検査であり、悪意あるコードに対する
// セキュリティ境界(サンドボックス)ではない。同一Node.jsプロセス内で実行する
// 限り、意図的に難読化されたコード(例: eval、Function constructor、
// 文字列を1文字ずつ結合したrequire名など)を完全に検出することは保証しない。
// ここで保証できるのは「信頼済みpolicyの誤実装・不注意な直接参照」の検出のみ。

'use strict';

const fs = require('fs');

const FORBIDDEN_BUILTINS = ['fs', 'child_process', 'module', 'vm', 'worker_threads', 'inspector'];

function lintSource(source, filename){
  const violations = [];

  // 1. internal/ への直接require (相対パスの ../internal, ./internal, ../../internal 等)
  const internalRequireRe = /require\(\s*(['"])(?:\.\.\/|\.\/)*internal(?:\/[^'"]*)?\1\s*\)/g;
  if(internalRequireRe.test(source)){
    violations.push({ rule: 'direct_internal_require', detail: 'internal/への直接requireを検出' });
  }

  // 2. 危険な組み込みモジュールのrequire
  for(const mod of FORBIDDEN_BUILTINS){
    const re = new RegExp(`require\\(\\s*(['"])${mod}\\1\\s*\\)`);
    if(re.test(source)){
      violations.push({ rule: 'forbidden_builtin_require', detail: `禁止builtinのrequireを検出: ${mod}` });
    }
  }

  // 3. 動的require(引数がリテラル文字列でない呼び出し)
  //    例: require(somePath), require(a + b), require(`${x}internal`)
  const requireCallRe = /require\(([^)]*)\)/g;
  let m;
  while((m = requireCallRe.exec(source)) !== null){
    const arg = m[1].trim();
    const isPlainStringLiteral = /^(['"])[^'"]*\1$/.test(arg);
    if(!isPlainStringLiteral){
      violations.push({ rule: 'dynamic_require', detail: `動的require(リテラル文字列以外の引数)を検出: require(${arg})` });
    }
  }

  // 4. eval / Function constructor(難読化requireの温床になり得るため注意喚起として検出)
  if(/\beval\s*\(/.test(source)){
    violations.push({ rule: 'eval_usage', detail: 'evalの使用を検出' });
  }
  if(/new\s+Function\s*\(/.test(source)){
    violations.push({ rule: 'function_constructor_usage', detail: 'Function constructorの使用を検出' });
  }

  return violations;
}

function lintFile(filepath){
  const source = fs.readFileSync(filepath, 'utf8');
  return lintSource(source, filepath);
}

function lintDirectory(dirpath){
  const results = {};
  const files = fs.readdirSync(dirpath).filter(f => f.endsWith('.js'));
  for(const f of files){
    const full = require('path').join(dirpath, f);
    const violations = lintFile(full);
    if(violations.length > 0) results[f] = violations;
  }
  return results;
}

module.exports = { lintSource, lintFile, lintDirectory, FORBIDDEN_BUILTINS };
