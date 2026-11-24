/**
 * Other ways to show a trend: a table of every value, a pie of totals, and a
 * world map of a country breakdown. (Time charts and bar lists live in
 * charts.ts.)
 */

import { type Child, h, mount, s } from '../dom.ts';
import { bucketLabel, count, countryFlag, countryName, percent } from '../format.ts';
import { barList, SERIES } from './charts.ts';
import { table } from './ui.ts';
import { WORLD_HEIGHT, WORLD_PATHS, WORLD_WIDTH } from './world-paths.ts';

export interface DisplayLine {
  label: string;
  values: number[];
  total: number;
}

/** Every bucket as a row and every line as a column, with totals at the bottom. */
export function seriesTable(
  buckets: number[],
  lines: DisplayLine[],
  interval: string,
  fmt: (n: number) => string = count,
): HTMLElement {
  const rows = buckets.map((b, i) => [
    h('span', { class: 'nowrap muted' }, bucketLabel(b, interval)),
    ...lines.map((l) => fmt(l.values[i] ?? 0)),
  ]);
  rows.push([h('strong', {}, 'Total'), ...lines.map((l) => h('strong', {}, fmt(l.total)))]);
  return h(
    'div',
    { class: 'series-values' },
    table(['', ...lines.map((l) => l.label)], rows, {
      numeric: lines.map((_, i) => i + 1),
      class: 'values-table',
    }),
  );
}

const sliceColor = (i: number) =>
  i < SERIES.length
    ? SERIES[i]!
    : `color-mix(in srgb, ${SERIES[i % SERIES.length]} 55%, var(--surface))`;

