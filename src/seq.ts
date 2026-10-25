// Sequence input. A byte-level streaming parser for FASTA, GenBank, EMBL and bare sequence:
// sequence bytes go straight through a lookup table into one shared Uint8Array, so even a
// whole chromosome is read without creating a string per line.

/** Base codes. The order matches the colour key (A, T, C, G) and is also the tie-break order. */
export const A = 0, T = 1, C = 2, G = 3, N = 4, BG = 5;
export const LETTERS = ['A', 'T', 'C', 'G', 'N'] as const;

export interface RecordInfo {
  id: string;              // accession.version or FASTA id
  title: string;           // definition line / description
  circular: boolean | null;
  origin: number;          // genome coordinate of the first kept base
  length: number;          // bases kept
  fullLength: number;      // sequence letters seen in the record (more than length when a stretch or cap applied)
  comp: number[];          // A, T, C, G, other among kept bases
}

export interface ParsedRecord extends RecordInfo { codes: Uint8Array }

export interface ParseOptions {
  from?: number;           // keep bases from this 1-based position of each record
  length?: number;         // and at most this many (0 = to the end)
  maxBases?: number;       // across all records
  maxRecords?: number;
}

export interface ParseResult { records: ParsedRecord[]; notes: string[] }

/** Byte -> code. 255 = not a sequence character (digits, spaces, gaps, line ends). */
export const LUT = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let c = 65; c <= 90; c++) { t[c] = N; t[c + 32] = N; }
  const set = (ch: string, v: number) => { t[ch.charCodeAt(0)] = v; t[ch.toLowerCase().charCodeAt(0)] = v; };
  set('A', A); set('T', T); set('U', T); set('C', C); set('G', G);
  return t;
})();

type Format = 'fasta' | 'genbank' | 'embl' | 'raw';

interface Rec {
  id: string; title: string; circular: boolean | null; origin: number;
  start: number;           // index of the first kept base in the shared buffer
  seen: number;            // sequence letters seen in the record
  skip: number;            // still to discard before keeping (range start)
  take: number;            // still allowed to keep (range length)
  hasSeq: boolean;         // a sequence section was present (GenBank ORIGIN / EMBL SQ / FASTA body)
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const MAX_LINE = 1 << 16;

export class ByteParser {
  private fmt: Format | null = null;
  private nl = 10;                 // line terminator byte (13 for old Mac files)
  private out: Uint8Array;
  private n = 0;
  private recs: Rec[] = [];
  private cur: Rec | null = null;
  private lineStart = true;
  private inSeq = false;           // GenBank/EMBL: inside ORIGIN/SQ. FASTA/raw: always.
  private collecting = false;      // gathering a header/text line into `line`
  private line = new Uint8Array(512);
  private lineLen = 0;
  private inDef = false;
  private droppedRecords = 0;
  private sawRecordWithoutSeq = false;
  private budget: number;
  private truncated = false;
  readonly opts: Required<ParseOptions>;

  constructor(opts: ParseOptions = {}, sizeHint = 0) {
    this.opts = {
      from: Math.max(1, Math.floor(opts.from ?? 1)),
      length: Math.max(0, Math.floor(opts.length ?? 0)),
      maxBases: opts.maxBases ?? Infinity,
      maxRecords: opts.maxRecords ?? Infinity,
    };
    this.budget = this.opts.maxBases;
    let cap = sizeHint > 0 ? sizeHint + 16 : 1 << 16;
    if (Number.isFinite(this.budget)) cap = Math.min(cap, this.budget + 1024);
    if (this.opts.length > 0 && this.opts.maxRecords === 1) cap = Math.min(cap, this.opts.length + 1024);
    this.out = new Uint8Array(Math.max(1024, cap));
  }

  get bases() { return this.n; }

