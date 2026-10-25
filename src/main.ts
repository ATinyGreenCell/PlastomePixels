// Plastome Pixels: the page. Everything heavy happens in the engine (a Web Worker); this file keeps
// the controls, the viewer and the side panel in step with it.
import { shortName, LETTERS } from './seq';
import { regionAt, Span, TieRule } from './analysis';
import { EngineClient, EngineError } from './client';
import { Viewer, Geometry, PanelGeom, Hit } from './viewer';
import type { RecordMeta, View, Config, Inspection, LoadLimits, ParseSource, ExportJob } from './protocol';
import { Kind, Hit as NcbiHit, Found, find, page as ncbiPage, summaries, buildTerm, cleanQuery, websiteSearchURL, efetchURL } from './ncbi';
import { APP_VERSION } from './version';

declare const __TARGET__: 'pages' | 'artifact';
declare const __ENGINE_URL__: string;

// ===== Fixed base colours. Change them here. =====
const BASE_RGB: number[][] = [
  [0, 255, 255],   // A  cyan
  [255, 255, 0],   // T  yellow
  [255, 0, 0],     // C  red
  [0, 0, 0],       // G  black
];

interface Settings {
  width: number; windows: number[]; gap: number; panelGap: number; margin: number;
  bg: string; other: string; tie: TieRule; start: number; length: number; scale: number; irMarks: boolean;
  ncbiKind: Kind; refseq: boolean; sliceFrom: number; sliceLen: number;
}

const DEFAULTS: Settings = {
  width: 100, windows: [1, 20, 40, 80, 160], gap: 5, panelGap: 30, margin: 0,
  bg: '#000000', other: '#808080', tie: 'order', start: 1, length: 0, scale: 1, irMarks: false,
  ncbiKind: 'plastid', refseq: true, sliceFrom: 1, sliceLen: 1_000_000,
};

const STORE_SETTINGS = 'plastome-pixels/settings/v1';
const LEGACY_GENOMES = 'plastome-pixels/genomes/v1';
const COARSE = matchMedia('(pointer: coarse)').matches;
const MAX_BASES = COARSE ? 48_000_000 : 96_000_000;   // held at once
const MAX_PANELS = 24;
const MAX_WHOLE = 20_000_000;                         // NCBI records longer than this download as a slice
const KINDS: Kind[] = ['plastid', 'mito', 'plasmid', 'chromosome', 'any'];

const nf = new Intl.NumberFormat('en-US');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (n: number, d: number) => (d ? (100 * n / d).toFixed(1) : '0.0');
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hexRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const isHex = (h: unknown): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h);
const speciesHTML = (name: string) => {
  const m = /^([A-Z][a-z]+ (?:x )?[a-z][a-z-]+)(\b.*)$/.exec(name);
  return m ? `<i>${esc(m[1])}</i>${esc(m[2])}` : esc(name);
};
const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------------------------------------
// state

let S: Settings = loadSettings();
let panels: RecordMeta[] = [];
let views = new Map<number, View>();
let ver = 0;                       // bumps whenever the pixels of a genome change
let sel: { uid: number; pos: number } | null = null;
let busyCount = 0;

const claude = (window as any).claude as { use?: (n: string) => Promise<any> } | undefined;
const inViewer = __TARGET__ === 'artifact' && !!claude;
const downloadsReady: Promise<any> = claude?.use ? claude.use('downloads').catch(() => null) : Promise.resolve(null);

const client = new EngineClient(
  () => (__TARGET__ === 'pages' ? __ENGINE_URL__ : engineBlobURL()),
  () => loadEngineOnPage(),
);
const viewer = new Viewer($('viewer'), $('sheet'), $('heads'), $('ruler'), $('plate'), client);

