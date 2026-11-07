/**
 * Web analytics overview: the Plausible-style dashboard in four queries.
 *
 * 1. totals for the range (visitors, pageviews, sessions, bounces, duration)
 * 2. totals for the previous period of the same length (for change %)
 * 3. a visitors/pageviews time series
 * 4. every breakdown table (chunked UNION ALLs — D1 caps compound SELECTs at 7)
 * 5. web vitals samples (p75 computed here, since SQLite has no percentile function)
 *
 * Visitors are distinct `distinct_id`s (devices), as in other web analytics tools;
 * product analytics (trends/funnels/retention) count persons instead.
 */

/** D1's SQLITE_MAX_COMPOUND_SELECT is 7; stay under it with headroom. */
const MAX_UNION = 5;

import { SYSTEM_EVENTS } from '../events.ts';
import type { Dialect } from '../sql/dialect.ts';
import { bucketExpr, eventsCte, num, text } from '../sql/source.ts';
import {
  bucketsBetween,
  DAY_MS,
  type Interval,
  iso,
  resolveRange,
  type TimeRange,
} from '../time.ts';
import type { WebSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase } from './types.ts';

export interface WebTotals {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounceRate: number;
  avgSessionSeconds: number;
  viewsPerSession: number;
}

export interface BreakdownRow {
  value: string;
  visitors: number;
  /** Pageviews, or occurrences for the errors table. */
  count: number;
}

export const WEB_BREAKDOWNS = {
  pages: 'Top pages',
  entry_pages: 'Entry pages',
  exit_pages: 'Exit pages',
  referrers: 'Referrers',
  utm_source: 'UTM sources',
  utm_medium: 'UTM mediums',
  utm_campaign: 'UTM campaigns',
  countries: 'Countries',
  devices: 'Devices',
  browsers: 'Browsers',
  os: 'Operating systems',
  errors: 'Errors',
} as const;

export type WebBreakdown = keyof typeof WEB_BREAKDOWNS;

export interface WebResult extends ResultBase {
  kind: 'web';
  interval: Interval;
  totals: WebTotals;
  previous: WebTotals | null;
  timeseries: { buckets: number[]; visitors: number[]; pageviews: number[] };
  breakdowns: Record<WebBreakdown, BreakdownRow[]>;
  /** p75 per web vital (LCP, INP and TTFB in ms; CLS unitless), from `$web_vitals` events. */
  vitals: Record<string, { p75: number; samples: number }>;
}

const PV = SYSTEM_EVENTS.pageview;

function totalsSql(
  d: Dialect,
  ctx: QueryContext,
  range: TimeRange,
  filters: WebSpec['filters'],
): string {
  return `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [PV, SYSTEM_EVENTS.pageleave], filters })},
pv AS (SELECT distinct_id FROM ev WHERE event = ${d.str(PV)}),
s AS (
  SELECT session_id, MIN(ts_ms) AS start_ms, MAX(ts_ms) AS end_ms,
    SUM(CASE WHEN event = ${d.str(PV)} THEN 1 ELSE 0 END) AS pvs
  FROM ev GROUP BY session_id
)
SELECT
  (SELECT COUNT(DISTINCT distinct_id) FROM pv) AS visitors,
  (SELECT COUNT(*) FROM pv) AS pageviews,
  (SELECT COUNT(*) FROM s WHERE pvs > 0) AS sessions,
  (SELECT COUNT(*) FROM s WHERE pvs = 1) AS bounces,
  (SELECT SUM(end_ms - start_ms) FROM s WHERE pvs > 0) AS duration_ms`;
}

function shapeTotals(row: Record<string, unknown> | undefined): WebTotals {
  const sessions = num(row?.sessions);
  const pageviews = num(row?.pageviews);
  return {
    visitors: num(row?.visitors),
    pageviews,
    sessions,
    bounceRate: sessions ? num(row?.bounces) / sessions : 0,
    avgSessionSeconds: sessions ? num(row?.duration_ms) / sessions / 1000 : 0,
    viewsPerSession: sessions ? pageviews / sessions : 0,
  };
}

