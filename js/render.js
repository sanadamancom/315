// render.js — SVG board construction + status/label computation.
// Depends on generator.js being loaded first (N, LEVELS, TARGET, LEVEL_COLOR, LEVEL_LINE_COLOR).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Compact tile sizing so the whole board fits a Full HD screen without scrolling.
const TILE_W = 100, TILE_H = 55, CELL_WALL = 55;
const MARGIN_X = 62, MARGIN_TOP = 10, MARGIN_BOTTOM = 38;
const STACK_DW = 400, STACK_DH = 220;

function vertexPoint(i, j, w, h, originX){
  return { x: originX + (j - i) * (w/2), y: (j + i) * (h/2) };
}
function pointsAttr(pts){
  return pts.map(p => `${p.x},${p.y}`).join(' ');
}

// Prototype 06: 現在偏差の2段階bandを表す縦積みの点(SVG円)を1組作る共通helper。
// テキストラベルの直後へ挿入する想定。初期状態は非表示(display:none)。
// 位置(x,y)は呼び出し側(repair-main.js)が対応テキストの実測bboxから設定し直す。
function createBandIndicator(className){
  const g = document.createElementNS(SVG_NS,'g');
  g.setAttribute('class', `band-indicator ${className}`);
  g.style.display = 'none';
  const chevronTop = document.createElementNS(SVG_NS,'path');
  chevronTop.setAttribute('class','band-chevron band-chevron-top');
  chevronTop.style.display = 'none';
  const dot1 = document.createElementNS(SVG_NS,'circle');
  dot1.setAttribute('class','band-dot band-dot-1');
  dot1.setAttribute('r','1.7');
  const dot2 = document.createElementNS(SVG_NS,'circle');
  dot2.setAttribute('class','band-dot band-dot-2');
  dot2.setAttribute('r','1.7');
  const chevronBottom = document.createElementNS(SVG_NS,'path');
  chevronBottom.setAttribute('class','band-chevron band-chevron-bottom');
  chevronBottom.style.display = 'none';
  g.appendChild(chevronTop);
  g.appendChild(dot1);
  g.appendChild(dot2);
  g.appendChild(chevronBottom);
  return g;
}

function addGridLines(svg, nCells, tileW, tileH, originX, stroke){
  const path = document.createElementNS(SVG_NS,'path');
  let d = '';
  for(let i=0;i<=nCells;i++){
    const a = vertexPoint(i,0,tileW,tileH,originX);
    const b = vertexPoint(i,nCells,tileW,tileH,originX);
    d += `M ${a.x} ${a.y} L ${b.x} ${b.y} `;
  }
  for(let j=0;j<=nCells;j++){
    const a = vertexPoint(0,j,tileW,tileH,originX);
    const b = vertexPoint(nCells,j,tileW,tileH,originX);
    d += `M ${a.x} ${a.y} L ${b.x} ${b.y} `;
  }
  path.setAttribute('d', d.trim());
  path.setAttribute('stroke', stroke || 'rgba(0,0,0,0.35)');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('fill', 'none');
  path.style.pointerEvents = 'none';
  svg.appendChild(path);
}

// ---- line status / label text (aware of the sum/remaining + show/hide toggles) ----

function lineStatus(values, target){
  const known = values.filter(v => v !== null);
  if(known.length < values.length) return 'warn';
  const sum = known.reduce((a,b)=>a+b,0);
  return sum === target ? 'ok' : 'bad';
}

function lineBadge(values, target){
  const known = values.filter(v => v !== null);
  const blanks = values.length - known.length;
  const sum = known.reduce((a,b)=>a+b,0);
  const cls = blanks === 0 ? (sum === target ? 'ok' : 'bad') : 'warn';
  const sumText = String(sum);
  const remainText = String(target - sum);
  const filledText = `${values.length - blanks}/${values.length}`;
  return { cls, sumText, remainText, filledText, blanks };
}

// Compose what a label should display, based on the current (mutually exclusive) labelMode
// owned by main.js: 'sum' | 'remaining' | 'fillcount' | 'off'.
function composeLabelText(badge){
  if(labelMode === 'off') return '';
  if(labelMode === 'remaining') return badge.remainText;
  if(labelMode === 'fillcount') return badge.filledText;
  return badge.sumText;
}

