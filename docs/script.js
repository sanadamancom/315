"use strict";

// ============================================================
// Perfect Magic Cube of Order 5 — voxel viewer
// cube[z][y][x], all axes 0..4
// ============================================================
const CUBE = [
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

const GRID = 5;
const CENTER = GRID / 2;
const GAP_COUNT = GRID - 1;
const CENTER_IDX = 2; // block index of the layer/row/column containing cell "63" — fixed anchor
const SEP_EPS = 0.03;
const SEP_FIXED_OPEN = 3.2;
const ARROW_LEN = 0.24;
const ARROW_HALF_W = 0.17;

const LAYER_COLOR_RGB = [
  [154, 59, 59],
  [143, 122, 52],
  [63, 122, 78],
  [46, 110, 107],
  [39, 67, 97],
];
function shade(rgb, factor) {
  const r = Math.min(255, Math.round(rgb[0] * factor));
  const g = Math.min(255, Math.round(rgb[1] * factor));
  const b = Math.min(255, Math.round(rgb[2] * factor));
  return `rgb(${r},${g},${b})`;
}

// ---------------- math ----------------
function multiply(a, b) {
  const r = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}
function applyMatrix(m, v) {
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  };
}
function orthonormalize(m) {
  const row = (i) => ({ x: m[i][0], y: m[i][1], z: m[i][2] });
  const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = (a) => {
    const l = Math.sqrt(dot3(a, a)) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  };
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const scl = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const r0 = norm(row(0));
  let r1 = norm(sub(row(1), scl(r0, dot3(row(1), r0))));
  const r2 = cross(r0, r1);
  return [
    [r0.x, r0.y, r0.z],
    [r1.x, r1.y, r1.z],
    [r2.x, r2.y, r2.z],
  ];
}
function lerpMatrix(a, b, t) {
  const r = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i][j] = a[i][j] + (b[i][j] - a[i][j]) * t;
  return orthonormalize(r);
}
function rotateAroundAxis(k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const { x, y, z } = k;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
function rotX(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}
function rotY(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}
function rotZ(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}
const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function toWorld(cx, cy, cz) {
  return { x: cx - CENTER, y: CENTER - cz, z: cy - CENTER };
}
function dirToWorld(d) {
  return { x: d.x, y: -d.z, z: d.y };
}
function norm3(v) {
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function sub3(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// ---------------- camera ----------------
const VCAM_N = norm3({ x: 1, y: 1, z: 1 });
const LIGHT_N = norm3({ x: 0.35, y: 1, z: 0.55 });
const CAM_DIST = 18;
const CAMERA_POS = { x: VCAM_N.x * CAM_DIST, y: VCAM_N.y * CAM_DIST, z: VCAM_N.z * CAM_DIST };
const FORWARD = { x: -VCAM_N.x, y: -VCAM_N.y, z: -VCAM_N.z };
const WORLD_UP = { x: 0, y: 1, z: 0 };
const CAM_RIGHT = norm3(cross3(FORWARD, WORLD_UP));
const CAM_UP = cross3(CAM_RIGHT, FORWARD);
const FOCAL = CAM_DIST;
const PERSPECTIVE_SCALE = 66;
function project(v) {
  const rel = sub3(v, CAMERA_POS);
  const viewX = dot(rel, CAM_RIGHT);
  const viewY = dot(rel, CAM_UP);
  const viewZ = dot(rel, FORWARD);
  const f = (FOCAL / viewZ) * PERSPECTIVE_SCALE;
  return { x: viewX * f, y: -viewY * f };
}

// ---------------- face directions ----------------
// gapKey/gapIndex identify which per-column gap array a given face borders.
const FACE_DIRS = [
  {
    axis: "+X",
    gapKey: "x",
    gapIndex: (x) => x,
    hasNeighbor: (x) => x < GRID - 1,
    corners: (x, y, z) => [
      [x + 1, y, z],
      [x + 1, y + 1, z],
      [x + 1, y + 1, z + 1],
      [x + 1, y, z + 1],
    ],
    normalData: { x: 1, y: 0, z: 0 },
  },
  {
    axis: "-X",
    gapKey: "x",
    gapIndex: (x) => x - 1,
    hasNeighbor: (x) => x > 0,
    corners: (x, y, z) => [
      [x, y, z],
      [x, y, z + 1],
      [x, y + 1, z + 1],
      [x, y + 1, z],
    ],
    normalData: { x: -1, y: 0, z: 0 },
  },
  {
    axis: "+Y",
    gapKey: "y",
    gapIndex: (x, y) => y,
    hasNeighbor: (x, y) => y < GRID - 1,
    corners: (x, y, z) => [
      [x, y + 1, z],
      [x + 1, y + 1, z],
      [x + 1, y + 1, z + 1],
      [x, y + 1, z + 1],
    ],
    normalData: { x: 0, y: 1, z: 0 },
  },
  {
    axis: "-Y",
    gapKey: "y",
    gapIndex: (x, y) => y - 1,
    hasNeighbor: (x, y) => y > 0,
    corners: (x, y, z) => [
      [x, y, z],
      [x, y, z + 1],
      [x + 1, y, z + 1],
      [x + 1, y, z],
    ],
    normalData: { x: 0, y: -1, z: 0 },
  },
  {
    axis: "+Z",
    gapKey: "z",
    gapIndex: (x, y, z) => z,
    hasNeighbor: (x, y, z) => z < GRID - 1,
    corners: (x, y, z) => [
      [x, y, z + 1],
      [x + 1, y, z + 1],
      [x + 1, y + 1, z + 1],
      [x, y + 1, z + 1],
    ],
    normalData: { x: 0, y: 0, z: 1 },
  },
  {
    axis: "-Z",
    gapKey: "z",
    gapIndex: (x, y, z) => z - 1,
    hasNeighbor: (x, y, z) => z > 0,
    corners: (x, y, z) => [
      [x, y, z],
      [x + 1, y, z],
      [x + 1, y + 1, z],
      [x, y + 1, z],
    ],
    normalData: { x: 0, y: 0, z: -1 },
  },
];

const AXIS_BELOW_SIGN = { x: -1, y: -1, z: 1 };

// ---------------- per-unit gap state ----------------
// gaps.x[y][z] = [g0..g3]   (boundary between block x & x+1, at that y,z column)
// gaps.y[x][z] = [g0..g3]   (boundary between block y & y+1, at that x,z column)
// gaps.z[x][y] = [g0..g3]   (boundary between block z & z+1, at that x,y column)
function makeGapGrid() {
  const grid = [];
  for (let a = 0; a < GRID; a++) {
    const row = [];
    for (let b = 0; b < GRID; b++) row.push([0, 0, 0, 0]);
    grid.push(row);
  }
  return grid;
}
function makeEmptyGaps() {
  return { x: makeGapGrid(), y: makeGapGrid(), z: makeGapGrid() };
}
function gapArrFor(gaps, gapKey, x, y, z) {
  if (gapKey === "x") return gaps.x[y][z];
  if (gapKey === "y") return gaps.y[x][z];
  return gaps.z[x][y];
}
function axisOffset(gapArr, idx, belowSign) {
  if (idx === CENTER_IDX) return 0;
  if (idx < CENTER_IDX) {
    let s = 0;
    for (let j = idx; j < CENTER_IDX; j++) s += gapArr[j];
    return belowSign * s;
  }
  let s = 0;
  for (let j = CENTER_IDX; j < idx; j++) s += gapArr[j];
  return -belowSign * s;
}
function blockOffset(x, y, z, gaps) {
  return {
    x: axisOffset(gaps.x[y][z], x, AXIS_BELOW_SIGN.x),
    y: axisOffset(gaps.z[x][y], z, AXIS_BELOW_SIGN.z),
    z: axisOffset(gaps.y[x][z], y, AXIS_BELOW_SIGN.y),
  };
}
function movingBlockForGap(g) {
  return g < CENTER_IDX ? g : g + 1;
}

// ============================================================
// state
// ============================================================
let displayMatrix = IDENTITY;
let targetMatrix = IDENTITY;
let gapsDisplay = makeEmptyGaps();
let gapsTarget = makeEmptyGaps();
let hoveredKey = null;

let isBgDragging = false;
let lastPos = { x: 0, y: 0 };
let box = { w: 800, h: 800 };
const CONTENT_SIZE = 1100;
const DRAG_SENS = 0.008;

const svg = document.getElementById("scene");
const stage = document.getElementById("stage");

// ---------------- rotation controls ----------------
function rotateStep(fn, angle) {
  targetMatrix = multiply(fn(angle), targetMatrix);
}
document.querySelectorAll("#toolbar button[data-rot]").forEach((btn) => {
  const map = { "x+": [rotX, 1], "x-": [rotX, -1], "y+": [rotY, 1], "y-": [rotY, -1], "z+": [rotZ, 1], "z-": [rotZ, -1] };
  const [fn, sign] = map[btn.dataset.rot];
  btn.addEventListener("click", () => rotateStep(fn, sign * (Math.PI / 2)));
});
document.getElementById("resetRotation").addEventListener("click", () => {
  targetMatrix = IDENTITY;
});
document.getElementById("closeAll").addEventListener("click", () => {
  gapsTarget = makeEmptyGaps();
});

// ---------------- background drag (rotation) ----------------
svg.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".gap-hit")) return; // let the gap element handle it
  isBgDragging = true;
  svg.classList.add("dragging");
  lastPos = { x: e.clientX, y: e.clientY };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener("pointermove", (e) => {
  if (!isBgDragging) return;
  const dx = e.clientX - lastPos.x;
  const dy = e.clientY - lastPos.y;
  lastPos = { x: e.clientX, y: e.clientY };
  const yawRot = rotateAroundAxis(CAM_UP, -dx * DRAG_SENS);
  const pitchRot = rotateAroundAxis(CAM_RIGHT, -dy * DRAG_SENS);
  targetMatrix = multiply(yawRot, multiply(pitchRot, targetMatrix));
});
function endBgDrag() {
  isBgDragging = false;
  svg.classList.remove("dragging");
}
svg.addEventListener("pointerup", endBgDrag);
svg.addEventListener("pointercancel", endBgDrag);

// ---------------- gap element interaction (event delegation) ----------------
svg.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".gap-hit");
  if (el) e.stopPropagation();
});
svg.addEventListener("click", (e) => {
  const el = e.target.closest(".gap-hit");
  if (!el) return;
  const gapKey = el.dataset.gapKey;
  const a = parseInt(el.dataset.a, 10);
  const b = parseInt(el.dataset.b, 10);
  const g = parseInt(el.dataset.g, 10);
  const arr = gapsTarget[gapKey][a][b];
  gapsTarget[gapKey][a][b] = arr.map((v, i) => (i === g ? (v > SEP_EPS ? 0 : SEP_FIXED_OPEN) : v));
});
svg.addEventListener(
  "mouseover",
  (e) => {
    const el = e.target.closest(".gap-hit");
    hoveredKey = el ? el.dataset.key : null;
  },
  true
);
svg.addEventListener(
  "mouseout",
  (e) => {
    const el = e.target.closest(".gap-hit");
    if (el && el.dataset.key === hoveredKey) hoveredKey = null;
  },
  true
);