function breakdownsSql(
  d: Dialect,
  ctx: QueryContext,
  range: TimeRange,
  filters: WebSpec['filters'],
): string[] {
  const cte = eventsCte(d, {
    project: ctx.project,
    ...range,
    events: [PV, SYSTEM_EVENTS.exception],
    filters,
  });
  const none = (expr: string) => `COALESCE(NULLIF(${expr}, ''), '(none)')`;
  // Visitors are counted in two steps (one row per value and visitor, then rows per value)
  // rather than COUNT(DISTINCT): exact on both engines, and Basin SQL rejects this many
  // COUNT(DISTINCT … GROUP BY) in one query at tens of millions of events.
  const simple = (name: string, expr: string, event: string = PV) =>
    `SELECT * FROM (
  SELECT ${d.str(name)} AS dim, val, COUNT(*) AS visitors, SUM(c) AS n
  FROM (
    SELECT val, distinct_id, COUNT(*) AS c
    FROM (SELECT ${expr} AS val, distinct_id FROM ev WHERE event = ${d.str(event)}) t
    GROUP BY val, distinct_id
  ) u
  GROUP BY val ORDER BY visitors DESC, n DESC, val ASC LIMIT 10
) ${name}_t`;
  // Per-session value taken from the first (entry) or last (exit) pageview. Sources are
  // attributed this way too: a visit from a campaign counts once for that campaign, not
  // once per internal page viewed afterwards. `n` counts sessions.
  const edge = (name: string, agg: 'MIN' | 'MAX', expr: string) =>
    `SELECT * FROM (
  SELECT ${d.str(name)} AS dim, val, COUNT(*) AS visitors, SUM(c) AS n
  FROM (
    SELECT val, distinct_id, COUNT(*) AS c
    FROM (
      SELECT ev.session_id, MIN(${expr}) AS val, MIN(ev.distinct_id) AS distinct_id
      FROM (SELECT session_id, ${agg}(ts_ms) AS t FROM ev WHERE event = ${d.str(PV)} GROUP BY session_id) x
      JOIN ev ON ev.session_id = x.session_id AND ev.ts_ms = x.t AND ev.event = ${d.str(PV)}
      GROUP BY ev.session_id
    ) t
    GROUP BY val, distinct_id
  ) u
  GROUP BY val ORDER BY visitors DESC, n DESC, val ASC LIMIT 10
) ${name}_t`;
  const parts = [
    simple('pages', none('path')),
    edge('entry_pages', 'MIN', none('ev.path')),
    edge('exit_pages', 'MAX', none('ev.path')),
    edge('referrers', 'MIN', `COALESCE(NULLIF(ev.referrer_host, ''), 'Direct / None')`),
    edge('utm_source', 'MIN', none('ev.utm_source')),
    edge('utm_medium', 'MIN', none('ev.utm_medium')),
    edge('utm_campaign', 'MIN', none('ev.utm_campaign')),
    simple('countries', none('country')),
    simple('devices', none('device')),
    simple('browsers', none('browser')),
    simple('os', none('os')),
    simple('errors', none(d.jsonText('props', ['message'])), SYSTEM_EVENTS.exception),
  ];
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += MAX_UNION) {
    chunks.push(`WITH ${cte}\n${parts.slice(i, i + MAX_UNION).join('\nUNION ALL\n')}`);
  }
  return chunks;
}

function vitalsSql(
  d: Dialect,
  ctx: QueryContext,
  range: TimeRange,
  filters: WebSpec['filters'],
): string {
  return `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [SYSTEM_EVENTS.webVitals], filters })}
SELECT ${d.jsonText('props', ['metric'])} AS metric, ${d.jsonNumber('props', ['value'])} AS val
FROM ev
ORDER BY ts_ms DESC
LIMIT 5000`;
}

