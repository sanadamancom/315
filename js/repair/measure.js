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
