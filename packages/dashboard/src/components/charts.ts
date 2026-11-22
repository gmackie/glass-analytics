/**
 * Charts, drawn as plain SVG at the container's real pixel width (so text and
 * strokes stay crisp at any size). Series colours are the traditional colours
 * of bottle glass — float green, cobalt, amber, ruby — defined in styles.css.
 */

import { addMonths } from '@dataflare/core/time';
import { type Child, h, mount, s } from '../dom.ts';
import { bucketLabel, count, duration, percent } from '../format.ts';
import { href } from '../state.ts';
import { icon } from './icons.ts';

export const SERIES = [
  'var(--glass-green)',
  'var(--glass-cobalt)',
  'var(--glass-amber)',
  'var(--glass-ruby)',
  'var(--glass-teal)',
  'var(--smoke)',
];

let chartIds = 0;

export interface LineSeries {
  label: string;
  values: number[];
  /** The same series over the previous period, drawn dashed. Aligned by index. */
  previous?: number[];
  /** A fitted trend, drawn as a thin dashed line in the series colour. */
  trend?: number[];
  /** How to print this line's values (e.g. a percent formula); the chart's format otherwise. */
  format?: (n: number) => string;
}

/** A note pinned to a moment, shown as a marker on time charts. */
export interface Annotation {
  /** Epoch ms. */
  at: number;
  text: string;
}

export type ChartType = 'line' | 'area' | 'bar';

export interface ChartOptions {
  height?: number;
  type?: ChartType;
  /** X labels to use instead of formatting `buckets`. */
  labels?: string[];
  /** Format for axis ticks and the tooltip. Default: counts. */
  format?: (n: number) => string;
  /** Fixed top of the y axis (e.g. 1 for rates). */
  yMax?: number;
  /** Hide the legend even with several series. */
  legend?: boolean;
  /** Logarithmic y axis, in powers of ten. */
  logScale?: boolean;
  /** Stack the series as shares of each bucket's total (areas, or bars with `type: 'bar'`). */
  percentStack?: boolean;
  /** Write each value on the chart, when there is room. */
  showValues?: boolean;
  /** Notes pinned to moments: a marker on the x axis and a line in the hover readout. */
  annotations?: Annotation[];
}

const INTERVAL_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 31 * 86_400_000,
};

/** The bucket a moment falls in, or null when it is outside the chart. */
function bucketIndex(buckets: number[], at: number, interval: string): number | null {
  if (!buckets.length || at < buckets[0]!) return null;
  let i = buckets.length - 1;
  while (i > 0 && buckets[i]! > at) i--;
  if (i === buckets.length - 1 && at >= buckets[i]! + (INTERVAL_MS[interval] ?? 86_400_000))
    return null;
  return i;
}

/** Powers of ten from 1 up to just above `dataMax`. */
function logTicks(dataMax: number): number[] {
  const top = Math.max(1, Math.ceil(Math.log10(Math.max(10, dataMax))));
  return Array.from({ length: top + 1 }, (_, k) => 10 ** k);
}

/** Round a step up to 1, 2 or 5 × 10^n so axis labels are whole, readable numbers. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function ticks(dataMax: number, fixedMax?: number): number[] {
  if (fixedMax) return [0, 0.25, 0.5, 0.75, 1].map((t) => t * fixedMax);
  const step = dataMax <= 4 ? 1 : niceStep(dataMax / 4);
  const out = [0];
  while (out[out.length - 1]! < dataMax) out.push(out[out.length - 1]! + step);
  if (out.length < 2) out.push(step);
  return out;
}

/** Re-render `draw(width)` whenever the element's width changes. */
function responsive(wrap: HTMLElement, draw: (width: number) => void, initial = 760): void {
  let last = 0;
  const run = (w: number) => {
    const width = Math.round(w);
    if (width < 40 || width === last) return;
    last = width;
    draw(width);
  };
  run(initial);
  if (typeof ResizeObserver !== 'undefined') {
    let frame = 0;
    new ResizeObserver((entries) => {
      cancelAnimationFrame(frame);
      const w = entries[0]?.contentRect.width ?? 0;
      frame = requestAnimationFrame(() => run(w));
    }).observe(wrap);
  }
}

function changeText(now: number, before: number): Child {
  if (!before) return null;
  const c = (now - before) / before;
  const cls = Math.abs(c) < 0.005 ? '' : c > 0 ? 'good' : 'bad';
  return h(
    'span',
    { class: `delta ${cls}` },
    `${c >= 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(0)}%`,
  );
}

/** 100% stacks: each series' share of the bucket's total, and the band it fills. */
interface Stack {
  shares: number[][];
  lower: number[][];
  upper: number[][];
}

