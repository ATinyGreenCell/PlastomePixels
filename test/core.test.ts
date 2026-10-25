// Node tests for the pure parts: parser, window calls, painting, inverted repeats, PNG.
// Run with: npm test
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseText, parseStream, ByteParser, unpack2bit, unpackNibbles, shortName, composition, N } from '../src/seq';
import { computeCalls, findQuadripartite, regionAt, TieRule } from '../src/analysis';
import { paintTileFull, paintTileAveraged, fillIndexRow, TileCol } from '../src/paint';
import { encodeIndexedPNG } from '../src/png';
import { SAMPLES } from '../src/samples';
import { SAMPLE_META } from '../src/sampleMeta';
import { buildTerm, efetchURL } from '../src/ncbi';

let ran = 0, failed = 0;
const ok = (cond: unknown, msg: string) => { ran++; if (!cond) { failed++; console.log('  FAIL  ' + msg); } else console.log('  ok    ' + msg); };
const throwsLike = (fn: () => unknown, re: RegExp, msg: string) => { try { fn(); ok(false, msg + ' (did not throw)'); } catch (e) { ok(re.test(String((e as Error).message)), `${msg} -> ${(e as Error).message}`); } };
const codesOf = (s: string) => Array.from(parseText(s).records[0].codes).join('');
const streamOf = (bytes: Uint8Array, chunk: number) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
});

const gbText = readFileSync('data/NC_000932.gb', 'utf8');
const gbSeq = gbText.split('\nORIGIN')[1].split('//')[0].replace(/[^A-Za-z]/g, '').toUpperCase();
const MAP: Record<string, number> = { A: 0, T: 1, U: 1, C: 2, G: 3 };
const ref = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '').split('').map(c => MAP[c] ?? 4).join('');

// ---- parsing ---------------------------------------------------------------------------------
console.log('parsing');
const gb = parseText(gbText);
ok(gb.records.length === 1 && gb.records[0].length === 154478, `GenBank: one record, 154,478 bp (${gb.records[0]?.length})`);
ok(gb.records[0].id === 'NC_000932.1' && gb.records[0].circular === true, 'GenBank: VERSION id and circular topology');
ok(gb.records[0].title === 'Arabidopsis thaliana chloroplast, complete genome', `GenBank: DEFINITION title (${gb.records[0].title})`);
ok(Array.from(gb.records[0].codes).join('') === ref(gbSeq), 'GenBank: sequence matches an independent extraction');
ok(gb.records[0].comp.join() === composition(gb.records[0].codes).join(), 'composition counted while parsing matches a recount');
ok(shortName(gb.records[0]) === 'Arabidopsis thaliana chloroplast', 'short name');
ok(Array.from(unpack2bit(SAMPLES[0].data, SAMPLES[0].length)).join('') === ref(gbSeq), 'sample data (2-bit) matches the GenBank file');
ok(SAMPLE_META.arabidopsis.quad?.irb.join() === '84170,110433', 'precomputed sample metadata present');