  push(chunk: Uint8Array): void {
    let i = 0;
    if (this.fmt === null) { i = this.sniff(chunk); if (this.fmt === null) return; }
    const len = chunk.length, nl = this.nl;
    while (i < len) {
      if (this.collecting) {
        const j = chunk.indexOf(nl, i);
        const end = j < 0 ? len : j;
        this.appendLine(chunk, i, end);
        if (j < 0) return;
        this.collecting = false;
        this.lineStart = true;
        this.endLine();
        i = j + 1;
        continue;
      }
      if (this.inSeq) {
        // Inside sequence, line breaks don't matter (the lookup table skips them), so everything up to
        // the next marker is consumed in one pass: '>' starts a FASTA header, '/' the GenBank/EMBL '//'.
        const marker = this.fmt === 'fasta' ? 62 : this.fmt === 'raw' ? -1 : 47;
        const j = marker < 0 ? -1 : chunk.indexOf(marker, i);
        const end = j < 0 ? len : j;
        if (this.cur !== null && end > i) this.consume(chunk, i, end);
        if (j < 0) return;
        this.collecting = true;
        this.lineLen = 0;
        i = j;
        continue;
      }
      // GenBank/EMBL text before the sequence: every line is looked at
      if (this.lineStart) {
        const b = chunk[i];
        if (b === 10 || b === 13) { i++; continue; }
        this.lineStart = false;
        this.collecting = true;
        this.lineLen = 0;
        continue;
      }
      const j = chunk.indexOf(nl, i);
      if (j < 0) return;
      this.lineStart = true;
      i = j + 1;
    }
  }

  /** Decide the format from the first bytes; returns where parsing should start. */
  private sniff(chunk: Uint8Array): number {
    let i = 0;
    if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) i = 3;
    const head = latin1.decode(chunk.subarray(i, Math.min(chunk.length, i + 65536)));
    if (head.startsWith('PK\x03\x04')) throw new Error('This is a .zip archive. Unzip it, then open the sequence file inside.');
    if (head.startsWith('BAM\x01')) throw new Error('This is a BAM alignment file, not a sequence. Use FASTA or GenBank.');
    if (chunk[0] === 0x43 && chunk[1] === 0x27 && chunk[2] === 0x41 && chunk[3] === 0x1a) throw new Error('This is a .2bit file. Convert it to FASTA first.');
    let ctrl = 0;
    const probe = Math.min(head.length, 8192);
    for (let k = 0; k < probe; k++) { const c = head.charCodeAt(k); if (c < 9 || (c > 13 && c < 32)) ctrl++; }
    if (ctrl > probe * 0.01 + 2) throw new Error('This looks like a binary file, not sequence text. Use FASTA, GenBank, EMBL or plain A/C/G/T.');
    const t = head.replace(/^\s+/, '');
    if (t.length === 0) return chunk.length; // whitespace only so far
    if (head.indexOf('\n') < 0 && head.indexOf('\r') >= 0) this.nl = 13;
    if (t.startsWith('<')) throw new Error('This is a web page or an XML file, not a sequence. If it came from public Wi-Fi, sign in to the Wi-Fi first.');
    if (t.startsWith('{') || t.startsWith('[')) throw new Error('This is a JSON file, not a sequence. Use FASTA, GenBank, EMBL or plain A/C/G/T.');
    if (t.startsWith('>')) this.fmt = 'fasta';
    else if (/^LOCUS\s/m.test(head)) this.fmt = 'genbank';
    else if (/^ID {3}/m.test(head)) this.fmt = 'embl';
    else this.fmt = 'raw';
    if (this.fmt === 'fasta' || this.fmt === 'raw') this.inSeq = true;
    if (this.fmt === 'raw') this.open('sequence', '', null, true);
    if (this.fmt === 'fasta') { while (i < chunk.length && chunk[i] !== 62) i++; this.lineStart = true; } // blank lines before the first header
    return i;
  }