function stackOf(series: LineSeries[], n: number): Stack {
  const totals = Array.from({ length: n }, (_, i) =>
    series.reduce((sum, l) => sum + Math.max(0, l.values[i] ?? 0), 0),
  );
  const shares = series.map((l) =>
    Array.from({ length: n }, (_, i) =>
      totals[i] ? Math.max(0, l.values[i] ?? 0) / totals[i]! : 0,
    ),
  );
  const lower = shares.map((_, si) =>
    Array.from({ length: n }, (_, i) => shares.slice(0, si).reduce((sum, sh) => sum + sh[i]!, 0)),
  );
  const upper = lower.map((lo, si) => lo.map((v, i) => v + shares[si]![i]!));
  return { shares, lower, upper };
}

/** What a chart knows before it has a width. */
interface ChartSetup {
  series: LineSeries[];
  buckets: number[];
  n: number;
  H: number;
  type: ChartType;
  fmt: (n: number) => string;
  axisFmt: (n: number) => string;
  label: (i: number) => string;
  id: string;
  stack: Stack | null;
  log: boolean;
  hasPrevious: boolean;
  notesAt: Map<number, Annotation[]>;
  options: ChartOptions;
}

/** A chart drawn at a width: its scales and padding. */
interface Plot extends ChartSetup {
  W: number;
  pad: { top: number; right: number; bottom: number; left: number };
  innerW: number;
  innerH: number;
  band: number;
  ticks: number[];
  x: (i: number) => number;
  y: (v: number) => number;
}

function chartSetup(
  buckets: number[],
  series: LineSeries[],
  interval: string,
  options: ChartOptions,
): ChartSetup {
  const n = Math.max(
    buckets.length,
    options.labels?.length ?? 0,
    ...series.map((x) => x.values.length),
  );
  const stack = options.percentStack && series.length > 1 ? stackOf(series, n) : null;
  const fmt = options.format ?? count;
  const notesAt = new Map<number, Annotation[]>();
  for (const a of options.annotations ?? []) {
    const i = bucketIndex(buckets, a.at, interval);
    if (i !== null) notesAt.set(i, [...(notesAt.get(i) ?? []), a]);
  }
  return {
    series,
    buckets,
    n,
    H: options.height ?? 260,
    type: options.type ?? 'line',
    fmt,
    axisFmt: stack ? (v: number) => percent(v, 0) : fmt,
    label: (i) => options.labels?.[i] ?? bucketLabel(buckets[i] ?? 0, interval),
    id: `c${++chartIds}`,
    stack,
    log: Boolean(options.logScale) && !stack,
    hasPrevious: series.some((x) => x.previous?.length),
    notesAt,
    options,
  };
}

function tickValuesFor(c: ChartSetup): number[] {
  if (c.stack) return [0, 0.25, 0.5, 0.75, 1];
  const all = c.series.flatMap((x) => [...x.values, ...(x.previous ?? []), ...(x.trend ?? [])]);
  const dataMax = Math.max(0, ...all);
  return c.log ? logTicks(dataMax) : ticks(dataMax, c.options.yMax);
}

function plotAt(c: ChartSetup, W: number): Plot {
  const values = tickValuesFor(c);
  const max = values[values.length - 1]! || 1;
  const longest = Math.max(...values.map((t) => c.axisFmt(t).length));
  const pad = { top: 14, right: 16, bottom: 28, left: Math.max(32, longest * 7 + 14) };
  const innerW = Math.max(10, W - pad.left - pad.right);
  const innerH = c.H - pad.top - pad.bottom;
  const band = innerW / Math.max(1, c.n);
  const x = (i: number) =>
    c.type === 'bar'
      ? pad.left + band * (i + 0.5)
      : pad.left + (c.n <= 1 ? innerW / 2 : (i / (c.n - 1)) * innerW);
  const y = (v: number) => {
    const share = c.log
      ? Math.log10(Math.max(1, Math.min(v, max))) / Math.log10(max)
      : Math.min(v, max) / max;
    return pad.top + innerH - share * innerH;
  };
  return { ...c, W, pad, innerW, innerH, band, ticks: values, x, y };
}

