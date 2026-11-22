/**
 * PNG encoding for a Raster: 8-bit RGB, rows Sub-filtered, deflated with CompressionStream
 * ("deflate" is the zlib format a PNG's IDAT wants). Works in Workers, browsers and Node.
 */

import type { Raster } from './canvas.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Each row: filter type 1 (Sub), then each byte minus the byte one pixel to its left. */
function filtered(r: Raster): Uint8Array {
  const stride = r.width * 3;
  const out = new Uint8Array((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    const row = y * (stride + 1);
    out[row] = 1;
    for (let i = 0; i < stride; i++) {
      const cur = r.data[y * stride + i]!;
      out[row + 1 + i] = (cur - (i >= 3 ? r.data[y * stride + i - 3]! : 0)) & 255;
    }
  }
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(r: Raster): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, r.width);
  view.setUint32(4, r.height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(filtered(r))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