/** A donut of totals, the largest slices first, with the rest as "Other". */
export function pieChart(
  items: { label: string; value: number; color?: string }[],
  fmt: (n: number) => string = count,
  maxSlices = 9,
  showZeros = false,
): HTMLElement {
  const sorted = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const shown =
    sorted.length > maxSlices
      ? [
          ...sorted.slice(0, maxSlices - 1),
          {
            label: 'Other',
            color: undefined,
            value: sorted.slice(maxSlices - 1).reduce((n, x) => n + x.value, 0),
          },
        ]
      : sorted;
  const legend = showZeros ? [...shown, ...items.filter((x) => x.value === 0)] : shown;
  const total = shown.reduce((n, x) => n + x.value, 0);
  if (!total) return h('p', { class: 'muted' }, 'Nothing to share out: every total is zero.');
  const R = 90;
  const r = 56;
  let angle = -Math.PI / 2;
  const arcs = shown.map((x, i) => {
    const sweep = (x.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const pt = (rad: number, a: number) =>
      `${(rad * Math.cos(a)).toFixed(2)},${(rad * Math.sin(a)).toFixed(2)}`;
    const large = sweep > Math.PI ? 1 : 0;
    // A full circle can't be one arc: draw two halves.
    const d =
      shown.length === 1
        ? `M${pt(R, 0)} A${R},${R} 0 1 1 ${pt(R, Math.PI)} A${R},${R} 0 1 1 ${pt(R, 0)} M${pt(r, 0)} A${r},${r} 0 1 0 ${pt(r, Math.PI)} A${r},${r} 0 1 0 ${pt(r, 0)} Z`
        : `M${pt(R, a0)} A${R},${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${large} 0 ${pt(r, a0)} Z`;
    return s(
      'path',
      { d, fill: x.color ?? sliceColor(i), class: 'pie-slice', 'fill-rule': 'evenodd' },
      s('title', {}, `${x.label}: ${fmt(x.value)} (${percent(x.value / total, 1)})`),
    );
  });
  return h(
    'div',
    { class: 'pie' },
    s(
      'svg',
      {
        viewBox: `${-R - 4} ${-R - 4} ${2 * R + 8} ${2 * R + 8}`,
        class: 'pie-chart',
        role: 'img',
        'aria-label': shown.map((x) => `${x.label} ${percent(x.value / total, 0)}`).join(', '),
      },
      ...arcs,
      s('text', { x: 0, y: -2, class: 'pie-total', 'text-anchor': 'middle' }, fmt(total)),
      s('text', { x: 0, y: 16, class: 'pie-caption', 'text-anchor': 'middle' }, 'total'),
    ),
    h(
      'ul',
      { class: 'pie-legend' },
      legend.map((x, i) =>
        h(
          'li',
          {},
          h('span', { class: 'swatch', style: `background:${x.color ?? sliceColor(i)}` }),
          h('span', { class: 'pie-label' }, x.label),
          h('span', { class: 'num' }, fmt(x.value)),
          h('span', { class: 'num muted' }, percent(x.value / total, 1)),
        ),
      ),
    ),
  );
}

/** Country codes that are not a place on the map: no country, the overflow line, Tor and unknown. */
const NOT_A_COUNTRY = new Set(['(NONE)', 'OTHER', 'XX', 'T1', '']);

/** Sum values by upper-case ISO alpha-2 code (UK is GB); anything that isn't a country is kept apart. */
function countryValues(rows: { code: string; value: number }[]): {
  values: Map<string, number>;
  unknown: number;
} {
  const values = new Map<string, number>();
  let unknown = 0;
  for (const r of rows) {
    const raw = r.code.trim().toUpperCase();
    const code = raw === 'UK' ? 'GB' : raw;
    if (NOT_A_COUNTRY.has(code) || !/^[A-Z]{2}$/.test(code)) unknown += r.value;
    else values.set(code, (values.get(code) ?? 0) + r.value);
  }
  return { values, unknown };
}

/** The fill for a country's value, on a square-root scale so mid-sized countries still show. */
const shadeFor = (max: number) => (v: number) =>
  `color-mix(in srgb, var(--accent) ${Math.round(12 + 78 * Math.sqrt(v / (max || 1)))}%, var(--surface-2))`;

/** The floating label that follows the pointer over the map. */
function mapReadout(svg: SVGElement): HTMLElement {
  const readout = h('div', { class: 'readout map-readout', hidden: true });
  svg.addEventListener('mousemove', (event: Event) => {
    const e = event as MouseEvent;
    const box = svg.getBoundingClientRect();
    const x = e.clientX - box.left;
    readout.style.left = `${x}px`;
    readout.style.top = `${Math.max(0, e.clientY - box.top - 10)}px`;
    readout.style.transform =
      x > box.width * 0.62 ? 'translate(calc(-100% - 14px), -100%)' : 'translate(14px, -100%)';
  });
  return readout;
}

function showCountry(
  readout: HTMLElement,
  code: string,
  v: number | undefined,
  total: number,
  fmt: (n: number) => string,
): void {
  readout.hidden = false;
  mount(
    readout,
    h('strong', {}, `${countryFlag(code)} ${countryName(code)}`),
    h(
      'span',
      { class: 'readout-row' },
      h('span', { class: 'readout-label' }, v ? percent(v / (total || 1), 1) : 'No data'),
      h('span', { class: 'readout-value' }, v ? fmt(v) : '–'),
    ),
  );
}

/**
 * One country's outline. The shade goes in a custom property, not the `fill`
 * attribute: the stylesheet's `.country` fill would win over an attribute.
 */
function countryPath(
  code: string,
  d: string,
  v: number | undefined,
  shade: (v: number) => string,
  hover: (code: string, v: number | undefined) => void,
  leave: () => void,
): SVGElement {
  const path = s('path', {
    d,
    class: v ? 'country has-value' : 'country',
    style: v ? `--country-fill:${shade(v)}` : null,
  });
  if (!code.startsWith('_')) path.addEventListener('mouseenter', () => hover(code, v));
  path.addEventListener('mouseleave', leave);
  return path;
}

/**
 * A choropleth of values by country (ISO alpha-2 codes), shaded on a square-root
 * scale so mid-sized countries still show, with the exact numbers listed below.
 */
export function worldMap(
  rows: { code: string; value: number }[],
  fmt: (n: number) => string = count,
): HTMLElement {
  const { values, unknown } = countryValues(rows);
  const max = Math.max(0, ...values.values());
  const total = [...values.values()].reduce((n, v) => n + v, 0) + unknown;
  const shade = shadeFor(max);
  const svg = s('svg', {
    viewBox: `0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`,
    class: 'world-map',
    role: 'img',
    'aria-label': `Map of ${values.size} countries`,
  });
  const readout = mapReadout(svg);
  const hover = (code: string, v: number | undefined) => showCountry(readout, code, v, total, fmt);
  const leave = () => {
    readout.hidden = true;
  };
  for (const [code, d] of Object.entries(WORLD_PATHS))
    svg.append(countryPath(code, d, values.get(code), shade, hover, leave));
  const unmapped = [...values.keys()].filter((c) => !WORLD_PATHS[c]);
  return h(
    'div',
    { class: 'world' },
    h('div', { class: 'world-canvas' }, svg, readout),
    h(
      'div',
      { class: 'world-scale', 'aria-hidden': 'true' },
      h('span', { class: 'muted small' }, fmt(0)),
      h('span', { class: 'world-ramp' }),
      h('span', { class: 'muted small' }, fmt(max)),
    ),
    barList(
      [...values.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, value]) => ({ label: code, value })),
      ['Country', 'Value'],
      {
        decorate: (c) => countryFlag(c),
        display: (c) => countryName(c),
        format: fmt,
      },
    ),
    mapFootnote(unmapped, unknown, fmt),
  );
}

/** What the map can't show: countries too small to draw, and values with no country. */
function mapFootnote(unmapped: string[], unknown: number, fmt: (n: number) => string): Child {
  const notes: string[] = [];
  if (unmapped.length)
    notes.push(
      `Too small for the map, listed above: ${unmapped.map((c) => countryName(c)).join(', ')}.`,
    );
  if (unknown > 0) notes.push(`Unknown or other countries: ${fmt(unknown)}.`);
  return notes.length ? h('p', { class: 'muted small' }, notes.join(' ')) : null;
}
