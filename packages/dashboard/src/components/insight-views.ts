/**
 * How insight results are shown: trends (time charts, numbers, tables, pies, maps), funnel
 * steps with the people behind each, and retention grids.
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult, TrendsSeries } from '@dataflare/core/insights/trends';
import { type Child, h, mount } from '../dom.ts';
import { bucketLabel, count, percent } from '../format.ts';
import {
  type Annotation,
  barList,
  type ChartType,
  funnelChart,
  kpiStat,
  lineChart,
  periodReached,
  retentionCurve,
  retentionGrid,
  SERIES,
  sparkline,
} from './charts.ts';
import { pieChart, seriesTable, worldMap } from './display.ts';
import { icon } from './icons.ts';
import { correlationView, funnelVizView, showActors } from './insight-options.ts';
import { letter, readBreakdowns, type Spec } from './insight-rail.ts';
import { funnelPathsMenu } from './paths-view.ts';
import { empty, table, tabs } from './ui.ts';

export const TIME_DISPLAYS = new Set(['line', 'area', 'bar']);

/** What a spec counts, in the plural: people, sessions or groups of a type. */
export function countedNoun(aggregateBy: unknown): string {
  if (!aggregateBy || aggregateBy === 'person') return 'people';
  if (aggregateBy === 'session') return 'sessions';
  return `${String(aggregateBy)} groups`;
}

// ── Trends ──────────────────────────────────────────────────────────────────

export interface TrendsDisplay {
  /** line, area, bar, number, bar_value, table, pie or world_map. */
  display: string;
  spec: Spec;
  annotations: (Annotation & { id?: string })[];
  onPeople?: (series: number, label: string) => void;
  onAnnotate?: () => void;
  onDeleteNote?: (id: string) => void;
  onMapBreakdown: () => void;
}

/** A result line with how to tag, colour and print it. */
interface Line extends TrendsSeries {
  tag: string;
  color: string;
  fmt: (n: number) => string;
  /** Spec series index, or null for a formula. */
  series: number | null;
  key: string;
}

const pct = (n: number) => percent(n, 1);

function toLines(r: TrendsResult, formulaOnly: boolean): Line[] {
  const formulas = r.formulas ?? [];
  const series = formulaOnly && formulas.length ? [] : r.series;
  const lines = [
    ...series.map((s) => ({
      ...s,
      tag: letter(s.seriesIndex),
      fmt: count,
      series: s.seriesIndex,
      key: `s${s.seriesIndex}:${s.breakdown}`,
    })),
    ...formulas.map((f) => ({
      ...f,
      tag: `ƒ${f.seriesIndex + 1}`,
      fmt: f.format === 'percent' ? pct : count,
      series: null,
      key: `f${f.seriesIndex}:${f.breakdown}`,
    })),
  ];
  return lines.map((l, i) => ({ ...l, color: SERIES[i % SERIES.length]! }));
}

/** The same lines over the previous period, matched by series and breakdown value. */
function priorOf(previous: TrendsResult | null, formulaOnly: boolean): Map<string, Line> {
  return new Map(previous ? toLines(previous, formulaOnly).map((l) => [l.key, l]) : []);
}

function delta(now: number, prior: number | undefined): Child {
  if (!prior) return null;
  const c = (now - prior) / prior;
  const cls = Math.abs(c) < 0.005 ? '' : c > 0 ? 'good' : 'bad';
  return h(
    'span',
    { class: `delta ${cls}` },
    c > 0 ? icon('arrowUp', 12) : icon('arrowDown', 12),
    `${Math.abs(c * 100).toFixed(0)}% vs previous`,
  );
}

function kpiRow(
  lines: Line[],
  prior: Map<string, Line>,
  r: TrendsResult,
  large: boolean,
): HTMLElement {
  return h(
    'div',
    { class: `stats ${large ? 'stats-large' : ''}` },
    lines.map((l) =>
      kpiStat(
        l.label,
        l.fmt(l.total),
        delta(l.total, prior.get(l.key)?.total) ?? `by ${r.interval}`,
        {
          tag: l.tag,
          color: l.color,
        },
      ),
    ),
  );
}

function mapBody(r: TrendsResult, o: TrendsDisplay): Child {
  if (readBreakdowns(o.spec).join() !== 'country')
    return empty(
      'The map shades each country by its total, so it needs one line per country.',
      h(
        'button',
        { type: 'button', class: 'primary', onclick: o.onMapBreakdown },
        icon('globe', 15),
        'Break down by country',
      ),
      { icon: 'globe', title: 'Break down by country' },
    );
  return worldMap(
    r.series
      .filter((x) => x.seriesIndex === 0 && x.breakdown)
      .map((x) => ({ code: x.breakdown!, value: x.total })),
  );
}

