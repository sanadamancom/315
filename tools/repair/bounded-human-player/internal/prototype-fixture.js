// internal/prototype-fixture.js
//
// 【internal専用】このモジュールはpolicy層から直接requireしてはならない。
// public-observation-adapter.js だけがこのモジュールを読み込み、
// 許可されたフィールドのみをpolicy層へ公開する。
//
// 内容はProrotype 11.0 (prototype11.html)に埋め込まれているseed=7候補と
// 完全に同一（正規CUBE_DATA・22 movableセル・初期表示値）。座標や初期値を
// 変更していない。

'use strict';

const CUBE_DATA = [
  [
    [25, 16, 80, 104, 90],
    [115, 98, 4, 1, 97],
    [42, 111, 85, 2, 75],
    [66, 72, 27, 102, 48],
    [67, 18, 119, 106, 5],
  ],
  [
    [91, 77, 71, 6, 70],
    [52, 64, 117, 69, 13],
    [30, 118, 21, 123, 23],
    [26, 39, 92, 44, 114],
    [116, 17, 14, 73, 95],
  ],
  [
    [47, 61, 45, 76, 86],
    [107, 43, 38, 33, 94],
    [89, 68, 63, 58, 37],
    [32, 93, 88, 83, 19],
    [40, 50, 81, 65, 79],
  ],
  [
    [31, 53, 112, 109, 10],
    [12, 82, 34, 87, 100],
    [103, 3, 105, 8, 96],
    [113, 57, 9, 62, 74],
    [56, 120, 55, 49, 35],
  ],
  [
    [121, 108, 7, 20, 59],
    [29, 28, 122, 125, 11],
    [51, 15, 41, 124, 84],
    [78, 54, 99, 24, 60],
    [36, 110, 46, 22, 101],
  ],
];

const MOVABLE_RAW = [
  {coord:{z:3,y:3,x:0}, initial:114},
  {coord:{z:0,y:4,x:3}, initial:113},
  {coord:{z:1,y:3,x:4}, initial:106},
  {coord:{z:0,y:0,x:2}, initial:20},
  {coord:{z:1,y:3,x:3}, initial:80},
  {coord:{z:4,y:0,x:3}, initial:44},
  {coord:{z:3,y:1,x:0}, initial:12},
  {coord:{z:3,y:1,x:4}, initial:100},
  {coord:{z:3,y:3,x:4}, initial:74},
  {coord:{z:0,y:3,x:3}, initial:102},
  {coord:{z:0,y:3,x:4}, initial:48},
  {coord:{z:0,y:4,x:4}, initial:5},
  {coord:{z:1,y:1,x:0}, initial:52},
  {coord:{z:1,y:1,x:4}, initial:13},
  {coord:{z:1,y:3,x:0}, initial:26},
  {coord:{z:0,y:0,x:3}, initial:104},
  {coord:{z:0,y:4,x:2}, initial:119},
  {coord:{z:1,y:4,x:3}, initial:73},
  {coord:{z:1,y:4,x:4}, initial:95},
  {coord:{z:4,y:0,x:2}, initial:7},
  {coord:{z:4,y:1,x:2}, initial:15},
  {coord:{z:4,y:1,x:3}, initial:125},
];

const N5 = 5;
function buildLines109(){
  const lines = [];
  for(let z=0;z<N5;z++) for(let y=0;y<N5;y++){
    const cells = []; for(let x=0;x<N5;x++) cells.push({z,y,x});
    lines.push({ type:'row', id:`row-${z}-${y}`, cells });
  }
  for(let z=0;z<N5;z++) for(let x=0;x<N5;x++){
    const cells = []; for(let y=0;y<N5;y++) cells.push({z,y,x});
    lines.push({ type:'col', id:`col-${z}-${x}`, cells });
  }
  for(let y=0;y<N5;y++) for(let x=0;x<N5;x++){
    const cells = []; for(let z=0;z<N5;z++) cells.push({z,y,x});
    lines.push({ type:'pillar', id:`pillar-${y}-${x}`, cells });
  }
  for(let z=0;z<N5;z++){
    lines.push({ type:'xy-main', id:`xy-main-${z}`, cells: Array.from({length:N5},(_,i)=>({z,y:i,x:i})) });
    lines.push({ type:'xy-anti', id:`xy-anti-${z}`, cells: Array.from({length:N5},(_,i)=>({z,y:i,x:N5-1-i})) });
  }
  for(let y=0;y<N5;y++){
    lines.push({ type:'xz-main', id:`xz-main-${y}`, cells: Array.from({length:N5},(_,i)=>({z:i,y,x:i})) });
    lines.push({ type:'xz-anti', id:`xz-anti-${y}`, cells: Array.from({length:N5},(_,i)=>({z:i,y,x:N5-1-i})) });
  }
  for(let x=0;x<N5;x++){
    lines.push({ type:'yz-main', id:`yz-main-${x}`, cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x})) });
    lines.push({ type:'yz-anti', id:`yz-anti-${x}`, cells: Array.from({length:N5},(_,i)=>({z:i,y:N5-1-i,x})) });
  }
  lines.push({ type:'space', id:'space-1', cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x:i})) });
  lines.push({ type:'space', id:'space-2', cells: Array.from({length:N5},(_,i)=>({z:i,y:i,x:N5-1-i})) });
  lines.push({ type:'space', id:'space-3', cells: Array.from({length:N5},(_,i)=>({z:i,y:N5-1-i,x:i})) });
  lines.push({ type:'space', id:'space-4', cells: Array.from({length:N5},(_,i)=>({z:N5-1-i,y:i,x:i})) });
  return lines;
}

module.exports = {
  N5,
  CUBE_DATA,
  MOVABLE_RAW,
  buildLines109,
};
