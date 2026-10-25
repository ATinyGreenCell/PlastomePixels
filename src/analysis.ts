// Window calls, and the inverted repeats that split a plastome into LSC / IRb / SSC / IRa.
import { N } from './seq';

/** How to break a tie between equally common bases in a window.
 *  'order': the first of A, T, C, G wins.   'first': the base that appears first in the window wins. */
export type TieRule = 'order' | 'first';

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * One call per window: windows tile the sequence from its first base, and each window's call is its
 * most common base (letters other than A/C/G/T are not counted; a window with none of them is N).
 * Returns one array per window size, null where the size is 1 (every base is its own call).
 *
 * When the sizes share a factor g (20, 40, 80, 160 share 20) the bases are counted once in blocks of
 * g, and every size is summed from those blocks, so extra columns cost almost nothing.
 */
export function computeCalls(codes: Uint8Array, windows: number[], tie: TieRule): (Uint8Array | null)[] {
  const L = codes.length;
  const sizes = windows.filter(w => w > 1);
  const out: (Uint8Array | null)[] = windows.map(() => null);
  if (!sizes.length) return out;
  const g = sizes.reduce(gcd);
  const distinct = new Set(sizes).size;
  const done = new Map<number, Uint8Array>();
  if (g >= 4 && distinct > 1) {
    const nU = Math.ceil(L / g);
    const U = g <= 255 ? new Uint8Array(nU * 4) : g <= 65535 ? new Uint16Array(nU * 4) : new Uint32Array(nU * 4);
    for (let u = 0, p = 0; u < nU; u++) {
      const e = Math.min(L, p + g), o = u * 4;
      for (; p < e; p++) { const c = codes[p]; if (c < 4) U[o + c]++; }
    }
    for (const w of new Set(sizes)) {
      const m = w / g, nW = Math.ceil(L / w), calls = new Uint8Array(nW);
      for (let k = 0; k < nW; k++) {
        let a = 0, t = 0, c = 0, gg = 0;
        const u1 = Math.min(nU, (k + 1) * m);
        for (let u = k * m; u < u1; u++) { const o = u * 4; a += U[o]; t += U[o + 1]; c += U[o + 2]; gg += U[o + 3]; }
        calls[k] = decide(a, t, c, gg, tie, codes, k * w, Math.min(L, k * w + w));
      }
      done.set(w, calls);
    }
  } else {
    for (const w of new Set(sizes)) {
      const nW = Math.ceil(L / w), calls = new Uint8Array(nW);
      const cnt = new Int32Array(5);
      for (let k = 0, s = 0; k < nW; k++, s += w) {
        const e = Math.min(L, s + w);
        cnt.fill(0);
        for (let i = s; i < e; i++) cnt[codes[i]]++;
        calls[k] = decide(cnt[0], cnt[1], cnt[2], cnt[3], tie, codes, s, e);
      }
      done.set(w, calls);
    }
  }
  windows.forEach((w, i) => { if (w > 1) out[i] = done.get(w)!; });
  return out;
}

function decide(a: number, t: number, c: number, g: number, tie: TieRule, codes: Uint8Array, s: number, e: number): number {
  let best = 0, n = a, ties = 1;
  if (t > n) { best = 1; n = t; ties = 1; } else if (t === n) ties++;
  if (c > n) { best = 2; n = c; ties = 1; } else if (c === n) ties++;
  if (g > n) { best = 3; n = g; ties = 1; } else if (g === n) ties++;
  if (n === 0) return N;
  if (ties === 1 || tie === 'order') return best;
  // several bases share the top count: the one that appears first in the window wins
  const top = [a, t, c, g];
  for (let i = s; i < e; i++) { const v = codes[i]; if (v < 4 && top[v] === n) return v; }
  return best;
}

