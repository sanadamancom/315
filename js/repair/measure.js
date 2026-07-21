// measure.js — 選択したラインを測定し、＝/↑/↓ だけを返す(正確な差分やセル単位の正誤は返さない)。

function lineSum(state, line){
  let sum = 0;
  for(const cell of line.cells){
    sum += repairGridValue(state, cell.z+1, cell.y, cell.x);
  }
  return sum;
}

// '=' : ちょうど315 / '↑' : 315を超えている / '↓' : 315に足りない
function measureLine(state, line){
  const sum = lineSum(state, line);
  if(sum === 315) return '=';
  return sum > 315 ? '↑' : '↓';
}

// Prototype 06: 偏差帯の固定閾値(この1箇所だけで管理する)。
const DEVIATION_BAND_THRESHOLD = 55;

// 315に対するdirectionと2段階のband(0=equal,1,2)だけを返す純粋関数。
// 正確な合計・偏差量は戻り値へ含めない。
// direction: 'equal' | 'over' | 'under'
// band: 0(=equalのみ) / 1(|sum-315|が1〜threshold) / 2(threshold+1以上)
function classifyDeviationBand(sum, threshold = DEVIATION_BAND_THRESHOLD){
  if(sum === 315) return { direction: 'equal', band: 0 };
  const direction = sum > 315 ? 'over' : 'under';
  const distance = Math.abs(sum - 315);
  const band = distance <= threshold ? 1 : 2;
  return { direction, band };
}

// 指定セル(L,r,c)が属するラインの一覧を返す。
function linesThroughCell(allLines, L, r, c){
  const z = L-1, y = r, x = c;
  return allLines.filter(line => line.cells.some(cell => cell.z===z && cell.y===y && cell.x===x));
}

// 交換前後のライン合計(315基準の絶対距離)から質的変化を返す純粋関数。
// 'unchanged' : 距離が変わらない(交換前から315だった共有ラインを含む)
// 'solved'    : 距離が変わり、かつ交換後がちょうど315
// 'closer'    : 距離が変わり、かつ縮まった
// 'farther'   : 距離が変わり、かつ広がった
// 315をまたぐ変化(例: 320→310)も絶対距離だけで判定する(符号は見ない)。
function classifyLineChange(beforeSum, afterSum){
  const beforeDistance = Math.abs(beforeSum - 315);
  const afterDistance = Math.abs(afterSum - 315);
  if(beforeDistance === afterDistance) return 'unchanged';
  if(afterDistance === 0) return 'solved';
  return afterDistance < beforeDistance ? 'closer' : 'farther';
}

// 指定セル(L,r,c)がラインに含まれるかどうか(座標系変換のみ、ラインは変更しない)。
function lineIncludesCell(line, cell){
  const z = cell.L-1, y = cell.r, x = cell.c;
  return line.cells.some(lc => lc.z===z && lc.y===y && lc.x===x);
}

// swappedCells(2セル)の少なくとも一方を含むラインだけを対象に、交換前後の質的変化を返す。
// 両セルを含む共有ラインもフィルタの性質上1件だけ含まれる(重複走査しない)。
// 入力(lines/grid/swappedCells)は一切変更せず、lineSum・classifyLineChangeを再利用する。
// 正確なsumや偏差量は戻り値へ含めない(lineへの既存参照とchangeラベルだけを返す)。
function analyzeAffectedLineChanges(lines, beforeGrid, afterGrid, swappedCells){
  const [a, b] = swappedCells;
  return lines
    .filter(line => lineIncludesCell(line, a) || lineIncludesCell(line, b))
    .map(line => ({
      line,
      change: classifyLineChange(lineSum(beforeGrid, line), lineSum(afterGrid, line)),
    }));
}

// ---- 自動解読(315から一意に算出できる封印固定セルだけを求める) ----
// 呼び出し側(repair-main.js)が「現在のライン状態(=/↑/↓)」と「公開済みの値だけ」を渡す純粋関数。
// correctValueやCUBE_DATAの封印値には一切アクセスできない構造にする(引数として渡さない)。
//
// lines            : buildLines109()が返す、{key, cells:[{z,y,x},...]} の配列(構造は変更しない)
// lineStatusMap    : Map<lineKey, '='|'↑'|'↓'> (呼び出し側がmeasureLine等で計算済みのものを渡す)
// knownValues      : Map<cellKey, number> (movableの現在値 + revealed-fixedの値 + 既に解読済みsealedの値)
// cellKeyOf        : ({z,y,x}) => cellKey (呼び出し側の座標系変換を再利用するための関数、副作用なし)
//
// 戻り値: { decoded: Map<cellKey, number>, contributingLineKeys: Set<lineKey> }
//   decoded              : 今回新たに解読できた値だけ(knownValuesに既にある値は上書きしない)
//   contributingLineKeys : 解読(単独ラインでも、伝播後の再解読でも)に使われたラインのkey集合
// 競合(同じセルへ異なる値)が出たセルは解読せず、decodedへ含めない。
function autoDecodeSealedCells(lines, lineStatusMap, knownValues, cellKeyOf){
  const working = new Map(knownValues);
  const decoded = new Map();
  const conflicted = new Set();
  const contributorsByCell = new Map(); // cellKey -> Set<lineKey> (現在のdecoded値に一致した寄与ラインだけ)

  let changed = true;
  while(changed){
    changed = false;
    // このラウンド内では「ラウンド開始時点のworking」を基準に全ラインの提案を集め、
    // 同一ラウンド内で複数ラインが同じセルへ異なる値を提案した場合も競合として検出できるようにする
    // (提案を集め切ってからまとめてworkingへ反映する: 逐次反映すると先に処理したラインの結果が
    //  後続ラインの「既知」に混入し、本来ラウンド内で起きるはずの競合を見逃してしまうため)。
    const roundWorking = working;
    const proposals = new Map(); // cellKey -> [{value, lineKey}]
    for(const line of lines){
      if(lineStatusMap.get(line.key) !== '=') continue;
      const keys = line.cells.map(cellKeyOf);
      const unknownKeys = keys.filter(k => !roundWorking.has(k) && !conflicted.has(k));
      if(unknownKeys.length !== 1) continue;
      const targetKey = unknownKeys[0];

      const knownSum = keys.reduce((sum, k) => roundWorking.has(k) ? sum + roundWorking.get(k) : sum, 0);
      const value = 315 - knownSum;
      if(!Number.isInteger(value) || value < 1 || value > 125) continue;

      if(!proposals.has(targetKey)) proposals.set(targetKey, []);
      proposals.get(targetKey).push({ value, lineKey: line.key });
    }

    for(const [key, props] of proposals){
      const distinctValues = new Set(props.map(p => p.value));
      if(distinctValues.size > 1){
        // 同一ラウンド内で異なる値が提案された: 競合として扱い、以後このセルは対象から外す。
        conflicted.add(key);
        changed = true;
        continue;
      }
      const value = props[0].value;
      decoded.set(key, value);
      working.set(key, value);
      contributorsByCell.set(key, new Set(props.map(p => p.lineKey)));
      changed = true;
    }
  }

  const contributingLineKeys = new Set();
  for(const key of decoded.keys()){
    for(const lineKey of contributorsByCell.get(key)) contributingLineKeys.add(lineKey);
  }

  return { decoded, contributingLineKeys };
}