  private appendLine(chunk: Uint8Array, a: number, b: number) {
    const n = Math.min(b - a, MAX_LINE - this.lineLen);
    if (n <= 0) return;
    if (this.lineLen + n > this.line.length) {
      const nb = new Uint8Array(Math.max(this.line.length * 2, this.lineLen + n));
      nb.set(this.line.subarray(0, this.lineLen));
      this.line = nb;
    }
    this.line.set(chunk.subarray(a, a + n), this.lineLen);
    this.lineLen += n;
  }

  private endLine() {
    const L = this.line, n = this.lineLen;
    if (this.fmt === 'fasta') {
      const h = utf8.decode(L.subarray(1, n)).trim();
      const sp = h.search(/\s/);
      this.open(sp < 0 ? h || 'sequence' : h.slice(0, sp), sp < 0 ? '' : h.slice(sp + 1), null, true);
      return;
    }
    if (this.inSeq) { // a line starting with '/' inside the sequence ends the record
      this.inSeq = false;
      this.close();
      return;
    }
    const c0 = L[0];
    if (this.fmt === 'genbank') {
      if (this.inDef && c0 === 32 && this.cur) { this.cur.title += ' ' + utf8.decode(L.subarray(0, n)).trim(); return; }
      this.inDef = false;
      if (c0 === 76 && startsWith(L, n, 'LOCUS')) {
        const s = latin1.decode(L.subarray(0, n));
        this.open(s.trim().split(/\s+/)[1] || 'record', '', topology(s), false);
      } else if (this.cur === null) {
        return;
      } else if (c0 === 68 && startsWith(L, n, 'DEFINITION')) {
        this.cur.title = utf8.decode(L.subarray(10, n)).trim();
        this.inDef = true;
      } else if (c0 === 86 && startsWith(L, n, 'VERSION')) {
        const v = latin1.decode(L.subarray(7, n)).trim().split(/\s+/)[0];
        if (v) this.cur.id = v;
      } else if (c0 === 79 && startsWith(L, n, 'ORIGIN')) {
        this.inSeq = true;
        this.cur.hasSeq = true;
      } else if (c0 === 47 && n >= 2 && L[1] === 47) {
        if (!this.cur.hasSeq) this.sawRecordWithoutSeq = true;
        this.close();
      }
      return;
    }
    // EMBL
    if (c0 === 73 && L[1] === 68 && L[2] === 32) {            // "ID "
      const s = latin1.decode(L.subarray(0, n));
      this.open(s.slice(5).split(';')[0].trim() || 'record', '', topology(s), false);
    } else if (this.cur === null) {
      return;
    } else if (c0 === 68 && L[1] === 69 && L[2] === 32) {     // "DE "
      const d = utf8.decode(L.subarray(5, n)).trim();
      this.cur.title += (this.cur.title ? ' ' : '') + d;
    } else if (c0 === 83 && L[1] === 81 && L[2] === 32) {     // "SQ "
      this.inSeq = true;
      this.cur.hasSeq = true;
    } else if (c0 === 47 && L[1] === 47) {
      if (!this.cur.hasSeq) this.sawRecordWithoutSeq = true;
      this.close();
    }
  }

  private open(id: string, title: string, circular: boolean | null, hasSeq: boolean) {
    this.close();
    if (this.recs.length >= this.opts.maxRecords) { this.droppedRecords++; this.cur = null; return; }
    const m = /:(\d+)-(\d+)$/.exec(id);           // NCBI names a stretch NC_000023.11:1000001-2000000
    const base = m ? Math.max(1, +m[1]) : 1;
    const skip = this.opts.from - 1;
    this.cur = {
      id, title, circular, origin: base + skip, start: this.n, seen: 0, skip,
      take: this.opts.length > 0 ? this.opts.length : Infinity, hasSeq,
    };
  }

  private close() {
    const c = this.cur;
    this.cur = null;
    if (c) this.recs.push(c);
  }

