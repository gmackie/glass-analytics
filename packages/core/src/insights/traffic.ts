/** Tracked pageviews over time and the paths, sites or referrers behind them. */
import { SYSTEM_EVENTS } from '../events.ts';
import type { Dialect } from '../sql/dialect.ts';
import { bucketExpr, num, text } from '../sql/source.ts';
import { bucketsBetween, type Interval, iso, resolveRange, type TimeRange } from '../time.ts';
import { type QueryContext, type ResultBase, zoneOf } from './types.ts';
import { defaultInterval } from './web.ts';

export interface TrafficSpec {
  from?: string | number;
  to?: string | number;
  path?: string;
  limit: number;
  offset: number;
}

export interface TrafficResult extends ResultBase {
  interval: Interval;
  buckets: number[];
  series: number[];
  pageviews: number;
  dimension: 'path' | 'project' | 'referrer_host';
  ranking: { value: string; pageviews: number }[];
  hasMore: boolean;
}

/** Shared scope for pageviews and visits, including only registered projects. */
export function trafficSource(d: Dialect, projects: string[], range: TimeRange): string {
  return `FROM ${d.table('events')} WHERE project IN (${projects.map((p) => d.str(p)).join(', ')})
    AND ts_ms >= ${d.num(Math.floor(range.from))} AND ts_ms < ${d.num(Math.ceil(range.to))}`;
}

/** Aggregate before limiting so a common path across many small sites ranks correctly. */
export async function runTraffic(
  spec: TrafficSpec,
  scope: string | string[],
  ctx: Omit<QueryContext, 'project'>,
): Promise<TrafficResult> {
  const oneSite = typeof scope === 'string';
  const projects = oneSite ? [scope] : scope;
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-30d', spec.to, ctx.now);
  const interval = defaultInterval(range);
  const zone = zoneOf({}, ctx, range);
  const buckets = bucketsBetween(range, interval, zone);
  const dimension = spec.path === undefined ? 'path' : oneSite ? 'referrer_host' : 'project';
  const result: TrafficResult = {
    kind: 'traffic',
    range: { from: iso(range.from), to: iso(range.to) },
    interval,
    buckets,
    series: buckets.map(() => 0),
    pageviews: 0,
    dimension,
    ranking: [],
    hasMore: false,
    sql: [],
    summary: 'No registered sites.',
  };
  if (!projects.length) return result;

  const pathFilter = spec.path === undefined ? '' : ` AND path = ${d.str(spec.path)}`;
  const source = `${trafficSource(d, projects, range)} AND event = ${d.str(SYSTEM_EVENTS.pageview)}${pathFilter}`;
  const bucket = bucketExpr(d, 'ts_ms', interval, zone);
  const seriesSql = `SELECT ${bucket} AS bucket, COUNT(*) AS pageviews ${source} GROUP BY ${bucket} ORDER BY bucket`;
  // Missing paths still count in the total. An empty referrer is direct traffic.
  const group = dimension === 'referrer_host' ? "COALESCE(referrer_host, '')" : dimension;
  const rankSql = `SELECT ${group} AS value, COUNT(*) AS pageviews ${source}
    ${dimension === 'path' ? "AND path <> ''" : ''}
    GROUP BY ${group} ORDER BY pageviews DESC, ${group} ASC
    LIMIT ${d.num(spec.limit + 1)} OFFSET ${d.num(spec.offset)}`;
  const [seriesRows, ranked] = await Promise.all([ctx.execute(seriesSql), ctx.execute(rankSql)]);
  const byBucket = new Map(seriesRows.map((r) => [num(r.bucket), num(r.pageviews)]));
  const series = buckets.map((b) => byBucket.get(b) ?? 0);
  const pageviews = seriesRows.reduce((sum, row) => sum + num(row.pageviews), 0);
  return {
    ...result,
    series,
    pageviews,
    hasMore: ranked.length > spec.limit,
    ranking: ranked
      .slice(0, spec.limit)
      .map((r) => ({ value: text(r.value), pageviews: num(r.pageviews) })),
    sql: [seriesSql, rankSql],
    summary: `${pageviews} pageviews across ${projects.length} ${projects.length === 1 ? 'site' : 'sites'}.`,
  };
}