function gradientDefs(p: Plot): SVGElement {
  const stop = (offset: string, color: string, opacity: number) =>
    s('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
  return s(
    'defs',
    {},
    p.series.map((_, si) => {
      const color = SERIES[si % SERIES.length]!;
      return s(
        'linearGradient',
        { id: `${p.id}-g${si}`, x1: 0, x2: 0, y1: 0, y2: 1 },
        stop('0%', color, si === 0 ? 0.22 : 0.12),
        stop('100%', color, 0),
      );
    }),
  );
}

function gridLines(p: Plot): SVGElement[] {
  return p.ticks.map((v, i) =>
    s(
      'g',
      {},
      s('line', {
        x1: p.pad.left,
        x2: p.W - p.pad.right,
        y1: p.y(v),
        y2: p.y(v),
        class: i === 0 ? 'grid baseline' : 'grid',
      }),
      s(
        'text',
        { x: p.pad.left - 10, y: p.y(v) + 4, class: 'axis', 'text-anchor': 'end' },
        p.axisFmt(v),
      ),
    ),
  );
}

/** Labels along the x axis, as many as fit, always including the last point of a line. */
function xAxisLabels(p: Plot): (SVGElement | null)[] {
  const every = Math.max(1, Math.ceil(p.n / Math.max(2, Math.floor(p.innerW / 72))));
  const anchor = (i: number) => {
    if (p.type === 'bar') return 'middle';
    if (i === 0) return 'start';
    return i === p.n - 1 ? 'end' : 'middle';
  };
  const shown = (i: number) =>
    i % every === 0 || (p.type !== 'bar' && i === p.n - 1 && (p.n - 1) % every > every / 2);
  return Array.from({ length: p.n }, (_, i) =>
    shown(i)
      ? s('text', { x: p.x(i), y: p.H - 8, class: 'axis', 'text-anchor': anchor(i) }, p.label(i))
      : null,
  );
}

/** What the marks functions draw into: shapes, and values written on them. */
interface Layers {
  marks: SVGElement[];
  labels: SVGElement[];
  /** Wide enough per point to write values. */
  roomy: boolean;
}

function valueText(L: Layers, cx: number, cy: number, text: string): void {
  L.labels.push(s('text', { x: cx, y: cy, class: 'value-label', 'text-anchor': 'middle' }, text));
}

const pathOf = (p: Plot, values: number[]) =>
  values.map((v, i) => `${i ? 'L' : 'M'}${p.x(i).toFixed(1)},${p.y(v).toFixed(1)}`).join(' ');

function stackedSeries(p: Plot, L: Layers, si: number): void {
  const { lower, upper, shares } = p.stack!;
  const color = SERIES[si % SERIES.length]!;
  if (p.type === 'bar') {
    const bw = Math.max(2, Math.min(40, p.band * 0.72));
    for (let i = 0; i < p.n; i++) {
      const top = p.y(upper[si]![i]!);
      const bottom = p.y(lower[si]![i]!);
      L.marks.push(
        s('rect', {
          x: p.x(i) - bw / 2,
          y: top,
          width: bw,
          height: Math.max(0, bottom - top),
          fill: color,
          class: 'bar',
        }),
      );
    }
  } else {
    const top = pathOf(p, upper[si]!);
    const bottom = lower[si]!.map((v, i) => `L${p.x(i).toFixed(1)},${p.y(v).toFixed(1)}`).reverse();
    L.marks.push(
      s('path', { d: `${top} ${bottom.join(' ')} Z`, fill: color, class: 'area stacked' }),
    );
    L.marks.push(s('path', { d: top, stroke: color, class: 'line' }));
  }
  if (!p.options.showValues || !L.roomy) return;
  for (let i = 0; i < p.n; i++) {
    const top = p.y(upper[si]![i]!);
    const bottom = p.y(lower[si]![i]!);
    if (bottom - top >= 16)
      valueText(L, p.x(i), (top + bottom) / 2 + 4, percent(shares[si]![i]!, 0));
  }
}

function barSeries(p: Plot, L: Layers, si: number): void {
  const line = p.series[si]!;
  const groups = p.series.length;
  const bw = Math.max(2, Math.min(32, (p.band * 0.72) / groups));
  const color = SERIES[si % SERIES.length]!;
  const labelled = p.options.showValues && L.roomy && p.n * groups <= 120;
  const rect = (bx: number, v: number, attrs: Record<string, string | number>) =>
    s('rect', {
      x: bx + 0.5,
      y: p.y(v),
      width: Math.max(1, bw - 1),
      height: Math.max(0, p.y(0) - p.y(v)),
      ...attrs,
    });
  line.values.forEach((v, i) => {
    const bx = p.x(i) - (bw * groups) / 2 + si * bw;
    if (line.previous)
      L.marks.push(rect(bx, line.previous[i] ?? 0, { class: 'bar-previous', stroke: color }));
    L.marks.push(rect(bx, v, { rx: Math.min(3, bw / 3), fill: color, class: 'bar' }));
    if (labelled) valueText(L, bx + bw / 2, p.y(v) - 5, (line.format ?? p.fmt)(v));
  });
  if (line.trend)
    L.marks.push(s('path', { d: pathOf(p, line.trend), stroke: color, class: 'line trend' }));
}

function lineSeries(p: Plot, L: Layers, si: number): void {
  const line = p.series[si]!;
  const color = SERIES[si % SERIES.length]!;
  if (line.previous?.length)
    L.marks.push(
      s('path', {
        d: pathOf(p, line.previous.slice(0, p.n)),
        stroke: color,
        class: 'line previous',
      }),
    );
  const d = pathOf(p, line.values);
  const fill = p.type === 'area' || (si === 0 && p.series.length === 1);
  if (fill && line.values.length > 1) {
    const close = `L${p.x(line.values.length - 1).toFixed(1)},${p.y(0)} L${p.x(0).toFixed(1)},${p.y(0)} Z`;
    L.marks.push(s('path', { d: `${d} ${close}`, fill: `url(#${p.id}-g${si})`, class: 'area' }));
  }
  L.marks.push(s('path', { d, stroke: color, class: 'line' }));
  if (line.trend?.length)
    L.marks.push(s('path', { d: pathOf(p, line.trend), stroke: color, class: 'line trend' }));
  if (p.n <= 1)
    L.marks.push(s('circle', { cx: p.x(0), cy: p.y(line.values[0] ?? 0), r: 4, fill: color }));
  if (p.options.showValues && L.roomy && p.n * p.series.length <= 120)
    line.values.forEach((v, i) => {
      valueText(L, p.x(i), p.y(v) - 8, (line.format ?? p.fmt)(v));
    });
}

function seriesLayers(p: Plot): Layers {
  const L: Layers = { marks: [], labels: [], roomy: p.innerW / Math.max(1, p.n) >= 30 };
  const draw = p.stack ? stackedSeries : p.type === 'bar' ? barSeries : lineSeries;
  p.series.forEach((_, si) => {
    draw(p, L, si);
  });
  return L;
}

function annotationMarks(p: Plot): SVGElement[] {
  return [...p.notesAt.entries()].map(([i, list]) =>
    s(
      'g',
      { class: 'annotation' },
      s('line', {
        x1: p.x(i),
        x2: p.x(i),
        y1: p.pad.top,
        y2: p.pad.top + p.innerH,
        class: 'annotation-line',
      }),
      s(
        'circle',
        { cx: p.x(i), cy: p.pad.top + p.innerH, r: 4.5, class: 'annotation-dot' },
        s('title', {}, list.map((a) => a.text).join('\n')),
      ),
    ),
  );
}

/** The point under the pointer's x. */
function hoverIndex(p: Plot, px: number): number {
  const raw =
    p.type === 'bar'
      ? Math.floor((px - p.pad.left) / p.band)
      : Math.round(((px - p.pad.left) / p.innerW) * (p.n - 1));
  return Math.max(0, Math.min(p.n - 1, raw));
}

function readoutRow(p: Plot, si: number, i: number): HTMLElement {
  const line = p.series[si]!;
  const value = (line.format ?? p.fmt)(line.values[i] ?? 0);
  return h(
    'span',
    { class: 'readout-row' },
    h('span', { class: 'swatch', style: `background:${SERIES[si % SERIES.length]}` }),
    h('span', { class: 'readout-label' }, line.label),
    h(
      'span',
      { class: 'readout-value' },
      p.stack ? `${percent(p.stack.shares[si]![i]!, 0)} · ${value}` : value,
    ),
    line.previous ? changeText(line.values[i] ?? 0, line.previous[i] ?? 0) : null,
  );
}

function readoutContent(p: Plot, i: number): Child[] {
  const previous = p.series
    .map((l) => (l.previous ? (l.format ?? p.fmt)(l.previous[i] ?? 0) : '–'))
    .join(' · ');
  return [
    h('strong', {}, p.label(i)),
    ...p.series.map((_, si) => readoutRow(p, si, i)),
    ...(p.notesAt.get(i) ?? []).map((a) =>
      h(
        'span',
        { class: 'readout-note' },
        h('span', { class: 'note-icon' }, icon('flag', 12)),
        a.text,
      ),
    ),
    p.hasPrevious ? h('span', { class: 'readout-prev muted' }, `Previous: ${previous}`) : null,
  ];
}

/** The hover cursor, dots on each line, and the readout that follows them. */
function hoverLayer(p: Plot, svg: SVGElement, readout: HTMLElement) {
  const cursor = s('line', {
    y1: p.pad.top,
    y2: p.pad.top + p.innerH,
    class: 'cursor',
    visibility: 'hidden',
  });
  const dots = p.series.map((_, si) =>
    s('circle', {
      r: 4,
      class: 'dot',
      fill: 'var(--surface)',
      stroke: SERIES[si % SERIES.length],
      visibility: 'hidden',
    }),
  );
  const dotY = (si: number, i: number) =>
    p.stack ? p.y(p.stack.upper[si]![i]!) : p.y(p.series[si]!.values[i] ?? 0);
  const show = (px: number) => {
    const i = hoverIndex(p, px);
    const cx = p.x(i);
    for (const k of ['x1', 'x2']) cursor.setAttribute(k, String(cx));
    cursor.setAttribute('visibility', 'visible');
    if (p.type !== 'bar')
      dots.forEach((dot, si) => {
        dot.setAttribute('cx', String(cx));
        dot.setAttribute('cy', String(dotY(si, i)));
        dot.setAttribute('visibility', 'visible');
      });
    readout.hidden = false;
    mount(readout, ...readoutContent(p, i));
    readout.style.left = `${cx}px`;
    readout.style.transform =
      cx > p.W * 0.62 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
    readout.hidden = true;
  };
  svg.addEventListener('mousemove', (event: Event) => {
    const rect = svg.getBoundingClientRect();
    show((((event as MouseEvent).clientX - rect.left) / rect.width) * p.W);
  });
  svg.addEventListener('mouseleave', hide);
  return { cursor, dots };
}

function chartSvg(p: Plot, readout: HTMLElement): SVGElement {
  const L = seriesLayers(p);
  const svg = s('svg', {
    viewBox: `0 0 ${p.W} ${p.H}`,
    width: p.W,
    height: p.H,
    class: 'chart',
    role: 'img',
    'aria-label': p.series.map((x) => x.label).join(', '),
  });
  const { cursor, dots } = hoverLayer(p, svg, readout);
  const hit = s('rect', {
    x: p.pad.left,
    y: p.pad.top,
    width: p.innerW,
    height: p.innerH,
    class: 'hit',
  });
  svg.append(
    gradientDefs(p),
    ...gridLines(p),
    ...xAxisLabels(p).filter((x) => x !== null),
    ...L.marks,
    ...L.labels,
    cursor,
    ...dots,
    hit,
    ...annotationMarks(p),
  );
  return svg;
}

function chartLegend(
  series: LineSeries[],
  hasPrevious: boolean,
  show: boolean,
): HTMLElement | null {
  if (!show || (series.length <= 1 && !hasPrevious)) return null;
  const items = series.map((line, i) =>
    h(
      'li',
      {},
      h('span', { class: 'swatch', style: `background:${SERIES[i % SERIES.length]}` }),
      line.label,
    ),
  );
  if (hasPrevious)
    items.push(
      h(
        'li',
        { class: 'legend-previous' },
        h('span', { class: 'swatch dashed' }),
        'Previous period',
      ),
    );
  return h('ul', { class: 'legend' }, items);
}

/** A multi-series time chart (line, area or bars) with a hover readout and optional previous-period overlay. */
export function lineChart(
  buckets: number[],
  series: LineSeries[],
  interval: string,
  options: ChartOptions = {},
): HTMLElement {
  const c = chartSetup(buckets, series, interval, options);
  const holder = h('div', { class: 'chart-canvas' });
  const readout = h('div', { class: 'readout', hidden: true });
  const legend = chartLegend(series, c.hasPrevious, options.legend ?? true);
  const wrap = h('div', { class: `chart-wrap chart-${c.type}` }, holder, readout, legend);
  const draw = (W: number) => holder.replaceChildren(chartSvg(plotAt(c, W), readout));
  responsive(wrap, draw);
  return wrap;
}

/** A tiny trend line with a soft fill, for KPI tiles and cards. */
export function sparkline(
  values: number[],
  options: { color?: string; height?: number; previous?: number[] } = {},
): SVGElement {
  const H = options.height ?? 36;
  const W = 120;
  const color = options.color ?? SERIES[0]!;
  const max = Math.max(1, ...values, ...(options.previous ?? []));
  const n = values.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => 2 + (H - 4) - (v / max) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const id = `s${++chartIds}`;
  return s(
    'svg',
    {
      class: 'sparkline',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    },
    s(
      'defs',
      {},
      s(
        'linearGradient',
        { id, x1: 0, x2: 0, y1: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.25 }),
        s('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }),
      ),
    ),
    options.previous?.length
      ? s('path', {
          d: options.previous
            .slice(0, n)
            .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            .join(' '),
          class: 'spark-previous',
          stroke: color,
        })
      : null,
    n > 1 ? s('path', { d: `${d} L${W},${H} L0,${H} Z`, fill: `url(#${id})` }) : null,
    s('path', { d, stroke: color, class: 'spark-line' }),
  );
}

export interface BarRow {
  label: string;
  value: number;
  secondary?: number;
  href?: string;
}

export interface BarListOptions {
  /** Content shown before the label (a flag or icon). */
  decorate?: (label: string) => Child;
  /** Display text for a label. */
  display?: (label: string) => string;
  /** Rows shown before "Show all". Default 8. */
  limit?: number;
  /** Format for values. Default: counts. */
  format?: (n: number) => string;
}

/** Horizontal bars behind each row, scaled to the largest value. */
export function barList(
  rows: BarRow[],
  headers: [string, string, string?],
  options: BarListOptions = {},
): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const limit = options.limit ?? 8;
  const fmtValue = options.format ?? count;
  const root = h('div', { class: 'bar-list' });
  const paint = (expanded: boolean) => {
    const shown = expanded ? rows : rows.slice(0, limit);
    mount(
      root,
      h(
        'div',
        { class: 'bar-head' },
        h('span', {}, headers[0]),
        h('span', { class: 'num' }, headers[1]),
        headers[2] ? h('span', { class: 'num' }, headers[2]) : null,
      ),
      ...shown.map((r) => {
        const text = options.display ? options.display(r.label) : r.label;
        const content = [
          options.decorate ? h('span', { class: 'bar-deco' }, options.decorate(r.label)) : null,
          h('span', { class: 'bar-text' }, text),
        ];
        const fill = h('span', {
          class: 'bar-fill',
          style: `width:${Math.max(1, (r.value / max) * 100)}%`,
        });
        return h(
          'div',
          {
            class: 'bar-row',
            title: `${text}: ${fmtValue(r.value)} (${percent(total ? r.value / total : 0, 0)})`,
          },
          r.href
            ? h('a', { class: 'bar-label', href: r.href }, fill, content)
            : h('span', { class: 'bar-label' }, fill, content),
          h('span', { class: 'num' }, fmtValue(r.value)),
          r.secondary !== undefined ? h('span', { class: 'num muted' }, count(r.secondary)) : null,
        );
      }),
      rows.length > limit
        ? h(
            'button',
            { type: 'button', class: 'link-button bar-more', onclick: () => paint(!expanded) },
            expanded ? 'Show fewer' : `Show all ${rows.length}`,
          )
        : null,
    );
  };
  paint(false);
  return root;
}