  /** Hot loop: the sequence bytes [a, b) of one line. */
  private consume(chunk: Uint8Array, a: number, b: number) {
    const c = this.cur!;
    const room = b - a;
    if (this.n + room > this.out.length) this.grow(this.n + room);
    const out = this.out;
    const n0 = this.n;
    let n = n0;
    if (c.skip === 0 && c.take >= room && this.budget >= room) {
      // branch-free: every byte is written, the cursor only moves past sequence letters
      for (let i = a; i < b; i++) {
        const v = LUT[chunk[i]];
        out[n] = v;
        n += (v >> 7) ^ 1;
      }
      const kept = n - n0;
      c.seen += kept;
      c.take -= kept;
      this.budget -= kept;
      this.n = n;
      return;
    }
    for (let i = a; i < b; i++) {
      const v = LUT[chunk[i]];
      if (v === 255) continue;
      c.seen++;
      if (c.skip > 0) { c.skip--; continue; }
      if (c.take <= 0) continue;
      if (this.budget <= 0) { this.truncated = true; continue; }
      out[n++] = v;
      c.take--;
      this.budget--;
    }
    this.n = n;
  }

  private grow(min: number) {
    let cap = this.out.length;
    while (cap < min) cap = Math.ceil(cap * 1.6) + 4096;
    const nb = new Uint8Array(cap);
    nb.set(this.out.subarray(0, this.n));
    this.out = nb;
  }

  finish(): ParseResult {
    if (this.collecting) { this.collecting = false; this.endLine(); }
    this.close();
    const notes: string[] = [];
    let buf = this.out;
    if (buf.length > this.n * 1.25 + 65536) buf = buf.slice(0, this.n); // give back unused room
    const records: ParsedRecord[] = [];
    for (let i = 0; i < this.recs.length; i++) {
      const r = this.recs[i];
      const end = i + 1 < this.recs.length ? this.recs[i + 1].start : this.n;
      const length = end - r.start;
      if (length <= 0) continue;
      const codes = buf.subarray(r.start, end);
      records.push({
        id: r.id, title: r.title.replace(/\s+/g, ' ').replace(/\.$/, '').trim(), circular: r.circular,
        origin: r.origin, length, fullLength: r.seen, comp: composition(codes), codes,
      });
    }
    if (!records.length) {
      if (this.sawRecordWithoutSeq) throw new Error('This record has no sequence (it may be a CONTIG or WGS master record). Get the FASTA instead.');
      if (this.recs.some(r => r.seen > 0)) throw new Error('No bases fall inside the chosen stretch. Check From base and Length.');
      throw new Error('No sequence found. Use FASTA, GenBank, EMBL or plain A/C/G/T text.');
    }
    for (const r of records) {
      if (r.comp[4] / r.length > 0.5) throw new Error(`"${r.id}" is mostly letters other than A, C, G and T. Is it a protein or text file?`);
    }
    if (this.droppedRecords) notes.push(`Kept the first ${records.length} sequences; ${this.droppedRecords} more were skipped.`);
    if (this.truncated) notes.push(`Stopped at ${this.opts.maxBases.toLocaleString('en-US')} bases, the most this page holds at once. Set From base and Length before opening to load another stretch.`);
    return { records, notes };
  }
}

function startsWith(buf: Uint8Array, n: number, s: string): boolean {
  if (n < s.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[i] !== s.charCodeAt(i)) return false;
  return true;
}

function topology(l: string): boolean | null {
  if (/\bcircular\b/i.test(l)) return true;
  if (/\blinear\b/i.test(l)) return false;
  return null;
}

export interface Abortable { aborted: boolean }

