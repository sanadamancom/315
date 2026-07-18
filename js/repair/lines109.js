// lines109.js — 5x5x5キューブの109ライン(行25+列25+柱25+平面対角線30+空間対角線4)を構築する。
// 既存generator.jsのbuildAllLines(89ライン=面の対角線含まず)とは別物。混在させない。
// 座標系はcube-data.jsと同じ: {z,y,x} (z=層/L-1, y=行/r, x=列/c)。
const N5 = 5;

function buildLines109(){
  const lines = [];
  // 行: z,y固定、xを走査
  for(let z=0;z<N5;z++) for(let y=0;y<N5;y++){
    const cells = []; for(let x=0;x<N5;x++) cells.push({z,y,x});
    lines.push({ type:'row', key:`row-${z}-${y}`, cells });
  }
  // 列: z,x固定、yを走査
  for(let z=0;z<N5;z++) for(let x=0;x<N5;x++){
    const cells = []; for(let y=0;y<N5;y++) cells.push({z,y,x});
    lines.push({ type:'col', key:`col-${z}-${x}`, cells });
  }
  // 柱: y,x固定、zを走査
  for(let y=0;y<N5;y++) for(let x=0;x<N5;x++){
    const cells = []; for(let z=0;z<N5;z++) cells.push({z,y,x});
    lines.push({ type:'pillar', key:`pillar-${y}-${x}`, cells });
  }
  // xy平面対角線(z固定、各層内の対角線): 10本
  for(let z=0;z<N5;z++){
    lines.push({ type:'xy-main', key:`xy-main-${z}`, cells: Array.from({length:N5},(_,i)=>({z,y:i,x:i})) });
    lines.push({ type:'xy-anti', key:`xy-anti-${z}`, cells: Array.from({length:N5},(_,i)=>({z,y:i,x:N5-1-i})) });
  }
  // xz平面対角線(y固定、縦断面対角線): 10本
  for(let y=0;y<N5;y++){
    lines.push({ type:'xz-main', key:`xz-main-${y}`, cells: Array.from({length:N5},(_,i)=>({z:i,y,x:i})) });
    lines.push({ type:'xz-anti', key:`xz-anti-${y}`, cells: Array.from({length:N5},(_,i)=>({z:i,y,x:N5-1-i})) });
  }
  // yz平面対角線(x固定、縦断面対角線): 10本
  for(let x=0;x<N5;x++){
    lines.push({ type:'yz-main', key:`yz-main-${x}`, cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x})) });
    lines.push({ type:'yz-anti', key:`yz-anti-${x}`, cells: Array.from({length:N5},(_,i)=>({z:i,y:N5-1-i,x})) });
  }
  // 空間対角線(角から角、4本)
  lines.push({ type:'space', key:'space-1', cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x:i})) });
  lines.push({ type:'space', key:'space-2', cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x:N5-1-i})) });
  lines.push({ type:'space', key:'space-3', cells: Array.from({length:N5},(_,i)=>({z:i,y:N5-1-i,x:i})) });
  lines.push({ type:'space', key:'space-4', cells: Array.from({length:N5},(_,i)=>({z:N5-1-i,y:i,x:i})) });
  return lines;
}

const LABEL_BY_TYPE = {
  row: '行', col: '列', pillar: '柱',
  'xy-main': '平面対角線(xy)', 'xy-anti': '平面対角線(xy)',
  'xz-main': '平面対角線(xz)', 'xz-anti': '平面対角線(xz)',
  'yz-main': '平面対角線(yz)', 'yz-anti': '平面対角線(yz)',
  space: '空間対角線',
};

function lineLabel(line){
  return LABEL_BY_TYPE[line.type] || line.type;
}