function noteChip(a: Annotation & { id?: string }, o: TrendsDisplay): HTMLElement {
  return h(
    'span',
    { class: 'note-chip' },
    h('span', { class: 'note-icon' }, icon('flag', 12)),
    h('span', { class: 'muted' }, bucketLabel(a.at, 'day')),
    a.text,
    a.id && o.onDeleteNote
      ? h(
          'button',
          {
            type: 'button',
            class: 'icon-button note-remove',
            'aria-label': `Delete note "${a.text}"`,
            onclick: () => o.onDeleteNote?.(a.id!),
          },
          icon('x', 12),
        )
      : null,
  );
}

function timeChart(
  lines: Line[],
  prior: Map<string, Line>,
  r: TrendsResult,
  o: TrendsDisplay,
): Child {
  const allPercent = lines.length > 0 && lines.every((l) => l.fmt === pct);
  return [
    lineChart(
      r.buckets,
      lines.map((l) => ({
        label: l.label,
        values: l.values,
        previous: prior.get(l.key)?.values,
        trend: l.trendLine,
        format: l.fmt,
      })),
      r.interval,
      {
        height: 320,
        type: o.display as ChartType,
        logScale: Boolean(o.spec.logScale),
        percentStack: Boolean(o.spec.percentStack),
        showValues: Boolean(o.spec.showValues),
        annotations: o.annotations,
        ...(allPercent ? { format: pct } : {}),
      },
    ),
    o.onAnnotate
      ? h(
          'div',
          { class: 'chart-notes' },
          o.annotations.map((a) => noteChip(a, o)),
          h(
            'button',
            { type: 'button', class: 'link-button add-button', onclick: o.onAnnotate },
            icon('plus', 13),
            'Add a note',
          ),
        )
      : null,
  ];
}

const BODIES: Record<
  string,
  (lines: Line[], prior: Map<string, Line>, r: TrendsResult, o: TrendsDisplay) => Child
> = {
  table: (lines, _p, r) => seriesTable(r.buckets, lines, r.interval),
  pie: (lines) => pieChart(lines.map((l) => ({ label: l.label, value: l.total }))),
  bar_value: (lines) =>
    barList(
      lines.map((l) => ({ label: l.label, value: l.total })),
      ['Series', 'Total'],
      { limit: 25 },
    ),
  world_map: (_lines, _p, r, o) => mapBody(r, o),
};

function seriesRow(l: Line, prior: Line | undefined, o: TrendsDisplay): Child[] {
  const change = prior?.total ? (l.total - prior.total) / prior.total : null;
  return [
    h(
      'span',
      { class: 'series-cell' },
      h('span', { class: 'series-tag', style: `--tag:${l.color}` }, l.tag),
      l.label,
    ),
    sparkline(l.values, { color: l.color, height: 22 }),
    l.fmt(l.total),
    prior ? l.fmt(prior.total) : '–',
    change === null
      ? '–'
      : h(
          'span',
          { class: `delta ${change >= 0 ? 'good' : 'bad'}` },
          `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(0)}%`,
        ),
    o.onPeople && l.series !== null
      ? h(
          'button',
          { type: 'button', class: 'link-button', onclick: () => o.onPeople?.(l.series!, l.label) },
          'People',
        )
      : '',
  ];
}

export function trendsView(
  r: TrendsResult,
  previous: TrendsResult | null,
  o: TrendsDisplay,
): HTMLElement {
  const formulaOnly = Boolean(o.spec.formulaOnly);
  const lines = toLines(r, formulaOnly);
  const prior = priorOf(previous, formulaOnly);
  const stats = kpiRow(lines, prior, r, o.display === 'number');
  if (o.display === 'number') return h('div', { class: 'insight-result' }, stats);
  const time = TIME_DISPLAYS.has(o.display);
  const body = (BODIES[o.display] ?? timeChart)(lines, prior, r, o);
  const showTable = time && (lines.length > 1 || previous || o.onPeople);
  return h(
    'div',
    { class: 'insight-result' },
    time ? stats : null,
    body,
    showTable
      ? table(
          ['Series', 'Trend', 'Total', 'Previous', 'Change', ''],
          lines.map((l) => seriesRow(l, prior.get(l.key), o)),
          { numeric: [2, 3, 4], class: 'series-table' },
        )
      : null,
  );
}

