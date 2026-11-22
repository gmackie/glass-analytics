/**
 * The extra queries behind the Reports pages: key-event conversions, traffic
 * channels and sources with their conversion rates, and site health (errors
 * over time, sessions affected, pages that look broken or slow).
 *
 * Key events are events a person or agent has marked as a `conversion` (a
 * goal: signup, purchase, pledge) or `important` (worth watching, not a goal).
 * Conversion rates divide converting visitors by visitors, both counted as
 * distinct devices like the rest of Web analytics.
 *
 * Sources are attributed on first touch within the range: a visitor belongs
 * to the source of their first pageview in the period, however many visits
 * follow.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import type { Dialect } from '../sql/dialect.ts';
import { bucketExpr, eventsCte, num, text } from '../sql/source.ts';
import { bucketsBetween, DAY_MS, type Interval, resolveRange, type TimeRange } from '../time.ts';
import { type QueryContext, zoneOf } from './types.ts';
import { percentile } from './web.ts';

const PV = SYSTEM_EVENTS.pageview;
const ERR = SYSTEM_EVENTS.exception;

export type EventRole = 'conversion' | 'important';

export interface KeyEvent {
  event: string;
  role: EventRole;
  description?: string;
}

export interface ReportRange {
  from?: string | number;
  to?: string | number;
  filters?: Filter[];
  interval?: Interval;
  utcOffsetMinutes?: number;
  timezone?: string;
}

function intervalFor(range: TimeRange): Interval {
  const days = (range.to - range.from) / DAY_MS;
  return days <= 2 ? 'hour' : days <= 92 ? 'day' : days <= 400 ? 'week' : 'month';
}

const lower = (expr: string) => `LOWER(COALESCE(${expr}, ''))`;
const anyLike = (expr: string, patterns: string[]) =>
  patterns.map((p) => `${lower(expr)} LIKE '${p}'`).join(' OR ');

const SEARCH = [
  '%google.%',
  '%bing.com%',
  '%duckduckgo.%',
  '%yahoo.%',
  '%ecosia.%',
  '%baidu.%',
  '%yandex.%',
  '%search.brave.%',
  '%startpage.%',
  '%qwant.%',
  '%kagi.%',
];
const SOCIAL = [
  '%facebook.%',
  'fb.%',
  '%instagram.%',
  't.co',
  '%twitter.%',
  'x.com',
  '%linkedin.%',
  'lnkd.in',
  '%reddit.%',
  '%youtube.%',
  'youtu.be',
  '%tiktok.%',
  '%pinterest.%',
  '%threads.net',
  '%bsky.app',
  '%mastodon%',
  '%whatsapp.%',
  '%telegram.%',
  '%news.ycombinator.%',
  '%substack.%',
];
const AI = [
  '%chatgpt.%',
  '%openai.%',
  '%perplexity.%',
  '%claude.ai',
  '%gemini.google.%',
  '%copilot.microsoft.%',
  '%you.com',
];
/**
 * AI assistants often strip the referrer and tag the link instead
 * (ChatGPT search appends `utm_source=chatgpt.com`), so the UTM source is matched too.
 */
const AI_SOURCES = [...AI, 'chatgpt', 'openai', 'perplexity', 'claude', 'gemini', 'copilot'];

/** The marketing channel of a pageview, from its UTM tags and referrer. Columns may be prefixed with `alias.`. */
export function channelExpr(alias = ''): string {
  const c = (name: string) => `${alias ? `${alias}.` : ''}${name}`;
  const medium = c('utm_medium');
  const source = c('utm_source');
  const ref = c('referrer_host');
  return `CASE
    WHEN ${lower(medium)} IN ('cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'paidsocial', 'paid_social', 'paid-social', 'display', 'cpm', 'banner', 'ads') THEN 'Paid'
    WHEN ${lower(medium)} IN ('email', 'e-mail', 'newsletter') OR ${lower(source)} IN ('email', 'newsletter') THEN 'Email'
    WHEN ${lower(medium)} IN ('social', 'social-media', 'social_media', 'sm', 'organic_social') THEN 'Social'
    WHEN ${anyLike(ref, AI)} OR ${anyLike(source, AI_SOURCES)} THEN 'AI assistants'
    WHEN ${anyLike(ref, SEARCH)} THEN 'Organic search'
    WHEN ${anyLike(ref, SOCIAL)} THEN 'Social'
    WHEN ${lower(source)} <> '' OR ${lower(c('utm_campaign'))} <> '' THEN 'Other campaigns'
    WHEN ${lower(ref)} <> '' THEN 'Referral'
    ELSE 'Direct'
  END`;
}