export interface FunnelStepView {
  label: string;
  /** People may skip this step. */
  optional?: boolean;
  /** The step's event, for linking to replays of people who dropped off. */
  event?: string;
  count: number;
  conversionFromStart: number;
  conversionFromPrevious: number;
  avgSecondsFromPrevious: number | null;
}

export interface FunnelBreakdownView {
  value: string;
  steps: FunnelStepView[];
}

export function kpiStat(
  label: string,
  value: string,
  hint?: Child,
  options: { color?: string; tag?: string } = {},
): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h(
      'div',
      { class: 'stat-label' },
      options.tag
        ? h(
            'span',
            { class: 'series-tag', style: options.color ? `--tag:${options.color}` : null },
            options.tag,
          )
        : null,
      label,
    ),
    h('div', { class: 'stat-value' }, value),
    hint ? h('div', { class: 'stat-hint' }, hint) : null,
  );
}

/**
 * Amplitude-style funnel: headline KPIs, vertical bars scaled to the first
 * step with the drop-off hatched, then a step table and breakdowns.
 */
/** Under a step: how many converted from the previous one, how many dropped, and their replays. */
function stepRates(step: FunnelStepView, prev: FunnelStepView | null): HTMLElement {
  if (!prev)
    return h(
      'div',
      { class: 'funnel-col-rates' },
      h('span', { class: 'muted' }, 'Entered the funnel'),
    );
  const dropped = Math.max(0, prev.count - step.count);
  const replays =
    dropped > 0 && prev.event && step.event
      ? h(
          'a',
          {
            class: 'funnel-replays',
            href: href('replays', { did: prev.event, not: step.event }),
            title: `Recorded sessions with ${prev.event} but no ${step.event}`,
          },
          icon('replay', 12),
          'Watch drop-offs',
        )
      : null;
  return h(
    'div',
    { class: 'funnel-col-rates' },
    h(
      'span',
      { class: 'funnel-bridge-convert' },
      `${percent(step.conversionFromPrevious, 1)} converted`,
    ),
    h('span', { class: 'funnel-bridge-drop' }, `${count(dropped)} dropped`),
    step.avgSecondsFromPrevious !== null
      ? h('span', { class: 'muted' }, `avg ${duration(step.avgSecondsFromPrevious)}`)
      : null,
    replays,
  );
}

