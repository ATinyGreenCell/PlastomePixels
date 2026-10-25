// The viewer: a native scroll area over an image that is never drawn whole. Only tiles near the
// viewport exist; zoomed out, each tile pixel is an average of a block of bases (computed in the
// engine), so memory stays flat however long the genome. Tiles are square pieces of the whole
// picture rather than of single columns: every tile costs the browser a fixed amount to show, and a
// dozen big ones are several times cheaper than a hundred thin ones. All scroll, zoom and pinch work
// is coalesced into one animation frame.
import type { EngineClient } from './client';
import type { TileReq, FromEngine } from './protocol';

export const RULER_W = 64, HEADS_H = 48;     // whole device pixels at common pixel ratios
const TB = 512;                              // tile size in backing pixels
const MAX_SH = 16;
const MAX_TILE_CSS = 16384;                  // zoomed far in, tiles shrink so none is enormous on screen
// New tile pixels handed to the compositor per frame. Showing a tile costs the page a copy of its
// pixels; spreading a burst of arrivals over a few frames keeps every frame short on slow phones.
const ATTACH_PX = 1_100_000;

export interface PanelGeom {
  uid: number;
  nameHTML: string;
  title: string;
  x: number;               // image px of the panel's first column
  width: number;           // image px across all its columns
  rows: number;
  colX: number[];
  origin0: number;         // genome coordinate of the first shown base
  length: number;          // shown bases
}

export interface Geometry {
  width: number;           // image px, margins included
  height: number;
  rows: number;
  margin: number;
  W: number;               // bases per row
  windows: number[];
  panels: PanelGeom[];
}

export interface Hit { panel: number; uid: number; col: number; pos: number }

interface Tile {
  key: string; grid: string; tv: number;
  x0: number; x1: number; y0: number; y1: number;    // image px covered
  el: HTMLCanvasElement | null; bytes: number; used: number; attached: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pow2floor = (v: number) => Math.pow(2, Math.floor(Math.log2(Math.max(1, v))));
const nf = new Intl.NumberFormat('en-US');

function niceStep(min: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, min))));
  for (const m of [1, 2, 5, 10]) if (m * p >= min) return m * p;
  return 10 * p;
}

function bpLabel(bp: number, step: number) {
  if (step >= 1_000_000) return `${+(bp / 1e6).toFixed(step % 1_000_000 ? 1 : 0)} Mb`;
  if (step >= 1000) return `${+(bp / 1000).toFixed(step % 1000 ? 1 : 0)} kb`;
  return nf.format(bp);
}

// screen pixels per base for the zoom buttons
const LADDER = [0.01, 0.015, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];

export class Viewer {
  scale = 1;
  mode: 'fit' | 'manual' = 'fit';
  onScale: (s: number) => void = () => {};
  onTap: (hit: Hit | null) => void = () => {};
  private g: Geometry | null = null;
  private tv = 0;                            // tile version: bumped whenever any pixel may change
  private laySig = '';
  private grid = '';                         // tile grid in use: version, level and tile size
  private tiles = new Map<string, Tile>();
  private attached = new Set<Tile>();
  private wanted = new Set<string>();
  private arrived = new Set<Tile>();        // drawn, waiting for room in a frame
  private attachLeft = ATTACH_PX;
  private bytes = 0;
  private budget: number;
  private lastSent = '';
  private raf = 0;
  private placeAll = false;
  private pendingScale: { s: number; ax: number; ay: number } | null = null;
  private dpr = window.devicePixelRatio || 1;
  private rStep = 0; private rFrom = 0; private rTo = -1;
  readonly marks: SVGSVGElement;
  readonly labels: HTMLDivElement;
  private snapTimer = 0;
  private vw = 0;                            // the viewer's client size, kept by a ResizeObserver so the
  private vh = 0;                            // frame loop never forces a layout just to learn it