// the same file in every chunk size and line ending gives the same result
const fasta = '>NC_1 A test, complete genome\n' + gbSeq.match(/.{1,70}/g)!.join('\n') + '\n>NC_2 second\nACGTN\nacgu-ryk*\n';
const want = [ref(gbSeq), '02314' + '0231444'];
for (const [name, text] of [['LF', fasta], ['CRLF', fasta.replace(/\n/g, '\r\n')], ['CR', fasta.replace(/\n/g, '\r')], ['BOM', '﻿' + fasta]] as const) {
  const r = parseText(text).records;
  ok(r.length === 2 && Array.from(r[0].codes).join('') === want[0] && Array.from(r[1].codes).join('') === want[1] && r[0].id === 'NC_1' && r[0].title === 'A test, complete genome', `FASTA with ${name} line endings`);
}
const bytes = new TextEncoder().encode(fasta);
for (const chunk of [1, 7, 61, 4096]) {
  const p = new ByteParser({}, 0);
  for (let i = 0; i < bytes.length; i += chunk) p.push(bytes.subarray(i, i + chunk));
  const r = p.finish().records;
  ok(r.length === 2 && Array.from(r[0].codes).join('') === want[0] && Array.from(r[1].codes).join('') === want[1], `FASTA fed in ${chunk}-byte chunks`);
}
const gbBytes = new TextEncoder().encode(gbText);
{
  const p = new ByteParser({}, 0);
  for (let i = 0; i < gbBytes.length; i += 13) p.push(gbBytes.subarray(i, i + 13));
  ok(Array.from(p.finish().records[0].codes).join('') === ref(gbSeq), 'GenBank fed in 13-byte chunks');
}
const embl = 'ID   X56734; SV 1; circular; genomic DNA; STD; PLN; 12 BP.\nXX\nDE   Test plastid,\nDE   complete genome.\nSQ   Sequence 12 BP;\n     acgtacgtac gt          12\n//\n';
const er = parseText(embl).records;
ok(er.length === 1 && er[0].id === 'X56734' && er[0].length === 12 && er[0].circular === true && er[0].title === 'Test plastid, complete genome', 'EMBL with multi-line DE');
ok(codesOf('  ACGT ACGT\n1234 gg') === '0231023133', 'plain text: digits and spaces skipped');
ok(codesOf('acgtacgtnRYKM') === '0231023144444', 'IUPAC codes become other');
ok(parseText('\n\n   >x\nAC').records[0].id === 'x', 'leading blank lines before a FASTA header');
const two = parseText('LOCUS       A1  8 bp DNA linear\nDEFINITION  first.\nORIGIN\n        1 acgtacgt\n//\nLOCUS       B2  4 bp DNA circular\nVERSION     B2.3\nORIGIN\n        1 gggg\n//\n').records;
ok(two.length === 2 && two[1].id === 'B2.3' && two[0].circular === false && two[1].circular === true && two[1].length === 4, 'two GenBank records in one file');
throwsLike(() => parseText('>p\nMKVLLLAEQRSTWYFPHIKLMNEQ'), /protein/, 'protein FASTA rejected');
throwsLike(() => parseText('PK\u0003\u0004rest'), /zip/, 'zip archive rejected');
throwsLike(() => parseText('\u0000\u0001\u0002\u0003binary\u0000\u0000\u0000'), /binary/, 'binary file rejected');
throwsLike(() => parseText('\n  <!doctype html><html><body>Sign in to the Wi-Fi</body></html>'), /web page/, 'a web page (Wi-Fi sign-in) is refused, not drawn');
throwsLike(() => parseText('{"esearchresult": {}}'), /JSON/, 'a JSON file is refused');
throwsLike(() => parseText(''), /No sequence/, 'empty input rejected');
throwsLike(() => parseText('LOCUS       X 5 bp DNA linear\nCONTIG      join(A:1..5)\n//\n'), /no sequence/, 'GenBank CONTIG record explained');

// stretches, caps and record limits
const span = parseText(fasta, { from: 101, length: 50, maxRecords: 1 }).records[0];
ok(span.length === 50 && span.origin === 101 && Array.from(span.codes).join('') === want[0].slice(100, 150) && span.fullLength === gbSeq.length, 'From/Length keeps only that stretch, with its coordinates');
const capped = parseText(fasta, { maxBases: 1000 });
ok(capped.records[0].length === 1000 && capped.records.length === 1 && capped.notes.some(n => /Stopped at 1,000/.test(n)), 'base cap stops reading and says so');
const many = parseText(Array.from({ length: 30 }, (_, i) => `>s${i}\nACGT`).join('\n'), { maxRecords: 24 });
ok(many.records.length === 24 && many.notes.some(n => /6 more/.test(n)), 'record cap keeps 24 and reports the rest');
ok(parseText('>NC_000023.11:1000001-2000000 Homo sapiens chromosome X\nACGT').records[0].origin === 1000001, 'NCBI slice header keeps genome coordinates');
ok(Array.from(unpackNibbles(Buffer.from([0x02, 0x31, 0x40]).toString('base64'), 5)).join('') === '02314', 'first-version saved genomes migrate');