function cellStatus(L,r,c){
  const rowVals = Array.from({length:N},(_,cc)=>grid[L][r][cc]);
  const colVals = Array.from({length:N},(_,rr)=>grid[L][rr][c]);
  const depthVals = Array.from({length:LEVELS},(_,i)=>grid[i+1][r][c]);
  const statuses = [lineStatus(rowVals,TARGET), lineStatus(colVals,TARGET), lineStatus(depthVals,TARGET)];
  if(r===c){
    const mainVals = Array.from({length:N},(_,i)=>grid[L][i][i]);
    statuses.push(lineStatus(mainVals,TARGET));
  }
  if(r+c===N-1){
    const antiVals = Array.from({length:N},(_,i)=>grid[L][i][N-1-i]);
    statuses.push(lineStatus(antiVals,TARGET));
  }
  // 空間対角線: セル(L,r,c)が乗る対角線は、tパラメータ t=L-1 において
  // r = t または 4-t かつ c = t または 4-t のとき
  const t = L-1;
  const rSigns = []; if(r===t) rSigns.push(1); if(r===N-1-t) rSigns.push(-1);
  const cSigns = []; if(c===t) cSigns.push(1); if(c===N-1-t) cSigns.push(-1);
  for(const rs of rSigns){
    for(const cs of cSigns){
      const vals = Array.from({length:LEVELS},(_,i)=>{
        const rr = rs===1 ? i : N-1-i;
        const ccc = cs===1 ? i : N-1-i;
        return grid[i+1][rr][ccc];
      });
      statuses.push(lineStatus(vals,TARGET));
    }
  }
  if(statuses.includes('bad')) return 'bad';
  if(statuses.every(s=>s==='ok')) return 'ok';
  return 'warn';
}

// ---- board construction ----