  constructor(private viewer: HTMLElement, private sheet: HTMLElement, private heads: HTMLElement,
    private ruler: HTMLElement, private plate: HTMLElement, private client: EngineClient) {
    const mem = (navigator as any).deviceMemory as number | undefined;
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.budget = (mem ? clamp(mem * 20, 24, 160) : coarse ? 40 : 64) * 1024 * 1024;
    this.marks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.marks.setAttribute('class', 'marks');
    this.marks.setAttribute('preserveAspectRatio', 'none');
    this.marks.setAttribute('aria-hidden', 'true');
    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    plate.append(this.marks, this.labels);
    client.onTile = m => this.onTile(m);
    viewer.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      this.vw = viewer.clientWidth;
      this.vh = viewer.clientHeight;
      if (this.mode === 'fit') { this.scale = this.fitScale(); this.applyScale(); this.placeAll = true; }
      this.schedule();
    }).observe(viewer);
    const watchDpr = () => {
      const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener?.('change', () => { this.dpr = window.devicePixelRatio || 1; this.placeAll = true; this.schedule(); watchDpr(); }, { once: true });
    };
    watchDpr();
    this.gestures();
  }

  // ---- geometry and content --------------------------------------------------------------

  /** New layout or new pixels (ver: the engine config the views were made with). */
  setGeometry(g: Geometry, ver: number) {
    this.g = g;
    const sig = `${ver}|${g.W}|${g.margin}|${g.width}x${g.height}|` + g.panels.map(p => `${p.uid}:${p.rows}:${p.colX.join(',')}`).join(';');
    if (sig !== this.laySig) {
      this.laySig = sig;
      this.tv++;
      this.lastSent = '';
      // what is on screen stays until its replacement arrives; the rest will never be wanted again
      for (const t of [...this.tiles.values()]) if (!t.attached) { this.free(t); this.tiles.delete(t.key); }
      this.arrived.clear();
      if (g.panels.length && g.rows > 0) {
        this.client.send({ t: 'layout', lay: { tv: this.tv, ver, W: g.W, panels: g.panels.map(p => ({ uid: p.uid, colX: p.colX, y: g.margin, rows: p.rows })) } });
        this.setReady(false);   // until a frame has checked the tiles
      } else {
        this.dropAll();
      }
    }
    this.sheet.style.setProperty('--img-w', String(g.width));
    this.sheet.style.setProperty('--img-h', String(g.height));
    this.marks.setAttribute('viewBox', `0 0 ${Math.max(1, g.width)} ${Math.max(1, g.height)}`);
    this.buildHeads();
    if (this.mode === 'fit') this.scale = this.fitScale();
    else this.scale = clamp(this.scale, this.minScale(), this.maxScale());
    this.applyScale();
    this.rTo = -1;
    this.placeAll = true;
    this.schedule();
  }

  get geometry() { return this.g; }

  private dropAll() {
    for (const t of this.tiles.values()) this.free(t);
    this.tiles.clear();
    this.attached.clear();
    this.wanted.clear();
    this.arrived.clear();
    this.bytes = 0;
  }

  // ---- zoom -----------------------------------------------------------------------------

  minScale() {
    return Math.max(1e-5, Math.min(this.fitAll() * 0.5, 0.01));
  }

  maxScale() {
    return Math.max(this.fitRaw(), Math.min(128 / this.dpr * 1.0001, this.capScale()));
  }

  /** Browsers cap element sizes near 16 million px. */
  private capScale() {
    const g = this.g;
    return g ? 15e6 / Math.max(1, g.width, g.height) : 48;
  }

  private room() {
    const { w, h } = this.size();
    return { w: Math.max(1, w - RULER_W - 8), h: Math.max(1, h - HEADS_H - 8) };
  }

  private size() {
    if (!this.vw) { this.vw = this.viewer.clientWidth; this.vh = this.viewer.clientHeight; }
    return { w: this.vw, h: this.vh };
  }

  /** The scale that shows the whole picture. */
  private fitAll() {
    const g = this.g;
    if (!g || !g.width || !g.height) return 1;
    const { w, h } = this.room();
    return Math.max(1e-5, Math.min(w / g.width, h / g.height));
  }

  /** What Fit shows: the whole picture, unless that would be a hairline (1 bp rows make it 80 px wide and
   *  160,000 tall); then its short side gets a quarter of the view and the long side scrolls. */
  private fitRaw() {
    const g = this.g;
    if (!g || !g.width || !g.height) return 1;
    const { w, h } = this.room();
    const short = Math.min(g.width, g.height);
    const legible = Math.min(Math.min(w, h) * 0.25 / short, g.width <= g.height ? w / g.width : h / g.height, this.capScale());
    return Math.max(this.fitAll(), legible);
  }

  fitScale() { return clamp(this.fitRaw(), 1e-5, this.maxScale()); }

  fit() {
    this.mode = 'fit';
    this.pendingScale = null;
    this.scale = this.fitScale();
    this.applyScale();
    this.viewer.scrollLeft = 0;
    this.viewer.scrollTop = 0;
    this.placeAll = true;
    this.schedule();
  }

  /** Zoom to s, keeping the image point under (ax, ay) (viewer coordinates) where it is. */
  setScale(s: number, ax?: number, ay?: number) {
    this.mode = 'manual';
    s = clamp(s, this.minScale(), this.maxScale());
    const ref = this.pendingScale;
    this.pendingScale = {
      s,
      ax: ax ?? ref?.ax ?? this.size().w / 2,
      ay: ay ?? ref?.ay ?? this.size().h / 2,
    };
    this.schedule();
  }

  /** One step along the screen-pixels-per-base ladder; whole device pixels at 1 and above. */
  step(dir: 1 | -1) {
    const target = this.pendingScale?.s ?? this.scale;
    const d = target * this.dpr;
    let next: number;
    if (dir > 0) next = LADDER.find(z => z > d * 1.01) ?? d * 1.5;
    else next = [...LADDER].reverse().find(z => z < d / 1.01) ?? d / 1.5;
    this.setScale(next / this.dpr);
  }

  /** After a pinch or wheel zoom: settle on whole device pixels per base when close, so every base is the same size. */
  private settle(ax?: number, ay?: number) {
    clearTimeout(this.snapTimer);
    this.snapTimer = window.setTimeout(() => {
      const s = this.pendingScale?.s ?? this.scale;
      const d = s * this.dpr;
      if (d < 1) return;
      const r = Math.round(d);
      if (r !== d && Math.abs(d - r) / r < 0.18) this.setScale(r / this.dpr, ax, ay);
    }, 160);
  }

  private applyScale() {
    const s = this.scale;
    this.sheet.style.setProperty('--s', String(s));
    const d = s * this.dpr;
    this.plate.classList.toggle('px', d >= 0.999);
    const colPx = (this.g?.W ?? 100) * s;
    this.sheet.classList.toggle('narrow', colPx < 50);
    this.sheet.classList.toggle('tiny', colPx < 16);
    this.onScale(s);
  }

  // ---- the frame loop --------------------------------------------------------------------

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame() {
    this.raf = 0;
    const v = this.viewer;
    if (this.pendingScale) {
      const { s, ax, ay } = this.pendingScale;
      this.pendingScale = null;
      const s1 = this.scale;
      const ix = (v.scrollLeft + ax - RULER_W) / s1, iy = (v.scrollTop + ay - HEADS_H) / s1;
      this.scale = s;
      this.applyScale();
      v.scrollLeft = ix * s + RULER_W - ax;
      v.scrollTop = iy * s + HEADS_H - ay;
      this.placeAll = true;
    }
    // every layout read of the frame, before any of its writes
    const sl = v.scrollLeft, st = v.scrollTop;
    this.attachLeft = ATTACH_PX;
    for (const t of this.arrived) {
      if (t.el && !t.attached && this.wanted.has(t.key)) {
        if (this.attachLeft <= 0) break;
        this.attach(t);
      }
      this.arrived.delete(t);
    }
    if (this.arrived.size) this.schedule();
    const grid = this.gridNow().grid;
    if (grid !== this.grid) { this.grid = grid; this.placeAll = true; }
    if (this.placeAll) { this.placeAll = false; for (const t of this.attached) this.place(t); }
    this.updateRuler(st);
    this.updateTiles(sl, st);
  }

  /** Tile grid for the current zoom: level sh (each tile pixel averages 2^sh x 2^sh image px) and tile span in image px. */
  private gridNow() {
    const d = this.scale * this.dpr;
    const sh = d >= 0.5 ? 0 : Math.min(MAX_SH, Math.floor(Math.log2(1 / d)));
    const size = sh > 0 ? TB : clamp(pow2floor(MAX_TILE_CSS / this.scale), 64, TB);
    const span = size << sh;
    return { sh, span, grid: `${this.tv}:${sh}:${span}` };
  }

  /** Does image rect [x0, x1) x [y0, y1) touch any column? (If not, the plate's own background shows.) */
  private hasContent(g: Geometry, x0: number, x1: number, y0: number, y1: number): boolean {
    if (g.margin >= y1) return false;
    for (const p of g.panels) {
      if (p.rows <= 0 || p.x >= x1 || p.x + p.width <= x0 || g.margin + p.rows <= y0) continue;
      for (const cx of p.colX) if (cx < x1 && cx + g.W > x0) return true;
    }
    return false;
  }

  private updateTiles(sl: number, st: number) {
    const g = this.g;
    if (!g) return;                                       // nothing laid out yet: not ready, not loading
    if (!g.panels.length || g.rows === 0) { this.setReady(true); return; }
    const { sh, span, grid } = this.gridNow();
    const s = this.scale;
    const { w: vw, h: vh } = this.size();
    const ix0 = sl / s, ix1 = (sl + vw - RULER_W) / s;
    const iy0 = st / s, iy1 = (st + vh - HEADS_H) / s;
    const mx = (ix1 - ix0) * 0.25, my = (iy1 - iy0) * 0.75;
    const cxv = (ix0 + ix1) / 2, cyv = (iy0 + iy1) / 2;
    const ntx = Math.ceil(g.width / span), nty = Math.ceil(g.height / span);
    const tx0 = clamp(Math.floor((ix0 - mx) / span), 0, ntx - 1), tx1 = clamp(Math.floor((ix1 + mx) / span), 0, ntx - 1);
    const ty0 = clamp(Math.floor((iy0 - my) / span), 0, nty - 1), ty1 = clamp(Math.floor((iy1 + my) / span), 0, nty - 1);
    const now = performance.now();
    const missing: { req: TileReq; pri: number }[] = [];
    const wanted = new Set<string>();
    let visibleMissing = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      const y0 = ty * span, y1 = Math.min(g.height, y0 + span);
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = tx * span, x1 = Math.min(g.width, x0 + span);
        if (!this.hasContent(g, x0, x1, y0, y1)) continue;
        const key = `${grid}:${tx}:${ty}`;
        wanted.add(key);
        let t = this.tiles.get(key);
        if (!t) {
          t = { key, grid, tv: this.tv, x0, x1, y0, y1, el: null, bytes: 0, used: now, attached: false };
          this.tiles.set(key, t);
        }
        t.used = now;
        const visible = x1 > ix0 && x0 < ix1 && y1 > iy0 && y0 < iy1;
        if (t.el) {
          if (!t.attached) {
            if (this.attachLeft > 0) this.attach(t);
            else { if (visible) visibleMissing++; this.arrived.add(t); this.schedule(); }
          }
          continue;
        }
        if (visible) visibleMissing++;
        const dx = (x0 + x1) / 2 - cxv, dy = (y0 + y1) / 2 - cyv;
        missing.push({ req: { key, sh, x0, x1, y0, y1 }, pri: (visible ? 0 : 1e12) + dx * dx + dy * dy });
      }
    }
    this.wanted = wanted;
    // tiles that scrolled away leave the page (kept in memory); older or coarser ones stay
    // underneath until everything visible on the current grid has arrived
    for (const t of [...this.attached]) {
      if (wanted.has(t.key)) continue;
      if (t.grid === grid || visibleMissing === 0) this.detach(t, t.tv !== this.tv);
    }
    missing.sort((a, b) => a.pri - b.pri);
    const sig = missing.map(m => m.req.key).join('|');
    if (sig !== this.lastSent) {
      this.lastSent = sig;
      this.client.send({ t: 'tiles', tv: this.tv, reqs: missing.map(m => m.req) });
    }
    this.evict();
    this.setReady(visibleMissing === 0);
  }

  private setReady(done: boolean) {
    const v = done ? 'done' : 'loading';
    if (document.body.dataset.ready !== v) document.body.dataset.ready = v;
  }

  private onTile(m: Extract<FromEngine, { t: 'tile' }>) {
    const t = this.tiles.get(m.key);
    if (m.tv !== this.tv || !t || t.el) { m.bitmap?.close(); return; }
    const c = document.createElement('canvas');
    c.width = m.w;
    c.height = m.h;
    let drawn = false;
    if (m.bitmap) {
      const bctx = c.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null;
      if (bctx) { bctx.transferFromImageBitmap(m.bitmap); drawn = true; }
      else { const ctx = c.getContext('2d'); if (ctx) { ctx.drawImage(m.bitmap, 0, 0); drawn = true; } m.bitmap.close(); }
    } else {
      const ctx = c.getContext('2d');
      const img = m.image ?? (m.rgba ? new ImageData(new Uint8ClampedArray(m.rgba), m.w, m.h) : null);
      if (ctx && img) { ctx.putImageData(img, 0, 0); drawn = true; }
    }
    if (!drawn) return;
    t.el = c;
    t.bytes = m.w * m.h * 4;
    this.bytes += t.bytes;
    this.arrived.add(t);
    this.schedule();
  }

  private attach(t: Tile) {
    if (!t.el) return;
    this.attachLeft -= t.bytes >> 2;
    this.place(t);
    this.plate.insertBefore(t.el, this.marks);
    t.attached = true;
    this.attached.add(t);
  }

  private detach(t: Tile, free: boolean) {
    if (t.attached && t.el) t.el.remove();
    t.attached = false;
    this.attached.delete(t);
    if (free) { this.free(t); this.tiles.delete(t.key); }
  }

  private free(t: Tile) {
    const c = t.el;
    if (!c) return;
    c.remove();
    try { (c.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null)?.transferFromImageBitmap(null); } catch { /* 2d canvas */ }
    c.width = 0;
    c.height = 0;
    this.bytes -= t.bytes;
    t.el = null;
    t.bytes = 0;
  }

  private evict() {
    if (this.bytes <= this.budget) return;
    const idle = [...this.tiles.values()].filter(t => t.el && !t.attached).sort((a, b) => a.used - b.used);
    for (const t of idle) {
      if (this.bytes <= this.budget * 0.85) break;
      this.free(t);
      this.tiles.delete(t.key);
    }
  }

  /** Position in whole device pixels, so neighbouring tiles share an edge exactly. */
  private place(t: Tile) {
    const el = t.el;
    if (!el) return;
    const k = this.scale * this.dpr, d = this.dpr;
    const X0 = Math.round(t.x0 * k) / d, X1 = Math.round(t.x1 * k) / d;
    const Y0 = Math.round(t.y0 * k) / d, Y1 = Math.round(t.y1 * k) / d;
    const st = el.style;
    st.left = X0 + 'px';
    st.top = Y0 + 'px';
    st.width = Math.max(0, X1 - X0) + 'px';
    st.height = Math.max(0, Y1 - Y0) + 'px';
    st.zIndex = t.grid === this.grid ? '2' : '1';
  }

  // ---- ruler and headers -----------------------------------------------------------------

  private updateRuler(st: number) {
    const g = this.g;
    if (!g || !g.panels.length) { if (this.rTo !== -2) { this.ruler.replaceChildren(); this.rTo = -2; } return; }
    const s = this.scale, W = g.W;
    const step = niceStep((40 / s) * W);
    const r0 = Math.floor(st / s - g.margin), r1 = Math.ceil((st + this.size().h) / s - g.margin);
    if (step === this.rStep && r0 >= this.rFrom && r1 <= this.rTo) return;
    const pad = r1 - r0;
    const from = Math.max(0, r0 - pad), to = Math.min(g.rows, r1 + pad);
    this.rStep = step; this.rFrom = r0 - pad; this.rTo = r1 + pad;
    const longest = g.panels.reduce((m, p) => Math.max(m, p.length), 0);
    const o = g.panels[0].origin0;            // the ruler follows the first genome's coordinates
    const frag = document.createDocumentFragment();
    const lo = o + from * W, hi = o - 1 + Math.min(longest, (to + 1) * W);
    let n = 0;
    for (let b = Math.ceil(lo / step) * step; b <= hi && n < 400; b += step, n++) {
      const row = Math.floor((b - o) / W);
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.top = `calc(${g.margin + row}px * var(--s))`;
      t.textContent = bpLabel(b, step);
      frag.append(t);
    }
    this.ruler.replaceChildren(frag);
  }

  private buildHeads() {
    const g = this.g!;
    const frag = document.createDocumentFragment();
    const corner = document.createElement('div');
    corner.className = 'corner';
    corner.innerHTML = '<span>bp</span>';
    frag.append(corner);
    for (const p of g.panels) {
      const pt = document.createElement('div');
      pt.className = 'pt';
      pt.style.left = `calc(${RULER_W}px + ${p.x}px * var(--s))`;
      pt.style.width = `calc(${p.width}px * var(--s))`;
      pt.title = p.title;
      const name = document.createElement('span');
      name.className = 'ptl';
      name.innerHTML = p.nameHTML;
      pt.append(name);
      frag.append(pt);
      g.windows.forEach((w, k) => {
        const ch = document.createElement('div');
        ch.className = 'ch';
        ch.style.left = `calc(${RULER_W}px + ${p.colX[k]}px * var(--s))`;
        ch.style.width = `calc(${g.W}px * var(--s))`;
        ch.title = w === 1 ? 'Every base' : `Most common base in each ${nf.format(w)} bp window`;
        ch.innerHTML = `<span class="n">${nf.format(w)}</span><span class="u">&nbsp;bp</span>`;
        frag.append(ch);
      });
    }
    this.heads.replaceChildren(frag);
  }

  // ---- hit testing and gestures ------------------------------------------------------------

  hitTest(clientX: number, clientY: number): Hit | null {
    const g = this.g;
    if (!g) return null;
    const r = this.plate.getBoundingClientRect();
    const ix = (clientX - r.left) / this.scale, iy = (clientY - r.top) / this.scale;
    const row = Math.floor(iy - g.margin);
    if (row < 0) return null;
    for (let pi = 0; pi < g.panels.length; pi++) {
      const p = g.panels[pi];
      for (let col = 0; col < p.colX.length; col++) {
        const cx = p.colX[col];
        if (ix >= cx && ix < cx + g.W) {
          const pos = row * g.W + Math.floor(ix - cx);
          return pos < p.length ? { panel: pi, uid: p.uid, col, pos } : null;
        }
      }
    }
    return null;
  }

  private gestures() {
    const v = this.viewer;
    let drag: { id: number; x: number; y: number; sl: number; st: number; moved: boolean; mouse: boolean } | null = null;
    let touches = 0;
    v.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') touches++;
      if (touches > 1) { drag = null; return; }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop, moved: false, mouse: e.pointerType === 'mouse' };
      if (drag.mouse) v.setPointerCapture(e.pointerId);
    });
    v.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; if (drag.mouse) v.classList.add('dragging'); }
      if (drag.moved && drag.mouse) { v.scrollLeft = drag.sl - dx; v.scrollTop = drag.st - dy; }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') touches = Math.max(0, touches - 1);
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      v.classList.remove('dragging');
      if (e.type === 'pointerup' && !d.moved) this.onTap(this.hitTest(e.clientX, e.clientY));
    };
    v.addEventListener('pointerup', end);
    v.addEventListener('pointercancel', end);

    // pinch: touch events, so that one-finger scrolling stays native and smooth
    let pinch: { d: number; s: number; left: number; top: number } | null = null;
    let lastMid = { x: 0, y: 0 };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    v.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        const r = v.getBoundingClientRect();
        pinch = { d: dist(e.touches) || 1, s: this.pendingScale?.s ?? this.scale, left: r.left, top: r.top };
        drag = null;
      }
    }, { passive: true });
    v.addEventListener('touchmove', e => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      lastMid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - pinch.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - pinch.top };
      this.setScale(pinch.s * dist(e.touches) / pinch.d, lastMid.x, lastMid.y);
    }, { passive: false });
    const endPinch = (e: TouchEvent) => { if (pinch && e.touches.length < 2) { pinch = null; this.settle(lastMid.x, lastMid.y); } };
    v.addEventListener('touchend', endPinch);
    v.addEventListener('touchcancel', endPinch);
    v.addEventListener('gesturestart', e => e.preventDefault());

    v.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = v.getBoundingClientRect();
      const base = this.pendingScale?.s ?? this.scale;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const ax = e.clientX - r.left, ay = e.clientY - r.top;
      this.setScale(base * Math.exp(-clamp(dy, -120, 120) * 0.0025), ax, ay);
      this.settle(ax, ay);
    }, { passive: false });

    v.addEventListener('keydown', e => {
      if (e.key === '+' || e.key === '=') { this.step(1); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { this.step(-1); e.preventDefault(); }
      else if (e.key === '0') { this.fit(); e.preventDefault(); }
      else if (e.key === 'Escape') this.onTap(null);
    });
  }
}