function engineBlobURL(): string | null {
  const src = document.getElementById('engine-src')?.textContent;
  if (!src) return null;
  return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

function loadEngineOnPage(): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = window as any;
    if (w.PPXEngine) { resolve(w.PPXEngine); return; }
    const s = document.createElement('script');
    if (__TARGET__ === 'pages') {
      s.src = __ENGINE_URL__;
      s.onload = () => (w.PPXEngine ? resolve(w.PPXEngine) : reject(new Error('engine failed to load')));
      s.onerror = () => reject(new Error('engine failed to load'));
      document.head.append(s);
    } else {
      s.textContent = document.getElementById('engine-src')?.textContent ?? '';
      document.head.append(s); // inline scripts run as soon as they are inserted
      if (w.PPXEngine) resolve(w.PPXEngine); else reject(new Error('engine failed to load'));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// settings

function sanitize(s: Partial<Settings>): Settings {
  const d = DEFAULTS;
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : def);
  const wins = Array.isArray(s.windows) ? s.windows.filter(w => Number.isInteger(w) && w >= 1 && w <= 1_000_000).slice(0, 16) : [];
  return {
    width: num(s.width, 1, 100_000, d.width),
    windows: wins.length ? wins : [...d.windows],
    gap: num(s.gap, 0, 500, d.gap),
    panelGap: num(s.panelGap, 0, 2000, d.panelGap),
    margin: num(s.margin, 0, 2000, d.margin),
    bg: isHex(s.bg) ? s.bg.toLowerCase() : d.bg,
    other: isHex(s.other) ? s.other.toLowerCase() : d.other,
    tie: s.tie === 'first' ? 'first' : 'order',
    start: num(s.start, 1, 4_000_000_000, 1),
    length: num(s.length, 0, 4_000_000_000, 0),
    scale: num(s.scale, 1, 16, 1),
    irMarks: !!s.irMarks,
    ncbiKind: KINDS.includes(s.ncbiKind as Kind) ? s.ncbiKind as Kind : d.ncbiKind,
    refseq: s.refseq === undefined ? d.refseq : !!s.refseq,
    sliceFrom: num(s.sliceFrom, 1, 5_000_000_000, d.sliceFrom),
    sliceLen: num(s.sliceLen, 1000, MAX_WHOLE, d.sliceLen),
  };
}

function loadSettings(): Settings {
  try { const raw = localStorage.getItem(STORE_SETTINGS); if (raw) return sanitize(JSON.parse(raw)); } catch { /* storage unavailable */ }
  return sanitize({});
}

const saveSettings = debounce(() => {
  try { localStorage.setItem(STORE_SETTINGS, JSON.stringify(S)); } catch { /* ignore */ }
}, 400);

const colors = () => [...BASE_RGB, hexRgb(S.other), hexRgb(S.bg)];

// ---------------------------------------------------------------------------------------------
// layout: engine config -> views -> geometry -> viewer

let configSeq = 0;

/** bump: the pixels of existing genomes change (windows, width, colours, ties, range). */
async function configure(bump: boolean): Promise<void> {
  if (bump) ver++;
  const mySeq = ++configSeq;
  const cfg: Config = { windows: S.windows, tie: S.tie, start: S.start, length: S.length, width: S.width, colors: colors() };
  const uids = panels.map(p => p.uid);
  try {
    const vs = await client.request<View[]>({ t: 'config', ver, cfg, uids }).promise;
    if (mySeq !== configSeq) return; // a newer layout is on its way
    views = new Map(vs.map(v => [v.uid, v]));
    layout();
  } catch (e) {
    toast((e as Error).message);
  }
}

function geometry(): Geometry {
  const W = S.width, nC = S.windows.length;
  let x = S.margin, rows = 0;
  const gp: PanelGeom[] = [];
  panels.forEach((p, i) => {
    const v = views.get(p.uid);
    const len = v ? v.length : 0;
    if (i > 0) x += S.panelGap;
    const x0 = x;
    const colX: number[] = [];
    for (let k = 0; k < nC; k++) { colX.push(x); x += W; if (k < nC - 1) x += S.gap; }
    const r = Math.ceil(len / W);
    rows = Math.max(rows, r);
    gp.push({
      uid: p.uid, nameHTML: speciesHTML(shortName(p)), title: `${shortName(p)} · ${p.id} · ${nf.format(len)} bp shown`,
      x: x0, width: x - x0, rows: r, colX, origin0: p.origin + (v ? v.offset : 0), length: len,
    });
  });
  return { width: panels.length ? x + S.margin : 0, height: panels.length ? rows + 2 * S.margin : 0, rows, margin: S.margin, W, windows: S.windows, panels: gp };
}

function layout() {
  const g = geometry();
  viewer.setGeometry(g, ver);
  const msg = $('viewerMsg');
  const empty = !panels.length ? 'Open a FASTA or GenBank file, or search NCBI, to begin.'
    : g.rows === 0 ? 'Nothing falls inside the chosen range. Check From base and Length under Layout.' : '';
  msg.textContent = empty;
  msg.hidden = !empty;
  renderPanelList();
  renderExportInfo();
  drawMarks();
  renderInspector(null);
  void drawStrip();
  syncZoomUI(viewer.scale);
  document.documentElement.style.setProperty('--base-n', S.other);
}

// ---------------------------------------------------------------------------------------------
// loading genomes

const loadedBases = () => panels.reduce((n, p) => n + p.length, 0);

function limitsFor(mode: 'replace' | 'add'): LoadLimits {
  const room = MAX_BASES - (mode === 'add' ? loadedBases() : 0);
  // a stretch that lies beyond what the page can hold is cut out while reading
  const far = S.length > 0 && S.start + S.length - 1 > room;
  return {
    from: far ? S.start : 1, length: far ? S.length : 0, maxBases: Math.max(0, room),
    maxRecords: Math.max(0, MAX_PANELS - (mode === 'add' ? panels.length : 0)),
  };
}

async function load(sources: { src: ParseSource; source: string; label: string }[], mode: 'replace' | 'add'): Promise<EngineError | null> {
  if (!sources.length) return null;
  if (mode === 'add' && panels.length >= MAX_PANELS) { toast(`There are already ${MAX_PANELS} genomes side by side. Remove one first.`); return null; }
  const fresh: RecordMeta[] = [];
  const notes: string[] = [];
  let failed = '';
  let lastErr: EngineError | null = null;
  for (const s of sources) {
    const lim = limitsFor(mode);
    lim.maxBases -= fresh.reduce((n, p) => n + p.length, 0);
    lim.maxRecords -= fresh.length;
    if (lim.maxRecords <= 0 || lim.maxBases <= 0) { notes.push(`${s.label} was not opened: the page is full.`); continue; }
    const job = client.request<{ records: RecordMeta[]; notes: string[] }>({ t: 'parse', src: s.src, source: s.source, limits: lim },
      (done, total) => busyText(`Reading ${s.label}… ${total ? Math.min(100, Math.round(100 * done / total)) + '%' : fmtBytes(done)}`));
    busy(true, `Reading ${s.label}…`, () => client.cancel(job.id));
    try {
      const r = await job.promise;
      fresh.push(...r.records);
      notes.push(...r.notes);
    } catch (e) {
      const err = e as EngineError;
      if (!err.aborted) { failed = `${s.label}: ${err.message}`; lastErr = err; }
    } finally {
      busy(false);
    }
  }
  if (fresh.length) {
    if (mode === 'replace') { client.send({ t: 'drop', uids: panels.map(p => p.uid) }); panels = fresh; }
    else panels = [...panels, ...fresh];
    client.send({ t: 'order', uids: panels.map(p => p.uid) });
    sel = null;
    await configure(mode === 'replace');
    if (mode === 'replace' || viewer.mode === 'fit') viewer.fit();
    toast([fresh.length === 1 ? `Loaded ${shortName(fresh[0])}.` : `Loaded ${fresh.length} sequences.`, ...notes].join(' '));
  }
  if (failed) toast(failed);
  else if (!fresh.length && notes.length) toast(notes.join(' '));
  return lastErr;
}

async function loadSamples(keys: string[]) {
  try {
    const metas = await client.request<RecordMeta[]>({ t: 'samples', keys }).promise;
    client.send({ t: 'drop', uids: panels.map(p => p.uid) });
    panels = metas;
    client.send({ t: 'order', uids: panels.map(p => p.uid) });
    sel = null;
    await configure(true);
    viewer.fit();
  } catch (e) { toast((e as Error).message); }
}

client.onQuad = m => {
  const p = panels.find(x => x.uid === m.uid);
  if (!p) return;
  p.quad = m.quad;
  renderPanelList();
  drawMarks();
  if (sel?.uid === m.uid) void inspect();
};

// ---------------------------------------------------------------------------------------------
// marks: selection and LSC / IR / SSC boundaries (viewer only, never exported)

function rangeRects(a: number, b: number, W: number): [number, number, number, number][] {
  const ra = Math.floor(a / W), rb = Math.floor(b / W);
  if (ra === rb) return [[a % W, ra, b % W + 1 - a % W, 1]];
  const out: [number, number, number, number][] = [[a % W, ra, W - a % W, 1]];
  if (rb - ra > 1) out.push([0, ra + 1, W, rb - ra - 1]);
  out.push([0, rb, b % W + 1, 1]);
  return out;
}

function drawMarks() {
  const g = viewer.geometry;
  const parts: string[] = [], labels: string[] = [];
  if (g) {
    const W = g.W, m = g.margin;
    if (S.irMarks) {
      panels.forEach((p, pi) => {
        const q = p.quad, gp = g.panels[pi], v = views.get(p.uid);
        if (!q || !gp || !v) return;
        const starts: [string, number][] = [];
        q.lsc.forEach(([s]) => starts.push(['LSC', s]));
        starts.push(['IRb', q.irb[0]]);
        q.ssc.forEach(([s]) => starts.push(['SSC', s]));
        starts.push(['IRa', q.ira[0]]);
        for (const [name, s] of starts) {
          const i = s - v.offset;
          if (i <= 0 || i >= v.length) continue;
          const row = Math.floor(i / W), x = i % W;
          for (const cx of gp.colX) {
            const d = x === 0 ? `M${cx} ${m + row}H${cx + W}` : `M${cx} ${m + row + 1}H${cx + x}V${m + row}H${cx + W}`;
            parts.push(`<path class="ir-halo" d="${d}"/><path class="ir-line" d="${d}"/>`);
          }
          labels.push(`<span class="ir-label" style="left:calc(${gp.x}px * var(--s));top:calc(${m + row}px * var(--s))">${name} ${nf.format(p.origin + s)}</span>`);
        }
      });
    }
    const pi = sel ? panels.findIndex(p => p.uid === sel!.uid) : -1;
    const gp = pi >= 0 ? g.panels[pi] : null;
    if (sel && gp && sel.pos < gp.length) {
      const pos = sel.pos, row = Math.floor(pos / W), x = pos % W;
      parts.push(`<path class="row-guide" d="M${gp.x - 0.5} ${m + row + 0.5}H${gp.x + gp.width + 0.5}"/>`);
      S.windows.forEach((w, k) => {
        const cx = gp.colX[k];
        if (w > 1) {
          const s0 = Math.floor(pos / w) * w, e0 = Math.min(gp.length, s0 + w) - 1;
          const d = rangeRects(s0, e0, W).map(([rx, ry, rw, rh]) => `M${cx + rx} ${m + ry}h${rw}v${rh}h${-rw}Z`).join('');
          parts.push(`<path class="win-halo" d="${d}"/><path class="win" d="${d}"/>`);
        }
        const d = `M${cx + x} ${m + row}h1v1h-1Z`;
        parts.push(`<path class="px-halo" d="${d}"/><path class="px" d="${d}"/>`);
      });
    }
  }
  viewer.marks.innerHTML = parts.join('');
  viewer.labels.innerHTML = labels.join('');
}

// ---------------------------------------------------------------------------------------------
// inspector

viewer.onTap = (hit: Hit | null) => {
  sel = hit ? { uid: hit.uid, pos: hit.pos } : null;
  drawMarks();
  void inspect();
};

let inspectSeq = 0;
async function inspect() {
  const my = ++inspectSeq;
  if (!sel) { renderInspector(null); return; }
  try {
    const info = await client.request<Inspection | null>({ t: 'inspect', uid: sel.uid, pos: sel.pos }).promise;
    if (my === inspectSeq) renderInspector(info);
  } catch { if (my === inspectSeq) renderInspector(null); }
}

function renderInspector(info: Inspection | null) {
  const box = $('inspector');
  const p = sel ? panels.find(x => x.uid === sel!.uid) : null;
  const v = p ? views.get(p.uid) : null;
  if (!sel || !p || !v || !info) {
    box.innerHTML = `<p class="ins-empty">Tap or click any pixel to see its position, its base, and what each window column called there.</p>`;
    return;
  }
  const W = S.width, pos = sel.pos;
  const coord = (i: number) => p.origin + v.offset + i;
  const region = regionAt(p.quad, v.offset + pos);
  const ctx = info.ctx.map((c, i) => c < 0 ? '<span class="ctx-cell empty"></span>'
    : `<span class="ctx-cell b${c}${i === 10 ? ' here' : ''}">${LETTERS[c]}</span>`).join('');
  const rows = S.windows.map((w, k) => {
    const [s0, e0] = info.ranges[k] ?? [pos, pos + 1];
    const range = w === 1 ? nf.format(coord(s0)) : `${nf.format(coord(s0))}–${nf.format(coord(e0 - 1))}`;
    const n = info.counts[k] ?? [0, 0, 0, 0, 0];
    const call = info.calls[k] ?? 4;
    return `<tr><th scope="row">${nf.format(w)}</th><td class="rng">${range}</td><td><span class="call b${call}">${LETTERS[call] ?? 'N'}</span></td>${[0, 1, 2, 3].map(b => `<td>${n[b]}</td>`).join('')}</tr>`;
  }).join('');
  box.innerHTML = `
    <div class="ins-top">
      <div class="ins-pos"><span class="big">${nf.format(coord(pos))}</span> bp</div>
      <div class="ins-meta">${speciesHTML(shortName(p))}${region ? ` · <span class="region">${region}</span>` : ''} · row ${nf.format(Math.floor(pos / W) + 1)}, x ${pos % W + 1}</div>
    </div>
    <button class="ins-close" id="insClose" type="button" aria-label="Clear selection">×</button>
    <div class="ctx" aria-label="Sequence around the selected base">${ctx}</div>
    <div class="ins-table-wrap"><table class="ins-table">
      <thead><tr><th scope="col">Window</th><th scope="col">Range</th><th scope="col">Call</th><th scope="col">A</th><th scope="col">T</th><th scope="col">C</th><th scope="col">G</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  $('insClose').addEventListener('click', () => { sel = null; drawMarks(); renderInspector(null); });
}

// ---------------------------------------------------------------------------------------------
// side panel

function renderPanelList() {
  const list = $('panelList');
  if (!panels.length) { list.innerHTML = '<li class="empty">No genome loaded.</li>'; return; }
  list.innerHTML = panels.map((p, i) => {
    const c = p.comp, v = views.get(p.uid);
    const gc = pct(c[2] + c[3], c[0] + c[1] + c[2] + c[3]);
    const q = p.quad;
    const len = (spans: Span[]) => spans.reduce((n, [a, b]) => n + b - a + 1, 0);
    const plastid = /chloroplast|plastid|plastome/i.test(p.title);
    const struct = q ? `IRs ${nf.format(q.irLength)} bp · LSC ${nf.format(len(q.lsc))} · SSC ${nf.format(len(q.ssc))}`
      : q === undefined && plastid && p.length <= 3_000_000 ? 'Looking for the inverted repeats…'
      : plastid ? 'No inverted repeat over 1 kb found' : '';
    const held = p.length < p.fullLength ? ` · bases ${nf.format(p.origin)}–${nf.format(p.origin + p.length - 1)} of ${nf.format(p.fullLength)}` : '';
    const shown = v && v.length < p.length ? ` · showing ${nf.format(p.origin + v.offset)}–${nf.format(p.origin + v.offset + v.length - 1)}` : '';
    return `<li>
      <div class="pl-top"><span class="pl-name">${speciesHTML(shortName(p))}</span>
        <span class="pl-actions">
          ${i > 0 ? `<button class="icon" type="button" data-act="left" data-i="${i}" aria-label="Move ${esc(shortName(p))} left">←</button>` : ''}
          <button class="icon" type="button" data-act="remove" data-i="${i}" aria-label="Remove ${esc(shortName(p))}">×</button>
        </span></div>
      <div class="pl-id">${esc(p.id)} · ${esc(p.source)}</div>
      <div class="pl-stats"><span class="num">${nf.format(p.length)}</span> bp · GC <span class="num">${gc}%</span>${c[4] ? ` · ${nf.format(c[4])} other` : ''}${held}${shown}</div>
      <div class="pl-comp" aria-label="Base composition">${[0, 1, 2, 3].map(b => `<span class="seg b${b}" style="flex-grow:${c[b]}"></span>`).join('')}</div>
      ${struct ? `<div class="pl-struct">${struct}</div>` : ''}
    </li>`;
  }).join('');
}

function renderExportInfo() {
  const g = viewer.geometry, f = S.scale;
  const w = (g?.width ?? 0) * f, h = (g?.height ?? 0) * f;
  $('exportSize').textContent = panels.length && w && h ? `${nf.format(w)} × ${nf.format(h)} px` : '—';
  // nothing to save until something is shown (a running export keeps its Cancel button)
  if (exporting === null) for (const id of ['saveBtn', 'saveBtn2']) $<HTMLButtonElement>(id).disabled = !(panels.length && g?.rows);
  $('exportNote').textContent = f === 1 ? 'One pixel per base, exactly as drawn.' : `Each base becomes a ${f} × ${f} block.`;
}

let stripSeq = 0;
async function drawStrip() {
  const my = ++stripSeq;
  const cv = $<HTMLCanvasElement>('strip');
  const p = panels[0];
  let codes: number[] = [];
  if (p) { try { codes = await client.request<number[]>({ t: 'peek', uid: p.uid, start: 0, n: 120 }).promise; } catch { codes = []; } }
  if (my !== stripSeq) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(120, 1);
  const pal = colors();
  for (let i = 0; i < 120; i++) {
    const [r, g, b] = i < codes.length ? pal[codes[i]] : pal[5];
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// export

let exporting: number | null = null;

async function savePNG() {
  if (exporting !== null) { client.cancel(exporting); return; }
  const g = viewer.geometry;
  if (!panels.length || !g || !g.rows) { toast('Load a genome first.'); return; }
  const f = S.scale;
  if (g.width * f * g.height * f > 1_000_000_000) { toast('That export would be over 1,000 megapixels. Choose a smaller scale or a shorter range.'); return; }
  const btns = [$<HTMLButtonElement>('saveBtn'), $<HTMLButtonElement>('saveBtn2')];
  const labels = btns.map(b => b.textContent);
  const job: ExportJob = {
    ver, width: g.width, height: g.height, margin: g.margin, scale: f,
    panels: g.panels.map(p => ({ uid: p.uid, colX: p.colX })),
    text: { Software: `Plastome Pixels ${APP_VERSION}`, Description: `${panels.map(p => `${shortName(p)} (${p.id})`).join('; ')} | ${S.width} bp per row | windows ${S.windows.join(', ')} bp` },
  };
  const req = client.request<Blob>({ t: 'export', job }, (done, total) => {
    const t = `Cancel · ${Math.round(100 * done / Math.max(1, total))}%`;
    btns.forEach(b => { b.textContent = t; });
  });
  exporting = req.id;
  btns.forEach(b => { b.textContent = 'Cancel'; });
  try {
    const blob = await req.promise;
    const filename = `${sanitizeName(panels.map(p => p.id).join('+'))}_${S.width}bp_w${S.windows.join('-')}${f > 1 ? `_${f}x` : ''}.png`;
    await deliver(blob, filename);
  } catch (e) {
    const err = e as EngineError;
    toast(err.aborted ? 'Export cancelled.' : err.message || 'Could not build the PNG.');
  } finally {
    exporting = null;
    btns.forEach((b, i) => { b.textContent = labels[i]; });
  }
}

function sanitizeName(s: string) {
  return s.replace(/[^A-Za-z0-9._+-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'plastome';
}

async function deliver(blob: Blob, filename: string) {
  if (inViewer) {
    const dl = await downloadsReady;
    if (dl) {
      try { await dl.save({ filename, data: blob }); toast(`Saved ${filename}`); }
      catch (e: any) {
        const code = e?.code;
        if (code === 'declined') toast('Save cancelled.');
        else if (code === 'rate_limited') toast('A save prompt is already open.');
        else if (code === 'too_large') toast('Too large to save from here. Choose a smaller scale.');
        else showImage(blob, filename);
      }
      return;
    }
    showImage(blob, filename);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  toast(`Saved ${filename}`);
}

function showImage(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  $('imgBoxName').textContent = filename;
  $<HTMLImageElement>('imgBoxImg').src = url;
  $('imgBox').hidden = false;
  $('imgBoxClose').focus();
}

// ---------------------------------------------------------------------------------------------
// busy and toasts

let cancelBusy: (() => void) | null = null;
function busy(on: boolean, msg = '', cancel?: () => void) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const el = $('busyMsg');
  if (on) { $('busyText').textContent = msg; cancelBusy = cancel ?? null; $('busyCancel').hidden = !cancel; }
  el.hidden = busyCount === 0;
  if (busyCount === 0) cancelBusy = null;
}
function busyText(msg: string) { $('busyText').textContent = msg; }

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, Math.min(9000, 3500 + msg.length * 30));
}

// ---------------------------------------------------------------------------------------------
// NCBI search

const KIND_LABEL: Record<Kind, string> = {
  plastid: 'plastid genomes', mito: 'mitochondrial genomes', plasmid: 'plasmids', chromosome: 'chromosomes and genomes', any: 'Nucleotide records',
};
let search: { q: string; found: Found; hits: NcbiHit[] } | null = null;
let searchCtl: AbortController | null = null;

function setSearchStatus(text: string) { const el = $('ncbiStatus'); el.textContent = text; el.hidden = !text; }

function updateWebLink(term?: string) {
  const q = cleanQuery($<HTMLInputElement>('ncbiQ').value);
  const t = term ?? (q ? buildTerm(q, S.ncbiKind, false, true) : '');
  const a = $<HTMLAnchorElement>('ncbiWeb');
  a.href = t ? websiteSearchURL(t) : 'https://www.ncbi.nlm.nih.gov/nuccore';
  a.textContent = t ? 'Open this search on the NCBI site ↗' : 'NCBI Nucleotide ↗';
}

function sliceOf(h: NcbiHit): [number, number] {
  const from = clamp(S.sliceFrom, 1, Math.max(1, h.length));
  return [from, Math.min(h.length, from + S.sliceLen - 1)];
}

function renderHits() {
  const box = $('ncbiResults');
  if (!search) { box.innerHTML = ''; $('ncbiMore').hidden = true; $('sliceRow').hidden = true; return; }
  const { found, hits, q } = search;
  setSearchStatus(found.count === 0
    ? `Nothing matched “${cleanQuery(q)}” among ${KIND_LABEL[S.ncbiKind]}. Try another name, or choose Any.`
    : `${nf.format(found.count)} ${found.count === 1 ? 'match' : 'matches'}${found.count > hits.length ? `, showing ${hits.length}` : ''}.${found.note ? ` ${found.note}` : ''}`);
  box.innerHTML = hits.map((h, i) => {
    const big = h.length > MAX_WHOLE;
    const [a, b] = sliceOf(h);
    return `<li class="hit">
      <div class="hit-title">${speciesHTML(h.title)}</div>
      <div class="hit-meta"><span class="num">${esc(h.acc)}</span> · <span class="num">${nf.format(h.length)}</span> bp${h.circular ? ' · circular' : ''}</div>
      <div class="hit-actions">
        <button class="btn small primary" type="button" data-hit="${i}" data-mode="replace">${big ? 'Show slice' : 'Show'}</button>
        <button class="btn small" type="button" data-hit="${i}" data-mode="add">${big ? 'Add slice' : 'Add beside'}</button>
        ${big ? `<span class="hint">bases ${nf.format(a)}–${nf.format(b)}</span>` : ''}
      </div>
    </li>`;
  }).join('');
  $('ncbiMore').hidden = !(found.count > hits.length);
  $('sliceRow').hidden = !hits.some(h => h.length > MAX_WHOLE);
  updateWebLink(found.term);
}

function ncbiFailed(e: unknown, term?: string) {
  const err = e as EngineError;
  if (err?.name === 'AbortError' || err?.aborted) return;
  if (err?.network) {
    setSearchStatus(inViewer
      ? 'This copy runs inside claude.ai, which blocks requests to other sites, so it can’t load from NCBI. Use the link to run the search on the NCBI site, save a record as FASTA (Send to › File), then Open it here. The GitHub Pages copy loads straight from NCBI.'
      : navigator.onLine === false ? 'You’re offline. Connect, then search again.' : 'Couldn’t reach NCBI. Check the connection and try again.');
    updateWebLink(term);
    return;
  }
  setSearchStatus(err?.message || 'The NCBI request failed.');
}

async function runSearch() {
  const q = $<HTMLInputElement>('ncbiQ').value;
  if (!cleanQuery(q)) { setSearchStatus('Type an organism (scientific or common name) or an accession.'); return; }
  searchCtl?.abort();
  const ctl = new AbortController();
  searchCtl = ctl;
  const btn = $<HTMLButtonElement>('ncbiGo');
  btn.disabled = true;
  setSearchStatus('Searching NCBI…');
  try {
    const found = await find(q, S.ncbiKind, S.refseq, ctl.signal);
    const hits = await summaries(found.ids, ctl.signal);
    if (ctl !== searchCtl) return;
    search = { q, found, hits };
    renderHits();
  } catch (e) {
    if (ctl === searchCtl) ncbiFailed(e, buildTerm(q, S.ncbiKind, false, true));
  } finally {
    if (ctl === searchCtl) btn.disabled = false;
  }
}

async function moreHits() {
  if (!search) return;
  const cur = search;
  const btn = $<HTMLButtonElement>('ncbiMore');
  btn.disabled = true;
  try {
    const ids = await ncbiPage(cur.found.term, cur.hits.length);
    const more = await summaries(ids);
    if (search !== cur) return;
    cur.hits.push(...more.filter(h => !cur.hits.some(x => x.acc === h.acc)));
    renderHits();
  } catch (e) {
    ncbiFailed(e, cur.found.term);
  } finally {
    btn.disabled = false;
  }
}

async function loadHit(h: NcbiHit, mode: 'replace' | 'add') {
  const big = h.length > MAX_WHOLE;
  const [from, to] = sliceOf(h);
  const url = efetchURL(h.acc, big ? from : null, big ? to : null);
  const err = await load([{ src: { kind: 'url', url }, source: 'NCBI', label: big ? `${h.acc}:${nf.format(from)}–${nf.format(to)}` : h.acc }], mode);
  if (err?.network) ncbiFailed(err);
}

// ---------------------------------------------------------------------------------------------
// controls

function parseWindows(text: string): number[] | string {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return 'Enter at least one window size, like 1, 20, 40.';
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return `"${p}" isn't a whole number.`;
    const n = +p;
    if (n < 1 || n > 1_000_000) return 'Window sizes run from 1 to 1,000,000 bp.';
    out.push(n);
  }
  if (out.length > 16) return 'Up to 16 columns per genome.';
  return out;
}

