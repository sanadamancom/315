// tests/boundary-audit.test.js
//
// prototype-12.0a-boundary-audit の required_tests を検証する。
// 実行: node tools/repair/bounded-human-player/tests/boundary-audit.test.js
//
// 【重要】ここで確認しているのは「信頼済みpolicyの誤実装・不注意な
// 非公開情報参照」の検出であり、悪意あるコードに対するセキュリティ境界
// (同一Node.jsプロセス内でのサンドボックス化)ではない。

'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { createPublicObservationAdapter } = require('../public-observation-adapter');
const { createCognitiveState, CognitiveLimitViolation } = require('../cognitive-state');
const { runPolicy } = require('../deterministic-runner');
const { lintFile, lintDirectory } = require('../audit/static-policy-lint');

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
// listAvailableActionsは全pairを列挙しない
// ============================================================
check('listAvailableActionsは全pairを列挙しない', () => {
  const adapter = createPublicObservationAdapter({});
  const actions = adapter.listAvailableActions();
  assert.ok(Array.isArray(actions));
  // schemaを報告用に記録: すべて文字列(action種別)であり、座標やペアを含まない
  for(const a of actions){
    assert.strictEqual(typeof a, 'string', 'listAvailableActionsの各要素は文字列(action種別)のはず');
    assert.ok(!a.includes('-'), 'action文字列に座標らしきハイフン区切りが含まれていない'); // "0-0-0"のような座標idが混入していないこと
  }
  const actionsStr = JSON.stringify(actions);
  // 22セルの座標id形式(z-y-x)がどこにも含まれていないこと
  for(let z=0; z<5; z++) for(let y=0; y<5; y++) for(let x=0; x<5; x++){
    assert.ok(!actionsStr.includes(`${z}-${y}-${x}`));
  }
});

// ============================================================
// considerPairを通さないswap提案をrunnerが拒否
// ============================================================
check('considerPairを通さないswap提案をrunnerが拒否', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  const cells = adapter.getMovableCells();
  assert.throws(
    () => cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction'),
    CognitiveLimitViolation,
    'considerPairを経ていないpairはexecuteSwapで拒否されるはず'
  );
  // considerPairしたペアと異なるペアを提出しても拒否されること
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  assert.throws(
    () => cognitiveState.executeSwap(cells[2].id, cells[3].id, 'deduction'),
    CognitiveLimitViolation,
    'considerPairしていない別のpairはexecuteSwapで拒否されるはず'
  );
  // considerPair済みのペアなら通ること
  assert.doesNotThrow(() => cognitiveState.executeSwap(cells[0].id, cells[1].id, 'deduction'));
});

// ============================================================
// candidate_pairs_per_turn超過を拒否(再確認)
// ============================================================
check('candidate_pairs_per_turn超過を拒否(再確認)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { candidate_pairs_per_turn: 1 });
  const cells = adapter.getMovableCells();
  cognitiveState.considerPair(cells[0].id, cells[1].id);
  assert.throws(() => cognitiveState.considerPair(cells[2].id, cells[3].id), CognitiveLimitViolation);
});

// ============================================================
// 22セル一覧からpolicyが全pairを局所生成しても、実行はconsiderPair上限で拒否される
// (getMovableCells自体は禁止されないが、それを使った一括提出は防がれることを確認)
// ============================================================
check('getMovableCellsから局所生成した全231pairはconsiderPair上限で拒否される', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, { candidate_pairs_per_turn: 6 });
  const cells = adapter.getMovableCells();
  const allPairs = [];
  for(let i=0;i<cells.length;i++) for(let j=i+1;j<cells.length;j++) allPairs.push([cells[i].id, cells[j].id]);
  assert.strictEqual(allPairs.length, 231, 'C(22,2)=231のはず(policy側ローカル計算そのものは止められない)');
  let consideredOk = 0;
  let blocked = false;
  for(const [a,b] of allPairs){
    try { cognitiveState.considerPair(a,b); consideredOk++; }
    catch(e){ assert.ok(e instanceof CognitiveLimitViolation); blocked = true; break; }
  }
  assert.strictEqual(consideredOk, 6, 'considerPairは上限6件までしか通らないはず');
  assert.ok(blocked, '7件目以降はCognitiveLimitViolationで止まるはず');
});