export function defaultInterval(range: TimeRange): Interval {
  const days = (range.to - range.from) / DAY_MS;
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export async function runWeb(spec: WebSpec, ctx: QueryContext): Promise<WebResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const interval = spec.interval ?? defaultInterval(range);
  const previous = { from: range.from - (range.to - range.from), to: range.from };
  const compare = spec.compare ?? true;

  const seriesSql = `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [PV], filters: spec.filters })}
SELECT bucket, COUNT(DISTINCT distinct_id) AS visitors, COUNT(*) AS pageviews
FROM (SELECT ${bucketExpr(d, 'ts_ms', interval, spec.utcOffsetMinutes)} AS bucket, distinct_id FROM ev) t
GROUP BY bucket ORDER BY bucket LIMIT 5000`;

  const breakdownQueries = breakdownsSql(d, ctx, range, spec.filters);
  const queries = {
    totals: totalsSql(d, ctx, range, spec.filters),
    previous: compare ? totalsSql(d, ctx, previous, spec.filters) : null,
    series: seriesSql,
    breakdowns: breakdownQueries,
    vitals: vitalsSql(d, ctx, range, spec.filters),
  };
  const [totalsRows, previousRows, seriesRows, breakdownChunks, vitalRows] = await Promise.all([
    ctx.execute(queries.totals),
    queries.previous ? ctx.execute(queries.previous) : Promise.resolve(null),
    ctx.execute(queries.series),
    Promise.all(breakdownQueries.map((q) => ctx.execute(q))),
    ctx.execute(queries.vitals),
  ]);
  const breakdownRows = breakdownChunks.flat();

  const buckets = bucketsBetween(range, interval, spec.utcOffsetMinutes);
  const slot = new Map(buckets.map((b, i) => [b, i]));
  const visitors = new Array<number>(buckets.length).fill(0);
  const pageviews = new Array<number>(buckets.length).fill(0);
  for (const row of seriesRows) {
    const i = slot.get(num(row.bucket));
    if (i === undefined) continue;
    visitors[i] = num(row.visitors);
    pageviews[i] = num(row.pageviews);
  }

  const breakdowns = Object.fromEntries(
    Object.keys(WEB_BREAKDOWNS).map((k) => [k, [] as BreakdownRow[]]),
  ) as Record<WebBreakdown, BreakdownRow[]>;
  for (const row of breakdownRows) {
    const dim = text(row.dim) as WebBreakdown;
    breakdowns[dim]?.push({ value: text(row.val), visitors: num(row.visitors), count: num(row.n) });
  }
  for (const rows of Object.values(breakdowns))
    rows.sort((a, b) => b.visitors - a.visitors || b.count - a.count);

  const samples = new Map<string, number[]>();
  for (const row of vitalRows) {
    const metric = text(row.metric);
    if (!metric || row.val === null || row.val === undefined) continue;
    const list = samples.get(metric) ?? [];
    list.push(num(row.val));
    samples.set(metric, list);
  }
  const vitals = Object.fromEntries(
    [...samples.entries()].map(([metric, values]) => [
      metric,
      { p75: percentile(values, 0.75), samples: values.length },
    ]),
  );

  const totals = shapeTotals(totalsRows[0]);
  const prev = previousRows ? shapeTotals(previousRows[0]) : null;
  const change = (now: number, before: number | undefined) =>
    before
      ? ` (${now >= before ? '+' : ''}${fmt((now - before) / before, 'percent')} vs previous period)`
      : '';
  const topPage = breakdowns.pages[0];
  const topRef = breakdowns.referrers[0];

  return {
    kind: 'web',
    interval,
    totals,
    previous: prev,
    timeseries: { buckets, visitors, pageviews },
    breakdowns,
    vitals,
    sql: [
      queries.totals,
      ...(queries.previous ? [queries.previous] : []),
      queries.series,
      ...queries.breakdowns,
      queries.vitals,
    ],
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      totals.pageviews === 0
        ? 'No pageviews in this range.'
        : `${fmt(totals.visitors)} visitors${change(totals.visitors, prev?.visitors)}, ${fmt(totals.pageviews)} pageviews, ` +
          `${fmt(totals.sessions)} sessions, bounce rate ${fmt(totals.bounceRate, 'percent')}. ` +
          (topPage ? `Top page ${topPage.value} (${fmt(topPage.visitors)} visitors). ` : '') +
          (topRef ? `Top referrer ${topRef.value}.` : ''),
  };
}