function syncInputs() {
  const set = (id: string, v: string) => { ($(id) as HTMLInputElement).value = v; };
  set('width', String(S.width));
  set('windows', S.windows.join(', '));
  set('start', String(S.start));
  set('length', S.length ? String(S.length) : '');
  set('gap', String(S.gap));
  set('panelGap', String(S.panelGap));
  set('margin', String(S.margin));
  set('bg', S.bg);
  set('other', S.other);
  ($('tie') as HTMLSelectElement).value = S.tie;
  ($('scale') as HTMLSelectElement).value = String(S.scale);
  ($('irMarks') as HTMLInputElement).checked = S.irMarks;
  $('windowsErr').hidden = true;
  markPresets();
}

function squareWidth() {
  const longest = panels.reduce((m, p) => Math.max(m, views.get(p.uid)?.length ?? p.length), 0);
  return Math.max(1, Math.ceil(Math.sqrt(longest || 1)));
}

function markPresets() {
  document.querySelectorAll<HTMLButtonElement>('[data-width]').forEach(b => {
    const v = b.dataset.width === 'square' ? squareWidth() : Number(b.dataset.width);
    b.setAttribute('aria-pressed', String(v === S.width));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bg === S.bg)));
}

type NumKey = 'width' | 'gap' | 'panelGap' | 'margin' | 'start' | 'length';
function bindNumber(id: NumKey, lo: number, hi: number, bump: boolean) {
  const el = $<HTMLInputElement>(id);
  const apply = debounce(() => {
    const raw = el.value.trim();
    if (id === 'length' && raw === '') { if (S.length === 0) return; S.length = 0; }
    else {
      const v = Number(raw);
      if (!Number.isFinite(v) || raw === '') return;
      const next = clamp(Math.round(v), lo, hi);
      if (next === S[id]) return;
      S[id] = next;
    }
    sel = null;
    saveSettings();
    markPresets();
    if (bump) void configure(true).then(() => { if (viewer.mode === 'fit') viewer.fit(); });
    else { layout(); if (viewer.mode === 'fit') viewer.fit(); }
  }, 300);
  el.addEventListener('input', apply);
  el.addEventListener('change', () => { el.value = id === 'length' && !S.length ? '' : String(S[id]); });
}