// ---------------- resize ----------------
const ro = new ResizeObserver((entries) => {
  const cr = entries[0].contentRect;
  if (cr.width > 0 && cr.height > 0) box = { w: cr.width, h: cr.height };
});
ro.observe(stage);

// ============================================================
// render
// ============================================================
function computeFaces() {
  const list = [];
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const value = CUBE[z][y][x];
        const off = blockOffset(x, y, z, gapsDisplay);
        for (const dir of FACE_DIRS) {
          const interior = dir.hasNeighbor(x, y, z);
          let isOpen = true;
          let gapArr = null;
          let gIdx = -1;
          let a = 0,
            b = 0;
          if (interior) {
            gIdx = dir.gapIndex(x, y, z);
            if (dir.gapKey === "x") {
              a = y;
              b = z;
            } else if (dir.gapKey === "y") {
              a = x;
              b = z;
            } else {
              a = x;
              b = y;
            }
            gapArr = gapArrFor(gapsDisplay, dir.gapKey, x, y, z);
            isOpen = gapArr[gIdx] > SEP_EPS;
          }

          const worldNormal = applyMatrix(displayMatrix, dirToWorld(dir.normalData));
          const cornersData = dir.corners(x, y, z);
          const worldCorners = cornersData.map(([cx, cy, cz]) => {
            const w = toWorld(cx, cy, cz);
            return { x: w.x + off.x, y: w.y + off.y, z: w.z + off.z };
          });
          const rotated = worldCorners.map((w) => applyMatrix(displayMatrix, w));
          const screen = rotated.map(project);
          const depth = rotated.reduce((s, c) => s + dot(c, VCAM_N), 0) / rotated.length;
          const brightness = 0.42 + 0.75 * Math.max(0, dot(worldNormal, LIGHT_N));

          const key = interior ? `${dir.gapKey}:${a}:${b}:${gIdx}` : null;
          const hovered = key !== null && key === hoveredKey;

          let fill, fillOpacity, strokeColor, strokeWidth;
          if (!interior) {
            fill = shade(LAYER_COLOR_RGB[z], brightness);
            fillOpacity = 1;
            strokeColor = "#0A0D13";
            strokeWidth = 1;
          } else if (isOpen) {
            fill = shade(LAYER_COLOR_RGB[z], brightness);
            fillOpacity = 1;
            strokeColor = hovered ? "#4ADE80" : "#0A0D13";
            strokeWidth = hovered ? 3 : 1;
          } else {
            fill = "#000000";
            fillOpacity = 0.001;
            strokeColor = hovered ? "#5AAFE0" : "transparent";
            strokeWidth = hovered ? 3 : 0;
          }

          let arrow = null;
          if (interior && hovered) {
            const center = {
              x: worldCorners.reduce((s, c) => s + c.x, 0) / worldCorners.length,
              y: worldCorners.reduce((s, c) => s + c.y, 0) / worldCorners.length,
              z: worldCorners.reduce((s, c) => s + c.z, 0) / worldCorners.length,
            };
            const pointDir = dirToWorld(dir.normalData);
            const pointSign = isOpen ? -1 : 1;
            const widthVec = sub3(worldCorners[1], worldCorners[0]);
            const widthLen = Math.sqrt(dot(widthVec, widthVec)) || 1;
            const widthDir = { x: widthVec.x / widthLen, y: widthVec.y / widthLen, z: widthVec.z / widthLen };
            const tip = {
              x: center.x + pointDir.x * pointSign * ARROW_LEN,
              y: center.y + pointDir.y * pointSign * ARROW_LEN,
              z: center.z + pointDir.z * pointSign * ARROW_LEN,
            };
            const base1 = {
              x: center.x + widthDir.x * ARROW_HALF_W,
              y: center.y + widthDir.y * ARROW_HALF_W,
              z: center.z + widthDir.z * ARROW_HALF_W,
            };
            const base2 = {
              x: center.x - widthDir.x * ARROW_HALF_W,
              y: center.y - widthDir.y * ARROW_HALF_W,
              z: center.z - widthDir.z * ARROW_HALF_W,
            };
            arrow = [tip, base1, base2].map((p) => project(applyMatrix(displayMatrix, p)));
          }

          list.push({
            key: `${x}-${y}-${z}-${dir.axis}`,
            screen,
            value,
            fill,
            fillOpacity,
            strokeColor,
            strokeWidth,
            depth,
            interior,
            gapKey: dir.gapKey,
            a,
            b,
            gIdx,
            hoverKey: key,
            isOpen,
            arrow,
          });
        }
      }
  list.sort((p, q) => p.depth - q.depth);
  return list;
}

