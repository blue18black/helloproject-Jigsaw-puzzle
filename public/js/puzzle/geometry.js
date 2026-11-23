// ピースの形（凸凹）を作るモジュール。
// 隣り合うピースは同じ「辺」を共有するので、辺ごとに一度だけ曲線を作り、
// 両側のピースがそれを順方向／逆方向にたどることで形がぴったり噛み合う。

/** シード付き乱数（同じシードなら同じ形を再現できる＝途中保存の復元に使う） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 単位辺 (0,0)→(1,0) 上の「出っ張り」の形。先頭の点 + 3次ベジェ(制御点2つ+終点)×4。
// v はピースの外側への出っ張り量（ピースサイズ比）。
const TAB = [
  [0, 0],
  [0.35, 0], [0.42, 0.05], [0.37, 0.12],
  [0.30, 0.22], [0.40, 0.27], [0.50, 0.27],
  [0.60, 0.27], [0.70, 0.22], [0.63, 0.12],
  [0.58, 0.05], [0.65, 0], [1, 0],
];
export const TAB_HEIGHT = 0.27;

function tabPoints(rand) {
  const dir = rand() < 0.5 ? -1 : 1; // 出っ張りの向き
  const shift = (rand() - 0.5) * 0.1; // 位置を少しずらして単調さを消す
  const height = 0.9 + rand() * 0.2;
  return TAB.map(([u, v], i) =>
    i === 0 || i === TAB.length - 1 ? [u, v] : [u + shift, v * height * dir],
  );
}

/**
 * パズル全体の辺を生成する。
 * hEdges[r][c]: r 行目の上辺（r=0, r=rows は外枠）
 * vEdges[r][c]: c 列目の左辺（c=0, c=cols は外枠）
 * 各辺は絶対座標の点列 [p0, c1, c2, p1, c1, c2, p2, ...]
 */
export function buildEdges(cols, rows, pw, ph, seed) {
  const rand = mulberry32(seed);
  const s = Math.min(pw, ph);
  const hEdges = [];
  for (let r = 0; r <= rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const x0 = c * pw, y = r * ph;
      if (r === 0 || r === rows) {
        row.push([[x0, y], [x0, y], [x0 + pw, y], [x0 + pw, y]]);
      } else {
        row.push(tabPoints(rand).map(([u, v]) => [x0 + u * pw, y + v * s]));
      }
    }
    hEdges.push(row);
  }
  const vEdges = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c <= cols; c++) {
      const x = c * pw, y0 = r * ph;
      if (c === 0 || c === cols) {
        row.push([[x, y0], [x, y0], [x, y0 + ph], [x, y0 + ph]]);
      } else {
        row.push(tabPoints(rand).map(([u, v]) => [x + v * s, y0 + u * ph]));
      }
    }
    vEdges.push(row);
  }
  return { hEdges, vEdges };
}

/** ピース (c, r) の輪郭を、ピース左上を原点とするローカル座標の Path2D で返す */
export function piecePath(edges, c, r, pw, ph) {
  const ox = c * pw, oy = r * ph;
  const top = edges.hEdges[r][c];
  const right = edges.vEdges[r][c + 1];
  const bottom = [...edges.hEdges[r + 1][c]].reverse();
  const left = [...edges.vEdges[r][c]].reverse();

  const path = new Path2D();
  path.moveTo(top[0][0] - ox, top[0][1] - oy);
  for (const edge of [top, right, bottom, left]) {
    for (let i = 1; i < edge.length; i += 3) {
      path.bezierCurveTo(
        edge[i][0] - ox, edge[i][1] - oy,
        edge[i + 1][0] - ox, edge[i + 1][1] - oy,
        edge[i + 2][0] - ox, edge[i + 2][1] - oy,
      );
    }
  }
  path.closePath();
  return path;
}