// ── Conversions ───────────────────────────────────────────────────────────

export interface ConversionStat {
  event: string;
  role: EventRole;
  description: string;
  /** Times the event happened. */
  count: number;
  /** Distinct visitors (devices) who did it. */
  visitors: number;
  /** visitors / all visitors in the range. */
  rate: number;
  previous: { count: number; visitors: number; rate: number } | null;
  /** Converting visitors per bucket. */
  series: number[];
}

export interface ConversionsResult {
  interval: Interval;
  buckets: number[];
  visitors: number;
  goals: ConversionStat[];
  /** Visitors who did any `conversion` event, and their share of visitors. */
  converted: { visitors: number; rate: number; previous: number | null };
  sql: string[];
  summary: string;
}

function totalsSql(
  d: Dialect,
  project: string,
  range: TimeRange,
  filters: Filter[] | undefined,
  events: string[],
): string {
  const goals = events.map((e) => d.str(e)).join(', ');
  return `WITH ${eventsCte(d, { project, ...range, events: [PV, ...events], filters })}
SELECT event AS ev_name, COUNT(*) AS n, COUNT(DISTINCT distinct_id) AS visitors FROM ev WHERE event IN (${goals}) GROUP BY event
UNION ALL
SELECT '$visitors' AS ev_name, 0 AS n, COUNT(DISTINCT distinct_id) AS visitors FROM ev WHERE event = ${d.str(PV)}`;
}

function convertedSql(
  d: Dialect,
  project: string,
  range: TimeRange,
  filters: Filter[] | undefined,
  events: string[],
): string {
  return `WITH ${eventsCte(d, { project, ...range, events, filters })}
SELECT COUNT(DISTINCT distinct_id) AS visitors FROM ev`;
}

export async function runConversions(
  spec: ReportRange & { goals: KeyEvent[] },
  ctx: QueryContext,
): Promise<ConversionsResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-30d', spec.to, ctx.now);
  const previous = { from: range.from - (range.to - range.from), to: range.from };
  const interval = spec.interval ?? intervalFor(range);
  const buckets = bucketsBetween(range, interval, zoneOf(spec, ctx, range));
  const events = spec.goals.map((g) => g.event);
  const conversions = spec.goals.filter((g) => g.role === 'conversion').map((g) => g.event);
  if (events.length === 0) {
    return {
      interval,
      buckets,
      visitors: 0,
      goals: [],
      converted: { visitors: 0, rate: 0, previous: null },
      sql: [],
      summary: 'No key events are marked yet. Mark one with mark_event.',
    };
  }
  const sql = {
    now: totalsSql(d, ctx.project, range, spec.filters, events),
    before: totalsSql(d, ctx.project, previous, spec.filters, events),
    series: `WITH ${eventsCte(d, { project: ctx.project, ...range, events, filters: spec.filters })}
SELECT event AS ev_name, ${bucketExpr(d, 'ts_ms', interval, zoneOf(spec, ctx, range))} AS bucket, COUNT(DISTINCT distinct_id) AS visitors
FROM ev GROUP BY event, ${bucketExpr(d, 'ts_ms', interval, zoneOf(spec, ctx, range))} ORDER BY bucket LIMIT 20000`,
    converted: conversions.length
      ? convertedSql(d, ctx.project, range, spec.filters, conversions)
      : null,
    convertedBefore: conversions.length
      ? convertedSql(d, ctx.project, previous, spec.filters, conversions)
      : null,
  };
  const [now, before, series, converted, convertedBefore] = await Promise.all([
    ctx.execute(sql.now),
    ctx.execute(sql.before),
    ctx.execute(sql.series),
    sql.converted ? ctx.execute(sql.converted) : Promise.resolve([]),
    sql.convertedBefore ? ctx.execute(sql.convertedBefore) : Promise.resolve([]),
  ]);
  const byName = (rows: Record<string, unknown>[]) =>
    new Map(rows.map((r) => [text(r.ev_name), r]));
  const nowRows = byName(now);
  const beforeRows = byName(before);
  const visitors = num(nowRows.get('$visitors')?.visitors);
  const visitorsBefore = num(beforeRows.get('$visitors')?.visitors);
  const slot = new Map(buckets.map((b, i) => [b, i]));
  const goals: ConversionStat[] = spec.goals.map((g) => {
    const r = nowRows.get(g.event);
    const p = beforeRows.get(g.event);
    const values = new Array<number>(buckets.length).fill(0);
    for (const row of series) {
      if (text(row.ev_name) !== g.event) continue;
      const i = slot.get(num(row.bucket));
      if (i !== undefined) values[i] = num(row.visitors);
    }
    return {
      event: g.event,
      role: g.role,
      description: g.description ?? '',
      count: num(r?.n),
      visitors: num(r?.visitors),
      rate: visitors ? num(r?.visitors) / visitors : 0,
      previous:
        visitorsBefore || p
          ? {
              count: num(p?.n),
              visitors: num(p?.visitors),
              rate: visitorsBefore ? num(p?.visitors) / visitorsBefore : 0,
            }
          : null,
      series: values,
    };
  });
  const convertedNow = num(converted[0]?.visitors);
  const convertedPrev = sql.convertedBefore ? num(convertedBefore[0]?.visitors) : null;
  const rate = visitors ? convertedNow / visitors : 0;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return {
    interval,
    buckets,
    visitors,
    goals,
    converted: {
      visitors: convertedNow,
      rate,
      previous: convertedPrev !== null && visitorsBefore ? convertedPrev / visitorsBefore : null,
    },
    sql: [sql.now, sql.before, sql.series, ...(sql.converted ? [sql.converted] : [])],
    summary: `${visitors} visitors; ${conversions.length ? `${convertedNow} converted (${pct(rate)}). ` : ''}${goals.map((g) => `${g.event}: ${g.visitors} visitors (${pct(g.rate)})`).join(', ')}.`,
  };
}

