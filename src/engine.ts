// The engine: holds every sequence and does all the heavy work (parsing, window calls, inverted
// repeats, tile pixels, PNG export, saving). It runs in a Web Worker so the page never stalls; the
// same class runs on the page itself if a worker can't be started.
import { parseStream, parseText, unpack2bit, unpackNibbles, composition, ParsedRecord, ParseResult } from './seq';
import { computeCalls, countRange, findQuadripartite, Quadripartite } from './analysis';
import { paintTileFull, paintTileAveraged, fillIndexRow, ColumnSource, TileCol, BG_INDEX } from './paint';
import { encodeIndexedPNG } from './png';
import { SAMPLES } from './samples';
import { SAMPLE_META } from './sampleMeta';
import type { RecordMeta, Config, View, Layout, TileReq, ToEngine, FromEngine, LoadLimits, ExportJob, Inspection, ParseSource } from './protocol';

interface Rec {
  meta: RecordMeta;
  codes: Uint8Array;
  offset: number;
  view: Uint8Array;
  calls: (Uint8Array | null)[];
  callsKey: string;
  sk?: string;              // where its bases are kept between visits
}

class NetError extends Error {}

const DB_NAME = 'plastome-pixels', DB_STORE = 'genomes', DB_KEY = 'current';
const idb = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const SAVE_LIMIT = 64_000_000;   // bases kept between visits
const QUAD_LIMIT = 3_000_000;    // plastomes are far smaller; skip the search above this

const yieldTask = (() => {
  if (typeof MessageChannel === 'undefined') return () => new Promise<void>(r => setTimeout(r, 0));
  const ch = new MessageChannel();
  const waiting: (() => void)[] = [];
  ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  return () => new Promise<void>(r => { waiting.push(r); ch.port2.postMessage(0); });
})();

export class Engine {
  private recs = new Map<number, Rec>();
  private order: number[] = [];
  private nextUid = 1;
  private cfg: Config | null = null;
  private ver = -1;
  private pal32 = new Uint32Array(6);
  private pr = new Uint8Array(6);
  private pg = new Uint8Array(6);
  private pb = new Uint8Array(6);
  private lay: Layout | null = null;
  private cols: TileCol[] = [];             // every column of the current layout
  private queue: TileReq[] = [];
  private pumping = false;
  private aborted = new Set<number>();
  private acc = new Uint32Array(5 * 1024);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private quadQueue: number[] = [];
  private stored = new Set<string>();      // genomes whose bases the database already holds
  private quadRunning = false;
  readonly bitmaps: boolean;

  constructor(private emit: (m: FromEngine, transfer?: Transferable[]) => void, private inWorker: boolean) {
    this.bitmaps = inWorker && typeof createImageBitmap === 'function';
  }

  handle(m: ToEngine): void {
    switch (m.t) {
      case 'boot': this.run(m.id, () => this.boot(m.legacy, m.limits)); break;
      case 'parse': this.run(m.id, () => this.parse(m.id, m.src, m.source, m.limits)); break;
      case 'samples': this.run(m.id, async () => this.addSamples(m.keys)); break;
      case 'drop':
        for (const u of m.uids) this.recs.delete(u);
        this.order = this.order.filter(u => this.recs.has(u));
        this.scheduleSave();
        break;
      case 'order': this.order = m.uids.filter(u => this.recs.has(u)); this.scheduleSave(); break;
      case 'config': this.run(m.id, async () => this.configure(m.ver, m.cfg, m.uids)); break;
      case 'layout': this.setLayout(m.lay); break;
      case 'tiles': this.setTiles(m.tv, m.reqs); break;
      case 'inspect': this.run(m.id, async () => this.inspect(m.uid, m.pos)); break;
      case 'peek': this.run(m.id, async () => { const r = this.recs.get(m.uid); return r ? Array.from(r.view.subarray(m.start, m.start + m.n)) : []; }); break;
      case 'export': this.run(m.id, () => this.exportPNG(m.id, m.job)); break;
      case 'cancel': this.aborted.add(m.id); break;
    }
  }