function svgPoints(pts) {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function render() {
  const faces = computeFaces();

  const aspect = box.w / box.h || 1;
  let vw, vh;
  if (aspect >= 1) {
    vh = CONTENT_SIZE;
    vw = CONTENT_SIZE * aspect;
  } else {
    vw = CONTENT_SIZE;
    vh = CONTENT_SIZE / aspect;
  }
  svg.setAttribute("viewBox", `${-vw / 2} ${-vh / 2} ${vw} ${vh}`);

  let html = "";
  for (const f of faces) {
    const cx = f.screen.reduce((s, p) => s + p.x, 0) / f.screen.length;
    const cy = f.screen.reduce((s, p) => s + p.y, 0) / f.screen.length;
    const pts = svgPoints(f.screen);

    const gapAttrs = f.interior
      ? ` class="gap-hit" data-gap-key="${f.gapKey}" data-a="${f.a}" data-b="${f.b}" data-g="${f.gIdx}" data-key="${f.hoverKey}"`
      : "";

    html += `<g${gapAttrs}>`;
    html += `<polygon points="${pts}" fill="${f.fill}" fill-opacity="${f.fillOpacity}" stroke="${f.strokeColor}" stroke-width="${f.strokeWidth}"></polygon>`;
    if (!f.interior || f.isOpen) {
      html += `<text class="cell-value" x="${cx.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#F6ECD6">${f.value}</text>`;
    }
    if (f.arrow) {
      const arrowFill = f.isOpen ? "#4ADE80" : "#5AAFE0";
      html += `<polygon class="gap-visual" points="${svgPoints(f.arrow)}" fill="${arrowFill}" stroke="#0A0D13" stroke-width="1.5"></polygon>`;
    }
    html += `</g>`;
  }
  svg.innerHTML = html;
}

// ============================================================
// animation loop
// ============================================================
function tick() {
  displayMatrix = lerpMatrix(displayMatrix, targetMatrix, 0.35);
  for (const axisKey of ["x", "y", "z"]) {
    for (let a = 0; a < GRID; a++) {
      for (let b = 0; b < GRID; b++) {
        const disp = gapsDisplay[axisKey][a][b];
        const targ = gapsTarget[axisKey][a][b];
        for (let g = 0; g < GAP_COUNT; g++) {
          disp[g] += (targ[g] - disp[g]) * 0.35;
        }
      }
    }
  }
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