// gzip through the stream path
const gz = gzipSync(Buffer.from(fasta));
const gzr = await parseStream(streamOf(new Uint8Array(gz), 1000), {}, gz.length);
ok(gzr.records.length === 2 && Array.from(gzr.records[0].codes).join('') === want[0], 'gzip stream');
const multi = Buffer.concat([gzipSync(Buffer.from('>a\nACGT\n')), gzipSync(Buffer.from('>b\nGGCC\n'))]);
const mr = await parseStream(streamOf(new Uint8Array(multi), 7), {}, multi.length);
ok(mr.records.length === 2 && mr.records[1].id === 'b', 'multi-member gzip (bgzip style) reads every member');

// ---- window calls ----------------------------------------------------------------------------
console.log('window calls');
function brute(codes: Uint8Array, w: number, tie: TieRule): number[] {
  const out: number[] = [];
  for (let s = 0; s < codes.length; s += w) {
    const e = Math.min(codes.length, s + w);
    const cnt = [0, 0, 0, 0]; const first = [1e9, 1e9, 1e9, 1e9];
    for (let i = s; i < e; i++) { const c = codes[i]; if (c < 4) { cnt[c]++; first[c] = Math.min(first[c], i); } }
    const max = Math.max(...cnt);
    if (max === 0) { out.push(N); continue; }
    const tied = [0, 1, 2, 3].filter(b => cnt[b] === max);
    out.push(tie === 'order' ? tied[0] : tied.sort((a, b) => first[a] - first[b])[0]);
  }
  return out;
}
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randCodes = new Uint8Array(200_003).map(() => (rand() < 0.03 ? N : Math.floor(rand() * 4)));
for (const tie of ['order', 'first'] as TieRule[]) {
  for (const set of [[1, 20, 40, 80, 160], [1, 7, 13], [3, 6, 9, 333], [1000, 3000], [2], [999999]]) {
    const calls = computeCalls(randCodes, set, tie);
    const good = set.every((w, i) => w === 1 ? calls[i] === null : calls[i]!.join() === brute(randCodes, w, tie).join());
    ok(good, `calls for [${set}] with ties by ${tie}`);
  }
}
ok(computeCalls(new Uint8Array([4, 4, 4]), [3], 'order')[0]![0] === N, 'all-N window is N');
ok(computeCalls(new Uint8Array(0), [20], 'order')[0]!.length === 0, 'empty sequence');