  private async run(id: number, fn: () => Promise<unknown>) {
    try {
      const result = await fn();
      this.emit({ t: 'ok', id, result });
    } catch (e) {
      const err = e as Error;
      this.emit({ t: 'err', id, message: err?.message || String(e), network: e instanceof NetError, aborted: err?.name === 'AbortError' });
    } finally {
      this.aborted.delete(id);
    }
  }

  // ---- records -------------------------------------------------------------------------

  private adopt(p: { id: string; title: string; circular: boolean | null; origin: number; fullLength?: number; comp?: number[]; codes: Uint8Array },
    source: string, sample?: string, quad?: Quadripartite | null): RecordMeta {
    const uid = this.nextUid++;
    const meta: RecordMeta = {
      uid, id: p.id, title: p.title, circular: p.circular, source, sample, origin: p.origin,
      length: p.codes.length, fullLength: Math.max(p.fullLength ?? 0, p.codes.length),
      comp: p.comp ?? composition(p.codes), quad,
    };
    this.recs.set(uid, { meta, codes: p.codes, offset: 0, view: p.codes, calls: [], callsKey: '' });
    this.order.push(uid);
    if (quad === undefined) this.queueQuad(uid);
    return meta;
  }

  private addSamples(keys: string[]): RecordMeta[] {
    const out: RecordMeta[] = [];
    for (const key of keys) {
      const s = SAMPLES.find(x => x.key === key);
      if (!s) continue;
      const m = SAMPLE_META[key];
      out.push(this.adopt({ id: s.id, title: s.title, circular: true, origin: 1, comp: m?.comp, codes: unpack2bit(s.data, s.length) }, 'Sample', key, m ? m.quad : undefined));
    }
    this.scheduleSave();
    return out;
  }

  private async boot(legacy: string | null, limits: LoadLimits): Promise<RecordMeta[]> {
    let metas = await this.restore(limits);
    if (!metas.length && legacy) {
      try { metas = this.adoptLegacy(legacy); } catch { metas = []; }
      if (metas.length) this.scheduleSave();
    }
    if (!metas.length) metas = this.addSamples(SAMPLES.map(s => s.key));
    return metas;
  }

  private adoptLegacy(json: string): RecordMeta[] {
    const list = JSON.parse(json) as any[];
    const out: RecordMeta[] = [];
    for (const g of list) {
      if (g?.sample) { out.push(...this.addSamples([String(g.sample)])); continue; }
      if (typeof g?.data !== 'string' || typeof g?.length !== 'number') continue;
      out.push(this.adopt({ id: String(g.id), title: String(g.title ?? ''), circular: g.circular ?? null, origin: typeof g.origin === 'number' ? g.origin : 1, codes: unpackNibbles(g.data, g.length) }, String(g.source ?? 'Saved')));
    }
    return out;
  }

  private async parse(id: number, src: ParseSource, source: string, limits: LoadLimits): Promise<{ records: RecordMeta[]; notes: string[] }> {
    const opts = { from: limits.from, length: limits.length, maxBases: limits.maxBases, maxRecords: limits.maxRecords };
    const aborted = this.aborted;
    const signal = { get aborted() { return aborted.has(id); } };
    let res: ParseResult;
    let last = 0;
    const progress = (total: number) => (n: number) => {
      const now = Date.now();
      if (now - last > 120) { last = now; this.emit({ t: 'progress', id, done: n, total }); }
    };
    if (src.kind === 'text') {
      res = parseText(src.text, opts);
    } else if (src.kind === 'file') {
      res = await parseStream(src.file.stream() as ReadableStream<Uint8Array>, opts, src.file.size, progress(src.file.size), signal);
    } else {
      res = await this.download(src.url, opts, id, signal);
    }
    const records = res.records.map((r: ParsedRecord) => this.adopt(r, source));
    this.scheduleSave();
    return { records, notes: res.notes };
  }

