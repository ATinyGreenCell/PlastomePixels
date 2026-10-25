// Minimal indexed-colour PNG encoder. Rows stream through zlib (CompressionStream 'deflate'), so the
// image never has to exist in memory or on a canvas: any size the PNG format allows can be written.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export const canEncodePNG = () => typeof CompressionStream !== 'undefined';

/**
 * @param fillRow writes the palette indices of output row `y` into `row` (length = width).
 *                It may throw to abandon the encode.
 */
export async function encodeIndexedPNG(
  width: number,
  height: number,
  palette: number[][],
  fillRow: (y: number, row: Uint8Array) => void,
  text: Record<string, string> = {},
): Promise<Blob> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 3;  // colour type: indexed
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => { plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b; });

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const compressed = new Response(cs.readable).arrayBuffer();
  try {
    const stride = width + 1;
    const rowsPerBatch = Math.max(1, Math.floor((1 << 20) / stride));
    const row = new Uint8Array(width);
    for (let y0 = 0; y0 < height; y0 += rowsPerBatch) {
      const rows = Math.min(rowsPerBatch, height - y0);
      const batch = new Uint8Array(rows * stride); // each row leads with filter byte 0 (None)
      for (let r = 0; r < rows; r++) {
        fillRow(y0 + r, row);
        batch.set(row, r * stride + 1);
      }
      await writer.write(batch);
    }
    await writer.close();
  } catch (e) {
    writer.abort(e).catch(() => {});
    compressed.catch(() => {});
    throw e;
  }
  const idat = new Uint8Array(await compressed);

  const enc = new TextEncoder();
  const textChunks = Object.entries(text).map(([k, v]) => {
    const kb = enc.encode(k), vb = enc.encode(v.replace(/[^\x20-\x7e]/g, '?'));
    const d = new Uint8Array(kb.length + 1 + vb.length);
    d.set(kb, 0); d.set(vb, kb.length + 1);
    return chunk('tEXt', d);
  });

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([sig, chunk('IHDR', ihdr), chunk('PLTE', plte), ...textChunks, chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
