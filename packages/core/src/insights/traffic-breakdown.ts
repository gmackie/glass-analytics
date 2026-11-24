import { SYSTEM_EVENTS } from '../events.ts';
import { localTimeSql, num, text } from '../sql/source.ts';
import { DAY_MS, HOUR_MS, iso, MINUTE_MS, type TimeRange } from '../time.ts';
import { trafficSource } from './traffic.ts';
import { type QueryContext, type ResultBase, zoneOf } from './types.ts';

export interface TrafficBreakdown extends ResultBase {
  timezone: string;
  /** Pageview counts indexed by local hour, midnight first. */
  hourly: number[];
  devices: Record<'desktop' | 'mobile' | 'tablet' | 'other', number>;
  visitors: {
    likelyHuman: number;
    knownBot: number | null;
    unclassified: number;
    collectionStarted: string;
  };
  sessions: {
    count: number;
    averageSeconds: number | null;
    /** No elapsed time, under one minute, one to under five minutes, five minutes or longer. */
    bands: number[];
    sites: { project: string; count: number; averageSeconds: number | null }[];
  };
}

type Context = Omit<QueryContext, 'project'>;
type Filtered = { startedMs: number; count: number };

export async function runTrafficBreakdown(
  range: TimeRange,
  projects: string[],
  ctx: Context,
  filtered: Filtered,
): Promise<TrafficBreakdown> {
  const d = ctx.dialect;
  const zone = zoneOf({}, ctx, range);
  const hourly = Array<number>(24).fill(0);
  const devices: TrafficBreakdown['devices'] = { desktop: 0, mobile: 0, tablet: 0, other: 0 };
  const visitors = {
    likelyHuman: 0,
    knownBot: range.to <= filtered.startedMs && !filtered.count ? null : filtered.count,
    unclassified: 0,
    collectionStarted: iso(filtered.startedMs),
  };
  const sessions: TrafficBreakdown['sessions'] = {
    count: 0,
    averageSeconds: null,
    bands: [0, 0, 0, 0],
    sites: [],
  };
  const sql: string[] = [];
  const result = {
    kind: 'traffic_breakdown',
    range: { from: iso(range.from), to: iso(range.to) },
    timezone: zone.name,
    hourly,
    devices,
    visitors,
    sessions,
    sql,
    summary: 'No registered sites.',
  };
  if (!projects.length) return result;

  const source = trafficSource(d, projects, range);
  const pv = d.str(SYSTEM_EVENTS.pageview);
  const local = localTimeSql(d, 'ts_ms', zone);
  const hour = `((((${local} % ${DAY_MS}) + ${DAY_MS}) % ${DAY_MS}) / ${HOUR_MS})`;
  const pageviewsSql = `SELECT hour, device_group, COUNT(*) AS views, SUM(human) AS humans FROM (
    SELECT ${hour} AS hour,
      CASE WHEN device IN ('desktop', 'mobile', 'tablet') THEN device ELSE 'other' END AS device_group,
      CASE WHEN received_ms >= ${d.num(filtered.startedMs)} AND ${d.jsonText('props', ['$traffic_class'])} = 'likely_human' THEN 1 ELSE 0 END AS human
    ${source} AND event = ${pv}
  ) pageviews GROUP BY hour, device_group`;
  // Same span as Web reports, with project included in the session key across sites.
  const sessionsSql = `SELECT project, band, COUNT(*) AS sessions, SUM(elapsed) AS duration_ms FROM (
    SELECT project, elapsed, CASE WHEN elapsed = 0 THEN 0 WHEN elapsed < ${MINUTE_MS} THEN 1
      WHEN elapsed < ${5 * MINUTE_MS} THEN 2 ELSE 3 END AS band FROM (
      SELECT project, session_id, MAX(ts_ms) - MIN(ts_ms) AS elapsed
      ${source} AND event IN (${pv}, ${d.str(SYSTEM_EVENTS.pageleave)}) AND session_id <> ''
      GROUP BY project, session_id HAVING SUM(CASE WHEN event = ${pv} THEN 1 ELSE 0 END) > 0
    ) visits
  ) durations GROUP BY project, band`;
  sql.push(pageviewsSql, sessionsSql);
  const [pageviews, durations] = await Promise.all([
    ctx.execute(pageviewsSql),
    ctx.execute(sessionsSql),
  ]);
  for (const row of pageviews) {
    const views = num(row.views);
    const humans = num(row.humans);
    const hourIndex = num(row.hour);
    hourly[hourIndex] = hourly[hourIndex]! + views;
    devices[text(row.device_group) as keyof typeof devices] += views;
    visitors.likelyHuman += humans;
    visitors.unclassified += views - humans;
  }
  const bySite = new Map(projects.map((project) => [project, { count: 0, ms: 0 }]));
  let totalMs = 0;
  for (const row of durations) {
    const site = bySite.get(text(row.project))!;
    const count = num(row.sessions);
    const ms = num(row.duration_ms);
    const band = num(row.band);
    site.count += count;
    site.ms += ms;
    sessions.bands[band] = sessions.bands[band]! + count;
    sessions.count += count;
    totalMs += ms;
  }
  const average = (ms: number, count: number) => (count ? ms / count / 1000 : null);
  sessions.averageSeconds = average(totalMs, sessions.count);
  sessions.sites = Array.from(bySite, ([project, site]) => ({
    project,
    count: site.count,
    averageSeconds: average(site.ms, site.count),
  })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
  result.summary = `${visitors.likelyHuman + visitors.unclassified} tracked pageviews and ${sessions.count} sessions across ${projects.length} ${projects.length === 1 ? 'site' : 'sites'}.`;
  return result;
}
