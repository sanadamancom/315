// generator.js — pure puzzle-generation math, no DOM access.

const N = 5;
const LEVELS = 5;
const TARGET = 315;

const LEVEL_COLOR = {
  5:'#8a2131', 4:'#785321', 3:'#71712a', 2:'#356335', 1:'#1f4f66',
};

function darkenHex(hex, factor){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  const dr = Math.round(r*factor), dg = Math.round(g*factor), db = Math.round(b*factor);
  return `rgb(${dr},${dg},${db})`;
}
const LEVEL_LINE_COLOR = {};
for(const L of [1,2,3,4,5]) LEVEL_LINE_COLOR[L] = darkenHex(LEVEL_COLOR[L], 0.42);

// coefficient triples verified (via offline search) to yield a valid magic cube
// when combined as value = 1 + 25*A + 5*B + C  (A,B,C are linear mod-5 digit functions)
const COEFF_SETS = [
  [[1,2,1],[1,2,2],[1,3,1]],
  [[1,2,1],[1,2,3],[2,1,1]],
  [[1,3,2],[2,1,4],[3,4,1]],
  [[2,1,3],[1,3,4],[4,2,1]],
  [[1,2,4],[3,4,2],[2,1,3]],
  [[1,3,1],[2,1,2],[1,2,4]],
  [[2,3,1],[1,4,2],[3,1,4]],
  [[1,4,2],[2,3,1],[1,2,3]],
];

function randInt(n){ return Math.floor(Math.random()*n); }
function shuffled(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){ const j=randInt(i+1); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

// The 4 space diagonals (triagonals), as directions in (x,y,z):
const TRIAG_DIRS = [[1,1,1],[1,1,-1],[1,-1,1],[-1,1,1]];

// KEY INSIGHT for making the space diagonals sum to 315:
// For any coefficient row (α,β,γ) with α,β,γ,α±β all nonzero mod 5, the four values
// {±(α+β), ±(α−β)} are distinct, nonzero, and therefore cover ALL nonzero residues --
// so γ equals exactly one of them, i.e. EXACTLY ONE space diagonal has slope 0 for
// that digit (the digit is CONSTANT along it), while the other three are balanced
// (each hits 0..4 once → digit-sum 10 automatically).
// If the relabeling permutation maps that constant to 2, the degenerate diagonal's
// digit-sum is 5*2 = 10 as well → every space diagonal gets digit-sum 10 for every
// digit → value-sum 25*10 + 5*10 + 10 + 5 = 315. All other line families were already
// balanced, and per-digit relabeling preserves balancedness, so nothing else changes.
function pinnedPerm(coef){
  const [a,b,g] = coef;
  let constVal = null;
  for(const [dx,dy,dz] of TRIAG_DIRS){
    if((((a*dx + b*dy + g*dz) % 5) + 5) % 5 === 0){
      const x0 = dx===1?0:4, y0 = dy===1?0:4, z0 = dz===1?0:4;
      constVal = (((a*x0 + b*y0 + g*z0) % 5) + 5) % 5;
      break;
    }
  }
  for(let tries=0; tries<200; tries++){
    const p = shuffled([0,1,2,3,4]);
    if(constVal === null || p[constVal] === 2) return p;
  }
  // deterministic fallback (never reached in practice)
  const p = [0,1,2,3,4];
  if(constVal !== null){ const j = p.indexOf(2); [p[constVal], p[j]] = [p[j], p[constVal]]; }
  return p;
}

function isValidTriple(p){
  const [px,py,pz]=p;
  if(px===0||py===0||pz===0) return false;
  if((px+py)%5===0) return false;
  if(px===py) return false;
  return true;
}
function det3(M){
  const [[a,b,c],[d,e,f],[g,h,i]]=M;
  return a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g);
}