// ============================================================
// cognitiveStateからadapter/engine/internalへ到達不能
// ============================================================
check('cognitiveStateからadapter/engine/internalへ到達不能', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});

  // (a) own property名にadapter/engine/internal/fixtureが無いこと
  const ownProps = Object.getOwnPropertyNames(cognitiveState);
  const forbiddenNames = ['adapter','engine','fixture','cube_data','movablemap','board'];
  for(const p of ownProps){
    for(const f of forbiddenNames){
      assert.ok(!p.toLowerCase().includes(f), `プロパティ名 ${p} が内部参照らしき名前を含む`);
    }
  }

  // (b) prototype chainがObject.prototypeのみであること(独自classでない = 追加の隠しプロパティ経路が無い)
  const proto = Object.getPrototypeOf(cognitiveState);
  assert.strictEqual(proto, Object.prototype, 'cognitiveStateはObject.freeze({...})によるplain objectのはず');

  // (c) 各関数プロパティ自身にも内部参照を示す独自プロパティが付与されていないこと
  for(const p of ownProps){
    const v = cognitiveState[p];
    if(typeof v === 'function'){
      const fnOwnProps = Object.getOwnPropertyNames(v).filter(k => !['length','name','prototype'].includes(k));
      assert.strictEqual(fnOwnProps.length, 0, `関数 ${p} に想定外の独自プロパティがある: ${fnOwnProps}`);
    }
  }

  // (d) Object.freezeされているため、新規プロパティの追加や既存メソッドの上書きができない
  //     (これによりモンキーパッチでadapterを盗み出す/差し替える経路がないことを保証)
  assert.ok(Object.isFrozen(cognitiveState), 'cognitiveStateはfreezeされているはず');
  const before = cognitiveState.getStatus;
  try { cognitiveState.getStatus = () => 'hacked'; } catch(e) { /* strict modeなら例外、非strictなら無視 */ }
  assert.strictEqual(cognitiveState.getStatus, before, 'freezeされているため上書きできないはず');

  // (e) adapter自体も同様にfreezeされ、内部engineへの参照を外部プロパティとして持たない
  const adapterOwnProps = Object.getOwnPropertyNames(adapter);
  for(const p of adapterOwnProps){
    for(const f of ['engine','fixture','cube_data','movablemap','board']){
      assert.ok(!p.toLowerCase().includes(f));
    }
  }
  assert.ok(Object.isFrozen(adapter), 'adapterはfreezeされているはず');
});

// ============================================================
// public返却値のmutationで内部状態が変化しない
// ============================================================
check('public返却値のmutationで内部状態が変化しない', () => {
  const adapter = createPublicObservationAdapter({});
  const cells1 = adapter.getMovableCells();
  const originalValue = cells1[0].value;
  cells1[0].value = 999999; // 返却値を破壊的に変更
  cells1.push({ id: 'fake', z: 9, y: 9, x: 9, value: 1 }); // 配列自体も破壊

  const cells2 = adapter.getMovableCells();
  assert.strictEqual(cells2.length, 22, '内部のmovableセル数は変化しない');
  assert.strictEqual(cells2[0].value, originalValue, '内部の値は外部からのmutationで変化しない');
  assert.ok(!cells2.some(c => c.id === 'fake'), '外部からの配列pushは内部へ反映されない');

  const lines1 = adapter.getLines();
  lines1[0].cells[0].z = 999;
  lines1[0].type = 'hacked';
  const lines2 = adapter.getLines();
  assert.notStrictEqual(lines2[0].cells[0].z, 999);
  assert.notStrictEqual(lines2[0].type, 'hacked');
});