// ── Sources ───────────────────────────────────────────────────────────────

export const SOURCE_DIMENSIONS = {
  channel: 'Channel',
  referrer: 'Referrer',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  entry_page: 'Landing page',
  country: 'Country',
  device: 'Device',
} as const;
export type SourceDimension = keyof typeof SOURCE_DIMENSIONS;

export interface SourceRow {
  value: string;
  visitors: number;
  sessions: number;
  /** Visitors who did any conversion event in the range. */
  converted: number;
  rate: number;
  bounceRate: number;
  /** With revenue: net revenue from people first touched by this value, and per visitor. */
  revenue?: number;
  payers?: number;
  revenuePerVisitor?: number;
}

export function dimensionExpr(dimension: SourceDimension, alias: string): string {
  const col = (name: string) => `COALESCE(NULLIF(${alias}.${name}, ''), '(none)')`;
  switch (dimension) {
    case 'channel':
      return channelExpr(alias);
    case 'referrer':
      return `COALESCE(NULLIF(${alias}.referrer_host, ''), 'Direct / None')`;
    case 'entry_page':
      return col('path');
    default:
      return col(dimension);
  }
}

/**
 * Visitors per source value (first touch in range), with how many converted and
 * bounced. `conversions` are the events that count as converting.
 */
export async function runSources(
  spec: ReportRange & {
    dimension: SourceDimension;
    conversions: string[];
    limit?: number;
    revenue?: boolean;
  },
  ctx: QueryContext,
): Promise<{ dimension: SourceDimension; rows: SourceRow[]; sql: string[] }> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-30d', spec.to, ctx.now);
  const goals = spec.conversions.map((e) => d.str(e)).join(', ');
  const sql = `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [PV, ...spec.conversions], filters: spec.filters })},
firsts AS (SELECT distinct_id, MIN(ts_ms) AS t FROM ev WHERE event = ${d.str(PV)} GROUP BY distinct_id),
touch AS (
  SELECT ev.distinct_id, MIN(${dimensionExpr(spec.dimension, 'ev')}) AS val
  FROM ev JOIN firsts ON firsts.distinct_id = ev.distinct_id AND ev.ts_ms = firsts.t AND ev.event = ${d.str(PV)}
  GROUP BY ev.distinct_id
),
visits AS (SELECT distinct_id, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS views FROM ev WHERE event = ${d.str(PV)} GROUP BY distinct_id),
conv AS (${goals ? `SELECT DISTINCT distinct_id FROM ev WHERE event IN (${goals})` : `SELECT distinct_id FROM ev WHERE 1 = 0`})
SELECT touch.val AS val, COUNT(*) AS visitors, SUM(visits.sessions) AS sessions,
  SUM(CASE WHEN conv.distinct_id IS NULL THEN 0 ELSE 1 END) AS converted,
  SUM(CASE WHEN visits.views = 1 THEN 1 ELSE 0 END) AS bounced
FROM touch
JOIN visits ON visits.distinct_id = touch.distinct_id
LEFT JOIN conv ON conv.distinct_id = touch.distinct_id
GROUP BY touch.val ORDER BY visitors DESC, touch.val ASC LIMIT ${Math.min(spec.limit ?? 20, 100)}`;
  // Revenue by the paying person's first touch (people, not devices: payments often happen server-side).
  const revenueSql = spec.revenue
    ? `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [PV], filters: spec.filters })},
${eventsCte(d, { project: ctx.project, ...range, filters: [...(spec.filters ?? []), { property: 'props.$revenue_base', op: 'is_set' }], name: 'mv' })},
pfirst AS (SELECT pid, MIN(ts_ms) AS t FROM ev GROUP BY pid),
ptouch AS (
  SELECT ev.pid AS pid, MIN(${dimensionExpr(spec.dimension, 'ev')}) AS val
  FROM ev JOIN pfirst ON pfirst.pid = ev.pid AND ev.ts_ms = pfirst.t GROUP BY ev.pid
)
SELECT ptouch.val AS val, SUM(${d.jsonNumber('mv.props', ['$revenue_base'])}) AS revenue, COUNT(DISTINCT mv.pid) AS payers
FROM mv JOIN ptouch ON ptouch.pid = mv.pid GROUP BY ptouch.val`
    : null;
  const [main, money] = await Promise.all([
    ctx.execute(sql),
    revenueSql ? ctx.execute(revenueSql) : Promise.resolve([]),
  ]);
  const revenueBy = new Map(
    money.map((r) => [text(r.val), { revenue: num(r.revenue), payers: num(r.payers) }]),
  );
  const rows = main.map((r) =>
    sourceRow(r, spec.revenue ? (revenueBy.get(text(r.val)) ?? { revenue: 0, payers: 0 }) : null),
  );
  return { dimension: spec.dimension, rows, sql: revenueSql ? [sql, revenueSql] : [sql] };
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** One source's numbers, with revenue when it was asked for. */
function sourceRow(
  r: Record<string, unknown>,
  money: { revenue: number; payers: number } | null,
): SourceRow {
  const visitors = num(r.visitors);
  const share = (n: number) => (visitors ? n / visitors : 0);
  return {
    value: text(r.val),
    visitors,
    sessions: num(r.sessions),
    converted: num(r.converted),
    rate: share(num(r.converted)),
    bounceRate: share(num(r.bounced)),
    ...(money
      ? {
          revenue: cents(money.revenue),
          payers: money.payers,
          revenuePerVisitor: cents(share(money.revenue)),
        }
      : {}),
  };
}