// ---- shared deduction engine: finds every cell confirmable RIGHT NOW, via either ----
// (a) a line with exactly 1 blank (direct subtraction), or
// (b) a line with exactly 2 blanks where exactly one unordered pair of still-available
//     pool values sums correctly, AND the assignment of which value goes to which of the
//     2 cells can be resolved by checking that the wrong ordering would overshoot 315 on
//     one of that cell's OTHER lines.
// Used by both the "お助け" button and the puzzle-generation solvability check, so the
// two always agree on what counts as "confirmable by logic, not guessing".
function buildAllLines(N, LEVELS){
  const lines = [];
  for(let L=1; L<=LEVELS; L++){
    for(let r=0;r<N;r++) lines.push({ key:`row-${L}-${r}`, cells: Array.from({length:N},(_,c)=>({L,r,c})) });
    for(let c=0;c<N;c++) lines.push({ key:`col-${L}-${c}`, cells: Array.from({length:N},(_,r)=>({L,r,c})) });
    lines.push({ key:`dmain-${L}`, cells: Array.from({length:N},(_,i)=>({L,r:i,c:i})) });
    lines.push({ key:`danti-${L}`, cells: Array.from({length:N},(_,i)=>({L,r:i,c:N-1-i})) });
  }
  for(let r=0;r<N;r++){
    for(let c=0;c<N;c++){
      lines.push({ key:`depth-${r}-${c}`, cells: Array.from({length:LEVELS},(_,i)=>({L:i+1,r,c})) });
    }
  }
  // the 4 space diagonals (corner-to-corner through all levels) -- guaranteed 315
  // by the generator's pinned-permutation construction, so the solver may use them.
  lines.push({ key:'triag-mm', cells: Array.from({length:LEVELS},(_,i)=>({L:i+1, r:i,     c:i})) });
  lines.push({ key:'triag-ma', cells: Array.from({length:LEVELS},(_,i)=>({L:i+1, r:i,     c:N-1-i})) });
  lines.push({ key:'triag-am', cells: Array.from({length:LEVELS},(_,i)=>({L:i+1, r:N-1-i, c:i})) });
  lines.push({ key:'triag-aa', cells: Array.from({length:LEVELS},(_,i)=>({L:i+1, r:N-1-i, c:N-1-i})) });
  return lines;
}

function findConfirmedPlacements(grid, given, playablePool, N, LEVELS, TARGET, include2Blank){
  if(include2Blank === undefined) include2Blank = true;
  const allLines = buildAllLines(N, LEVELS);
  const cellKey = (L,r,c) => `${L},${r},${c}`;
  const linesByCell = new Map();
  for(const line of allLines){
    for(const cell of line.cells){
      const k = cellKey(cell.L,cell.r,cell.c);
      if(!linesByCell.has(k)) linesByCell.set(k, []);
      linesByCell.get(k).push(line);
    }
  }

  function isUsedElsewhere(value){
    for(let L=1; L<=LEVELS; L++) for(let r=0;r<N;r++) for(let c=0;c<N;c++)
      if(!given[L][r][c] && grid[L][r][c] === value) return true;
    return false;
  }
  // how many times does `value` still remain available in the pool (not yet placed anywhere)?
  function isAvailable(value){
    return playablePool.includes(value) && !isUsedElsewhere(value);
  }
  // would placing `value` at (L,r,c) push any of that cell's OTHER lines over target
  // (a hard proof that the ordering must be wrong)?
  function wouldOvershoot(L,r,c,value, excludeKey){
    const cellLines = linesByCell.get(cellKey(L,r,c));
    for(const line of cellLines){
      if(line.key === excludeKey) continue;
      let sum = 0;
      for(const cell of line.cells){
        if(cell.L===L && cell.r===r && cell.c===c){ sum += value; continue; }
        const v = grid[cell.L][cell.r][cell.c];
        if(v !== null) sum += v;
      }
      if(sum > TARGET) return true;
    }
    return false;
  }

  const confirmed = []; // {L,r,c,value}
  for(const line of allLines){
    const vals = line.cells.map(({L,r,c})=>grid[L][r][c]);
    const blanks = line.cells.filter((_,i)=>vals[i]===null);
    const knownSum = vals.reduce((a,b)=> a + (b===null?0:b), 0);
    const needed = TARGET - knownSum;

    if(blanks.length === 1){
      const t = blanks[0];
      if(given[t.L][t.r][t.c]) continue;
      if(!isAvailable(needed)) continue;
      confirmed.push({ L:t.L, r:t.r, c:t.c, value: needed });
      continue;
    }

    if(blanks.length === 2 && include2Blank){
      const [a, b] = blanks;
      if(given[a.L][a.r][a.c] || given[b.L][b.r][b.c]) continue;
      // find every unordered pair of distinct, still-available pool values summing to `needed`
      const seen = new Set();
      const pairs = [];
      for(const x of playablePool){
        if(!isAvailable(x)) continue;
        const y = needed - x;
        if(y === x) continue; // would need two copies of the same value; never happens (all values are unique 1-125)
        if(!isAvailable(y)) continue;
        const key = [Math.min(x,y), Math.max(x,y)].join('-');
        if(seen.has(key)) continue;
        seen.add(key);
        pairs.push([x,y]);
      }
      if(pairs.length !== 1) continue; // ambiguous or impossible -> not confirmable yet
      const [x,y] = pairs[0];
      const order1ok = !wouldOvershoot(a.L,a.r,a.c,x,line.key) && !wouldOvershoot(b.L,b.r,b.c,y,line.key);
      const order2ok = !wouldOvershoot(a.L,a.r,a.c,y,line.key) && !wouldOvershoot(b.L,b.r,b.c,x,line.key);
      if(order1ok && !order2ok){
        confirmed.push({ L:a.L, r:a.r, c:a.c, value:x });
        confirmed.push({ L:b.L, r:b.r, c:b.c, value:y });
      } else if(order2ok && !order1ok){
        confirmed.push({ L:a.L, r:a.r, c:a.c, value:y });
        confirmed.push({ L:b.L, r:b.r, c:b.c, value:x });
      }
      // if both orders are consistent (or neither is), the ordering is genuinely
      // ambiguous right now -- leave both cells blank rather than guess.
    }
  }

  return confirmed;
}