/** Counts of A, T, C, G and other letters in [start, end). */
export function countRange(codes: Uint8Array, start: number, end: number): number[] {
  const n = [0, 0, 0, 0, 0];
  for (let i = Math.max(0, start); i < Math.min(end, codes.length); i++) n[codes[i]]++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Quadripartite structure. 16-mers whose reverse complement also occurs pair up along one
// anti-diagonal (p + j = constant) for the two inverted-repeat copies.
// ---------------------------------------------------------------------------------------------

export type Span = [number, number]; // 0-based, inclusive

export interface Quadripartite {
  lsc: Span[];   // may wrap around the origin, so up to two pieces
  irb: Span;
  ssc: Span[];
  ira: Span;
  irLength: number;
}

const K = 16;
const DIAG_TOL = 24;   // indel slack between the two copies
const MAX_GAP = 400;   // mismatches split the seed run; bridge gaps up to this many bp
const MIN_IR = 1000;

export function findQuadripartite(codes: Uint8Array): Quadripartite | null {
  const L = codes.length;
  if (L < 10_000 || L > 3_000_000) return null;

  let bits = 1;
  while ((1 << bits) < L * 2) bits++;
  const cap = 1 << bits, mask = cap - 1, shift = 32 - bits;
  const keys = new Uint32Array(cap);
  const vals = new Int32Array(cap).fill(-2); // -2 empty, -1 seen more than once, >= 0 start position
  const slot = (k: number) => {
    let h = Math.imul(k, 0x9e3779b1) >>> shift;
    while (vals[h] !== -2 && keys[h] !== k) h = (h + 1) & mask;
    return h;
  };
  let fw = 0, run = 0;
  for (let i = 0; i < L; i++) {
    const c = codes[i];
    if (c > 3) { run = 0; continue; }
    fw = ((fw << 2) | c) >>> 0;
    if (++run >= K) {
      const h = slot(fw);
      if (vals[h] === -2) { keys[h] = fw; vals[h] = i - K + 1; } else vals[h] = -1;
    }
  }

  const scan = (visit: (p: number, j: number) => void) => {
    let rc = 0, r = 0;
    for (let i = 0; i < L; i++) {
      const c = codes[i];
      if (c > 3) { r = 0; continue; }
      rc = ((rc >>> 2) | ((c ^ 1) << 30)) >>> 0; // complement: A<->T (0,1), C<->G (2,3)
      if (++r >= K) {
        const h = slot(rc);
        const j = vals[h];
        if (j >= 0) { const p = i - K + 1; if (Math.abs(p - j) >= K) visit(p, j); }
      }
    }
  };
  const diag = new Int32Array(2 * L);
  scan((p, j) => { diag[p + j]++; });

  let best = -1, bestSum = 0, sum = 0;
  for (let d = 0; d < diag.length; d++) {
    sum += diag[d];
    if (d >= 2 * DIAG_TOL + 1) sum -= diag[d - 2 * DIAG_TOL - 1];
    if (sum > bestSum) { bestSum = sum; best = d - DIAG_TOL; }
  }
  if (best < 0 || bestSum < 2 * MIN_IR) return null;

  const firstHits: number[] = [], secondHits: number[] = [];
  scan((p, j) => {
    const d = p + j;
    if (d < best - DIAG_TOL || d > best + DIAG_TOL) return;
    (p < j ? firstHits : secondHits).push(p);
  });
  const a = longestRun(firstHits), b = longestRun(secondHits);
  if (!a || !b) return null;
  const first: Span = [a[0], a[1] + K - 1];
  const second: Span = [b[0], b[1] + K - 1];
  if (first[1] - first[0] + 1 < MIN_IR || second[1] - second[0] + 1 < MIN_IR || first[1] >= second[0]) return null;

  const between: Span = [first[1] + 1, second[0] - 1];
  const outside: Span[] = [];
  if (second[1] + 1 <= L - 1) outside.push([second[1] + 1, L - 1]);
  if (first[0] - 1 >= 0) outside.push([0, first[0] - 1]);
  const outsideLen = outside.reduce((s, [x, y]) => s + y - x + 1, 0);
  const betweenLen = Math.max(0, between[1] - between[0] + 1);
  const irLength = Math.round((first[1] - first[0] + second[1] - second[0] + 2) / 2);
  const sortSpans = (s: Span[]) => s.filter(([x, y]) => y >= x).sort((p, q) => p[0] - q[0]);
  if (betweenLen <= outsideLen) {
    return { lsc: sortSpans(outside), irb: first, ssc: sortSpans([between]), ira: second, irLength };
  }
  return { lsc: sortSpans([between]), irb: second, ssc: sortSpans(outside), ira: first, irLength };
}

function longestRun(pos: number[]): Span | null {
  if (pos.length === 0) return null;
  pos.sort((x, y) => x - y);
  let bs = pos[0], be = pos[0], s = pos[0], e = pos[0];
  for (let i = 1; i < pos.length; i++) {
    const p = pos[i];
    if (p - e > MAX_GAP) s = p;
    e = p;
    if (e - s > be - bs) { bs = s; be = e; }
  }
  return [bs, be];
}

export function regionAt(q: Quadripartite | null | undefined, p: number): string | null {
  if (!q) return null;
  const inSpan = ([x, y]: Span) => p >= x && p <= y;
  if (inSpan(q.irb)) return 'IRb';
  if (inSpan(q.ira)) return 'IRa';
  if (q.ssc.some(inSpan)) return 'SSC';
  if (q.lsc.some(inSpan)) return 'LSC';
  return null;
}