// ============================================================
// directおよびdynamic internal importを検出
// ============================================================
check('directおよびdynamic internal importを検出', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'violating-policy-example.js');
  const violations = lintFile(fixturePath);
  const rules = violations.map(v => v.rule);
  assert.ok(rules.includes('direct_internal_require'), 'internal/への直接requireを検出するはず');
  assert.ok(rules.includes('dynamic_require'), '動的requireを検出するはず');
  assert.ok(rules.includes('forbidden_builtin_require'), '禁止builtin(fs)のrequireを検出するはず');
  assert.ok(rules.includes('eval_usage'), 'evalの使用を検出するはず');
});

// ============================================================
// 禁止builtin利用policyを検出(実在のpolicies/配下は違反しないことも確認)
// ============================================================
check('禁止builtin利用policyを検出/実在policiesはクリーンであること', () => {
  const policiesDir = path.join(__dirname, '..', 'policies');
  const results = lintDirectory(policiesDir);
  const violatingFiles = Object.keys(results);
  assert.strictEqual(violatingFiles.length, 0, `実在policiesに違反がある: ${JSON.stringify(results)}`);

  // フィクスチャ単体を対象にした場合は違反が検出されること(lintDirectoryでも動作することを確認)
  const fixturesDir = path.join(__dirname, 'fixtures');
  const fixtureResults = lintDirectory(fixturesDir);
  assert.ok(fixtureResults['violating-policy-example.js'], 'フィクスチャは違反として検出されるはず');
  assert.ok(fixtureResults['violating-policy-example.js'].length >= 3);
});

// ============================================================
// 未実行swap結果を取得不能
// ============================================================
check('未実行swap結果を取得不能(previewSwap以外の経路も含む)', () => {
  const adapter = createPublicObservationAdapter({});
  const cognitiveState = createCognitiveState(adapter, {});
  // previewSwap自体
  assert.throws(() => cognitiveState.previewSwap('0-0-0','0-0-1'), CognitiveLimitViolation);
  // adapter/cognitiveStateに「シミュレーション」「プレビュー」系の別名メソッドが存在しないこと
  const suspiciousNames = ['simulate','preview','dryRun','wouldResultIn','peekSwap','tryLineState'];
  for(const obj of [adapter, cognitiveState]){
    const props = Object.getOwnPropertyNames(obj);
    for(const p of props){
      for(const s of suspiciousNames){
        if(p.toLowerCase().includes(s.toLowerCase()) && p !== 'previewSwap'){
          assert.fail(`未実行swapのプレビューらしきメソッドが存在する: ${p}`);
        }
      }
    }
  }
  // getLineStateは常に「現在の実盤面」に基づく値であり、引数でswap前後を選べない
  assert.strictEqual(adapter.getLineState.length, 1, 'getLineStateはlineIdのみを引数に取り、仮想状態指定はできない');
});

// ============================================================
// seed使用時の決定性とseed差を確認
// ============================================================
check('seed使用時の決定性とseed差を確認(seedを実際に使う監査用policyで検証)', () => {
  // 簡易mulberry32 PRNG。ctx.randomSeedから分岐する監査用policy。
  function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeSeedSensitivePolicy(){
    return {
      id: 'seed_sensitive_audit_policy',
      run(cognitiveState, ctx){
        const rnd = mulberry32(ctx.randomSeed);
        const cells = cognitiveState.getMovableCells();
        // seedに応じて検討順序を変える(自律的な「良い手の選択」はしない。順序決定だけにseedを使う)
        const order = cells.map((c,i) => i).sort(() => rnd() - 0.5);
        const idA = cells[order[0]].id;
        const idB = cells[order[1]].id;
        cognitiveState.considerPair(idA, idB);
        cognitiveState.executeSwap(idA, idB, 'deduction');
      },
    };
  }

  const r1a = runPolicy({ policyId:'seed_sensitive_audit_policy', policy: makeSeedSensitivePolicy(), randomSeed: 111, cognitiveLimits:{}, puzzleFixture:'prototype11-seed7' });
  const r1b = runPolicy({ policyId:'seed_sensitive_audit_policy', policy: makeSeedSensitivePolicy(), randomSeed: 111, cognitiveLimits:{}, puzzleFixture:'prototype11-seed7' });
  assert.deepStrictEqual(r1a, r1b, '同一seedなら同一policyで完全一致するはず');

  const r2 = runPolicy({ policyId:'seed_sensitive_audit_policy', policy: makeSeedSensitivePolicy(), randomSeed: 222, cognitiveLimits:{}, puzzleFixture:'prototype11-seed7' });
  const pairA = r1a.observation_trace.find(t => t.kind === 'swap').pair;
  const pairB = r2.observation_trace.find(t => t.kind === 'swap').pair;
  assert.notDeepStrictEqual(pairA, pairB, '異なるseedなら(このpolicyでは)選ばれるpairが変わるはず — seedが実際に分岐へ使われている証拠');

  // 参考情報: scripted_replayはseedを一切使わない。これを虚偽表示しないよう明記する。
  console.log('      [note] scripted_replay policyはrandomSeedを使用しない(完全固定scriptの再生のため)。');
});