function buildStack3D(){
  const dw = STACK_DW, dh = STACK_DH, nCells = 5;
  const tileW = dw/nCells, tileH = dh/nCells, originX = dw/2;
  const wallDepth = tileH;
  const offsetStep = wallDepth;
  const totalH = dh + wallDepth + offsetStep*4;

  const PAD = 8; // 図の外周余白 (バッジはキューブ内に埋め込むため最小限)
  const svg = document.createElementNS(SVG_NS,'svg');
  svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${dw + PAD*2} ${totalH + PAD*2}`);
  svg.setAttribute('width', dw + PAD*2);
  svg.setAttribute('height', totalH + PAD*2);
  svg.classList.add('stack3d-svg');

  // 空間対角線4本の可視化用: 各レベルの通過セル中心を後で結ぶ
  const triagDefs = [
    { id:'mm', rs: 1, cs: 1 },
    { id:'ma', rs: 1, cs:-1 },
    { id:'am', rs:-1, cs: 1 },
    { id:'aa', rs:-1, cs:-1 },
  ];
  const cellCenter = (L, r, c)=>{
    const yOff = (5-L)*offsetStep;
    const p1 = vertexPoint(r,c,tileW,tileH,originX);
    const p3 = vertexPoint(r+1,c+1,tileW,tileH,originX);
    return { x:(p1.x+p3.x)/2, y:(p1.y+p3.y)/2 + yOff };
  };

  [1,2,3,4,5].forEach(L=>{
    const yOff = (5-L)*offsetStep;
    const g = document.createElementNS(SVG_NS,'g');
    g.setAttribute('transform', `translate(0, ${yOff})`);

    for(let r=0;r<nCells;r++){
      for(let c=0;c<nCells;c++){
        if(r === nCells-1){
          const left = vertexPoint(r+1,c,tileW,tileH,originX);
          const bottom = vertexPoint(r+1,c+1,tileW,tileH,originX);
          const poly = document.createElementNS(SVG_NS,'polygon');
          poly.setAttribute('points', pointsAttr([
            left, bottom,
            {x:bottom.x, y:bottom.y+wallDepth}, {x:left.x, y:left.y+wallDepth}
          ]));
          poly.setAttribute('fill', LEVEL_COLOR[L]);
          poly.setAttribute('fill-opacity', '0.62');
          poly.setAttribute('stroke', LEVEL_LINE_COLOR[L]);
          poly.setAttribute('stroke-width', '1.3');
          poly.style.filter = 'brightness(0.6)'; poly.style.pointerEvents = 'none';
          poly.setAttribute('class', 'stack-wall');
          poly.dataset.l = L; poly.dataset.r = r; poly.dataset.c = c;
          g.appendChild(poly);
        }
        if(c === nCells-1){
          const right = vertexPoint(r,c+1,tileW,tileH,originX);
          const bottom = vertexPoint(r+1,c+1,tileW,tileH,originX);
          const poly = document.createElementNS(SVG_NS,'polygon');
          poly.setAttribute('points', pointsAttr([
            bottom, right,
            {x:right.x, y:right.y+wallDepth}, {x:bottom.x, y:bottom.y+wallDepth}
          ]));
          poly.setAttribute('fill', LEVEL_COLOR[L]);
          poly.setAttribute('fill-opacity', '0.62');
          poly.setAttribute('class', 'stack-wall');
          poly.dataset.l = L; poly.dataset.r = r; poly.dataset.c = c;
          poly.setAttribute('stroke', LEVEL_LINE_COLOR[L]);
          poly.setAttribute('stroke-width', '1.3');
          poly.style.filter = 'brightness(0.44)'; poly.style.pointerEvents = 'none';
          g.appendChild(poly);
        }
      }
    }

    for(let r=0;r<nCells;r++){
      for(let c=0;c<nCells;c++){
        const p1 = vertexPoint(r,c,tileW,tileH,originX);
        const p2 = vertexPoint(r,c+1,tileW,tileH,originX);
        const p3 = vertexPoint(r+1,c+1,tileW,tileH,originX);
        const p4 = vertexPoint(r+1,c,tileW,tileH,originX);
        const center = { x:(p1.x+p3.x)/2, y:(p1.y+p3.y)/2 };

        const cellG = document.createElementNS(SVG_NS,'g');
        cellG.setAttribute('class', 'stack-cell');
        cellG.dataset.l = L; cellG.dataset.r = r; cellG.dataset.c = c;

        const poly = document.createElementNS(SVG_NS,'polygon');
        poly.setAttribute('class','cube-face');
        poly.setAttribute('points', pointsAttr([p1,p2,p3,p4]));
        poly.setAttribute('fill', LEVEL_COLOR[L]);
        poly.setAttribute('fill-opacity', '0.62');
        poly.setAttribute('stroke', LEVEL_COLOR[L]);
        poly.setAttribute('stroke-width', '1');
        cellG.appendChild(poly);

        if(L === 5){
          cellG.classList.add('clickable');
          cellG.addEventListener('click', ()=> onDepthClick(r,c));
          const text = document.createElementNS(SVG_NS,'text');
          text.setAttribute('class','stack-label');
          text.setAttribute('x', center.x);
          text.setAttribute('y', center.y);
          text.setAttribute('text-anchor','middle');
          text.setAttribute('dominant-baseline','central');
          cellG.appendChild(text);
        }

        g.appendChild(cellG);
      }
    }
    addGridLines(g, nCells, tileW, tileH, originX, LEVEL_LINE_COLOR[L]);
    svg.appendChild(g);
  });

  // 空間対角線の折れ線 (盤面の上に薄く重ねる)
  for(const def of triagDefs){
    const pts = [];
    for(let i=0;i<LEVELS;i++){
      const r = def.rs===1 ? i : N-1-i;
      const c = def.cs===1 ? i : N-1-i;
      pts.push(cellCenter(i+1, r, c));
    }
    const line = document.createElementNS(SVG_NS,'polyline');
    line.setAttribute('points', pts.map(p=>`${p.x},${p.y}`).join(' '));
    line.setAttribute('class', `triag-line triag-${def.id}`);
    line.setAttribute('fill', 'none');
    svg.appendChild(line);
  }

  // 対角線ラベル: 上面の縦列ラベルと同じ流儀で「キューブの壁面」に数値を配置し、
  // その壁面自体をクリック可能にする。配置は各対角線が可視面に現れる端点の壁:
  //   ma: L5(5,1)の左壁 (左上)   / mm: L5(5,5)の手前左壁 (中央)
  //   am: L1(5,1)の左壁 (左下)   / aa: L1(5,5)の手前左壁 (最下部)
  const bottomOff = offsetStep * 4; // L1のyオフセット
  const wallFace = (i0,j0,i1,j1,yAdd)=>{
    const A = vertexPoint(i0,j0,tileW,tileH,originX);
    const B = vertexPoint(i1,j1,tileW,tileH,originX);
    return {
      pts: [
        { x:A.x, y:A.y+yAdd },
        { x:B.x, y:B.y+yAdd },
        { x:B.x, y:B.y+yAdd+wallDepth },
        { x:A.x, y:A.y+yAdd+wallDepth },
      ],
      cx: (A.x+B.x)/2,
      cy: (A.y+B.y)/2 + yAdd + wallDepth/2,
    };
  };
  // すべて実在する可視壁(前面左エッジ i=5)のセグメント上に配置する。
  // 旧配置(j=0の左上境界)は壁が存在せず立体的に奥へ沈んで見えていた。
  const badgeFaces = {
    ma: wallFace(5,0, 5,1, 0),          // L5 前面左端の壁 (セル(5,1)の正面)
    mm: wallFace(5,4, 5,5, 0),          // L5 前面中央の壁 (セル(5,5)の正面)
    am: wallFace(5,0, 5,1, bottomOff),  // L1 前面左端の壁
    aa: wallFace(5,4, 5,5, bottomOff),  // L1 前面中央の壁
  };
  for(const def of triagDefs){
    const f = badgeFaces[def.id];
    const bg = document.createElementNS(SVG_NS,'g');
    bg.setAttribute('class', `triag-badge triag-badge-${def.id}`);
    bg.dataset.triag = def.id;
    const info = TRIAG_INFO_DEFS.find(d=>d.id===def.id);
    const tip = document.createElementNS(SVG_NS,'title');
    tip.textContent = `空間対角線 ${info ? info.label : def.id} — クリックで対象マスをハイライト`;
    bg.appendChild(tip);
    const face = document.createElementNS(SVG_NS,'polygon');
    face.setAttribute('points', pointsAttr(f.pts));
    face.setAttribute('class','triag-badge-bg');
    bg.appendChild(face);
    const txt = document.createElementNS(SVG_NS,'text');
    txt.setAttribute('x', f.cx);
    txt.setAttribute('y', f.cy);
    txt.setAttribute('text-anchor','middle');
    txt.setAttribute('dominant-baseline','central');
    txt.setAttribute('class','triag-badge-text');
    bg.appendChild(txt);
    bg.addEventListener('click', ()=> onTriagClick(def.id));
    svg.appendChild(bg);
  }

  return svg;
}

function buildLevelCard(L){
  const card = document.createElement('div');
  card.className = 'level-card';
  card.id = `card-${L}`;

  const rawW = TILE_W*N, rawH = TILE_H*N + CELL_WALL;
  const totalW = rawW + MARGIN_X*2, totalH = rawH + MARGIN_TOP + MARGIN_BOTTOM;
  const originX = MARGIN_X + rawW/2;

  const svg = document.createElementNS(SVG_NS,'svg');
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  svg.setAttribute('width', totalW);
  svg.setAttribute('height', totalH);
  svg.classList.add('level-svg');

  const board = document.createElementNS(SVG_NS,'g');
  board.setAttribute('transform', `translate(0, ${MARGIN_TOP})`);
  svg.appendChild(board);

  for(let r=0;r<N;r++){
    for(let c=0;c<N;c++){
      if(r === N-1){
        const left = vertexPoint(r+1,c,TILE_W,TILE_H,originX);
        const bottom = vertexPoint(r+1,c+1,TILE_W,TILE_H,originX);
        const poly = document.createElementNS(SVG_NS,'polygon');
        poly.setAttribute('points', pointsAttr([
          left, bottom,
          {x:bottom.x, y:bottom.y+CELL_WALL}, {x:left.x, y:left.y+CELL_WALL}
        ]));
        poly.setAttribute('fill', LEVEL_COLOR[L]);
        poly.setAttribute('fill-opacity', '0.62');
        poly.setAttribute('stroke', LEVEL_LINE_COLOR[L]);
        poly.setAttribute('stroke-width', '1.3');
        poly.style.filter = 'brightness(0.6)'; poly.style.pointerEvents = 'none';
        poly.setAttribute('class', 'col-wall-hit');
        poly.dataset.l = L; poly.dataset.c = c;
        board.appendChild(poly);

        // this left-facing wall segment is indexed by column c -> shows the column sum
        const cx = (left.x + bottom.x)/2, cy = (left.y + bottom.y)/2 + CELL_WALL/2;
        const label = document.createElementNS(SVG_NS,'text');
        label.setAttribute('class','wall-label col-wall-label');
        label.dataset.l = L; label.dataset.c = c;
        label.setAttribute('x', cx); label.setAttribute('y', cy);
        label.setAttribute('text-anchor','middle');
        label.setAttribute('dominant-baseline','central');
        board.appendChild(label);
        board.appendChild(createBandIndicator('col-wall-band'));
        {
          const bi = board.lastChild;
          bi.dataset.l = L; bi.dataset.c = c;
        }
      }
      if(c === N-1){
        const right = vertexPoint(r,c+1,TILE_W,TILE_H,originX);
        const bottom = vertexPoint(r+1,c+1,TILE_W,TILE_H,originX);
        const poly = document.createElementNS(SVG_NS,'polygon');
        poly.setAttribute('points', pointsAttr([
          bottom, right,
          {x:right.x, y:right.y+CELL_WALL}, {x:bottom.x, y:bottom.y+CELL_WALL}
        ]));
        poly.setAttribute('fill', LEVEL_COLOR[L]);
        poly.setAttribute('fill-opacity', '0.62');
        poly.setAttribute('stroke', LEVEL_LINE_COLOR[L]);
        poly.setAttribute('stroke-width', '1.3');
        poly.style.filter = 'brightness(0.44)'; poly.style.pointerEvents = 'none';
        poly.setAttribute('class', 'row-wall-hit');
        poly.dataset.l = L; poly.dataset.r = r;
        board.appendChild(poly);

        // this right-facing wall segment is indexed by row r -> shows the row sum
        const cx = (right.x + bottom.x)/2, cy = (right.y + bottom.y)/2 + CELL_WALL/2;
        const label = document.createElementNS(SVG_NS,'text');
        label.setAttribute('class','wall-label row-wall-label');
        label.dataset.l = L; label.dataset.r = r;
        label.setAttribute('x', cx); label.setAttribute('y', cy);
        label.setAttribute('text-anchor','middle');
        label.setAttribute('dominant-baseline','central');
        board.appendChild(label);
        board.appendChild(createBandIndicator('row-wall-band'));
        {
          const bi = board.lastChild;
          bi.dataset.l = L; bi.dataset.r = r;
        }
      }
    }
  }

  for(let r=0;r<N;r++){
    for(let c=0;c<N;c++){
      const p1 = vertexPoint(r,c,TILE_W,TILE_H,originX);
      const p2 = vertexPoint(r,c+1,TILE_W,TILE_H,originX);
      const p3 = vertexPoint(r+1,c+1,TILE_W,TILE_H,originX);
      const p4 = vertexPoint(r+1,c,TILE_W,TILE_H,originX);
      const center = { x:(p1.x+p3.x)/2, y:(p1.y+p3.y)/2 };

      const g = document.createElementNS(SVG_NS,'g');
      g.setAttribute('class', 'iso-cell empty');
      g.dataset.l = L; g.dataset.r = r; g.dataset.c = c;
      g.addEventListener('click', ()=> onCellClick(L,r,c));
      g.addEventListener('contextmenu', (e)=>{ e.preventDefault(); onCellRightClick(L,r,c); });

      const poly = document.createElementNS(SVG_NS,'polygon');
      poly.setAttribute('class','cube-face');
      poly.setAttribute('points', pointsAttr([p1,p2,p3,p4]));
      poly.setAttribute('fill', LEVEL_COLOR[L]);
      poly.setAttribute('fill-opacity', '0.62');
      poly.setAttribute('stroke', LEVEL_COLOR[L]);
      poly.setAttribute('stroke-width', '1');
      g.appendChild(poly);

      const text = document.createElementNS(SVG_NS,'text');
      text.setAttribute('class','cube-label');
      text.setAttribute('x', center.x);
      text.setAttribute('y', center.y);
      text.setAttribute('text-anchor','middle');
      text.setAttribute('dominant-baseline','central');
      g.appendChild(text);

      // 診断専用の透明な輪郭(既存のcube-face fillには一切触れない)。
      // デフォルトはfill/stroke無しで完全に透明。専用CSSクラスが付いたときだけ縁が見える。
      // 隣接セルの縁と重ならないよう、セル中心に向けて少し内側へ縮めてある。
      const DIAG_INSET = 0.84;
      const insetPt = (p) => ({ x: center.x + (p.x-center.x)*DIAG_INSET, y: center.y + (p.y-center.y)*DIAG_INSET });
      const diagOutline = document.createElementNS(SVG_NS,'polygon');
      diagOutline.setAttribute('class','cell-diag-outline');
      diagOutline.setAttribute('points', pointsAttr([p1,p2,p3,p4].map(insetPt)));
      diagOutline.setAttribute('fill','none');
      diagOutline.setAttribute('pointer-events','none');
      diagOutline.setAttribute('stroke-linejoin','round');
      g.appendChild(diagOutline);

      board.appendChild(g);
    }
  }

  addGridLines(board, N, TILE_W, TILE_H, originX, LEVEL_LINE_COLOR[L]);

  {
    const bottomV = vertexPoint(N,N,TILE_W,TILE_H,originX);
    const text = document.createElementNS(SVG_NS,'text');
    text.setAttribute('class','edge-label diag-sum-main');
    text.dataset.l = L;
    text.setAttribute('x', bottomV.x);
    text.setAttribute('y', bottomV.y + CELL_WALL + 13);
    text.setAttribute('text-anchor','middle');
    text.setAttribute('dominant-baseline','central');
    board.appendChild(text);
    board.appendChild(createBandIndicator('diag-band-main'));
    { const bi = board.lastChild; bi.dataset.l = L; }

    const hit = document.createElementNS(SVG_NS,'circle');
    hit.setAttribute('class','diag-hit diag-hit-main');
    hit.dataset.l = L;
    hit.setAttribute('cx', bottomV.x); hit.setAttribute('cy', bottomV.y + CELL_WALL + 13);
    hit.setAttribute('r', 15);
    hit.setAttribute('fill', 'transparent');
    hit.style.pointerEvents = 'none';
    board.appendChild(hit);
  }
  {
    const rightV = vertexPoint(0,N,TILE_W,TILE_H,originX);
    const text = document.createElementNS(SVG_NS,'text');
    text.setAttribute('class','edge-label diag-sum-anti');
    text.dataset.l = L;
    text.setAttribute('x', rightV.x + 13);
    text.setAttribute('y', rightV.y);
    text.setAttribute('text-anchor','start');
    text.setAttribute('dominant-baseline','central');
    board.appendChild(text);
    board.appendChild(createBandIndicator('diag-band-anti'));
    { const bi = board.lastChild; bi.dataset.l = L; }

    const hit = document.createElementNS(SVG_NS,'circle');
    hit.setAttribute('class','diag-hit diag-hit-anti');
    hit.dataset.l = L;
    hit.setAttribute('cx', rightV.x + 13); hit.setAttribute('cy', rightV.y);
    hit.setAttribute('r', 15);
    hit.setAttribute('fill', 'transparent');
    hit.style.pointerEvents = 'none';
    board.appendChild(hit);
  }

  // Large "NLEVEL" label running along the upper-right edge (top vertex -> right vertex),
  // rotated to match that edge's angle, extending outward past the corner.
  {
    const topV = vertexPoint(0,0,TILE_W,TILE_H,originX);
    const rightV = vertexPoint(0,N,TILE_W,TILE_H,originX);
    const dx = rightV.x - topV.x, dy = rightV.y - topV.y;
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const len = Math.sqrt(dx*dx + dy*dy);
    const nx = dy/len, ny = -dx/len; // outward normal (up-right, away from the tile)
    const startX = topV.x + dx*0.15 + nx*22;
    const startY = topV.y + dy*0.15 + ny*22;
    const tierLabel = document.createElementNS(SVG_NS,'text');
    tierLabel.setAttribute('class','tier-label');
    tierLabel.setAttribute('x', startX);
    tierLabel.setAttribute('y', startY);
    tierLabel.setAttribute('text-anchor','start');
    tierLabel.setAttribute('dominant-baseline','central');
    tierLabel.setAttribute('transform', `rotate(${angleDeg}, ${startX}, ${startY})`);
    tierLabel.textContent = `${L}LEVEL`;
    board.appendChild(tierLabel);
  }

  card.appendChild(svg);
  return card;
}

function buildCube(){
  const wrap = document.getElementById('cubeWrap');
  wrap.innerHTML = '';

  // Each level board's own rendered pixel footprint (must match buildLevelCard's math).
  const rawW = TILE_W*N, rawH = TILE_H*N + CELL_WALL;
  const boardW = rawW + MARGIN_X*2, boardH = rawH + MARGIN_TOP + MARGIN_BOTTOM;

  // Arrange the 5 boards in an X: one center, four corners each offset by half a
  // board-width/height so the facing corners of adjacent diamonds meet with no gap.
  const GAP = 110; // extra generous: prevents the raised-z-index center tier from overlapping (and stealing clicks from) its neighbors
  const dx = boardW/2 + GAP/2, dy = boardH/2 + GAP/2;
  const containerW = boardW + dx*2, containerH = boardH + dy*2;
  wrap.style.position = 'relative';
  wrap.style.width = containerW + 'px';
  wrap.style.height = containerH + 'px';
  wrap.style.margin = '0 auto';
  wrap.dataset.naturalWidth = containerW;
  wrap.dataset.naturalHeight = containerH;

  const positions = {
    5: { x: 0,        y: 0        }, // top-left
    4: { x: dx*2,     y: 0        }, // top-right
    3: { x: dx,       y: dy       }, // center
    2: { x: 0,        y: dy*2     }, // bottom-left
    1: { x: dx*2,     y: dy*2     }, // bottom-right
  };
  const zIndex = { 5:1, 4:1, 3:2, 2:3, 1:3 }; // bottom-row tiers (1,2) drawn frontmost, top-row (4,5) drawn backmost

  [5,4,3,2,1].forEach(L=>{
    const slot = document.createElement('div');
    slot.className = 'level-slot';
    slot.id = `slot-${L}`;
    slot.style.position = 'absolute';
    slot.style.left = positions[L].x + 'px';
    slot.style.top = positions[L].y + 'px';
    slot.style.zIndex = String(zIndex[L]);
    slot.appendChild(buildLevelCard(L));
    wrap.appendChild(slot);
  });
}

// The 4 main space diagonals (corner-to-corner through all 5 levels) ARE now part of
// the puzzle: the generator's pinned-permutation construction guarantees they sum to
// 315, the solver uses them for deduction, and checkAnswer verifies them.
const TRIAG_INFO_DEFS = [
  { id:'mm', rs: 1, cs: 1, label:'L1(1,1) → L5(5,5)' },
  { id:'ma', rs: 1, cs:-1, label:'L1(1,5) → L5(5,1)' },
  { id:'am', rs:-1, cs: 1, label:'L1(5,1) → L5(1,5)' },
  { id:'aa', rs:-1, cs:-1, label:'L1(5,5) → L5(1,1)' },
];

function triagCellsById(id){
  const def = TRIAG_INFO_DEFS.find(d=>d.id===id);
  if(!def) return [];
  return Array.from({length:LEVELS},(_,i)=>({
    L: i+1,
    r: def.rs===1 ? i : N-1-i,
    c: def.cs===1 ? i : N-1-i,
  }));
}

function triagValues(def){
  return Array.from({length:LEVELS},(_,i)=>{
    const r = def.rs===1 ? i : N-1-i;
    const c = def.cs===1 ? i : N-1-i;
    return grid[i+1][r][c];
  });
}

function refreshStackModal(){
  const miniContent = document.getElementById('miniStackContent');
  if(miniContent){
    miniContent.innerHTML = '';
    miniContent.appendChild(buildStack3D());
  }
}