// ---- painting --------------------------------------------------------------------------------
console.log('painting');
{
  // a small picture: two genomes (the second shorter), an every-base column and a 20 bp column each,
  // with gaps and a margin, checked against a straightforward full-image renderer
  const W = 97, w = 20, gap = 5, panelGap = 9, margin = 3;
  const gA = randCodes.subarray(0, 12345), gB = randCodes.subarray(50_000, 55_001);
  const cA = computeCalls(gA, [w], 'order')[0]!, cB = computeCalls(gB, [w], 'order')[0]!;
  const rowsA = Math.ceil(gA.length / W), rowsB = Math.ceil(gB.length / W);
  const cols: TileCol[] = [];
  let x = margin;
  for (const [g, c, rows] of [[gA, cA, rowsA], [gB, cB, rowsB]] as const) {
    cols.push({ x, y: margin, rows, src: { codes: g, calls: null, w: 1 } }); x += W + gap;
    cols.push({ x, y: margin, rows, src: { codes: g, calls: c, w } }); x += W + panelGap;
  }
  const IW = x - panelGap + margin, IH = Math.max(rowsA, rowsB) + 2 * margin;
  const ref = new Uint8Array(IW * IH).fill(5);
  for (const col of cols) for (let p = 0; p < col.src.codes.length; p++) {
    const v = col.src.calls ? col.src.calls[Math.floor(p / col.src.w)] : col.src.codes[p];
    ref[(col.y + Math.floor(p / W)) * IW + col.x + (p % W)] = v;
  }
  const pal32 = Uint32Array.from([10, 11, 12, 13, 14, 15]);
  let good = true;
  for (const [x0, y0, bw, bh] of [[0, 0, IW, IH], [90, 80, 40, 50], [0, rowsB - 5, IW, 20], [IW - 33, IH - 17, 33, 17], [100, 0, 3, 9]]) {
    const out = new Uint32Array(bw * bh);
    paintTileFull(cols, W, x0, y0, bw, bh, pal32, out);
    for (let y = 0; y < bh; y++) for (let xx = 0; xx < bw; xx++) if (out[y * bw + xx] !== 10 + ref[(y0 + y) * IW + x0 + xx]) good = false;
  }
  ok(good, 'full-resolution tiles match the picture (gaps, margins, ragged ends, a short genome)');
  // averaged tiles equal a box filter over the full-resolution picture, clipped at its edges
  const pr = [0, 255, 255, 0, 128, 7], pg = [255, 255, 0, 0, 128, 9], pb = [255, 0, 0, 0, 128, 11];
  let worst = 0;
  for (const sh of [1, 2, 3, 5]) {
    const f = 1 << sh;
    for (const [x0, y0, x1, y1] of [[0, 0, IW, IH], [64, 32, IW, 130], [0, IH - 40, 128, IH]]) {
      const bw = Math.ceil((x1 - x0) / f), bh = Math.ceil((y1 - y0) / f);
      const out = new Uint8ClampedArray(bw * bh * 4);
      paintTileAveraged(cols, W, x0, x1, y0, y1, sh, pr, pg, pb, out, new Uint32Array(bw * 5));
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0 + by * f; y < Math.min(y1, y0 + by * f + f); y++) for (let xx = x0 + bx * f; xx < Math.min(x1, x0 + bx * f + f); xx++) {
          const c = ref[y * IW + xx];
          r += pr[c]; g += pg[c]; b += pb[c]; n++;
        }
        const o = (by * bw + bx) * 4;
        worst = Math.max(worst, Math.abs(out[o] - r / n), Math.abs(out[o + 1] - g / n), Math.abs(out[o + 2] - b / n));
        if (out[o + 3] !== 255) worst = 999;
      }
    }
  }
  ok(worst <= 0.5, `averaged tiles match a box filter of the picture (max error ${worst.toFixed(2)})`);
  const row = new Uint8Array(200).fill(5);
  fillIndexRow({ codes: gA, calls: cA, w }, W, 3, row, 50);
  ok(Array.from(row.subarray(50, 50 + W)).every((v, xx) => v === cA[Math.floor((3 * W + xx) / w)]) && row[49] === 5 && row[50 + W] === 5, 'export row of a window column');
  // speed: a full-resolution 512 x 512 tile, and a deep overview tile over a 20 Mb genome's columns
  const big = new Uint8Array(20_000_000).map((_, i) => (i * 2654435761) >>> 30);
  const bigCalls = computeCalls(big, [20, 40, 80, 160], 'order');
  const bigCols: TileCol[] = [1, 20, 40, 80, 160].map((ww, k) => ({ x: k * 105, y: 0, rows: Math.ceil(big.length / 100), src: { codes: big, calls: k ? bigCalls[k - 1] : null, w: ww } }));
  let t0 = performance.now();
  const full = new Uint32Array(512 * 512);
  for (let i = 0; i < 20; i++) paintTileFull(bigCols, 100, 0, i * 512, 512, 512, pal32, full);
  const tFull = (performance.now() - t0) / 20;
  t0 = performance.now();
  const deep = new Uint8ClampedArray(512 * 512 * 4);
  paintTileAveraged(bigCols, 100, 0, 520, 0, 200_000, 9, pr, pg, pb, deep, new Uint32Array(512 * 5));
  const tDeep = performance.now() - t0;
  console.log(`  full tile ${tFull.toFixed(2)} ms; overview of 20 Mb x 5 columns in one tile ${tDeep.toFixed(0)} ms`);
  ok(tFull < 20 && tDeep < 1500, 'tiles paint fast');
}