function syncZoomUI(s: number) {
  const zr = $<HTMLInputElement>('zoomRange');
  const lo = viewer.minScale(), hi = viewer.maxScale();
  zr.value = String(Math.round(1000 * Math.log(s / lo) / Math.log(hi / lo)));
  $('zoomVal').textContent = `${s >= 10 ? s.toFixed(0) : s >= 1 ? s.toFixed(1).replace(/\.0$/, '') : s >= 0.1 ? s.toFixed(2) : s.toPrecision(2)}×`;
  $('fitBtn').setAttribute('aria-pressed', String(viewer.mode === 'fit'));
}

function initControls() {
  syncInputs();
  bindNumber('width', 1, 100_000, true);
  bindNumber('gap', 0, 500, false);
  bindNumber('panelGap', 0, 2000, false);
  bindNumber('margin', 0, 2000, false);
  bindNumber('start', 1, 4_000_000_000, true);
  bindNumber('length', 0, 4_000_000_000, true);

  document.querySelectorAll<HTMLButtonElement>('[data-width]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.width === 'square' ? squareWidth() : Number(b.dataset.width);
    if (v === S.width) return;
    S.width = v;
    $<HTMLInputElement>('width').value = String(v);
    sel = null;
    saveSettings();
    markPresets();
    void configure(true).then(() => viewer.fit());
  }));

  const win = $<HTMLInputElement>('windows');
  win.addEventListener('input', debounce(() => {
    const r = parseWindows(win.value);
    const err = $('windowsErr');
    if (typeof r === 'string') { err.textContent = r; err.hidden = false; return; }
    err.hidden = true;
    if (r.join() === S.windows.join()) return;
    S.windows = r;
    sel = null;
    saveSettings();
    void configure(true).then(() => { if (viewer.mode === 'fit') viewer.fit(); });
  }, 350));
  win.addEventListener('change', () => { if ($('windowsErr').hidden) win.value = S.windows.join(', '); });

  const colorInput = (id: 'bg' | 'other') => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('input', debounce(() => {
      if (!isHex(el.value) || el.value.toLowerCase() === S[id]) return;
      S[id] = el.value.toLowerCase();
      saveSettings();
      markPresets();
      $('plate').style.background = S.bg;
      void configure(true);
    }, 120));
  };
  colorInput('bg'); colorInput('other');
  document.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach(b => b.addEventListener('click', () => {
    if (S.bg === b.dataset.bg) return;
    S.bg = b.dataset.bg!;
    $<HTMLInputElement>('bg').value = S.bg;
    $('plate').style.background = S.bg;
    saveSettings();
    markPresets();
    void configure(true);
  }));

  $<HTMLSelectElement>('tie').addEventListener('change', e => { S.tie = (e.target as HTMLSelectElement).value === 'first' ? 'first' : 'order'; saveSettings(); void configure(true); });
  $<HTMLSelectElement>('scale').addEventListener('change', e => { S.scale = Number((e.target as HTMLSelectElement).value) || 1; renderExportInfo(); saveSettings(); });
  $<HTMLInputElement>('irMarks').addEventListener('change', e => { S.irMarks = (e.target as HTMLInputElement).checked; drawMarks(); saveSettings(); });
  $('resetBtn').addEventListener('click', () => {
    S = sanitize({ ncbiKind: S.ncbiKind, refseq: S.refseq, sliceFrom: S.sliceFrom, sliceLen: S.sliceLen });
    syncInputs();
    sel = null;
    saveSettings();
    $('plate').style.background = S.bg;
    void configure(true).then(() => viewer.fit());
  });

  // files
  const fileInput = $<HTMLInputElement>('fileInput');
  let fileMode: 'replace' | 'add' = 'replace';
  $('openBtn').addEventListener('click', () => { fileMode = 'replace'; fileInput.click(); });
  $('addBtn').addEventListener('click', () => { fileMode = 'add'; fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    void load(files.map(f => ({ src: { kind: 'file', file: f } as ParseSource, source: f.name.replace(/\.gz$/i, ''), label: f.name })), fileMode);
  });

  // paste box
  const pasteBox = $('pasteBox');
  $('pasteToggle').addEventListener('click', e => {
    pasteBox.hidden = !pasteBox.hidden;
    (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!pasteBox.hidden));
    if (!pasteBox.hidden) $('pasteArea').focus();
  });
  const pasteGo = async (mode: 'replace' | 'add') => {
    const ta = $<HTMLTextAreaElement>('pasteArea');
    if (!ta.value.trim()) { toast('Paste a sequence first.'); return; }
    const before = panels;
    await load([{ src: { kind: 'text', text: ta.value }, source: 'Pasted', label: 'the pasted text' }], mode);
    if (panels !== before) { ta.value = ''; pasteBox.hidden = true; $('pasteToggle').setAttribute('aria-expanded', 'false'); }
  };
  $('pasteShow').addEventListener('click', () => void pasteGo('replace'));
  $('pasteAdd').addEventListener('click', () => void pasteGo('add'));

  document.querySelectorAll<HTMLButtonElement>('[data-sample]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.sample!;
    void loadSamples(k === 'both' ? ['arabidopsis', 'amborella'] : [k]);
  }));

  // NCBI search
  const q = $<HTMLInputElement>('ncbiQ');
  $('ncbiForm').addEventListener('submit', e => { e.preventDefault(); void runSearch(); });
  q.addEventListener('input', debounce(() => updateWebLink(), 300));
  const markKinds = () => document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === S.ncbiKind)));
  markKinds();
  document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => b.addEventListener('click', () => {
    S.ncbiKind = b.dataset.kind as Kind;
    markKinds();
    saveSettings();
    updateWebLink();
    if (search && cleanQuery(q.value)) void runSearch();
  }));
  const rs = $<HTMLInputElement>('refseq');
  rs.checked = S.refseq;
  rs.addEventListener('change', () => { S.refseq = rs.checked; saveSettings(); if (search && cleanQuery(q.value)) void runSearch(); });
  const sf = $<HTMLInputElement>('sliceFrom'), sl = $<HTMLInputElement>('sliceLen');
  sf.value = String(S.sliceFrom);
  sl.value = String(S.sliceLen);
  const sliceChange = debounce(() => {
    const a = Number(sf.value), b = Number(sl.value);
    if (Number.isFinite(a) && a >= 1) S.sliceFrom = Math.round(a);
    if (Number.isFinite(b) && b >= 1000) S.sliceLen = Math.min(MAX_WHOLE, Math.round(b));
    saveSettings();
    renderHits();
  }, 300);
  sf.addEventListener('input', sliceChange);
  sl.addEventListener('input', sliceChange);
  $('ncbiResults').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-hit]');
    if (!b || !search) return;
    const h = search.hits[Number(b.dataset.hit)];
    if (h) void loadHit(h, b.dataset.mode === 'add' ? 'add' : 'replace');
  });
  $('ncbiMore').addEventListener('click', () => void moreHits());
  updateWebLink();

  // genome list
  $('panelList').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (!panels[i]) return;
    if (b.dataset.act === 'remove') { client.send({ t: 'drop', uids: [panels[i].uid] }); panels = panels.filter((_, j) => j !== i); }
    else if (b.dataset.act === 'left' && i > 0) { const next = [...panels]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; panels = next; }
    client.send({ t: 'order', uids: panels.map(p => p.uid) });
    sel = null;
    layout();
    if (viewer.mode === 'fit') viewer.fit();
  });

  // zoom
  viewer.onScale = s => syncZoomUI(s);
  $('fitBtn').addEventListener('click', () => viewer.fit());
  $('zoomIn').addEventListener('click', () => viewer.step(1));
  $('zoomOutBtn').addEventListener('click', () => viewer.step(-1));
  $<HTMLInputElement>('zoomRange').addEventListener('input', e => {
    const v = Number((e.target as HTMLInputElement).value) / 1000;
    const lo = viewer.minScale(), hi = viewer.maxScale();
    viewer.setScale(lo * Math.pow(hi / lo, v));
  });
  $('saveBtn').addEventListener('click', () => void savePNG());
  $('saveBtn2').addEventListener('click', () => void savePNG());
  $('busyCancel').addEventListener('click', () => cancelBusy?.());

  $('imgBoxClose').addEventListener('click', () => {
    const img = $<HTMLImageElement>('imgBoxImg');
    URL.revokeObjectURL(img.src);
    img.removeAttribute('src');
    $('imgBox').hidden = true;
  });
}