function generateSolution(){
  // pick a random valid coefficient set (re-validate + allow slight retry loop for safety)
  let coeffs;
  for(let tries=0; tries<50; tries++){
    coeffs = COEFF_SETS[randInt(COEFF_SETS.length)];
    const [A,B,C] = coeffs;
    if(!isValidTriple(A) || !isValidTriple(B) || !isValidTriple(C)) continue;
    if(det3(coeffs) % 5 === 0) continue;
    break;
  }
  const [A,B,C] = coeffs;

  // digit permutations: random EXCEPT each digit's degenerate space diagonal constant
  // is pinned to 2 (see pinnedPerm) -- this is what makes all 4 space diagonals sum 315.
  const permA = pinnedPerm(A);
  const permB = pinnedPerm(B);
  const permC = pinnedPerm(C);

  // random axis role assignment: level must stay mapped to the z-role (index2) so that
  // in-layer diagonals keep their validity guarantee; only row/col may swap x<->y roles.
  const axes = (Math.random()<0.5) ? [0,1,2] : [1,0,2];
  // random reflection per axis
  const reflect = [Math.random()<0.5, Math.random()<0.5, Math.random()<0.5];

  function coordFor(role, r, c, l){
    // role 0->row(r),1->col(c),2->level(l) reassigned via axes permutation
    const raw = [r,c,l];
    let v = raw[axes[role]];
    if(reflect[role]) v = 4 - v;
    return v;
  }

  const sol = {};
  for(let L=1; L<=LEVELS; L++) sol[L] = Array.from({length:N},()=>Array(N).fill(0));

  for(let r=0;r<N;r++){
    for(let c=0;c<N;c++){
      for(let l=0;l<N;l++){
        const x = coordFor(0,r,c,l);
        const y = coordFor(1,r,c,l);
        const z = coordFor(2,r,c,l);
        let a=(A[0]*x+A[1]*y+A[2]*z)%5;
        let b=(B[0]*x+B[1]*y+B[2]*z)%5;
        let cc=(C[0]*x+C[1]*y+C[2]*z)%5;
        a=permA[a]; b=permB[b]; cc=permC[cc];
        const val = 1 + 25*a + 5*b + cc;
        sol[l+1][r][c] = val;
      }
    }
  }
  return sol;
}

// Difficulty presets. Two levers per tier:
//   perLevel     -- pre-filled ("given") cells per level, out of 25. Fewer = harder.
//   minPairCells -- generation-time floor on "cells that 1-blank subtraction alone
//                   CANNOT fill" (they need 2-cell pair reasoning). Measured on real
//                   generations: at 16 hints the typical residue is ~8 cells, at 12
//                   hints it ranges 8-52, so these floors are what actually separate
//                   the tiers in felt difficulty -- hint count alone barely does.
//   genuine2Blank -- reject puzzles solvable by 1-blank reasoning alone, so the
//                    お助け button (1-blank only) can never trivially clear the board.
// 3段階に整理(2026年再設計)。プレイヤーからの「簡単すぎる/数字を埋めるだけ」
// という指摘を受け、全ティアで2マス同時推理を必須化(genuine2Blank:true)。
// 初期配置(ヒント)も全体的に削減し、数独としての手応えを優先する。
// 指標を「1マス推論で残るマス数」から「実際に必要な独立した2マス推理の
// 発動回数(minPairRounds)」に変更。残数だけでは、1回のペア推理が連鎖的に
// 大半を解いてしまうケースを区別できず体感難度を反映しなかった
// (実測: 残数30以上でも発動回数はわずか1〜3回のことがあった)。
const DIFFICULTY_PRESETS = {
  normal: { label: 'ふつう',     perLevel: [13,13,13,13,13], genuine2Blank: true, minPairRounds: 2 },
  hard:   { label: 'むずかしい', perLevel: [11,11,11,11,11], genuine2Blank: true, minPairRounds: 2 },
  oni:    { label: 'とても難しい', perLevel: [11,11,11,11,11], genuine2Blank: true, minPairRounds: 3 },
};

