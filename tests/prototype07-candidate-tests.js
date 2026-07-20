// tests/prototype07-candidate-tests.js
// tools/repair/prototype07-candidate.json (固定artifact) の検証。
// productionのcube-data.js / lines109.jsは参照するが変更しない。
// 座標・数字・witnessPath・具体的な交換手順はログへ出力しない。
// 実行: node tests/prototype07-candidate-tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const files = ['js/repair/cube-data.js', 'js/repair/lines109.js'];
const ctx = {};
vm.createContext(ctx);
for (const f of files) {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}
vm.runInContext(`
  globalThis.CUBE_DATA = CUBE_DATA;
  globalThis.buildLines109 = buildLines109;
`, ctx);
const CUBE_DATA = ctx.CUBE_DATA;
const lines109 = ctx.buildLines109();

const candidate = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'tools/repair/prototype07-candidate.json'), 'utf8'
));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}`); }
}

function sha8(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}
function flatIndex(z, y, x) { return z * 25 + y * 5 + x; }
function coordOf(i) { const z = Math.floor(i / 25); const rem = i % 25; const y = Math.floor(rem / 5); const x = rem % 5; return { z, y, x }; }

console.log('== schema / forbidden fields ==');
{
  check('schemaVersionが存在する', typeof candidate.schemaVersion === 'number');
  check('prototypeがrepair-prototype-07', candidate.prototype === 'repair-prototype-07');
  check('structure.mLayoutIdが存在する', typeof candidate.structure.mLayoutId === 'string');
  check('structure.presentationMaskIdが存在する', typeof candidate.structure.presentationMaskId === 'string');
  check('structure.candidateIdが存在する', typeof candidate.structure.candidateId === 'string');
  check('structure.thresholdが55', candidate.structure.threshold === 55);
  check('source.seedが存在する', typeof candidate.source.seed === 'number');

  const jsonText = JSON.stringify(candidate);
  const forbidden = ['correctValue', 'witnessPath', 'exactDeviation', 'solutionPair'];
  check('forbidden fieldがartifactに存在しない', forbidden.every(k => !jsonText.includes(k)));
}

console.log('== 座標の範囲・重複検証 ==');
let mCoords, rCoords, sFlatSet, allFlatM, allFlatR;
{
  const M = candidate.movableCells;
  const R = candidate.revealedFixedCells;
  check('movableCellsが12件', M.length === 12);
  check('revealedFixedCellsが57件', R.length === 57);

  const inRange = c => Number.isInteger(c.z) && c.z >= 0 && c.z <= 4 &&
    Number.isInteger(c.y) && c.y >= 0 && c.y <= 4 &&
    Number.isInteger(c.x) && c.x >= 0 && c.x <= 4;
  check('movableCellsが全て座標範囲内', M.every(inRange));
  check('revealedFixedCellsが全て座標範囲内', R.every(inRange));

  allFlatM = M.map(c => flatIndex(c.z, c.y, c.x));
  allFlatR = R.map(c => flatIndex(c.z, c.y, c.x));
  check('movableCells座標に重複なし', new Set(allFlatM).size === 12);
  check('revealedFixedCells座標に重複なし', new Set(allFlatR).size === 57);
  check('movableCellsとrevealedFixedCellsが重複しない', allFlatM.every(i => !allFlatR.includes(i)));

  const usedSet = new Set([...allFlatM, ...allFlatR]);
  sFlatSet = new Set();
  for (let i = 0; i < 125; i++) if (!usedSet.has(i)) sFlatSet.add(i);
  check('R=57・S=56・M=12(合計125)', allFlatM.length === 12 && allFlatR.length === 57 && sFlatSet.size === 56);
}

console.log('== 匿名ID再計算 ==');
{
  const sortedM = [...allFlatM].sort((a, b) => a - b);
  const mLayoutId = sha8(sortedM.join(','));
  check('mLayoutIdが0808a60fと一致', mLayoutId === candidate.structure.mLayoutId && mLayoutId === '0808a60f');

  const sortedR = [...allFlatR].sort((a, b) => a - b);
  const sortedS = [...sFlatSet].sort((a, b) => a - b);
  // presentation mask id was defined over M+S sorted flat indices
  const maskKey = 'M:' + sortedM.join(',') + '|S:' + sortedS.join(',');
  const maskId = sha8(maskKey);
  check('presentationMaskIdが07b69206と一致', maskId === candidate.structure.presentationMaskId && maskId === '07b69206');
}

console.log('== ライン制約検証(active 20 / inactive 89) ==');
let mSetFlat, rSetFlat, sSetFlatCheck;
{
  mSetFlat = new Set(allFlatM);
  rSetFlat = new Set(allFlatR);
  sSetFlatCheck = sFlatSet;

  let activeCount = 0, inactiveCount = 0;
  let activeOk = true, inactiveOk = true;
  let levelRowColOk = true;

  for (const line of lines109) {
    const cellFlats = line.cells.map(c => flatIndex(c.z, c.y, c.x));
    const mCount = cellFlats.filter(i => mSetFlat.has(i)).length;
    const rCount = cellFlats.filter(i => rSetFlat.has(i)).length;
    const sCount = cellFlats.filter(i => sSetFlatCheck.has(i)).length;
    if (mCount === 2) {
      activeCount++;
      if (!(rCount === 2 && sCount === 1 && mCount === 2)) activeOk = false;
    } else if (mCount === 0) {
      inactiveCount++;
      if (sCount === 1) inactiveOk = false;
    } else {
      activeOk = false; inactiveOk = false;
    }
  }
  check('active lineが20本', activeCount === 20);
  check('inactive lineが89本', inactiveCount === 89);
  check('全active lineがR=2・S=1・M=2', activeOk);
  check('全inactive lineがM=0かつS!=1', inactiveOk);

  for (let z = 0; z < 5 && levelRowColOk; z++) {
    for (let y = 0; y < 5 && levelRowColOk; y++) {
      let hasR = false, hasS = false;
      for (let x = 0; x < 5; x++) {
        const i = flatIndex(z, y, x);
        if (rSetFlat.has(i)) hasR = true;
        if (sSetFlatCheck.has(i)) hasS = true;
      }
      if (!hasR || !hasS) levelRowColOk = false;
    }
    for (let x = 0; x < 5 && levelRowColOk; x++) {
      let hasR = false, hasS = false;
      for (let y = 0; y < 5; y++) {
        const i = flatIndex(z, y, x);
        if (rSetFlat.has(i)) hasR = true;
        if (sSetFlatCheck.has(i)) hasS = true;
      }
      if (!hasR || !hasS) levelRowColOk = false;
    }
  }
  check('各LEVELの全row・columnにR/Sが最低1件ずつ存在', levelRowColOk);
}

console.log('== 初期配置(順列・固定点・最短距離) ==');
let Mlist, correctVals, initialValues, sigma;
{
  Mlist = candidate.movableCells.map(c => flatIndex(c.z, c.y, c.x));
  correctVals = Mlist.map(i => { const { z, y, x } = coordOf(i); return CUBE_DATA[z][y][x]; });
  initialValues = candidate.movableCells.map(c => c.initialValue);

  const sortedInit = [...initialValues].sort((a, b) => a - b);
  const sortedCorrect = [...correctVals].sort((a, b) => a - b);
  check('initialValueがM位置の正解値集合の順列', JSON.stringify(sortedInit) === JSON.stringify(sortedCorrect));

  // reconstruct sigma: position i -> index j such that correctVals[j] === initialValues[i]
  const used = new Array(12).fill(false);
  sigma = new Array(12).fill(-1);
  let sigmaOk = true;
  for (let i = 0; i < 12; i++) {
    let found = -1;
    for (let j = 0; j < 12; j++) {
      if (!used[j] && correctVals[j] === initialValues[i]) { found = j; break; }
    }
    if (found === -1) { sigmaOk = false; break; }
    used[found] = true;
    sigma[i] = found;
  }
  check('sigma(内部順列)を一意に再構成できる', sigmaOk);

  const fixedPoints = sigma.filter((v, i) => v === i).length;
  check('固定点が0(全movableセルが正しい位置にない)', fixedPoints === 0);

  function cyclesDistance(s) {
    const seen = new Array(12).fill(false);
    let cycles = 0;
    for (let i = 0; i < 12; i++) {
      if (!seen[i]) {
        cycles++;
        let j = i;
        while (!seen[j]) { seen[j] = true; j = s[j]; }
      }
    }
    return 12 - cycles;
  }
  const dist = cyclesDistance(sigma);
  check('最短交換距離が8', dist === 8);

  const candidateKey = `M:${candidate.structure.mLayoutId}|S:${candidate.structure.presentationMaskId}|sigma:${sigma.join(',')}`;
  const candidateId = sha8(candidateKey);
  check('candidateIdが106b01adと一致', candidateId === candidate.structure.candidateId && candidateId === '106b01ad');
}

console.log('== active line構造(edge)と初期状態分類 ==');
let activeEdges;
{
  const posOf = new Map(Mlist.map((flat, idx) => [flat, idx]));
  activeEdges = [];
  for (const line of lines109) {
    const cellFlats = line.cells.map(c => flatIndex(c.z, c.y, c.x));
    const mIn = cellFlats.filter(i => posOf.has(i));
    if (mIn.length === 2) {
      const a = posOf.get(mIn[0]), b = posOf.get(mIn[1]);
      const fixedSum = cellFlats.filter(i => !posOf.has(i))
        .reduce((s, i) => { const { z, y, x } = coordOf(i); return s + CUBE_DATA[z][y][x]; }, 0);
      activeEdges.push([a, b, fixedSum]);
    }
  }
  check('active edge(pair)が20本再構成できる', activeEdges.length === 20);

  function valuesOf(vals) { return vals; }
  function lineSums(vals) { return activeEdges.map(([a, b, fs]) => fs + vals[a] + vals[b]); }

  const initSums = lineSums(initialValues);
  const allUnsolved = initSums.every(s => s !== 315);
  check('初期状態で全20 active lineが不成立', allUnsolved);

  const overCount = initSums.filter(s => s > 315).length;
  const underCount = initSums.filter(s => s < 315).length;
  check('初期over/underが10/10', overCount === 10 && underCount === 10);

  const band1 = initSums.filter(s => { const d = Math.abs(s - 315); return d > 0 && d <= 55; }).length;
  const band2 = initSums.filter(s => Math.abs(s - 315) > 55).length;
  check('初期band1/band2が11/9', band1 === 11 && band2 === 9);
}

console.log('== majority定義(確定版)による初期候補数 ==');
{
  function classify(s) {
    const d0 = s - 315;
    if (d0 === 0) return { equal: true };
    const sign = d0 > 0 ? 1 : -1;
    const mag = Math.abs(d0);
    const band = mag <= 55 ? 1 : 2;
    const [lo, hi] = band === 1 ? [1, 55] : [56, 300];
    return { equal: false, sign, lo, hi };
  }
  function closerFartherCounts(sign, lo, hi, delta) {
    const total = hi - lo + 1;
    if (sign * delta > 0) return { closer: 0, farther: total, total };
    const AD = Math.abs(delta);
    const dMinCloser = Math.floor(AD / 2) + 1;
    const closer = dMinCloser <= hi ? Math.max(0, hi - Math.max(lo, dMinCloser) + 1) : 0;
    const same = (AD % 2 === 0 && lo <= Math.floor(AD / 2) && Math.floor(AD / 2) <= hi) ? 1 : 0;
    const farther = total - closer - same;
    return { closer, farther, total };
  }
  function evalLine(fixedSum, aVal, bVal, delta) {
    const s = fixedSum + aVal + bVal;
    const cls = classify(s);
    if (cls.equal) return { majorityCloser: false, guaranteedFarther: delta !== 0 };
    const { closer, farther, total } = closerFartherCounts(cls.sign, cls.lo, cls.hi, delta);
    return { majorityCloser: (closer / total) > 0.5, guaranteedFarther: farther === total };
  }

  const adj = new Map();
  const edgeSet = new Map();
  for (const [a, b, fs] of activeEdges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, fs]);
    adj.get(b).push([a, fs]);
    edgeSet.set([a, b].sort((x, y) => x - y).join(','), fs);
  }

  function majorityCompatiblePairs(vals) {
    const compat = [];
    for (let A = 0; A < 12; A++) {
      for (let B = A + 1; B < 12; B++) {
        let aCloser = 0, bCloser = 0, gf = false;
        for (const [other, fs] of (adj.get(A) || [])) {
          if (other === B) continue;
          const delta = vals[B] - vals[A];
          const r = evalLine(fs, vals[A], vals[other], delta);
          if (r.guaranteedFarther) gf = true;
          if (r.majorityCloser) aCloser++;
        }
        for (const [other, fs] of (adj.get(B) || [])) {
          if (other === A) continue;
          const delta = vals[A] - vals[B];
          const r = evalLine(fs, vals[B], vals[other], delta);
          if (r.guaranteedFarther) gf = true;
          if (r.majorityCloser) bCloser++;
        }
        if (aCloser >= 2 && bCloser >= 2 && !gf) compat.push([A, B]);
      }
    }
    return compat;
  }

  const initPairs = majorityCompatiblePairs(initialValues);
  check('確定済みmajority定義で初期候補が3組', initPairs.length === 3);

  console.log('== P2 witness path(存在確認のみ、経路自体は非表示) ==');
  {
    function cycleMap(s) {
      const seen = new Array(12).fill(false);
      const comp = new Array(12).fill(-1);
      let cid = 0;
      for (let i = 0; i < 12; i++) {
        if (!seen[i]) {
          let j = i;
          while (!seen[j]) { seen[j] = true; comp[j] = cid; j = s[j]; }
          cid++;
        }
      }
      return comp;
    }
    function applySwap(s, a, b) { const n = s.slice(); const t = n[a]; n[a] = n[b]; n[b] = t; return n; }
    function totalAbsDeviation(sums) { return sums.reduce((acc, s) => acc + Math.abs(s - 315), 0); }
    function solvedCount(sums) { return sums.filter(s => s === 315).length; }
    function affectedEdgesForPair(A, B) {
      return activeEdges.filter(([a, b]) => {
        const inA = (a === A || b === A), inB = (a === B || b === B);
        return (inA || inB) && !(inA && inB);
      });
    }

    let found = null;
    let nodes = 0;
    const NODE_CAP = 200000;
    function dfs(s, prevSums, prevSolved, prevDev, path) {
      if (found) return;
      nodes++;
      if (nodes > NODE_CAP) return;
      if (s.every((v, i) => v === i)) { found = path.slice(); return; }
      const vals = s.map(idx => correctVals[idx]);
      const pairs = majorityCompatiblePairs(vals);
      if (pairs.length < 1 || pairs.length > 4) return;
      const comp = cycleMap(s);
      const progressing = pairs.filter(([a, b]) => comp[a] === comp[b]);
      for (const [A, B] of progressing) {
        const newS = applySwap(s, A, B);
        const newVals = newS.map(idx => correctVals[idx]);
        const newSums = activeEdges.map(([a, b, fs]) => fs + newVals[a] + newVals[b]);
        if (prevSums.some((ps, i) => ps === 315 && newSums[i] !== 315)) continue;
        const newSolved = solvedCount(newSums);
        if (newSolved < prevSolved) continue;
        const newDev = totalAbsDeviation(newSums);
        if (!(newDev < prevDev)) continue;
        const affected = affectedEdgesForPair(A, B);
        let closer = 0, farther = 0;
        for (const [a, b, fs] of affected) {
          const idx2 = activeEdges.findIndex(e => e[0] === a && e[1] === b && e[2] === fs);
          const before = Math.abs(prevSums[idx2] - 315);
          const after = Math.abs(newSums[idx2] - 315);
          if (after < before) closer++; else if (after > before) farther++;
        }
        if (!(closer > farther)) continue;
        const isFinal = newS.every((v, i) => v === i);
        if (isFinal && (newSolved - prevSolved) > 7) continue;
        path.push([A, B]);
        dfs(newS, newSums, newSolved, newDev, path);
        path.pop();
        if (found) return;
      }
    }
    const initSums2 = activeEdges.map(([a, b, fs]) => fs + initialValues[a] + initialValues[b]);
    const initSolved2 = solvedCount(initSums2);
    const initDev2 = totalAbsDeviation(initSums2);
    dfs(sigma, initSums2, initSolved2, initDev2, []);
    check('P2を満たす最短8手のwitness pathが存在する', found !== null && found.length === 8);
  }
}

console.log('== 一意解検証(20 pair-sum制約) ==');
{
  const adj2 = new Map();
  for (const [a, b, fs] of activeEdges) {
    const T = correctVals[a] + correctVals[b];
    if (!adj2.has(a)) adj2.set(a, []);
    if (!adj2.has(b)) adj2.set(b, []);
    adj2.get(a).push([b, T]);
    adj2.get(b).push([a, T]);
  }
  const valuePool = new Set(correctVals);
  function trySeed(seedPos, seedVal) {
    const assign = new Map([[seedPos, seedVal]]);
    const usedVals = new Set([seedVal]);
    const frontier = [seedPos];
    while (frontier.length) {
      const cur = frontier.pop();
      for (const [nbr, T] of (adj2.get(cur) || [])) {
        const need = T - assign.get(cur);
        if (assign.has(nbr)) {
          if (assign.get(nbr) !== need) return null;
        } else {
          if (!valuePool.has(need) || usedVals.has(need)) return null;
          assign.set(nbr, need);
          usedVals.add(need);
          frontier.push(nbr);
        }
      }
    }
    if (assign.size !== 12 || usedVals.size !== 12) return null;
    return assign;
  }
  const solutions = new Set();
  for (const v of valuePool) {
    const res = trySeed(0, v);
    if (res) {
      const tup = [];
      for (let p = 0; p < 12; p++) tup.push(res.get(p));
      solutions.add(tup.join(','));
    }
  }
  check('20本のpair-sum制約下で解が一意', solutions.size === 1);
}

console.log('== production接続の一致検証(js/repair/puzzle.js ⇔ artifact) ==');
{
  const pctx = {};
  vm.createContext(pctx);
  for (const f of ['js/repair/cube-data.js', 'js/repair/puzzle.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), pctx, { filename: f });
  }
  vm.runInContext('globalThis.CUBE_DATA = CUBE_DATA; globalThis.REPAIR_CELLS = REPAIR_CELLS; globalThis.REVEALED_FIXED_CELLS = REVEALED_FIXED_CELLS;', pctx);
  const prodCells = pctx.REPAIR_CELLS;
  const prodRevealed = pctx.REVEALED_FIXED_CELLS;
  const prodCubeData = pctx.CUBE_DATA;

  // candidate JSONをruntime読込しているとは仮定しない(構造だけをテスト側でartifactと突き合わせる)。
  const artifactMovableKeys = new Set(candidate.movableCells.map(c => `${c.z + 1}-${c.y}-${c.x}`));
  const prodMovableKeys = new Set(prodCells.map(c => `${c.L}-${c.r}-${c.c}`));
  const movableKeysMatch = artifactMovableKeys.size === prodMovableKeys.size &&
    [...artifactMovableKeys].every(k => prodMovableKeys.has(k)) &&
    [...prodMovableKeys].every(k => artifactMovableKeys.has(k));
  check('production REPAIR_CELLSの座標集合がPrototype07 artifactと完全一致', movableKeysMatch);

  const artifactInitByKey = new Map(candidate.movableCells.map(c => [`${c.z + 1}-${c.y}-${c.x}`, c.initialValue]));
  const initialValueMismatch = prodCells.filter(c => artifactInitByKey.get(`${c.L}-${c.r}-${c.c}`) !== c.initialValue).length;
  check('各Mセルのinitial値がartifactと完全一致', movableKeysMatch && initialValueMismatch === 0);

  const correctValueMismatch = prodCells.filter(c => c.correctValue !== prodCubeData[c.L - 1][c.r][c.c]).length;
  check('productionのcorrectValueがCUBE_DATAから正しく導出されている', correctValueMismatch === 0);

  const artifactRevealedKeys = new Set(candidate.revealedFixedCells.map(c => `${c.z + 1}-${c.y}-${c.x}`));
  const prodRevealedKeys = new Set(prodRevealed.map(c => `${c.L}-${c.r}-${c.c}`));
  const revealedKeysMatch = artifactRevealedKeys.size === prodRevealedKeys.size &&
    [...artifactRevealedKeys].every(k => prodRevealedKeys.has(k)) &&
    [...prodRevealedKeys].every(k => artifactRevealedKeys.has(k));
  check('production REVEALED_FIXED_CELLSがartifactの57座標と完全一致', revealedKeysMatch);
}

console.log(`\n合計: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