function funnelColumn(
  steps: FunnelStepView[],
  i: number,
  base: number,
  noun: string,
  worst: boolean,
): HTMLElement {
  const step = steps[i]!;
  const prev = i > 0 ? steps[i - 1]! : null;
  const dropped = prev ? Math.max(0, prev.count - step.count) : 0;
  const share = step.count / base;
  return h(
    'div',
    { class: `funnel-col ${worst ? 'worst' : ''}` },
    h(
      'div',
      { class: 'funnel-col-head' },
      h('span', { class: 'funnel-step-index' }, String(i + 1)),
      h('span', { class: 'step-name', title: step.label }, step.label),
      step.optional ? h('span', { class: 'badge' }, 'optional') : null,
    ),
    h(
      'div',
      {
        class: 'funnel-col-track',
        title: `${count(step.count)} ${noun}${prev ? `, ${count(dropped)} dropped` : ''}`,
      },
      prev
        ? h('div', { class: 'funnel-col-drop', style: `height:${(dropped / base) * 100}%` })
        : null,
      h(
        'div',
        {
          class: `funnel-col-fill ${share > 0.82 ? 'tall' : ''}`,
          style: `height:${Math.max(step.count ? 1 : 0, share * 100)}%`,
        },
        h('span', { class: 'funnel-col-pct' }, percent(step.conversionFromStart, 1)),
      ),
    ),
    h(
      'div',
      { class: 'funnel-col-foot' },
      h(
        'div',
        { class: 'funnel-col-count' },
        count(step.count),
        h('span', { class: 'muted' }, ` ${noun}`),
      ),
      stepRates(step, prev),
    ),
  );
}