// ---- inverted repeats ------------------------------------------------------------------------
console.log('inverted repeats');
const fmt = ([a, b]: [number, number]) => `${a + 1}-${b + 1}`;
const q1 = findQuadripartite(gb.records[0].codes);
ok(!!q1 && fmt(q1.irb) === '84171-110434' && fmt(q1.ira) === '128215-154478', 'Arabidopsis IRs match the literature');
const amb = parseText(readFileSync('data/Amborella_trichopoda.gb', 'utf8')).records[0];
const q2 = findQuadripartite(amb.codes);
ok(!!q2 && fmt(q2.irb) === '90951-117611' && fmt(q2.ira) === '136026-162686', 'Amborella IRs match the GenBank annotation');
const rot = new Uint8Array(amb.codes.length);
rot.set(amb.codes.subarray(125000)); rot.set(amb.codes.subarray(0, 125000), amb.codes.length - 125000);
const q3 = findQuadripartite(rot);
ok(!!q3 && q3.lsc.length === 1 && regionAt(q3, 50000) === 'LSC' && regionAt(q3, 0) === 'SSC', 'a genome that starts inside the SSC is still labelled');
ok(findQuadripartite(new Uint8Array(50000).map(() => Math.floor(rand() * 4))) === null, 'random sequence has no IR');

// ---- NCBI query building ---------------------------------------------------------------------
console.log('NCBI');
ok(buildTerm('NC_000913.3', 'plastid', true, false) === 'NC_000913.3[accn]', 'accession query');
ok(buildTerm('tobacco', 'plastid', true, false) === '"tobacco"[Organism] AND ((chloroplast[filter] OR plastid[filter]) AND 50000:3000000[SLEN]) AND srcdb_refseq[PROP]', 'organism + plastid + RefSeq query');
ok(buildTerm('human', 'chromosome', true, false).endsWith('NC_000001:NC_999999[accn]'), 'chromosomes keep to NC_ records');
ok(buildTerm('E. "coli" (K-12)', 'any', false, true) === '(E. coli K-12)', 'quotes and brackets are cleaned from free text');
ok(/seq_start=1&seq_stop=1000000/.test(efetchURL('NC_000023.11', 1, 1000000)), 'slice download URL');

// ---- PNG -------------------------------------------------------------------------------------
console.log('PNG');
{
  const pal = [[0, 255, 255], [255, 255, 0], [255, 0, 0], [0, 0, 0], [128, 128, 128], [10, 20, 30]];
  const blob = await encodeIndexedPNG(7, 5, pal, (y, r) => { for (let x = 0; x < 7; x++) r[x] = (x + y) % 6; }, { Software: 'test' });
  const png = new Uint8Array(await blob.arrayBuffer());
  ok(png[0] === 137 && String.fromCharCode(...png.subarray(12, 16)) === 'IHDR', 'PNG signature and header');
  const { writeFileSync } = await import('node:fs');
  writeFileSync('test/out.png', png);
  let threw = false;
  try { await encodeIndexedPNG(4, 4, pal, y => { if (y === 2) throw new Error('stop'); }); } catch { threw = true; }
  ok(threw, 'an encode can be abandoned part way');
}

// ---- speed -----------------------------------------------------------------------------------
console.log('speed');
{
  const big = new Uint8Array(20_000_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761 >>> 29) & 3;
  let t = performance.now();
  computeCalls(big, [1, 20, 40, 80, 160], 'order');
  const tCalls = performance.now() - t;
  const fa = new Uint8Array(21_000_000);
  for (let i = 0, j = 0; i < fa.length; i++) fa[i] = (i % 71 === 70) ? 10 : 'ACGT'.charCodeAt((j++ * 2654435761 >>> 29) & 3);
  const p = new ByteParser({}, fa.length);
  t = performance.now();
  for (let i = 0; i < fa.length; i += 1 << 16) p.push(fa.subarray(i, i + (1 << 16)));
  const r = p.finish();
  const tParse = performance.now() - t;
  console.log(`  parse ${(fa.length / 1e6 / (tParse / 1000)).toFixed(0)} MB/s (${r.records[0].length.toLocaleString()} bases); calls for 20 Mb x 4 windows ${tCalls.toFixed(0)} ms`);
  ok(tParse < 2000 && tCalls < 2000, 'parser and window calls are fast');
}

console.log(failed ? `${failed} of ${ran} FAILED` : `all ${ran} passed`);
if (failed) process.exit(1);