  /** NCBI efetch, streamed into the parser; one retry when NCBI is busy, and a stall watchdog. */
  private async download(url: string, opts: object, id: number, signal: { aborted: boolean }): Promise<ParseResult> {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      let watchdog = setTimeout(() => ctl.abort(), 45_000);
      const poke = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctl.abort(), 45_000); };
      let res: Response;
      try {
        res = await fetch(url, { signal: ctl.signal });
      } catch (e) {
        clearTimeout(watchdog);
        if ((e as Error)?.name === 'AbortError') throw new Error('NCBI stopped answering. Try again in a moment.');
        throw new NetError('NCBI could not be reached.');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        clearTimeout(watchdog);
        await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!res.ok) { clearTimeout(watchdog); throw new Error(res.status === 400 ? 'NCBI has no sequence under that accession.' : `NCBI answered with error ${res.status}.`); }
      if (/html/i.test(res.headers.get('content-type') || '')) {
        clearTimeout(watchdog);
        throw new Error('A web page answered instead of NCBI. On public Wi-Fi, sign in to it first, then try again.');
      }
      const total = Number(res.headers.get('content-length')) || 0;
      let last = 0;
      try {
        return await parseStream(res.body as ReadableStream<Uint8Array>, opts, total, n => {
          poke();
          const now = Date.now();
          if (now - last > 120) { last = now; this.emit({ t: 'progress', id, done: n, total }); }
        }, signal);
      } catch (e) {
        if (ctl.signal.aborted && !signal.aborted) throw new Error('The download stalled. Try again in a moment.');
        throw e;
      } finally {
        clearTimeout(watchdog);
      }
    }
  }

  // ---- inverted repeats, found in the background ----------------------------------------

  private queueQuad(uid: number) {
    this.quadQueue.push(uid);
    if (!this.quadRunning) { this.quadRunning = true; setTimeout(() => this.runQuads(), 30); }
  }

  private async runQuads() {
    while (this.quadQueue.length) {
      const uid = this.quadQueue.shift()!;
      const r = this.recs.get(uid);
      if (!r || r.meta.quad !== undefined) continue;
      // the window calls and tiles go first: wait until the tile queue is idle
      while (this.queue.length) await new Promise(res => setTimeout(res, 50));
      let q: Quadripartite | null = null;
      try { q = r.codes.length <= QUAD_LIMIT ? findQuadripartite(r.codes) : null; } catch { q = null; }
      r.meta.quad = q;
      this.emit({ t: 'quad', uid, quad: q });
      this.scheduleSave();
      await yieldTask();
    }
    this.quadRunning = false;
  }

  // ---- layout -------------------------------------------------------------------------

  private configure(ver: number, cfg: Config, uids: number[]): View[] {
    this.cfg = cfg;
    this.ver = ver;
    this.queue = [];
    this.lay = null;          // the page sends the new layout once it has these views
    this.cols = [];
    cfg.colors.forEach(([r, g, b], i) => {
      this.pr[i] = r; this.pg[i] = g; this.pb[i] = b;
      this.pal32[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    });
    const views: View[] = [];
    const winKey = cfg.windows.join(',') + '|' + cfg.tie;
    for (const uid of uids) {
      const r = this.recs.get(uid);
      if (!r) continue;
      const L = r.codes.length, o = r.meta.origin;
      const off = Math.min(L, Math.max(0, cfg.start - o));
      const end = cfg.length > 0 ? Math.min(L, Math.max(off, cfg.start + cfg.length - o)) : L;
      const key = `${off}:${end}|${winKey}`;
      if (key !== r.callsKey) {
        r.offset = off;
        r.view = r.codes.subarray(off, end);
        r.calls = computeCalls(r.view, cfg.windows, cfg.tie);
        r.callsKey = key;
      }
      views.push({ uid, offset: off, length: end - off });
    }
    return views;
  }

  // ---- tiles ---------------------------------------------------------------------------

  private setLayout(lay: Layout) {
    const cfg = this.cfg;
    this.queue = [];
    if (!cfg || lay.ver !== this.ver) { this.lay = null; this.cols = []; return; }
    this.lay = lay;
    const cols: TileCol[] = [];
    for (const p of lay.panels) {
      const r = this.recs.get(p.uid);
      if (!r) continue;
      p.colX.forEach((x, k) => cols.push({ x, y: p.y, rows: p.rows, src: { codes: r.view, calls: r.calls[k] ?? null, w: cfg.windows[k] } }));
    }
    this.cols = cols;
  }

  private setTiles(tv: number, reqs: TileReq[]) {
    if (!this.lay || tv !== this.lay.tv) return;
    this.queue = reqs;
    if (!this.pumping) void this.pump();
  }

  private async pump() {
    this.pumping = true;
    try {
      while (this.queue.length) {
        const t0 = performance.now();
        while (this.queue.length && performance.now() - t0 < (this.inWorker ? 24 : 6)) this.renderTile(this.queue.shift()!);
        await yieldTask(); // let a newer request replace what is left
      }
    } finally {
      this.pumping = false;
    }
  }

  private renderTile(q: TileReq) {
    const lay = this.lay;
    if (!lay) return;
    const tv = lay.tv, f = 1 << q.sh;
    const bw = (q.x1 - q.x0 + f - 1) >> q.sh, bh = (q.y1 - q.y0 + f - 1) >> q.sh;
    if (bw <= 0 || bh <= 0) return;
    const img = new ImageData(bw, bh);
    if (q.sh === 0) {
      paintTileFull(this.cols, lay.W, q.x0, q.y0, bw, bh, this.pal32, new Uint32Array(img.data.buffer));
    } else {
      if (this.acc.length < bw * 5) this.acc = new Uint32Array(bw * 5);
      paintTileAveraged(this.cols, lay.W, q.x0, q.x1, q.y0, q.y1, q.sh, this.pr, this.pg, this.pb, img.data, this.acc);
    }
    if (!this.inWorker) { this.emit({ t: 'tile', tv, key: q.key, w: bw, h: bh, image: img }); return; }
    if (this.bitmaps) {
      createImageBitmap(img).then(
        bitmap => this.emit({ t: 'tile', tv, key: q.key, w: bw, h: bh, bitmap }, [bitmap]),
        () => this.emit({ t: 'tile', tv, key: q.key, w: bw, h: bh, rgba: img.data.buffer }, [img.data.buffer]),
      );
    } else {
      this.emit({ t: 'tile', tv, key: q.key, w: bw, h: bh, rgba: img.data.buffer }, [img.data.buffer]);
    }
  }

  // ---- inspector ------------------------------------------------------------------------

  private inspect(uid: number, pos: number): Inspection | null {
    const r = this.recs.get(uid), cfg = this.cfg;
    if (!r || !cfg || pos < 0 || pos >= r.view.length) return null;
    const v = r.view;
    const ctx: number[] = [];
    for (let i = pos - 10; i <= pos + 10; i++) ctx.push(i >= 0 && i < v.length ? v[i] : -1);
    const calls: number[] = [], counts: number[][] = [], ranges: [number, number][] = [];
    cfg.windows.forEach((w, k) => {
      const s = Math.floor(pos / w) * w, e = Math.min(v.length, s + w);
      const c = r.calls[k];
      calls.push(c ? c[Math.floor(pos / w)] : v[pos]);
      counts.push(countRange(v, s, e));
      ranges.push([s, e]);
    });
    return { ctx, calls, counts, ranges };
  }

  // ---- export ---------------------------------------------------------------------------

  private async exportPNG(id: number, job: ExportJob): Promise<Blob> {
    const cfg = this.cfg;
    if (!cfg || job.ver !== this.ver) throw new Error('The layout changed while saving. Try again.');
    const f = job.scale, W = cfg.width;
    const outW = job.width * f, outH = job.height * f;
    const cols = job.panels.map(p => {
      const r = this.recs.get(p.uid);
      return r ? p.colX.map((cx, k) => ({ cx, src: { codes: r.view, calls: r.calls[k] ?? null, w: cfg.windows[k] } as ColumnSource })) : [];
    }).flat();
    const base = new Uint8Array(job.width);
    let cached = -1, last = 0;
    return encodeIndexedPNG(outW, outH, cfg.colors, (y, row) => {
      if (this.aborted.has(id)) throw new DOMException('Cancelled', 'AbortError');
      const iy = Math.floor(y / f);
      if (iy !== cached) {
        base.fill(BG_INDEX);
        const r = iy - job.margin;
        if (r >= 0) for (const c of cols) fillIndexRow(c.src, W, r, base, c.cx);
        cached = iy;
      }
      if (f === 1) row.set(base);
      else for (let x = 0; x < job.width; x++) row.fill(base[x], x * f, x * f + f);
      if ((y & 255) === 0) {
        const now = Date.now();
        if (now - last > 150) { last = now; this.emit({ t: 'progress', id, done: y, total: outH }); }
      }
    }, job.text);
  }

  // ---- saving between visits (IndexedDB) -------------------------------------------------

  private db(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') { rej(new Error('no IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('blocked'));
    });
  }

  private async restore(limits: LoadLimits): Promise<RecordMeta[]> {
    try {
      const db = await this.db();
      const val = await idb(db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_KEY));
      if (!Array.isArray(val)) { db.close(); return []; }
      // every genome's bases, in one transaction (each genome is its own record, so a change to the
      // list never rewrites them)
      const st = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE);
      const bases = await Promise.all(val.map((g: any) => (typeof g?.sk === 'string' ? idb(st.get(g.sk)) : Promise.resolve(g?.codes))));
      db.close();
      const out: RecordMeta[] = [];
      let total = 0;
      val.forEach((g: any, i: number) => {
        if (g?.sample) { out.push(...this.addSamples([String(g.sample)])); return; }
        const codes = bases[i];
        if (!(codes instanceof Uint8Array) || !g.meta || total + codes.length > limits.maxBases) return;
        total += codes.length;
        const m = g.meta;
        const meta = this.adopt({ id: String(m.id), title: String(m.title ?? ''), circular: m.circular ?? null, origin: Number(m.origin) || 1, fullLength: m.fullLength, comp: m.comp, codes }, String(m.source ?? 'Saved'), undefined, m.quad);
        if (typeof g.sk === 'string') { this.recs.get(meta.uid)!.sk = g.sk; this.stored.add(g.sk); }
        out.push(meta);
      });
      return out;
    } catch {
      return [];
    }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save(); }, 1500);
  }

  private async save() {
    try {
      const list = this.order.map(u => this.recs.get(u)).filter((r): r is Rec => !!r);
      const total = list.reduce((n, r) => n + (r.meta.sample ? 0 : r.codes.length), 0);
      const keep = total > SAVE_LIMIT ? list.filter(r => r.meta.sample) : list;
      const value = keep.map(r => {
        if (r.meta.sample) return { sample: r.meta.sample };
        r.sk ??= 'g:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const m = r.meta;
        return { sk: r.sk, meta: { id: m.id, title: m.title, circular: m.circular, source: m.source, origin: m.origin, fullLength: m.fullLength, comp: m.comp, quad: m.quad } };
      });
      const db = await this.db();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const st = tx.objectStore(DB_STORE);
        const want = new Set<string>();
        for (const r of keep) {
          if (!r.sk) continue;
          want.add(r.sk);
          // bases are written once; reordering, removing or naming the repeats only rewrites the list.
          // A slice of a parse buffer is copied, or the whole shared buffer would be stored.
          if (!this.stored.has(r.sk)) st.put(r.codes.byteOffset === 0 && r.codes.byteLength === r.codes.buffer.byteLength ? r.codes : r.codes.slice(), r.sk);
        }
        st.put(value, DB_KEY);
        const keys = st.getAllKeys();      // genomes no longer shown leave the database
        keys.onsuccess = () => { for (const k of keys.result) if (k !== DB_KEY && !want.has(String(k))) st.delete(k); };
        tx.oncomplete = () => { this.stored = want; res(); };
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
      db.close();
    } catch { /* storage unavailable or full: the page still works */ }
  }
}