function breakdownRow(b: FunnelBreakdownView, bi: number): HTMLElement {
  const first = b.steps[0]?.count ?? 0;
  const conv = first ? (b.steps[b.steps.length - 1]?.count ?? 0) / first : 0;
  return h(
    'tr',
    {},
    h(
      'td',
      {},
      h('span', { class: 'swatch', style: `background:${SERIES[bi % SERIES.length]}` }),
      h('code', {}, b.value),
    ),
    ...b.steps.map((st) =>
      h(
        'td',
        { class: 'num' },
        h('div', { class: 'funnel-bd-count' }, count(st.count)),
        h('div', { class: 'muted small' }, percent(st.conversionFromStart, 0)),
      ),
    ),
    h(
      'td',
      { class: 'num' },
      h(
        'div',
        { class: 'funnel-bd-conv' },
        h(
          'span',
          { class: 'funnel-bd-conv-track' },
          h('span', { class: 'funnel-bd-conv-bar', style: `width:${conv * 100}%` }),
        ),
        h('span', {}, percent(conv, 1)),
      ),
    ),
  );
}

function funnelBreakdowns(steps: FunnelStepView[], breakdowns: FunnelBreakdownView[]): HTMLElement {
  return h(
    'div',
    { class: 'funnel-breakdowns' },
    h('h3', { class: 'funnel-breakdowns-title' }, 'Breakdown'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'funnel-breakdown-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Segment'),
            ...steps.map((st) => h('th', { class: 'num' }, st.label)),
            h('th', { class: 'num' }, 'Conversion'),
          ),
        ),
        h('tbody', {}, breakdowns.map(breakdownRow)),
      ),
    ),
  );
}

