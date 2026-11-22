/**
 * A tiny RGB canvas for report charts: rectangles, anti-aliased thick lines, filled areas
 * under a line, dashed rules and text from a glyph atlas. No dependencies and no DOM, so
 * it runs in a Worker; each pixel is blended with its coverage.
 */

import { ATLAS, type AtlasSize } from './font.ts';

export type RGB = [number, number, number];

export function hex(color: string): RGB {
  const v = Number.parseInt(color.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Coverage of pixel [p, p+1) by the span [a, b). */
const overlap = (p: number, a: number, b: number) =>
  clamp(Math.min(p + 1, b) - Math.max(p, a), 0, 1);

const decoded = new Map<number, Uint8Array>();

/** An atlas size's coverage, one byte (0–15) per pixel. */
function coverage(a: AtlasSize): Uint8Array {
  const hit = decoded.get(a.size);
  if (hit) return hit;
  const bin = atob(a.data.join(''));
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0; i < out.length; i++) {
    const byte = bin.charCodeAt(i >> 1);
    out[i] = i & 1 ? byte & 15 : byte >> 4;
  }
  decoded.set(a.size, out);
  return out;
}

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, background: RGB) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    // One pixel, then copy the filled part onto the rest, doubling each time.
    this.data.set(background, 0);
    for (let filled = 3; filled < this.data.length; filled *= 2)
      this.data.copyWithin(filled, 0, Math.min(filled, this.data.length - filled));
  }

  /** Mix a colour into one pixel with alpha 0–1. */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    const d = this.data;
    if (a >= 1) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      return;
    }
    const k = 1 - a;
    d[i] = d[i]! * k + c[0] * a + 0.5;
    d[i + 1] = d[i + 1]! * k + c[1] * a + 0.5;
    d[i + 2] = d[i + 2]! * k + c[2] * a + 0.5;
  }

  /** A rectangle with fractional edges (partly covered pixels are blended). */
  fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    const x1 = x + w;
    const y1 = y + h;
    const left = Math.max(0, Math.floor(x));
    const right = Math.min(this.width, Math.ceil(x1));
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, Math.ceil(y1)); py++) {
      const cy = a * overlap(py, y, y1);
      for (let px = left; px < right; px++)
        this.blend(px, py, c, px >= x && px + 1 <= x1 ? cy : cy * overlap(px, x, x1));
    }
  }

  /** A thick line with round ends: each pixel's coverage from its distance to the segment. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: RGB, a = 1): void {
    const r = width / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    for (
      let py = Math.floor(Math.min(y0, y1) - r - 1);
      py <= Math.ceil(Math.max(y0, y1) + r + 1);
      py++
    ) {
      for (
        let px = Math.floor(Math.min(x0, x1) - r - 1);
        px <= Math.ceil(Math.max(x0, x1) + r + 1);
        px++
      ) {
        const t = clamp(((px + 0.5 - x0) * dx + (py + 0.5 - y0) * dy) / len2, 0, 1);
        const d = Math.hypot(px + 0.5 - (x0 + t * dx), py + 0.5 - (y0 + t * dy));
        this.blend(px, py, c, a * clamp(r + 0.5 - d, 0, 1));
      }
    }
  }

  /** Connected segments. Joints overlap, so round ends make round joins. */
  polyline(points: [number, number][], width: number, c: RGB, a = 1): void {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!;
      const [x1, y1] = points[i]!;
      this.line(x0, y0, x1, y1, width, c, a);
    }
  }

  /** The area between a line and a baseline, column by column, with a soft top edge. */
  area(points: [number, number][], baseY: number, c: RGB, a: number): void {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!;
      const [x1, y1] = points[i]!;
      for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
        const t = x1 === x0 ? 0 : clamp((px + 0.5 - x0) / (x1 - x0), 0, 1);
        const top = y0 + t * (y1 - y0);
        this.fillRect(px, top, overlap(px, x0, x1), baseY - top, c, a);
      }
    }
  }

  /** A horizontal dashed rule, one pixel tall. */
  dashed(x0: number, x1: number, y: number, c: RGB, dash = 4, gap = 4, a = 1): void {
    for (let x = x0; x < x1; x += dash + gap)
      this.fillRect(x, Math.round(y), Math.min(dash, x1 - x), 1, c, a);
  }

  /** Width of a string at a size, in pixels. */
  measure(text: string, size: 11 | 13): number {
    const atlas = ATLAS[size]!;
    let w = 0;
    for (const ch of text) w += (atlas.glyphs[ch] ?? atlas.glyphs['?']!)[0];
    return w;
  }

  /** Text whose top is at `y`; `align` places `x` at its start, middle or end. Returns the width. */
  text(
    x: number,
    y: number,
    text: string,
    size: 11 | 13,
    c: RGB,
    align: 'left' | 'center' | 'right' = 'left',
  ): number {
    const atlas = ATLAS[size]!;
    const width = this.measure(text, size);
    let pen = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
    const cov = coverage(atlas);
    for (const ch of text) {
      const [advance, offset, cell] = atlas.glyphs[ch] ?? atlas.glyphs['?']!;
      this.glyph(cov, atlas, offset, cell, Math.round(pen), Math.round(y), c);
      pen += advance;
    }
    return width;
  }

  private glyph(
    cov: Uint8Array,
    atlas: AtlasSize,
    offset: number,
    cell: number,
    x: number,
    y: number,
    c: RGB,
  ): void {
    for (let gy = 0; gy < atlas.height; gy++)
      for (let gx = 0; gx < cell; gx++) {
        const level = cov[gy * atlas.width + offset + gx]!;
        if (level) this.blend(x + gx, y + gy, c, level / 15);
      }
  }

  /** Text cut to fit a width, with an ellipsis. */
  fit(text: string, size: 11 | 13, max: number): string {
    if (this.measure(text, size) <= max) return text;
    let out = text;
    while (out.length > 1 && this.measure(`${out}…`, size) > max) out = out.slice(0, -1);
    return `${out}…`;
  }
}