// ── Health ────────────────────────────────────────────────────────────────

export interface HealthResult {
  interval: Interval;
  buckets: number[];
  errors: {
    total: number;
    previous: number;
    series: number[];
    visitors: number;
    sessions: number;
    sessionsTotal: number;
    sessionRate: number;
  };
  /** Pages where errors happen most. */
  errorPages: { path: string; errors: number; visitors: number }[];
  /** The issues (error tracking) with the most errors in the range. */
  topIssues: { issue: string; errors: number; visitors: number }[];
  /** Pages whose title or path looks like a "not found" page, with how people got there. */
  notFound: { path: string; title: string; views: number; visitors: number; referrer: string }[];
  /** p75 Largest Contentful Paint per page (pages with 5+ samples). */
  slowPages: { path: string; p75: number; samples: number }[];
  sql: string[];
  summary: string;
}

export async function runHealth(spec: ReportRange, ctx: QueryContext): Promise<HealthResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-30d', spec.to, ctx.now);
  const previous = { from: range.from - (range.to - range.from), to: range.from };
  const interval = spec.interval ?? intervalFor(range);
  const buckets = bucketsBetween(range, interval, zoneOf(spec, ctx, range));
  const bucket = bucketExpr(d, 'ts_ms', interval, zoneOf(spec, ctx, range));
  const cte = (r: TimeRange, events: string[]) =>
    eventsCte(d, { project: ctx.project, ...r, events, filters: spec.filters });
  const title = lower('title');
  const sql = {
    errors: `WITH ${cte(range, [PV, ERR])}
SELECT
  (SELECT COUNT(*) FROM ev WHERE event = ${d.str(ERR)}) AS errors,
  (SELECT COUNT(DISTINCT distinct_id) FROM ev WHERE event = ${d.str(ERR)}) AS visitors,
  (SELECT COUNT(DISTINCT session_id) FROM ev WHERE event = ${d.str(ERR)}) AS sessions,
  (SELECT COUNT(DISTINCT session_id) FROM ev WHERE event = ${d.str(PV)}) AS sessions_total`,
    previous: `WITH ${cte(previous, [ERR])}
SELECT COUNT(*) AS errors FROM ev`,
    series: `WITH ${cte(range, [ERR])}
SELECT ${bucket} AS bucket, COUNT(*) AS n FROM ev GROUP BY ${bucket} ORDER BY bucket LIMIT 5000`,
    pages: `WITH ${cte(range, [ERR])}
SELECT COALESCE(NULLIF(path, ''), '(none)') AS path, COUNT(*) AS n, COUNT(DISTINCT distinct_id) AS visitors
FROM ev GROUP BY COALESCE(NULLIF(path, ''), '(none)') ORDER BY n DESC, path ASC LIMIT 10`,
    issues: `WITH ${cte(range, [ERR])}
SELECT ${d.jsonText('props', ['$issue_id'])} AS issue, COUNT(*) AS n, COUNT(DISTINCT distinct_id) AS visitors
FROM ev WHERE ${d.jsonText('props', ['$issue_id'])} IS NOT NULL
GROUP BY ${d.jsonText('props', ['$issue_id'])} ORDER BY n DESC, issue ASC LIMIT 10`,
    notFound: `WITH ${cte(range, [PV])}
SELECT path, MIN(title) AS title, COUNT(*) AS views, COUNT(DISTINCT distinct_id) AS visitors,
  MIN(COALESCE(NULLIF(referrer_host, ''), 'Direct / None')) AS referrer
FROM ev
WHERE ${title} LIKE '%404%' OR ${title} LIKE '%not found%' OR ${title} LIKE '%page not found%' OR ${lower('path')} LIKE '%/404%'
GROUP BY path ORDER BY views DESC, path ASC LIMIT 10`,
    vitals: `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [SYSTEM_EVENTS.webVitals], filters: spec.filters })}
SELECT COALESCE(NULLIF(path, ''), '(none)') AS path, ${d.jsonNumber('props', ['value'])} AS val
FROM ev WHERE ${d.jsonText('props', ['metric'])} = 'LCP'
ORDER BY ts_ms DESC LIMIT 5000`,
  };
  const [errors, prev, series, pages, issues, notFound, vitals] = await Promise.all([
    ctx.execute(sql.errors),
    ctx.execute(sql.previous),
    ctx.execute(sql.series),
    ctx.execute(sql.pages),
    ctx.execute(sql.issues),
    ctx.execute(sql.notFound),
    ctx.execute(sql.vitals),
  ]);
  const slot = new Map(buckets.map((b, i) => [b, i]));
  const values = new Array<number>(buckets.length).fill(0);
  for (const row of series) {
    const i = slot.get(num(row.bucket));
    if (i !== undefined) values[i] = num(row.n);
  }
  const e = errors[0] ?? {};
  const sessionsTotal = num(e.sessions_total);
  const samples = new Map<string, number[]>();
  for (const row of vitals) {
    if (row.val === null || row.val === undefined) continue;
    const list = samples.get(text(row.path)) ?? [];
    list.push(num(row.val));
    samples.set(text(row.path), list);
  }
  const slowPages = [...samples]
    .filter(([, v]) => v.length >= 5)
    .map(([path, v]) => ({ path, p75: percentile(v, 0.75), samples: v.length }))
    .sort((a, b) => b.p75 - a.p75)
    .slice(0, 10);
  const total = num(e.errors);
  const sessionRate = sessionsTotal ? num(e.sessions) / sessionsTotal : 0;
  return {
    interval,
    buckets,
    errors: {
      total,
      previous: num(prev[0]?.errors),
      series: values,
      visitors: num(e.visitors),
      sessions: num(e.sessions),
      sessionsTotal,
      sessionRate,
    },
    errorPages: pages.map((r) => ({
      path: text(r.path),
      errors: num(r.n),
      visitors: num(r.visitors),
    })),
    topIssues: issues.map((r) => ({
      issue: text(r.issue),
      errors: num(r.n),
      visitors: num(r.visitors),
    })),
    notFound: notFound.map((r) => ({
      path: text(r.path),
      title: text(r.title),
      views: num(r.views),
      visitors: num(r.visitors),
      referrer: text(r.referrer),
    })),
    slowPages,
    sql: Object.values(sql),
    summary: `${total} errors in ${num(e.sessions)} of ${sessionsTotal} sessions (${(sessionRate * 100).toFixed(1)}%), affecting ${num(e.visitors)} visitors. ${notFound.length ? `${notFound.length} pages look like "not found" pages. ` : ''}${slowPages[0] ? `Slowest page by LCP: ${slowPages[0].path} (p75 ${Math.round(slowPages[0].p75)} ms).` : ''}`,
  };
}