/** The step people are most often lost before (by conversion from the previous step). */
function worstStep(steps: FunnelStepView[]): { i: number; rate: number } | null {
  let worst: { i: number; rate: number } | null = null;
  steps.forEach((step, i) => {
    if (i > 0 && (!worst || step.conversionFromPrevious < worst.rate))
      worst = { i, rate: step.conversionFromPrevious };
  });
  return worst;
}

function funnelStats(
  steps: FunnelStepView[],
  noun: string,
  windowSeconds: number | undefined,
): HTMLElement {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const totalDrop = Math.max(0, first.count - last.count);
  const avgThrough = steps
    .slice(1)
    .reduce((sum, step) => sum + (step.avgSecondsFromPrevious ?? 0), 0);
  return h(
    'div',
    { class: 'stats' },
    kpiStat(
      'Conversion',
      percent(first.count ? last.count / first.count : 0, 1),
      `${count(last.count)} of ${count(first.count)} ${noun}`,
    ),
    kpiStat('Completed', count(last.count), last.label),
    kpiStat(
      'Drop-off',
      count(totalDrop),
      first.count ? `${percent(totalDrop / first.count, 1)} of starters` : undefined,
    ),
    avgThrough > 0
      ? kpiStat('Avg. time to convert', duration(avgThrough), 'first step → last step')
      : null,
    windowSeconds ? kpiStat('Conversion window', duration(windowSeconds)) : null,
  );
}

