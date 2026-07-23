// tools/repair/tests/production-candidates.test.js
//
// production-candidates-01 の required_tests を検証する。
// 座標・正解値・正解交換はコンソール出力に含めない(件数・真偽値のみ出力)。

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const A = require('../prototype02-analyzer.js');
const { buildLines109, CUBE_DATA } = require('../bounded-human-player/internal/prototype-fixture.js');
const { createPublicObservationAdapter } = require('../bounded-human-player/public-observation-adapter');
const { createCognitiveState } = require('../bounded-human-player/cognitive-state');
const { createLocalGreedyPolicy } = require('../bounded-human-player/policies/local-greedy-policy');
const { runPolicy } = require('../bounded-human-player/deterministic-runner');
const S = require('../search-production-candidates.js');

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

const lines = buildLines109();
const dataPath = path.join(__dirname, '..', 'production-candidates.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// ============================================================
// 探索の決定性(byte一致)
// ============================================================
check('同一seedで探索結果がbyte一致', () => {
  const r1 = S.runAllRoles();
  const r2 = S.runAllRoles();
  const norm = r => JSON.stringify(r.outcomes.map(o => ({ role: o.role, trial: o.trial, evaluated: o.evaluated })));
  assert.strictEqual(norm(r1), norm(r2));
});

check('3問すべてが生成されている', () => {
  assert.strictEqual(data.candidates.length, 3);
  data.candidates.forEach(c => assert.ok(c !== null, `${c && c.publicId}が生成されている`));
});

check('3問が異なる初期盤面を持つ', () => {
  const keysOf = c => new Set(c.cells.map(cell => `${cell.z}-${cell.y}-${cell.x}:${cell.initialValue}`));
  const [a, b, c] = data.candidates.map(keysOf);
  const eq = (s1, s2) => s1.size === s2.size && [...s1].every(v => s2.has(v));
  assert.ok(!eq(a, b) && !eq(b, c) && !eq(a, c), '3問の初期盤面はすべて異なるはず');
});

// ============================================================
// core_invariants(候補ごとに検証)
// ============================================================
for(const candidate of data.candidates){
  check(`${candidate.publicId}: core_invariants`, () => {
    const cells = candidate.cells.map(c => ({
      L: c.z + 1, r: c.y, c: c.x, correctValue: c.correctValue, initialValue: c.initialValue,
    }));

    // 座標の一意性・範囲内
    const seen = new Set();
    for(const cell of cells){
      const key = `${cell.L}-${cell.r}-${cell.c}`;
      assert.ok(!seen.has(key), '座標重複なし');
      seen.add(key);
      assert.ok(cell.L>=1 && cell.L<=5 && cell.r>=0 && cell.r<=4 && cell.c>=0 && cell.c<=4);
    }

    // 完成状態(固定+可動セルの正解値)がcanonical Perfect Magic Cubeと一致し、
    // 109ラインすべて315になることを確認
    const board = A.buildBoard(CUBE_DATA, cells.map(c => ({ ...c, initialValue: c.correctValue })));
    let allEq = true;
    for(const line of lines){ if(A.lineSum(board, line) !== 315) allEq = false; }
    assert.ok(allEq, '完成状態で109ラインすべて315');

    // 1〜125を重複なく使用(完成状態)
    const flat = board.flat(2);
    const uniq = new Set(flat);
    assert.strictEqual(flat.length, 125);
    assert.strictEqual(uniq.size, 125);
    assert.strictEqual(Math.min(...flat), 1);
    assert.strictEqual(Math.max(...flat), 125);

    // 初期状態は未完成(少なくとも1セルはcorrectValue!==initialValue)
    assert.ok(cells.some(c => c.initialValue !== c.correctValue), '初期状態は未完成のはず');

    // 固定セル(候補cells以外の117セル)が正解位置から動いていない
    const fixedCheck = A.validateFixedCellsUnchanged(CUBE_DATA, A.buildBoard(CUBE_DATA, cells), cells);
    assert.ok(fixedCheck.valid, '固定セルは正しい位置から動いていないはず');

    // 315からの単純な1セル逆算だけで連続的に解ける構成の除外
    const direct = A.analyzeDirectSubtraction(CUBE_DATA, lines, cells);
    assert.strictEqual(direct.solvedCellCount, 0, '直接引き算の連鎖だけで解けない構成のはず');

    // 一意解であること(countLineConstrainedSolutions)
    const uniqueness = A.countLineConstrainedSolutions(CUBE_DATA, lines, cells, { maxSolutions: 3 });
    assert.ok(uniqueness.isUnique, '構造上、解が一意であるはず');

    // 初期表示値が可動セル集合内での正解値の順列であること(値の追加・欠落がない)
    const permCheck = A.validateInitialIsPermutationOfCorrect(cells);
    assert.ok(permCheck.isPermutation, '初期表示値は可動セルの正解値集合の順列のはず');

    // singleLineCount(可動セルを1つだけ含むライン)が0本
    const movableIds = new Set(cells.map(c => `${c.L-1}-${c.r}-${c.c}`));
    let singleCount = 0;
    for(const line of lines){
      const cnt = line.cells.filter(cell => movableIds.has(`${cell.z}-${cell.y}-${cell.x}`)).length;
      if(cnt === 1) singleCount++;
    }
    assert.strictEqual(singleCount, 0, '可動セルを1つだけ含むラインは0本のはず');
  });
}

// ============================================================
// 役割別の構造条件(rootStrongCompatibleCountの帯域)
// ============================================================
check('役割別の構造条件を満たす(rootStrongCompatibleCountの帯域)', () => {
  data.candidates.forEach((candidate, i) => {
    const spec = S.ROLE_SPECS[i];
    const [lo, hi] = spec.rootStrongCompatibleCountRange;
    const val = candidate.structuralMetrics.rootStrongCompatibleCount;
    assert.ok(val >= lo && val <= hi,
      `${candidate.publicId}のrootStrongCompatibleCount(${val})が想定帯域[${lo},${hi}]の範囲内であるはず`);
  });
});

// ============================================================
// bounded-human-playerによる自動評価(相対比較・cycle検出・trace再現性のみ)
// ============================================================
function buildAdapterForCandidate(candidate){
  // bounded-human-playerのinternal/prototype-fixture.jsは変更しない。
  // 新しい候補用に、同じ形のadapter互換オブジェクトをこのテストファイル内だけで
  // 構築する(public-observation-adapter.js/internal/puzzle-engine.jsは無改変)。
  const MAGIC = 315;
  const LARGE_THRESHOLD = 30;
  function cloneBoard(b){ return b.map(l => l.map(r => r.slice())); }
  const board = cloneBoard(CUBE_DATA);
  for(const c of candidate.cells) board[c.z][c.y][c.x] = c.initialValue;
  const movableMap = new Map(candidate.cells.map(c => [`${c.z}-${c.y}-${c.x}`, c]));
  let swapCount = 0, probeCount = 0, status = 'active';
  const undoStack = [];

  function lineSumAt(line){ let s=0; for(const c of line.cells) s+=board[c.z][c.y][c.x]; return s; }
  function lineStatusAt(line){
    const sum = lineSumAt(line);
    if(sum===MAGIC) return { status:'equal', band:null };
    const st = sum>MAGIC ? 'up':'down';
    const band = Math.abs(sum-MAGIC) > LARGE_THRESHOLD ? 'large':'small';
    return { status: st, band };
  }
  function checkCompletion(){
    for(let z=0;z<5;z++) for(let y=0;y<5;y++) for(let x=0;x<5;x++){
      if(board[z][y][x] !== CUBE_DATA[z][y][x]) return;
    }
    status = 'cleared';
  }

  return {
    getMovableCells: () => [...movableMap.entries()].map(([id,c]) => ({ id, z:c.z, y:c.y, x:c.x, value: board[c.z][c.y][c.x] })),
    getLines: () => lines.map(l => ({ id: l.type + '-' + l.cells.map(c=>`${c.z}${c.y}${c.x}`).join(''), type: l.type, cells: l.cells.map(c=>({...c})) })),
    getLineState: function(lineId){
      const line = this.getLines().find(l => l.id === lineId);
      const st = lineStatusAt(line);
      return { id: lineId, status: st.status, band: st.band };
    },
    getSwapCount: () => swapCount,
    getProbeCount: () => probeCount,
    canUndo: () => undoStack.length>0 && status==='active',
    getStatus: () => status,
    listAvailableActions: () => status==='active' ? ['swap','undo','reset','declare_stuck'] : [],
    applySwap: (idA, idB, meta) => {
      if(status!=='active') throw new Error('active状態でのみswap可能');
      const [za,ya,xa] = idA.split('-').map(Number);
      const [zb,yb,xb] = idB.split('-').map(Number);
      undoStack.push(cloneBoard(board));
      const tmp = board[za][ya][xa]; board[za][ya][xa]=board[zb][yb][xb]; board[zb][yb][xb]=tmp;
      swapCount++;
      if(meta && meta.declaredActionType==='probe') probeCount++;
      checkCompletion();
      return { success:true, status, swapCount, probeCount };
    },
    applyUndo: () => {
      const prev = undoStack.pop();
      for(let z=0;z<5;z++) for(let y=0;y<5;y++) for(let x=0;x<5;x++) board[z][y][x]=prev[z][y][x];
      return { success:true, swapCount };
    },
    declareStuck: () => { status='stuck'; return { success:true, status }; },
    _internalStateFingerprint: () => board.flat(2).join(','),
  };
}

check('bounded-human-playerでの自動評価: 同一seed trace一致・cognitive_limit_violations=0', () => {
  data.candidates.forEach(candidate => {
    const runOnce = () => {
      const adapter = buildAdapterForCandidate(candidate);
      const cognitiveState = createCognitiveState(adapter, {});
      const policy = createLocalGreedyPolicy();
      const trace = [];
      let tick = 0;
      const instrumented = {
        limits: cognitiveState.limits,
        observeLine: (id) => { const s = cognitiveState.observeLine(id); trace.push({tick:tick++, kind:'observe_line'}); return s; },
        considerPair: (a,b) => { const r = cognitiveState.considerPair(a,b); trace.push({tick:tick++, kind:'consider_pair'}); return r; },
        previewSwap: (...a) => cognitiveState.previewSwap(...a),
        listAllMovablePairs: (...a) => cognitiveState.listAllMovablePairs(...a),
        getMovableCells: () => cognitiveState.getMovableCells(),
        getLines: () => cognitiveState.getLines(),
        listAvailableActions: () => cognitiveState.listAvailableActions(),
        getSwapCount: () => cognitiveState.getSwapCount(),
        getProbeCount: () => cognitiveState.getProbeCount(),
        canUndo: () => cognitiveState.canUndo(),
        getStatus: () => cognitiveState.getStatus(),
        getFinalClassification: () => cognitiveState.getFinalClassification(),
        executeSwap: (a,b,t,r) => { const res = cognitiveState.executeSwap(a,b,t); trace.push({tick:tick++, kind:'swap'}); return res; },
        executeUndo: () => { const res = cognitiveState.executeUndo(); trace.push({tick:tick++, kind:'undo'}); return res; },
        executeDeclareStuck: () => { const res = cognitiveState.executeDeclareStuck(); trace.push({tick:tick++, kind:'declare_stuck'}); return res; },
      };
      let err = null;
      try { policy.run(instrumented, {}); } catch(e){ err = e.message; }
      return { trace, err, finalStatus: cognitiveState.getFinalClassification() };
    };
    const r1 = runOnce();
    const r2 = runOnce();
    assert.deepStrictEqual(r1.trace.map(t=>t.kind), r2.trace.map(t=>t.kind), `${candidate.publicId}: trace一致`);
    assert.strictEqual(r1.err, null, `${candidate.publicId}: cognitive_limit_violationsなし`);
  });
});

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if(failed > 0) process.exit(1);
