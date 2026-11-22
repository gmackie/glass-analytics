/**
 * The PNG renderer: files decode (zlib, CRCs, filters), pixels land where they should, text is
 * drawn, and the same input always gives the same bytes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { hex, Raster } from '../src/raster/canvas.ts';
import { funnelPng, retentionPng, timeChartPng } from '../src/raster/charts.ts';
import { crc32, encodePng } from '../src/raster/png.ts';

/** A minimal PNG decoder for RGB, Sub-filtered files: checks every chunk's CRC. */
function decode(png: Uint8Array): {
  width: number;
  height: number;
  px: (x: number, y: number) => number[];
} {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    const crc = view.getUint32(at + 8 + len);
    assert.equal(
      (crc32(png.subarray(at + 4, at + 8 + len)) ^ 0xffffffff) >>> 0,
      crc,
      `${type} CRC`,
    );
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const line = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    assert.equal(line[0], 1, 'Sub filter');
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) row[i] = (line[1 + i]! + (i >= 3 ? row[i - 3]! : 0)) & 255;
    rows.push(row);
  }
  return { width, height, px: (x, y) => [...rows[y]!.subarray(x * 3, x * 3 + 3)] };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const SAMPLES = process.env.RASTER_SAMPLES;

describe('raster', () => {
  it('encodes a decodable PNG with the right pixels', async () => {
    const r = new Raster(20, 10, hex('#ffffff'));
    r.fillRect(2, 2, 5, 5, hex('#ff0000'));
    r.line(10, 5, 18, 5, 3, hex('#0000ff'));
    const img = decode(await encodePng(r));
    assert.deepEqual([img.width, img.height], [20, 10]);
    assert.deepEqual(img.px(4, 4), [255, 0, 0]);
    assert.deepEqual(img.px(0, 0), [255, 255, 255]);
    assert.deepEqual(img.px(14, 5), [0, 0, 255]);
    // Edges are blended: half a pixel of red over white is pink.
    r.fillRect(0, 9, 1.5, 1, hex('#ff0000'));
    assert.deepEqual([...r.data.subarray((9 * 20 + 1) * 3, (9 * 20 + 1) * 3 + 3)], [255, 128, 128]);
  });

  it('draws text from the atlas', () => {
    const r = new Raster(80, 20, hex('#ffffff'));
    const w = r.text(2, 2, 'Pageviews', 13, hex('#000000'));
    assert.ok(w > 40 && w < 80, `width ${w}`);
    const dark = [...r.data].filter((v, i) => i % 3 === 0 && v < 128).length;
    assert.ok(dark > 30, `${dark} dark pixels`);
    assert.equal(r.fit('A very long label that will not fit', 11, 60).endsWith('…'), true);
  });

  it('renders charts deterministically', async () => {
    const labels = ['14 Nov', '15 Nov', '16 Nov', '17 Nov', '18 Nov', '19 Nov', '20 Nov'];
    const line = await timeChartPng({
      labels,
      series: [
        { label: 'Pageviews', values: [120, 180, 160, 240, 310, 280, 350] },
        { label: 'Signups', values: [12, 20, 18, 30, 41, 33, 44] },
      ],
    });
    const bars = await timeChartPng({
      labels,
      series: [{ label: 'Orders', values: [3, 5, 2, 8, 6, 9, 4] }],
      type: 'bar',
    });
    const funnel = await funnelPng({
      steps: [
        { label: 'Visited', count: 1200 },
        { label: 'Signed up', count: 310 },
        { label: 'Paid', count: 48 },
      ],
    });
    const retention = await retentionPng([1, 0.42, 0.31, 0.27, 0.24, 0.22], 'week');
    for (const png of [line, bars, funnel, retention])
      assert.deepEqual([decode(png).width, decode(png).height], [600, 300]);
    // A bar reaches the plot: the tallest (9) is filled with the first series colour.
    const b = decode(bars);
    const column = Array.from({ length: 300 }, (_, y) =>
      b.px(Math.round(16 + 50 + (5.5 / 7) * 500), y),
    );
    assert.ok(
      column.some((p) => p.join() === '42,122,103'),
      'a bar in the series colour',
    );
    // The same input gives the same bytes.
    assert.equal(
      sha(
        await funnelPng({
          steps: [
            { label: 'A', count: 2 },
            { label: 'B', count: 1 },
          ],
        }),
      ),
      sha(
        await funnelPng({
          steps: [
            { label: 'A', count: 2 },
            { label: 'B', count: 1 },
          ],
        }),
      ),
    );
    if (SAMPLES)
      for (const [name, png] of Object.entries({ line, bars, funnel, retention }))
        writeFileSync(`${SAMPLES}/${name}.png`, png);
  });
});