export function funnelChart(
  steps: FunnelStepView[],
  options: {
    windowSeconds?: number;
    breakdowns?: FunnelBreakdownView[];
    /** What was counted, plural: "people" (default), "sessions", "company groups"… */
    noun?: string;
  } = {},
): HTMLElement {
  const noun = options.noun ?? 'people';
  const base = Math.max(1, steps[0]!.count);
  const worst = worstStep(steps);
  return h(
    'div',
    { class: 'funnel funnel-view' },
    funnelStats(steps, noun, options.windowSeconds),
    h(
      'div',
      { class: 'funnel-columns', style: `--steps:${steps.length}` },
      steps.map((_, i) => funnelColumn(steps, i, base, noun, worst?.i === i)),
    ),
    worst && steps.length > 2
      ? h(
          'p',
          { class: 'funnel-callout' },
          'Biggest drop-off: into ',
          h('strong', {}, steps[worst.i]!.label),
          ` (${percent(1 - worst.rate, 1)} of the previous step lost).`,
        )
      : null,
    options.breakdowns?.length ? funnelBreakdowns(steps, options.breakdowns) : null,
  );
}

export interface CohortView {
  start: number;
  size: number;
  counts: number[];
  rates: number[];
}

const PERIOD_MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};

/** Whether period `k` of a cohort starting at `start` has fully happened yet. */
export function periodReached(start: number, k: number, period: string, now = Date.now()): boolean {
  const at =
    period === 'month' ? addMonths(start, k) : start + k * (PERIOD_MS[period] ?? PERIOD_MS.week!);
  return at <= now;
}

export function retentionGrid(
  cohorts: CohortView[],
  average: number[],
  period: string,
  now = Date.now(),
  /** Click a cohort's cell to see who it counts. */
  onCell?: (cohortStart: number, k: number) => void,
): HTMLElement {
  const periods = average.length;
  const reachedAny = (k: number) => cohorts.some((c) => periodReached(c.start, k, period, now));
  const cell = (rate: number, n: number | null, reached: boolean, open?: () => void) => {
    if (!reached) return h('td', { class: 'num heat na', title: 'Not reached yet' }, '');
    const heat = Math.round(Math.sqrt(Math.max(0, rate)) * 100);
    const text = percent(rate, rate < 0.1 && rate > 0 ? 1 : 0);
    return h(
      'td',
      {
        class: `num heat ${heat > 62 ? 'dark' : ''}`,
        style: `--heat:${heat}`,
        title: n === null ? undefined : `${count(n)} people${open ? ': click to see them' : ''}`,
      },
      open && n ? h('button', { type: 'button', class: 'cell-button', onclick: open }, text) : text,
    );
  };
  const rowLabel = (start: number) =>
    period === 'hour'
      ? `${bucketLabel(start, 'day')} ${bucketLabel(start, 'hour')}`
      : bucketLabel(start, period === 'month' ? 'month' : 'day');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'retention' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Cohort'),
          h('th', { class: 'num' }, 'People'),
          Array.from({ length: periods }, (_, k) =>
            h('th', { class: 'num' }, `${period[0]!.toUpperCase()}${k}`),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        h(
          'tr',
          { class: 'average' },
          h('td', {}, 'Average'),
          h('td', { class: 'num' }, count(cohorts.reduce((n, c) => n + c.size, 0))),
          average.map((r, k) => cell(r, null, reachedAny(k))),
        ),
        cohorts.map((c) =>
          h(
            'tr',
            {},
            h('td', {}, rowLabel(c.start)),
            h('td', { class: 'num' }, count(c.size)),
            c.rates.map((r, k) =>
              cell(
                r,
                c.counts[k] ?? 0,
                periodReached(c.start, k, period, now),
                onCell ? () => onCell(c.start, k) : undefined,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Average retention by period as a curve, stopping at the last period any cohort has reached. */
export function retentionCurve(
  cohorts: CohortView[],
  average: number[],
  period: string,
  now = Date.now(),
): HTMLElement | null {
  let reached = average.length;
  while (reached > 0 && !cohorts.some((c) => periodReached(c.start, reached - 1, period, now)))
    reached--;
  if (reached < 2) return null;
  const values = average.slice(0, reached);
  return lineChart(
    values.map((_, i) => i),
    [{ label: 'Retained', values }],
    period,
    {
      height: 200,
      labels: values.map((_, k) => `${period[0]!.toUpperCase()}${k}`),
      format: (v) => percent(v, 0),
      yMax: 1,
      type: 'area',
    },
  );
}