// ============================================================
// Date/Math.randomがtraceへ影響しないことの確認(ソース走査)
// ============================================================
check('Date.now/Math.randomがdeterministic-runnerのtrace生成に使われていない', () => {
  function stripComments(src){
    // 簡易的にコメント行(// ...)とブロックコメント(/* ... */)を除去してから検査する。
    // 目的はドキュメント上の言及と実コードでの呼び出しを区別すること。
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  const runnerSrc = stripComments(fs.readFileSync(path.join(__dirname, '..', 'deterministic-runner.js'), 'utf8'));
  assert.ok(!runnerSrc.includes('Date.now'), 'deterministic-runner.jsの実コードがDate.now()を呼び出していないこと');
  assert.ok(!runnerSrc.includes('new Date'), 'deterministic-runner.jsの実コードがnew Date()を呼び出していないこと');
  assert.ok(!runnerSrc.includes('Math.random'), 'deterministic-runner.jsの実コードがMath.random()を直接呼び出していないこと(乱数はpolicy側がseedから生成する)');

  const cogSrc = stripComments(fs.readFileSync(path.join(__dirname, '..', 'cognitive-state.js'), 'utf8'));
  assert.ok(!cogSrc.includes('Date.now') && !cogSrc.includes('Math.random'));

  const adapterSrc = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public-observation-adapter.js'), 'utf8'));
  assert.ok(!adapterSrc.includes('Date.now') && !adapterSrc.includes('Math.random'));
});

// ============================================================
// 証拠4ファイル不変
// ============================================================
check('証拠4ファイル不変(11.0/11.1/11.2 HTML + session JSON)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const expectedHashes = {
    'prototype11.html': '05cfa1496bdefcdab75a2f35e7cb35a9a1aa198639fe44119e8bf8752fa48fdc',
    'prototype11-access.html': '9313dc6f4d5047c0a4af274bf7676d79f46e9a592eda6624fe344a52622aeba6',
    'prototype11-lite.html': '7bbd8ac7590d8e7285040f1abf3ac76dd93ebc7866ef0dd3ab4f614d8b4e67e8',
  };
  for(const [name, expected] of Object.entries(expectedHashes)){
    const data = fs.readFileSync(path.join(repoRoot, name));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    assert.strictEqual(hash, expected, `${name}のSHA-256が変化している`);
  }
  const evidenceLog = '/home/claude/evidence/prototype11.0-session-log.jsonl';
  const logHash = crypto.createHash('sha256').update(fs.readFileSync(evidenceLog)).digest('hex');
  assert.strictEqual(logHash, 'a2574f65bdc1173718845e80235d103435aecb39725433a8ce26ce4851f5c471');
});

// ============================================================
// 既存16テスト全合格(サブプロセスで再実行)
// ============================================================
check('既存16テスト全合格', () => {
  const { execFileSync } = require('child_process');
  const existingTestPath = path.join(__dirname, 'bounded-human-player.test.js');
  const out = execFileSync(process.execPath, [existingTestPath], { encoding: 'utf8' });
  assert.ok(out.includes('16 passed, 0 failed'), `既存テストが全合格していない:\n${out}`);
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
