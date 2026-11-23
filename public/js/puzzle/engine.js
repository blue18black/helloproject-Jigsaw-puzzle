// ジグソーパズル本体：描画・ドラッグ・回転・吸着（スナップ）・ズーム／パン。
//
// 座標系
//   ワールド座標: パズル完成図の左上が (0,0)、右下が (W,H)。ボード枠もここに描く。
//   グループ: つながったピースの集まり。g.x, g.y は「そのグループを完成図として見たときの
//            原点 (0,0) がワールドのどこにあるか」。g.rot は 90° 単位の回転 (0〜3)。
//   → 2つのグループが正しくつながる条件は「rot が同じ かつ (x,y) が同じ」になり、
//     ボードにはまる条件は「rot=0 かつ (x,y)=(0,0)」になる。判定がとても単純になる。

import { buildEdges, piecePath, TAB_HEIGHT } from "./geometry.js";

const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
const rot = (x, y, r) => {
  const m = ROT[r & 3];
  return [m[0] * x + m[1] * y, m[2] * x + m[3] * y];
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

const WORLD = 1000; // 完成図の長辺のワールド長
const MAX_SPRITE_PIXELS = 48e6; // ピース画像キャッシュの総ピクセル上限（メモリ対策）

export class PuzzleEngine {
  /**
   * @param {HTMLElement} container
   * @param {object} o
   * @param {HTMLImageElement} o.image 読み込み済み画像
   * @param {number} o.cols
   * @param {number} o.rows
   * @param {boolean} o.rotate ピース回転あり
   * @param {boolean} o.ghost ボードに見本をうっすら表示
   * @param {number} o.seed ピース形状のシード
   * @param {object} [o.state] 途中保存データ
   * @param {number} [o.topInset] 上部ツールバーの高さ(px)
   */
  constructor(container, o) {
    this.container = container;
    this.img = o.image;
    this.cols = o.cols;
    this.rows = o.rows;
    this.rotate = !!o.rotate;
    this.ghost = !!o.ghost;
    this.seed = o.seed >>> 0;
    this.topInset = o.topInset ?? 56;
    this.onChange = o.onChange ?? (() => {});
    this.onSnap = o.onSnap ?? (() => {});
    this.onComplete = o.onComplete ?? (() => {});
    this.onInteract = o.onInteract ?? (() => {});

    const aspect = this.img.naturalWidth / this.img.naturalHeight;
    this.W = aspect >= 1 ? WORLD : WORLD * aspect;
    this.H = aspect >= 1 ? WORLD / aspect : WORLD;
    this.pw = this.W / this.cols;
    this.ph = this.H / this.rows;
    this.s = Math.min(this.pw, this.ph);
    this.pad = Math.ceil(this.s * (TAB_HEIGHT + 0.04));

    this.edgesOnly = false;
    this.paused = false;
    this.completed = false;
    this.finish = null;
    this.light = false;
    this.cam = { x: 0, y: 0, z: 1 };
    this.pointers = new Map();
    this.selected = new Set(); // 範囲選択中のグループ
    this.drag = null;
    this.pinch = null;
    this.raf = 0;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "puzzle-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.hitCtx = document.createElement("canvas").getContext("2d");
    container.appendChild(this.canvas);

    this._buildPieces();
    this._resize();
    if (!(o.state && this._restore(o.state))) this._initialLayout();
    this.fit();

    this._bind();
    this.onChange(this.progress());
  }

  // ---------------------------------------------------------------- 構築

  _buildPieces() {
    const { cols, rows, pw, ph, pad, img } = this;
    const edges = buildEdges(cols, rows, pw, ph, this.seed);
    const cellW = pw + pad * 2, cellH = ph + pad * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let k = clamp((img.naturalWidth / this.W) * dpr, 1, 3);
    k = Math.min(k, Math.sqrt(MAX_SPRITE_PIXELS / (cols * rows * cellW * cellH)));
    this.spriteScale = k;

    this.pieces = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const path = piecePath(edges, c, r, pw, ph);
        const x0 = c * pw, y0 = r * ph;

        const sprite = document.createElement("canvas");
        sprite.width = Math.ceil(cellW * k);
        sprite.height = Math.ceil(cellH * k);
        const g = sprite.getContext("2d");
        g.scale(k, k);
        g.translate(pad, pad);
        g.save();
        g.clip(path);
        g.drawImage(img, -x0, -y0, this.W, this.H);
        // 立体感：左上にハイライト、右下に影
        const bevel = Math.max(this.s * 0.02, 1 / k);
        g.lineWidth = bevel * 2;
        g.save();
        g.translate(bevel, bevel);
        g.strokeStyle = "rgba(255,255,255,0.28)";
        g.stroke(path);
        g.restore();
        g.save();
        g.translate(-bevel, -bevel);
        g.strokeStyle = "rgba(0,0,0,0.32)";
        g.stroke(path);
        g.restore();
        g.restore();
        g.lineWidth = 1 / k;
        g.strokeStyle = "rgba(0,0,0,0.35)";
        g.stroke(path);

        const neighbors = [];
        if (r > 0) neighbors.push(i - cols);
        if (r < rows - 1) neighbors.push(i + cols);
        if (c > 0) neighbors.push(i - 1);
        if (c < cols - 1) neighbors.push(i + 1);
        const edge = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
        this.pieces.push({ i, c, r, x0, y0, path, sprite, neighbors, edge });
      }
    }
  }

  _newGroup(pieceIdxs, x, y, r, locked = false) {
    const g = { pieces: pieceIdxs, x, y, rot: r, locked, flash: 0 };
    g.hasEdge = pieceIdxs.some((i) => this.pieces[i].edge);
    for (const i of pieceIdxs) this.groupOf[i] = g;
    return g;
  }

  /** ボードの周りにピースを置ける「スロット」を、画面の縦横比に合わせて作る */
  _slots(count) {
    const { W, H } = this;
    const slot = Math.max(this.pw, this.ph) * 1.32;
    const view = this._viewSize();
    const A = view.w / Math.max(1, view.h);
    for (let m = slot; ; m += slot * 0.5) {
      let tw = W + 2 * m, th = H + 2 * m;
      if (tw / th < A) tw = th * A; else th = tw / A;
      const tx = (W - tw) / 2, ty = (H - th) / 2;
      const nx = Math.floor(tw / slot), ny = Math.floor(th / slot);
      const gx = tx + (tw - nx * slot) / 2, gy = ty + (th - ny * slot) / 2;
      const margin = slot * 0.2;
      const slots = [];
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const cx = gx + (i + 0.5) * slot, cy = gy + (j + 0.5) * slot;
          const hitsBoard = cx + slot / 2 > -margin && cx - slot / 2 < W + margin &&
            cy + slot / 2 > -margin && cy - slot / 2 < H + margin;
          if (!hitsBoard) slots.push({ cx, cy, d: Math.hypot(cx - W / 2, (cy - H / 2) * A) });
        }
      }
      if (slots.length >= count) {
        slots.sort((a, b) => a.d - b.d);
        return { slots: slots.slice(0, count), slot };
      }
    }
  }

  _placeInSlots(pieceGroups) {
    const { slots, slot } = this._slots(pieceGroups.length);
    shuffle(slots);
    pieceGroups.forEach((g, n) => {
      const p = this.pieces[g.pieces[0]];
      const { cx, cy } = slots[n];
      const jx = (Math.random() - 0.5) * slot * 0.12, jy = (Math.random() - 0.5) * slot * 0.12;
      const [rx, ry] = rot(p.x0 + this.pw / 2, p.y0 + this.ph / 2, g.rot);
      g.x = cx + jx - rx;
      g.y = cy + jy - ry;
    });
  }

  _initialLayout() {
    this.groupOf = new Array(this.pieces.length);
    this.groups = this.pieces.map((p) =>
      this._newGroup([p.i], 0, 0, this.rotate ? Math.floor(Math.random() * 4) : 0),
    );
    shuffle(this.groups);
    this._placeInSlots(this.groups);
  }

  _restore(state) {
    try {
      if (state.cols !== this.cols || state.rows !== this.rows || state.seed !== this.seed) return false;
      this.groupOf = new Array(this.pieces.length);
      const seen = new Set();
      const groups = state.groups.map(([x, y, r, locked, idxs]) => {
        idxs.forEach((i) => {
          if (seen.has(i) || i < 0 || i >= this.pieces.length) throw new Error("bad save");
          seen.add(i);
        });
        return this._newGroup(idxs, x, y, r & 3, !!locked);
      });
      if (seen.size !== this.pieces.length) return false;
      this.groups = groups;
      this._sortLocked();
      return true;
    } catch {
      return false;
    }
  }

  serialize() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      seed: this.seed,
      cols: this.cols,
      rows: this.rows,
      groups: this.groups.map((g) => [r1(g.x), r1(g.y), g.rot, g.locked ? 1 : 0, g.pieces]),
    };
  }

  // ---------------------------------------------------------------- 公開API

  progress() {
    const total = this.pieces.length;
    const connected = total - this.groups.length;
    const placed = this.groups.filter((g) => g.locked).reduce((n, g) => n + g.pieces.length, 0);
    return {
      total,
      connected,
      placed,
      percent: total > 1 ? Math.floor((connected / (total - 1)) * 100) : 100,
    };
  }

  setEdgesOnly(on) {
    this.edgesOnly = on;
    this._pruneSelection();
    this.requestRender();
  }

  /** @returns {boolean} 選択を解除したら true */
  clearSelection() {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.requestRender();
    return true;
  }

  setBackground(color, light) {
    this.container.style.background = color;
    this.light = light;
    this.requestRender();
  }

  setPaused(p) {
    this.paused = p;
    this._endDrag();
  }

  /** バラバラ（1枚だけ）のピースをボードの周りに並べ直す */
  scatterLoose() {
    const loose = this.groups.filter((g) => !g.locked && g.pieces.length === 1);
    if (!loose.length) return;
    this._placeInSlots(loose);
    this.fit();
  }

  /** 全ピース＋ボードが収まるようにカメラを合わせる */
  fit() {
    let x0 = 0, y0 = 0, x1 = this.W, y1 = this.H;
    if (!this.completed) {
      for (const g of this.groups) {
        if (this._hidden(g)) continue;
        for (const i of g.pieces) {
          const b = this._pieceBounds(g, this.pieces[i]);
          x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
          x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
        }
      }
    }
    this._fitRect(x0, y0, x1 - x0, y1 - y0);
  }

  zoomBy(f) {
    const v = this._viewSize();
    this._zoomAt(v.w / 2, this.topInset + v.h / 2, f);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this._unbind();
    this.ro?.disconnect();
    for (const p of this.pieces) { p.sprite.width = p.sprite.height = 0; }
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- カメラ

  _viewSize() {
    const w = this.container.clientWidth, h = this.container.clientHeight - this.topInset;
    return { w: Math.max(w, 1), h: Math.max(h, 1) };
  }

  _fitRect(x, y, w, h) {
    const v = this._viewSize();
    const pad = Math.min(32, v.w * 0.04);
    const z = Math.min((v.w - pad * 2) / w, (v.h - pad * 2) / h);
    this.fitZoom = z;
    this.cam.z = z;
    this.cam.x = x - (v.w - w * z) / 2 / z;
    this.cam.y = y - (this.topInset + (v.h - h * z) / 2) / z;
    this.requestRender();
  }

  _zoomLimits() {
    const v = this._viewSize();
    const fz = this.fitZoom ?? 1;
    return [fz * 0.35, Math.max(fz * 1.5, (Math.min(v.w, v.h) * 0.45) / this.s)];
  }

  _zoomAt(sx, sy, f) {
    const [zmin, zmax] = this._zoomLimits();
    const z = clamp(this.cam.z * f, zmin, zmax);
    const wx = sx / this.cam.z + this.cam.x, wy = sy / this.cam.z + this.cam.y;
    this.cam.z = z;
    this.cam.x = wx - sx / z;
    this.cam.y = wy - sy / z;
    this.requestRender();
  }

  _toWorld(sx, sy) {
    return { x: sx / this.cam.z + this.cam.x, y: sy / this.cam.z + this.cam.y };
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.requestRender();
  }

  // ---------------------------------------------------------------- 判定

  _hidden(g) {
    return this.edgesOnly && !g.locked && !g.hasEdge;
  }

  _pieceBounds(g, p) {
    const [ox, oy] = rot(p.x0, p.y0, g.rot);
    const [ex, ey] = rot(this.pw, this.ph, g.rot);
    const ax = g.x + ox, ay = g.y + oy;
    const pad = this.pad;
    return [
      Math.min(ax, ax + ex) - pad, Math.min(ay, ay + ey) - pad,
      Math.max(ax, ax + ex) + pad, Math.max(ay, ay + ey) + pad,
    ];
  }

  _hit(wx, wy) {
    for (let n = this.groups.length - 1; n >= 0; n--) {
      const g = this.groups[n];
      if (g.locked || this._hidden(g)) continue;
      const [gx, gy] = rot(wx - g.x, wy - g.y, (4 - g.rot) & 3);
      for (const i of g.pieces) {
        const p = this.pieces[i];
        const lx = gx - p.x0, ly = gy - p.y0;
        if (lx < -this.pad || ly < -this.pad || lx > this.pw + this.pad || ly > this.ph + this.pad) continue;
        if (this.hitCtx.isPointInPath(p.path, lx, ly)) return g;
      }
    }
    return null;
  }

  _bringToTop(g) {
    const idx = this.groups.indexOf(g);
    if (idx >= 0) this.groups.splice(idx, 1);
    this.groups.push(g);
  }

  /** 中心が矩形 [x0,y0,x1,y1]（ワールド座標）に入っているピースを含むグループ */
  _groupsInRect(x0, y0, x1, y1) {
    const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
    const hw = this.pw / 2, hh = this.ph / 2;
    const out = new Set();
    for (const g of this.groups) {
      if (g.locked || this._hidden(g)) continue;
      for (const i of g.pieces) {
        const p = this.pieces[i];
        const [cx, cy] = rot(p.x0 + hw, p.y0 + hh, g.rot);
        const x = g.x + cx, y = g.y + cy;
        if (x >= ax && x <= bx && y >= ay && y <= by) {
          out.add(g);
          break;
        }
      }
    }
    return out;
  }

  _pruneSelection() {
    for (const g of this.selected) {
      if (g.locked || this._hidden(g) || !this.groups.includes(g)) this.selected.delete(g);
    }
  }

  _sortLocked() {
    // ボードにはまったグループは常に一番下に描く
    this.groups.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));
  }

  _rotateGroup(g, px, py) {
    const [rx, ry] = rot(g.x - px, g.y - py, 1);
    g.x = px + rx;
    g.y = py + ry;
    g.rot = (g.rot + 1) & 3;
    this._snap(g);
  }

  /** ドロップ後：隣のピースとつながるか、ボードにはまるかを調べる */
  _snap(g) {
    const thr = this.s * 0.28;
    let merged = false;
    let again = true;
    while (again) {
      again = false;
      search: for (const i of g.pieces) {
        for (const ni of this.pieces[i].neighbors) {
          const ng = this.groupOf[ni];
          if (ng === g || ng.rot !== g.rot || this._hidden(ng)) continue;
          if (Math.hypot(ng.x - g.x, ng.y - g.y) < thr) {
            this._merge(g, ng);
            merged = again = true;
            break search;
          }
        }
      }
    }
    let locked = false;
    if (!g.locked && g.rot === 0 && Math.hypot(g.x, g.y) < thr) {
      g.x = 0; g.y = 0; g.locked = true;
      locked = true;
    }
    if (merged || locked) {
      g.flash = performance.now();
      this._sortLocked();
      this.onSnap(locked || g.locked ? "board" : "piece");
      this.onChange(this.progress());
    }
    if (this.groups.length === 1) this._startFinish();
    this.requestRender();
  }

  _merge(g, ng) {
    if (!g.locked) { g.x = ng.x; g.y = ng.y; }
    g.locked = g.locked || ng.locked;
    for (const i of ng.pieces) { g.pieces.push(i); this.groupOf[i] = g; }
    g.hasEdge = g.hasEdge || ng.hasEdge;
    this.groups.splice(this.groups.indexOf(ng), 1);
  }

  _startFinish() {
    if (this.completed) return;
    const g = this.groups[0];
    this.completed = true;
    this._endDrag();
    // 回転していたら、見た目の中心を保ったまま正位置に戻す
    if (g.rot !== 0) {
      const [cx, cy] = rot(this.W / 2, this.H / 2, g.rot);
      g.x = g.x + cx - this.W / 2;
      g.y = g.y + cy - this.H / 2;
      g.rot = 0;
    }
    this.finish = { t0: performance.now(), fromX: g.x, fromY: g.y, done: false };
    g.locked = true;
    this.selected.clear();
    this.canvas.style.cursor = "default";
    this.requestRender();
  }

  // ---------------------------------------------------------------- 入力

  _bind() {
    const c = this.canvas;
    this._h = {
      down: (e) => this._down(e),
      move: (e) => this._move(e),
      up: (e) => this._up(e),
      wheel: (e) => this._wheel(e),
      ctx: (e) => e.preventDefault(),
      // 中ボタンの自動スクロールを止める
      mdown: (e) => e.button === 1 && e.preventDefault(),
    };
    c.addEventListener("mousedown", this._h.mdown);
    c.addEventListener("pointerdown", this._h.down);
    c.addEventListener("pointermove", this._h.move);
    c.addEventListener("pointerup", this._h.up);
    c.addEventListener("pointercancel", this._h.up);
    c.addEventListener("wheel", this._h.wheel, { passive: false });
    c.addEventListener("contextmenu", this._h.ctx);
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.container);
  }

  _unbind() {
    const c = this.canvas;
    c.removeEventListener("mousedown", this._h.mdown);
    c.removeEventListener("pointerdown", this._h.down);
    c.removeEventListener("pointermove", this._h.move);
    c.removeEventListener("pointerup", this._h.up);
    c.removeEventListener("pointercancel", this._h.up);
    c.removeEventListener("wheel", this._h.wheel);
    c.removeEventListener("contextmenu", this._h.ctx);
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (this.paused) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const pt = this._pos(e);
    this.pointers.set(e.pointerId, pt);
    this.onInteract();

    if (this.pointers.size === 2) {
      // 2本指：ピンチズーム＋パン
      this._endDrag();
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.cam.z, world: this._toWorld(mid.x, mid.y) };
      return;
    }
    if (this.pointers.size > 2) return;

    const w = this._toWorld(pt.x, pt.y);
    const g = this.completed ? null : this._hit(w.x, w.y);

    if (g && e.button === 2) {
      if (this.rotate) this._rotateGroup(g, w.x, w.y);
      return;
    }
    // 右・中ボタンのドラッグ、完成後のドラッグは画面移動
    if (e.button === 1 || e.button === 2 || this.completed) {
      this.drag = { type: "pan", id: e.pointerId, sx: pt.x, sy: pt.y, cx: this.cam.x, cy: this.cam.y };
      this.canvas.style.cursor = "move";
      return;
    }
    if (g) {
      // 選択中のピースをつかんだら、選択中のものをまとめて動かす
      const multi = this.selected.has(g);
      if (!multi) this.selected.clear();
      const list = multi ? this.groups.filter((x) => this.selected.has(x)) : [g];
      for (const x of list) this._bringToTop(x);
      this.drag = {
        type: "piece", id: e.pointerId, g, list,
        starts: list.map((x) => [x.x, x.y]),
        sx: pt.x, sy: pt.y, wx: w.x, wy: w.y, t: performance.now(), moved: false,
      };
      this.canvas.style.cursor = "grabbing";
    } else {
      // 空いている所のドラッグは範囲選択
      this.selected.clear();
      this.drag = { type: "select", id: e.pointerId, sx: pt.x, sy: pt.y, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
    }
    this.requestRender();
  }

  _move(e) {
    const pt = this._pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const [zmin, zmax] = this._zoomLimits();
      const z = clamp(this.pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0), zmin, zmax);
      this.cam.z = z;
      this.cam.x = this.pinch.world.x - mid.x / z;
      this.cam.y = this.pinch.world.y - mid.y / z;
      this.requestRender();
      return;
    }

    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) > 4) d.moved = true;
      if (d.type === "piece") {
        const w = this._toWorld(pt.x, pt.y);
        const dx = w.x - d.wx, dy = w.y - d.wy;
        d.list.forEach((x, n) => {
          x.x = d.starts[n][0] + dx;
          x.y = d.starts[n][1] + dy;
        });
      } else if (d.type === "select") {
        const w = this._toWorld(pt.x, pt.y);
        d.x1 = w.x;
        d.y1 = w.y;
      } else {
        this.cam.x = d.cx - (pt.x - d.sx) / this.cam.z;
        this.cam.y = d.cy - (pt.y - d.sy) / this.cam.z;
      }
      this.requestRender();
    } else if (!d && e.pointerType === "mouse" && !this.completed && !this.paused) {
      const w = this._toWorld(pt.x, pt.y);
      this.canvas.style.cursor = this._hit(w.x, w.y) ? "grab" : "crosshair";
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.type === "piece") {
      this.canvas.style.cursor = "grab";
      const tap = !d.moved && performance.now() - d.t < 500;
      if (tap && this.rotate) {
        this._rotateGroup(d.g, d.wx, d.wy);
        this._pruneSelection();
      } else {
        this._snapAll(d.list);
      }
    } else if (d.type === "select") {
      if (d.moved) this.selected = this._groupsInRect(d.x0, d.y0, d.x1, d.y1);
      this.canvas.style.cursor = "crosshair";
    } else {
      this.canvas.style.cursor = "default";
    }
    this.requestRender();
  }

  _snapAll(list) {
    for (const g of list) {
      if (this.completed) break;
      if (this.groups.includes(g)) this._snap(g); // 先に他のグループへ合体済みなら飛ばす
    }
    this._pruneSelection();
  }

  _endDrag() {
    const d = this.drag;
    this.drag = null;
    if (d?.type === "piece" && !this.completed) this._snapAll(d.list);
    this.requestRender();
  }

  _wheel(e) {
    e.preventDefault();
    if (this.paused) return;
    const pt = this._pos(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this._zoomAt(pt.x, pt.y, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
  }

  // ---------------------------------------------------------------- 描画

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    this.raf = 0;
    const animating = this._render(now);
    if (animating) this.requestRender();
  }

  _drawGroup(g) {
    const { ctx, pad, pw, ph } = this;
    const ang = (g.rot * Math.PI) / 2;
    for (const i of g.pieces) {
      const p = this.pieces[i];
      const [ox, oy] = rot(p.x0, p.y0, g.rot);
      ctx.save();
      ctx.translate(g.x + ox, g.y + oy);
      if (g.rot) ctx.rotate(ang);
      ctx.drawImage(p.sprite, -pad, -pad, pw + pad * 2, ph + pad * 2);
      ctx.restore();
    }
  }

  /** 選択中のグループを赤く塗る（alpha で明滅） */
  _tintGroup(g, alpha) {
    const { ctx } = this;
    const ang = (g.rot * Math.PI) / 2;
    ctx.fillStyle = `rgba(232, 56, 44, ${alpha})`;
    ctx.strokeStyle = `rgba(255, 140, 120, ${Math.min(1, alpha + 0.35)})`;
    ctx.lineWidth = 1.5 / this.cam.z;
    for (const i of g.pieces) {
      const p = this.pieces[i];
      const [ox, oy] = rot(p.x0, p.y0, g.rot);
      ctx.save();
      ctx.translate(g.x + ox, g.y + oy);
      if (g.rot) ctx.rotate(ang);
      ctx.fill(p.path);
      ctx.stroke(p.path);
      ctx.restore();
    }
  }

  _strokeGroup(g, style, width) {
    const { ctx } = this;
    const ang = (g.rot * Math.PI) / 2;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    for (const i of g.pieces) {
      const p = this.pieces[i];
      const [ox, oy] = rot(p.x0, p.y0, g.rot);
      ctx.save();
      ctx.translate(g.x + ox, g.y + oy);
      if (g.rot) ctx.rotate(ang);
      ctx.stroke(p.path);
      ctx.restore();
    }
  }

  /** @returns {boolean} アニメーション継続中なら true */
  _render(now) {
    const { ctx, cam, dpr, W, H } = this;
    let animating = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const k = dpr * cam.z;
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    ctx.imageSmoothingQuality = "high";

    // ボード
    ctx.fillStyle = this.light ? "rgba(0,0,0,0.07)" : "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1.5 / cam.z;
    ctx.strokeStyle = this.light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)";
    ctx.strokeRect(0, 0, W, H);
    if (this.ghost && !this.completed) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(this.img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // 完成アニメーション
    let reveal = 0;
    if (this.finish) {
      const f = this.finish;
      const g = this.groups[0];
      const t1 = clamp((now - f.t0) / 450, 0, 1);
      g.x = f.fromX * (1 - easeOut(t1));
      g.y = f.fromY * (1 - easeOut(t1));
      reveal = clamp((now - f.t0 - 450) / 900, 0, 1);
      if (reveal < 1) animating = true;
      else if (!f.done) {
        f.done = true;
        setTimeout(() => this.onComplete(), 250);
      }
    }

    if (reveal < 1) {
      const d = this.drag;
      const dragging = d?.type === "piece" ? new Set(d.list) : null;
      // 選択中（範囲ドラッグ中はその範囲に入っているもの）を赤く光らせる
      const marked = d?.type === "select" && d.moved ? this._groupsInRect(d.x0, d.y0, d.x1, d.y1) : this.selected;
      const glow = 0.5 + 0.12 * Math.sin(now / 180);
      if (marked.size) animating = true;

      for (const g of this.groups) {
        if (dragging?.has(g) || this._hidden(g)) continue;
        this._drawGroup(g);
        if (marked.has(g)) this._tintGroup(g, glow);
      }
      if (dragging) {
        for (const g of d.list) {
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.5)";
          ctx.shadowBlur = 14 * dpr;
          ctx.shadowOffsetX = 3 * dpr;
          ctx.shadowOffsetY = 6 * dpr;
          this._drawGroup(g);
          ctx.restore();
          if (marked.has(g)) this._tintGroup(g, glow);
        }
      }
      // 範囲選択の矩形
      if (d?.type === "select" && d.moved) {
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
        const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        ctx.fillStyle = "rgba(229, 57, 53, 0.45)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(255, 110, 100, 0.95)";
        ctx.lineWidth = 1.5 / cam.z;
        ctx.strokeRect(x, y, w, h);
      }
      // つながった瞬間のキラッとした縁取り
      for (const g of this.groups) {
        if (!g.flash) continue;
        const t = (now - g.flash) / 450;
        if (t >= 1) { g.flash = 0; continue; }
        animating = true;
        this._strokeGroup(g, `rgba(255,255,255,${0.9 * (1 - t)})`, (3 * (1 - t) + 1) / cam.z);
      }
    }

    if (reveal > 0) {
      // ピースの継ぎ目を消して一枚絵に戻し、光を横切らせる
      ctx.globalAlpha = easeOut(reveal);
      ctx.drawImage(this.img, 0, 0, W, H);
      ctx.globalAlpha = 1;
      if (reveal < 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.clip();
        const x = -W * 0.5 + (W * 2) * reveal;
        const grad = ctx.createLinearGradient(x - W * 0.25, 0, x + W * 0.25, H * 0.3);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.55)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }
    return animating;
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
