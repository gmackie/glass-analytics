/**
 * All sites: one row per project, so a deployment that tracks several sites can
 * see at a glance which ones are gaining or losing traffic.
 *
 * Two queries across every project at once, rather than one overview per project:
 * 1. visitors and pageviews for the range and the previous period of the same length,
 *    plus the last pageview seen in either
 * 2. a visitors time series per project, for the sparkline
 *
 * Visitors are distinct `distinct_id`s (devices), as on the Reports page. They are
 * counted in two steps (one row per project, period and visitor, then rows per
 * project) rather than COUNT(DISTINCT CASE …), which is exact on every engine.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import { bucketExpr, num, text } from '../sql/source.ts';
import { bucketsBetween, type Interval, iso, resolveRange } from '../time.ts';
import { fmt, type QueryContext } from './types.ts';
import { defaultInterval } from './web.ts';

/**
 * How a site's traffic moved against the previous period.
 * - `up` / `down`: visitors changed by at least 20%, on enough traffic to mean something
 * - `steady`: changed by less than that
 * - `quiet`: too little traffic in both periods to call a trend
 * - `new`: pageviews this period, none in the previous one
 * - `stopped`: pageviews in the previous period, none this one (often a removed tag)
 * - `none`: no pageviews in either
 */
export type SiteTrend = 'up' | 'down' | 'steady' | 'quiet' | 'new' | 'stopped' | 'none';

export interface SiteRow {
  project: string;
  visitors: number;
  pageviews: number;
  previous: { visitors: number; pageviews: number };
  /** Relative change in visitors, or null when the previous period had none. */
  change: number | null;
  trend: SiteTrend;
  /** Visitors per bucket of the range, aligned with `buckets`. */
  series: number[];
  /** Last pageview in the range or the previous period, as ISO time. */
  lastPageview: string | null;
}

export interface SitesResult {
  kind: 'sites';
  interval: Interval;
  buckets: number[];
  sites: SiteRow[];
  range: { from: string; to: string };
  summary: string;
  sql: string[];
}

export interface SitesSpec {
  from?: string | number;
  to?: string | number;
}

/** Below this many visitors across both periods, a percentage change is noise. */
export const MIN_TREND_VISITORS = 20;
/** The change that counts as gaining or losing traffic. */
export const TREND_THRESHOLD = 0.2;

export function siteTrend(visitors: number, previous: number): SiteTrend {
  if (visitors === 0 && previous === 0) return 'none';
  if (previous === 0) return 'new';
  if (visitors === 0) return 'stopped';
  if (visitors + previous < MIN_TREND_VISITORS) return 'quiet';
  const change = (visitors - previous) / previous;
  if (change >= TREND_THRESHOLD) return 'up';
  if (change <= -TREND_THRESHOLD) return 'down';
  return 'steady';
}

/**
 * Compare every project over one range. `projects` lists the projects to report, so
 * a project with no events yet still gets a row; events of unlisted projects are ignored.
 */
export async function runSites(
  spec: SitesSpec,
  projects: string[],
  ctx: Omit<QueryContext, 'project'>,
): Promise<SitesResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const interval = defaultInterval(range);
  const prevFrom = range.from - (range.to - range.from);
  const buckets = bucketsBetween(range, interval);
  const empty = (): SitesResult => ({
    kind: 'sites',
    interval,
    buckets,
    sites: [],
    range: { from: iso(range.from), to: iso(range.to) },
    summary: 'No projects yet.',
    sql: [],
  });
  if (projects.length === 0) return empty();

  const where = (from: number) =>
    `project IN (${projects.map((p) => d.str(p)).join(', ')})
    AND event = ${d.str(SYSTEM_EVENTS.pageview)}
    AND ts_ms >= ${d.num(Math.floor(from))}
    AND ts_ms < ${d.num(Math.ceil(range.to))}`;
  const current = `CASE WHEN ts_ms >= ${d.num(Math.floor(range.from))} THEN 1 ELSE 0 END`;

  const totalsSql = `SELECT project,
  SUM(CASE WHEN cur = 1 THEN 1 ELSE 0 END) AS visitors,
  SUM(CASE WHEN cur = 1 THEN n ELSE 0 END) AS pageviews,
  SUM(CASE WHEN cur = 0 THEN 1 ELSE 0 END) AS prev_visitors,
  SUM(CASE WHEN cur = 0 THEN n ELSE 0 END) AS prev_pageviews,
  MAX(last_ms) AS last_ms
FROM (
  SELECT project, distinct_id, ${current} AS cur, COUNT(*) AS n, MAX(ts_ms) AS last_ms
  FROM ${d.table('events')}
  WHERE ${where(prevFrom)}
  GROUP BY project, distinct_id, ${current}
) v
GROUP BY project`;

  const seriesSql = `SELECT project, bucket, COUNT(DISTINCT distinct_id) AS visitors
FROM (
  SELECT project, ${bucketExpr(d, 'ts_ms', interval)} AS bucket, distinct_id
  FROM ${d.table('events')}
  WHERE ${where(range.from)}
) t
GROUP BY project, bucket
ORDER BY project, bucket
LIMIT 50000`;

  const [totalRows, seriesRows] = await Promise.all([
    ctx.execute(totalsSql),
    ctx.execute(seriesSql),
  ]);

  const slot = new Map(buckets.map((b, i) => [b, i]));
  const series = new Map(projects.map((p) => [p, new Array<number>(buckets.length).fill(0)]));
  for (const row of seriesRows) {
    const values = series.get(text(row.project));
    const i = slot.get(num(row.bucket));
    if (values && i !== undefined) values[i] = num(row.visitors);
  }
  const totals = new Map(totalRows.map((r) => [text(r.project), r]));

  const sites = projects.map((project): SiteRow => {
    const r = totals.get(project);
    const visitors = num(r?.visitors);
    const previous = { visitors: num(r?.prev_visitors), pageviews: num(r?.prev_pageviews) };
    const last = r?.last_ms === null || r?.last_ms === undefined ? null : num(r.last_ms);
    return {
      project,
      visitors,
      pageviews: num(r?.pageviews),
      previous,
      change: previous.visitors ? (visitors - previous.visitors) / previous.visitors : null,
      trend: siteTrend(visitors, previous.visitors),
      series: series.get(project) ?? [],
      lastPageview: last === null ? null : iso(last),
    };
  });
  sites.sort((a, b) => b.visitors - a.visitors || a.project.localeCompare(b.project));

  const named = (t: SiteTrend) => sites.filter((s) => s.trend === t).map((s) => s.project);
  const pct = (s: SiteRow) =>
    s.change === null ? '' : ` ${s.change > 0 ? '+' : ''}${fmt(s.change, 'percent')}`;
  const list = (t: SiteTrend) =>
    sites
      .filter((s) => s.trend === t)
      .map((s) => `${s.project}${pct(s)}`)
      .join(', ');
  const total = sites.reduce((n, s) => n + s.visitors, 0);
  const parts = [`${fmt(total)} visitors across ${sites.length} sites.`];
  if (named('up').length) parts.push(`Gaining: ${list('up')}.`);
  if (named('down').length) parts.push(`Losing: ${list('down')}.`);
  if (named('stopped').length)
    parts.push(`No pageviews this period (check the tag): ${named('stopped').join(', ')}.`);
  if (named('new').length) parts.push(`New this period: ${named('new').join(', ')}.`);

  return {
    kind: 'sites',
    interval,
    buckets,
    sites,
    range: { from: iso(range.from), to: iso(range.to) },
    summary: parts.join(' '),
    sql: [totalsSql, seriesSql],
  };
}