// ── Funnels ─────────────────────────────────────────────────────────────────

function peopleChips(funnel: FunnelResult, shared: Spec): HTMLElement {
  const chip = (label: string, selection: Record<string, unknown>, title: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        onclick: () => showActors('funnel', shared, selection, title),
      },
      label,
    );
  return h(
    'div',
    { class: 'row people-row' },
    h('span', { class: 'muted small' }, 'Who:'),
    funnel.steps.map((st, i) => [
      chip(`reached ${i + 1}`, { step: i + 1, status: 'converted' }, `Reached step ${i + 1}`),
      i > 0 && st.count < (funnel.steps[i - 1]?.count ?? 0)
        ? chip(
            `dropped before ${i + 1}`,
            { step: i + 1, status: 'dropped' },
            `Dropped before step ${i + 1}`,
          )
        : null,
    ]),
  );
}

export function funnelView(funnel: FunnelResult, spec: Spec, shared: Spec): HTMLElement {
  if (!funnel.steps[0]?.count)
    return empty('No one did the first step in this period.', undefined, { icon: 'funnel' });
  const viz = funnelVizView(funnel);
  if (viz) return viz;
  return h(
    'div',
    {},
    funnelChart(funnel.steps, {
      windowSeconds: funnel.windowSeconds,
      breakdowns: funnel.breakdowns,
      noun: countedNoun(spec.aggregateBy),
    }),
    peopleChips(funnel, shared),
    spec.order === 'unordered' ? null : funnelPathsMenu(funnel.steps.length, shared),
    funnel.breakdowns?.length ? null : correlationView(shared),
  );
}

// ── Retention ───────────────────────────────────────────────────────────────

const PERIOD_ADJECTIVE: Record<string, string> = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

type RetentionTable = Pick<RetentionResult, 'cohorts' | 'average'>;

/** The latest period any cohort has reached. */
function lastReached(t: RetentionTable, period: RetentionResult['period'], now: number): number {
  let last = t.average.length - 1;
  while (last > 0 && !t.cohorts.some((c) => periodReached(c.start, last, period, now))) last--;
  return last;
}

function retentionStats(
  t: RetentionTable,
  r: RetentionResult,
  noun: string,
  now: number,
): HTMLElement {
  const p = r.period[0]!.toUpperCase();
  const last = lastReached(t, r.period, now);
  return h(
    'div',
    { class: 'stats' },
    kpiStat(
      `Retained at ${p}1`,
      t.average.length > 1 && last >= 1 ? percent(t.average[1] ?? 0, 1) : '–',
      `of ${noun} come back the next ${r.period}`,
    ),
    last > 1
      ? kpiStat(
          `Retained at ${p}${last}`,
          percent(t.average[last] ?? 0, 1),
          `latest ${r.period} any cohort has reached`,
        )
      : null,
    kpiStat(
      `${noun[0]!.toUpperCase()}${noun.slice(1)} in cohorts`,
      count(t.cohorts.reduce((n, c) => n + c.size, 0)),
      `${t.cohorts.length} ${PERIOD_ADJECTIVE[r.period] ?? r.period} cohorts`,
    ),
  );
}

export function retentionView(
  r: RetentionResult,
  noun = 'people',
  onCell?: (cohortStart: number, k: number, breakdown?: string) => void,
): HTMLElement {
  if (!r.cohorts.length)
    return empty('No one in any cohort for this period.', undefined, { icon: 'retention' });
  const now = Date.now();
  const tables = r.breakdowns ?? [];
  const root = h('div', { class: 'insight-result' });
  let selected: string | null = null;
  const choose = (v: string) => {
    selected = v || null;
    paint();
  };
  const paint = () => {
    const t: RetentionTable =
      (selected === null ? null : tables.find((b) => b.value === selected)) ?? r;
    const cell = onCell
      ? (start: number, k: number) => onCell(start, k, selected ?? undefined)
      : undefined;
    mount(
      root,
      tables.length
        ? tabs(
            [
              { value: '', label: 'All' },
              ...tables.slice(0, 12).map((b) => ({ value: b.value, label: b.value || '(none)' })),
            ],
            selected ?? '',
            choose,
            'tabs-small retention-breakdowns',
          )
        : null,
      retentionStats(t, r, noun, now),
      t.cohorts.length
        ? [
            retentionCurve(t.cohorts, t.average, r.period, now),
            retentionGrid(t.cohorts, t.average, r.period, now, cell),
          ]
        : empty('No one in this group’s cohorts.', undefined, { icon: 'retention' }),
    );
  };
  paint();
  return root;
}