function initDropPaste() {
  let depth = 0;
  const shade = $('dropShade');
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; shade.hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) shade.hidden = true; });
  window.addEventListener('drop', e => {
    depth = 0;
    shade.hidden = true;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    void load(files.map(f => ({ src: { kind: 'file', file: f } as ParseSource, source: f.name.replace(/\.gz$/i, ''), label: f.name })), e.shiftKey ? 'add' : 'replace');
  });
  document.addEventListener('paste', e => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, [contenteditable]')) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.replace(/[^A-Za-z]/g, '').length < 50) return;
    e.preventDefault();
    void load([{ src: { kind: 'text', text }, source: 'Pasted', label: 'the pasted text' }], 'replace');
  });
}

// ---------------------------------------------------------------------------------------------
// GitHub Pages: the offline copy, and updating it (the LowPingNews way)

function newerVersion(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

function mem(k: string, v?: string | null): string | null {
  try {
    if (v === undefined) return sessionStorage.getItem(k);
    if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
  } catch { /* private mode */ }
  return null;
}

let updating = false;
let lastCheck = 0;
async function checkForUpdate(force = false) {
  if (!force && Date.now() - lastCheck < 10 * 60_000) return;
  lastCheck = Date.now();
  try {
    const r = await fetch('./version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (newerVersion(j?.version, APP_VERSION)) showUpdate(String(j.version));
    else if (j?.version === APP_VERSION) { mem('ppx-updating', null); mem('ppx-hard', null); }
  } catch { /* offline: try again later */ }
}

function showUpdate(v: string) {
  const b = $('update');
  if (!updating) b.textContent = `Version ${v} is ready (you have ${APP_VERSION}). Tap to update.`;
  b.hidden = false;
  const tried = Number(mem('ppx-updating') || 0);
  if (tried && Date.now() - tried < 120_000) void hardUpdate(b);   // just tried, still old
}

async function updateNow(b: HTMLElement) {
  if (updating) return;
  updating = true;
  b.textContent = 'Updating…';
  mem('ppx-updating', String(Date.now()));
  const sws = navigator.serviceWorker;
  if (sws) {
    const changed = new Promise<void>(res => sws.addEventListener('controllerchange', () => res(), { once: true }));
    // the new version downloads in the background: give it time, but only when one is on its way
    const coming = await Promise.race([
      sws.getRegistration().then(async reg => { if (!reg) return false; await reg.update(); return !!(reg.installing || reg.waiting); }).catch(() => false),
      new Promise<boolean>(r => setTimeout(() => r(true), 8000)),
    ]);
    if (coming) await Promise.race([changed, new Promise(r => setTimeout(r, 20_000))]);
  }
  location.reload();
}

async function hardUpdate(b: HTMLElement) {
  if (updating) return;
  if (mem('ppx-hard')) { b.textContent = 'Could not update yet. Close the app fully and open it again.'; return; }
  updating = true;
  b.textContent = 'Updating…';
  // clearing the offline copy on a link that can't fetch the new one would leave no app at all
  let reached = false;
  try {
    const r = await fetch('./version.json', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    reached = typeof j?.version === 'string';      // a Wi-Fi sign-in page answers 200 too
  } catch { /* no */ }
  if (!reached) { updating = false; b.textContent = 'Could not update now: the connection is too weak. Tap to try again later.'; return; }
  mem('ppx-hard', '1');
  try {
    for (const k of await caches.keys()) if (k.startsWith('ppx-shell-')) await caches.delete(k);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* nothing to clear */ }
  location.reload();
}

function initPages() {
  $('ver').textContent = `v${APP_VERSION}`;
  $('update').addEventListener('click', () => void updateNow($('update')));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { /* still works online */ });
  const idle: (f: () => void) => void = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
  idle(() => void checkForUpdate(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void checkForUpdate(); });
  window.addEventListener('online', () => void checkForUpdate(true));
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
  let hinted = false;
  try { hinted = localStorage.getItem('ppx-hinted') === '1'; } catch { /* ignore */ }
  if (ios && !standalone && !hinted) {
    const h = $('hint');
    h.hidden = false;
    h.addEventListener('click', () => { h.hidden = true; try { localStorage.setItem('ppx-hinted', '1'); } catch { /* ignore */ } });
  }
}

function loadFontsLater() {
  // fonts never hold up the first paint: system faces show at once and the brand faces swap in
  const add = () => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = __TARGET__ === 'pages' ? './fonts/fonts.css'
      : 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Martian+Mono:wght@400;500;700&display=swap';
    document.head.append(l);
  };
  if (document.readyState === 'complete') setTimeout(add, 0); else window.addEventListener('load', () => setTimeout(add, 0), { once: true });
}

// ---------------------------------------------------------------------------------------------
// boot

async function boot() {
  initControls();
  initDropPaste();
  loadFontsLater();
  if (__TARGET__ === 'pages') initPages();
  else $('ver').hidden = true;
  $('plate').style.background = S.bg;
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LEGACY_GENOMES); } catch { legacy = null; }
  try {
    panels = await client.request<RecordMeta[]>({ t: 'boot', legacy, limits: limitsFor('replace') }).promise;
    if (legacy) { try { localStorage.removeItem(LEGACY_GENOMES); } catch { /* ignore */ } }
  } catch (e) {
    toast((e as Error).message);
    panels = [];
  }
  await configure(true);
  viewer.fit();
}

void boot();