/** Feeds a byte stream through the parser, gunzipping it when it starts with the gzip magic. */
export async function parseStream(
  stream: ReadableStream<Uint8Array>, opts: ParseOptions, sizeHint: number,
  onProgress?: (bytesIn: number) => void, signal?: Abortable,
): Promise<ParseResult> {
  const raw = stream.getReader();
  const first = await raw.read();
  if (first.done || !first.value || first.value.length === 0) return new ByteParser(opts).finish();
  let consumed = first.value.length;
  const gz = first.value[0] === 0x1f && first.value[1] === 0x8b;
  let reader: ReadableStreamDefaultReader<Uint8Array> = raw;
  let head: Uint8Array | null = first.value;
  if (gz) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t open .gz files. Decompress the file first.');
    const firstChunk = first.value;
    const joined = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(firstChunk); },
      async pull(ctrl) {
        const r = await raw.read();
        if (r.done) { ctrl.close(); return; }
        consumed += r.value.length;
        onProgress?.(consumed);
        ctrl.enqueue(r.value);
      },
      cancel(reason) { raw.cancel(reason).catch(() => {}); },
    });
    reader = joined.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
    head = null;
  }
  const p = new ByteParser(opts, gz ? sizeHint * 3 : sizeHint);
  if (head) { p.push(head); onProgress?.(consumed); }
  for (;;) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); throw new DOMException('Cancelled', 'AbortError'); }
    const r = await reader.read();
    if (r.done) break;
    p.push(r.value);
    if (!gz) { consumed += r.value.length; onProgress?.(consumed); }
  }
  return p.finish();
}

export function parseText(text: string, opts: ParseOptions = {}): ParseResult {
  const bytes = new TextEncoder().encode(text);
  const p = new ByteParser(opts, bytes.length);
  p.push(bytes);
  return p.finish();
}

/** "Arabidopsis thaliana chloroplast, complete genome" -> "Arabidopsis thaliana chloroplast". */
export function shortName(r: { id: string; title: string }): string {
  const t = r.title.split(',')[0]
    .replace(/\b(complete|partial) (genome|sequence)\b.*$/i, '')
    .replace(/\s+(genomic )?DNA$/i, '')
    .trim();
  return t || r.id;
}

/** 2 bits per base, for the built-in samples (A/T/C/G only). */
export function unpack2bit(b64: string, length: number): Uint8Array {
  const bytes = fromBase64(b64);
  const out = new Uint8Array(length);
  const full = length >> 2;
  for (let j = 0, i = 0; j < full; j++, i += 4) {
    const b = bytes[j];
    out[i] = b >> 6; out[i + 1] = (b >> 4) & 3; out[i + 2] = (b >> 2) & 3; out[i + 3] = b & 3;
  }
  for (let i = full << 2; i < length; i++) out[i] = (bytes[i >> 2] >> (6 - 2 * (i & 3))) & 3;
  return out;
}

/** 4 bits per base (keeps N): the format the first version saved genomes in. */
export function unpackNibbles(b64: string, length: number): Uint8Array {
  const bytes = fromBase64(b64);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const b = bytes[i >> 1];
    out[i] = Math.min(4, (i & 1) ? b & 15 : b >> 4);
  }
  return out;
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const hist = new Uint32Array(65536);
/** Counts of A, T, C, G and other. Pairs of bases are tallied as 16-bit words, which is several
 *  times faster than counting bases one at a time. */
export function composition(codes: Uint8Array): number[] {
  const c = [0, 0, 0, 0, 0];
  let a = 0, b = codes.length;
  if ((codes.byteOffset & 1) && a < b) c[codes[a++]]++;
  if (((b - a) & 1) && a < b) c[codes[--b]]++;
  if (b > a) {
    hist.fill(0);
    const u16 = new Uint16Array(codes.buffer, codes.byteOffset + a, (b - a) >> 1);
    for (let i = 0; i < u16.length; i++) hist[u16[i]]++;
    for (let h = 0; h < 1285; h++) {              // both bytes are codes 0..4, so h < 5 * 256 + 5
      const k = hist[h];
      if (k) { c[h & 255] += k; c[h >> 8] += k; }
    }
  }
  return c;
}
