// Pixel painting. The viewer shows the image as square tiles cut from the whole picture (every
// genome, every column, background between), because each tile costs the browser a fixed amount to
// show: a few big tiles are far cheaper than many thin per-column ones. Window columns are drawn as
// runs (one fill per window), never pixel by pixel.

export interface ColumnSource {
  codes: Uint8Array;            // the shown bases
  calls: Uint8Array | null;     // one call per window, or null for the every-base column
  w: number;                    // window size
}

/** A column placed in the image: left edge x, first row y, `rows` rows of W bases. */
export interface TileCol { x: number; y: number; rows: number; src: ColumnSource }

export const BG_INDEX = 5;

/** Full resolution: image px [x0, x0+bw) x [y0, y0+bh), as 32-bit RGBA. */
export function paintTileFull(cols: TileCol[], W: number, x0: number, y0: number, bw: number, bh: number,
  pal32: Uint32Array, out: Uint32Array): void {
  out.fill(pal32[BG_INDEX], 0, bw * bh);
  const x1 = x0 + bw, y1 = y0 + bh;
  for (const c of cols) {
    const ax = Math.max(x0, c.x), bx = Math.min(x1, c.x + W);
    const ay = Math.max(y0, c.y), by = Math.min(y1, c.y + c.rows);
    if (ax >= bx || ay >= by) continue;
    const { codes, calls, w } = c.src;
    const L = codes.length, span = bx - ax;
    for (let y = ay; y < by; y++) {
      const p0 = (y - c.y) * W + (ax - c.x);
      const n = Math.min(span, L - p0);
      if (n <= 0) break;                       // past the end of the sequence
      const o = (y - y0) * bw + (ax - x0);
      if (calls === null) {
        for (let i = 0; i < n; i++) out[o + i] = pal32[codes[p0 + i]];
      } else {
        let p = p0, k = (p0 / w) | 0;
        const pe = p0 + n;
        while (p < pe) {
          const e = Math.min(pe, (k + 1) * w);
          out.fill(pal32[calls[k]], o + p - p0, o + e - p0);
          p = e;
          k++;
        }
      }
    }
  }
}

/**
 * Overview: each output pixel averages an f x f block (f = 1 << sh) of the image, the way a good
 * downscale would, so zoomed-out views stay faithful instead of shimmering. Covers image px
 * [x0, x1) x [y0, y1) (clipped to the image, so edge blocks average only what is there).
 * `out` is RGBA bytes; `acc` is scratch of at least bw*5.
 */
export function paintTileAveraged(cols: TileCol[], W: number, x0: number, x1: number, y0: number, y1: number, sh: number,
  pr: ArrayLike<number>, pg: ArrayLike<number>, pb: ArrayLike<number>, out: Uint8ClampedArray, acc: Uint32Array): void {
  const f = 1 << sh;
  const bw = (x1 - x0 + f - 1) >> sh, bh = (y1 - y0 + f - 1) >> sh;
  const r0 = pr[0], r1 = pr[1], r2 = pr[2], r3 = pr[3], r4 = pr[4], r5 = pr[5];
  const g0 = pg[0], g1 = pg[1], g2 = pg[2], g3 = pg[3], g4 = pg[4], g5 = pg[5];
  const b0 = pb[0], b1 = pb[1], b2 = pb[2], b3 = pb[3], b4 = pb[4], b5 = pb[5];
  // only the columns this tile touches, with their part of it
  const live: { c: TileCol; ax: number; span: number; off: number }[] = [];
  for (const c of cols) {
    const ax = Math.max(x0, c.x), bx = Math.min(x1, c.x + W);
    if (ax < bx && c.y < y1 && c.y + c.rows > y0) live.push({ c, ax, span: bx - ax, off: ax - x0 });
  }
  let o = 0;
  for (let by = 0; by < bh; by++) {
    const ys = y0 + (by << sh), ye = Math.min(y1, ys + f);
    acc.fill(0, 0, bw * 5);
    for (const { c, ax, span, off } of live) {
      const ay = Math.max(ys, c.y), byy = Math.min(ye, c.y + c.rows);
      if (ay >= byy) continue;
      const { codes, calls, w } = c.src;
      const L = codes.length;
      for (let y = ay; y < byy; y++) {
        const p0 = (y - c.y) * W + (ax - c.x);
        const n = Math.min(span, L - p0);
        if (n <= 0) break;
        if (calls === null) {
          for (let i = 0; i < n; i++) acc[((off + i) >> sh) * 5 + codes[p0 + i]]++;
        } else {
          let p = p0, k = (p0 / w) | 0;
          const pe = p0 + n;
          while (p < pe) {
            const e = Math.min(pe, (k + 1) * w), cc = calls[k];
            let a = off + p - p0;
            const b = off + e - p0;
            while (a < b) {
              const bin = a >> sh, be = Math.min(b, (bin + 1) << sh);
              acc[bin * 5 + cc] += be - a;
              a = be;
            }
            p = e;
            k++;
          }
        }
      }
    }
    const rowsN = ye - ys;
    for (let bx = 0; bx < bw; bx++, o += 4) {
      const q = bx * 5;
      const c0 = acc[q], c1 = acc[q + 1], c2 = acc[q + 2], c3 = acc[q + 3], c4 = acc[q + 4];
      const xs = x0 + (bx << sh);
      const tot = (Math.min(x1, xs + f) - xs) * rowsN;
      const c5 = tot - c0 - c1 - c2 - c3 - c4;     // everything else in the block is background
      out[o] = (c0 * r0 + c1 * r1 + c2 * r2 + c3 * r3 + c4 * r4 + c5 * r5) / tot;
      out[o + 1] = (c0 * g0 + c1 * g1 + c2 * g2 + c3 * g3 + c4 * g4 + c5 * g5) / tot;
      out[o + 2] = (c0 * b0 + c1 * b1 + c2 * b2 + c3 * b3 + c4 * b4 + c5 * b5) / tot;
      out[o + 3] = 255;
    }
  }
}

/** Palette indices of image row r of a column, written into dest at offset cx (dest is pre-filled with background). */
export function fillIndexRow(src: ColumnSource, W: number, r: number, dest: Uint8Array, cx: number): void {
  const { codes, calls, w } = src;
  const p0 = r * W;
  const n = Math.max(0, Math.min(W, codes.length - p0));
  if (n === 0) return;
  if (calls === null) { dest.set(codes.subarray(p0, p0 + n), cx); return; }
  let p = p0, k = Math.floor(p0 / w);
  const pe = p0 + n;
  while (p < pe) {
    const e = Math.min(pe, (k + 1) * w);
    dest.fill(calls[k], cx + p - p0, cx + e - p0);
    p = e;
    k++;
  }
}
