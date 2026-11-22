/**
 * Report charts as PNGs: time series (lines, areas or bars), funnels and retention curves, in
 * the dashboard's light palette, 600×300 by default. Used for the images in Slack, Discord and
 * Teams reports and inline in emails. The image holds the chart and its labels only.
 */

import { hex, Raster, type RGB } from './canvas.ts';
import { encodePng } from './png.ts';

export const REPORT_PALETTE = ['#2a7a67', '#3459c6', '#b5761a', '#b23a49', '#24879a', '#7b8a84'];

const INK = hex('#16201c');
const MUTED = hex('#64746d');
const GRID = hex('#e2e8e5');
const WHITE = hex('#ffffff');

export interface PngSeries {
  label: string;
  values: number[];
}

export interface TimeChart {
  /** One label per bucket ("18 Nov"). */
  labels: string[];
  series: PngSeries[];
  type?: 'line' | 'area' | 'bar';
  /** Values are ratios to show as percentages. */
  percent?: boolean;
  width?: number;
  height?: number;
}

/** "1.2k", "3.4M", "12%". */
export function compact(n: number, percent = false): string {
  if (percent) return `${Math.round(n * 1000) / 10}%`;
  const a = Math.abs(n);
  if (a >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (a >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${Math.round(n / 100) / 10}k`;
  return String(Math.round(n * 100) / 100);
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function ticks(max: number, percent: boolean): number[] {
  if (percent && max <= 1) return [0, 0.25, 0.5, 0.75, 1];
  const step = max <= 4 && !percent ? 1 : niceStep(max / 4);
  const out = [0];
  while (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  if (out.length < 2) out.push(step);
  return out;
}

const colorOf = (i: number): RGB => hex(REPORT_PALETTE[i % REPORT_PALETTE.length]!);

interface Frame {
  r: Raster;
  left: number;
  right: number;
  top: number;
  bottom: number;
  max: number;
  n: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

function frame(c: TimeChart, W: number, H: number): Frame {
  const r = new Raster(W, H, WHITE);
  const n = Math.max(1, ...c.series.map((s) => s.values.length), c.labels.length);
  const values = ticks(Math.max(0, ...c.series.flatMap((s) => s.values)), Boolean(c.percent));
  const max = values[values.length - 1]! || 1;
  const left = 12 + Math.max(...values.map((v) => r.measure(compact(v, c.percent), 11)));
  const legend = c.series.length > 1 ? 22 : 0;
  const f = { r, left, right: W - 16, top: 12, bottom: H - 26 - legend, max, n } as Frame;
  const bar = c.type === 'bar';
  const span = f.right - f.left;
  f.x = (i) =>
    bar ? f.left + (span / n) * (i + 0.5) : f.left + (n <= 1 ? span / 2 : (i / (n - 1)) * span);
  f.y = (v) => f.bottom - (Math.min(v, max) / max) * (f.bottom - f.top);
  for (const v of values) {
    const y = f.y(v);
    if (v === 0) r.fillRect(left, Math.round(y), span, 1, GRID);
    else r.dashed(left, f.right, y, GRID, 3, 3);
    r.text(left - 8, y - 7, compact(v, c.percent), 11, MUTED, 'right');
  }
  return f;
}

function xLabels(f: Frame, labels: string[]): void {
  const every = Math.max(1, Math.ceil(f.n / Math.max(2, Math.floor((f.right - f.left) / 70))));
  for (let i = 0; i < f.n; i += every) {
    const text = labels[i] ?? '';
    const align = f.n < 2 ? 'center' : i === 0 ? 'left' : i === f.n - 1 ? 'right' : 'center';
    f.r.text(f.x(i), f.bottom + 7, text, 11, MUTED, align);
  }
}

function legend(f: Frame, series: PngSeries[], H: number): void {
  if (series.length < 2) return;
  let x = f.left;
  for (const [i, s] of series.entries()) {
    const label = f.r.fit(s.label, 11, 140);
    f.r.fillRect(x, H - 16, 10, 10, colorOf(i));
    x += 15 + f.r.text(x + 15, H - 18, label, 11, INK) + 14;
    if (x > f.right - 60) break;
  }
}

function drawBars(f: Frame, series: PngSeries[]): void {
  const groups = series.length;
  const band = (f.right - f.left) / f.n;
  const bw = Math.max(2, Math.min(28, (band * 0.72) / groups));
  for (const [si, s] of series.entries())
    for (const [i, v] of s.values.entries()) {
      const x = f.x(i) - (bw * groups) / 2 + si * bw;
      f.r.fillRect(x + 0.5, f.y(v), bw - 1, f.bottom - f.y(v), colorOf(si));
    }
}

function drawLines(f: Frame, series: PngSeries[], area: boolean): void {
  for (const [si, s] of series.entries()) {
    const points = s.values.map((v, i): [number, number] => [f.x(i), f.y(v)]);
    if (area || series.length === 1) f.r.area(points, f.bottom, colorOf(si), si === 0 ? 0.16 : 0.1);
    f.r.polyline(points, 2.2, colorOf(si));
    if (points.length === 1)
      f.r.line(points[0]![0], points[0]![1], points[0]![0], points[0]![1], 7, colorOf(si));
  }
}

/** A time series chart as PNG bytes. */
export async function timeChartPng(c: TimeChart): Promise<Uint8Array> {
  const W = c.width ?? 600;
  const H = c.height ?? 300;
  const f = frame(c, W, H);
  const series = c.series.slice(0, 6);
  if (c.type === 'bar') drawBars(f, series);
  else drawLines(f, series, c.type === 'area');
  xLabels(f, c.labels);
  legend(f, series, H);
  return encodePng(f.r);
}

export interface FunnelChart {
  steps: { label: string; count: number }[];
  width?: number;
  height?: number;
}

/** Funnel steps as bars, each with its conversion from the first step. */
export async function funnelPng(c: FunnelChart): Promise<Uint8Array> {
  const W = c.width ?? 600;
  const H = c.height ?? 300;
  const r = new Raster(W, H, WHITE);
  const steps = c.steps.slice(0, 8);
  const first = Math.max(1, steps[0]?.count ?? 1);
  const gap = 14;
  const bw = (W - 32 - gap * (steps.length - 1)) / Math.max(1, steps.length);
  const top = 30;
  const bottom = H - 42;
  for (const [i, s] of steps.entries()) {
    const x = 16 + i * (bw + gap);
    const h = (s.count / first) * (bottom - top);
    r.fillRect(x, top, bw, bottom - top, hex('#f3f6f5'));
    r.fillRect(x, bottom - h, bw, h, colorOf(0));
    r.text(
      x + bw / 2,
      top - 22,
      `${Math.round((s.count / first) * 1000) / 10}%`,
      13,
      INK,
      'center',
    );
    r.text(x + bw / 2, bottom + 6, r.fit(s.label, 11, bw), 11, INK, 'center');
    r.text(x + bw / 2, bottom + 21, compact(s.count), 11, MUTED, 'center');
  }
  return encodePng(r);
}

/** The average retention curve: share of each cohort back in period 0…n. */
export async function retentionPng(
  average: number[],
  period: string,
  width = 600,
  height = 300,
): Promise<Uint8Array> {
  const labels = average.map((_, k) => `${period[0]!.toUpperCase()}${k}`);
  return timeChartPng({
    labels,
    series: [{ label: 'Retained', values: average }],
    type: 'area',
    percent: true,
    width,
    height,
  });
}
