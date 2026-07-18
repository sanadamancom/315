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
