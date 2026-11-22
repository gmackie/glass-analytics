/**
 * Error tracking reads over the event store: per-issue counts, daily series and
 * the breakdowns, people and sessions behind one issue. Exceptions carry their
 * issue in `props.$issue_id` (set at ingest), so these queries are the same on D1
 * and the lake. Issue metadata (status, assignee, first seen) lives in D1.
 */

import type { Filter } from '../filters.ts';
import { bucketExpr, eventsCte } from '../sql/source.ts';
import { bucketsBetween, DAY_MS, type Interval, resolveRange } from '../time.ts';
import { type QueryContext, zoneOf } from './types.ts';

const EXCEPTION = '$exception';

export interface IssueRange {
  from?: string | number;
  to?: string | number;
  filters?: Filter[];
  timezone?: string;
}

export interface IssueCount {
  issue: string;
  events: number;
  users: number;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function source(spec: IssueRange, ctx: QueryContext) {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-14d', spec.to, ctx.now);
  const issue = d.jsonText('props', ['$issue_id']);
  const cte = eventsCte(d, {
    project: ctx.project,
    ...range,
    events: [EXCEPTION],
    filters: spec.filters,
  });
  const only = (ids?: readonly string[]) =>
    ids?.length ? ` AND ${issue} IN (${ids.map((i) => d.str(i)).join(', ')})` : '';
  return { d, range, issue, cte, only };
}

/** Exceptions, people and sessions per issue in a range (all issues, or the ids given). */
export async function issueCounts(
  spec: IssueRange,
  ctx: QueryContext,
  ids?: readonly string[],
): Promise<{ rows: IssueCount[]; sql: string }> {
  const { issue, cte, only } = source(spec, ctx);
  const sql = `WITH ${cte}
SELECT ${issue} AS issue, COUNT(*) AS n, COUNT(DISTINCT pid) AS users, COUNT(DISTINCT session_id) AS sessions,
  MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts
FROM ev WHERE ${issue} IS NOT NULL${only(ids)}
GROUP BY ${issue} ORDER BY n DESC, issue ASC LIMIT 1000`;
  const rows = await ctx.execute(sql);
  return {
    sql,
    rows: rows.map((r) => ({
      issue: text(r.issue),
      events: num(r.n),
      users: num(r.users),
      sessions: num(r.sessions),
      firstSeen: num(r.first_ts),
      lastSeen: num(r.last_ts),
    })),
  };
}

/** Exceptions per bucket for some issues. */
export async function issueSeries(
  spec: IssueRange & { interval?: Interval },
  ctx: QueryContext,
  ids: readonly string[],
): Promise<{
  interval: Interval;
  buckets: number[];
  series: Record<string, number[]>;
  sql: string;
}> {
  const { d, range, issue, cte, only } = source(spec, ctx);
  // Hours for a range of up to two days, days beyond that.
  const interval = spec.interval ?? (range.to - range.from <= 2 * DAY_MS ? 'hour' : 'day');
  const zone = zoneOf(spec, ctx, range);
  const buckets = bucketsBetween(range, interval, zone);
  const bucket = bucketExpr(d, 'ts_ms', interval, zone);
  const series: Record<string, number[]> = Object.fromEntries(
    ids.map((id) => [id, new Array<number>(buckets.length).fill(0)]),
  );
  const sql = `WITH ${cte}
SELECT ${issue} AS issue, ${bucket} AS bucket, COUNT(*) AS n
FROM ev WHERE ${issue} IS NOT NULL${only(ids)}
GROUP BY ${issue}, ${bucket} ORDER BY issue, bucket LIMIT 20000`;
  if (ids.length === 0) return { interval, buckets, series, sql };
  const slot = new Map(buckets.map((b, i) => [b, i]));
  for (const r of await ctx.execute(sql)) {
    const i = slot.get(num(r.bucket));
    const list = series[text(r.issue)];
    if (i !== undefined && list) list[i] = num(r.n);
  }
  return { interval, buckets, series, sql };
}

export interface IssueDetail {
  breakdowns: Record<string, { value: string; events: number; users: number }[]>;
  people: { person: string; events: number; lastSeen: number }[];
  /** Recent sessions with the error, for opening their replays at the moment it happened. */
  occurrences: { session: string; person: string; ts: number; url: string; release: string }[];
  sql: string[];
}

/** What's behind an issue (and any issues merged into it): where, who and when. */
export async function issueDetail(
  spec: IssueRange,
  ctx: QueryContext,
  ids: readonly string[],
): Promise<IssueDetail> {
  const { d, issue, cte, only } = source(spec, ctx);
  const where = `${issue} IS NOT NULL${only(ids)}`;
  const dims: Record<string, string> = {
    browser: 'browser',
    os: 'os',
    device: 'device',
    country: 'country',
    path: "COALESCE(NULLIF(path, ''), '(none)')",
    release: `COALESCE(${d.jsonText('props', ['$release'])}, '(none)')`,
    handled: `COALESCE(${d.jsonText('props', ['handled'])}, 'false')`,
  };
  const sql: Record<string, string> = {};
  for (const [name, expr] of Object.entries(dims)) {
    sql[name] = `WITH ${cte}
SELECT ${expr} AS value, COUNT(*) AS n, COUNT(DISTINCT pid) AS users
FROM ev WHERE ${where} GROUP BY ${expr} ORDER BY n DESC, value ASC LIMIT 6`;
  }
  sql.people = `WITH ${cte}
SELECT pid AS person, COUNT(*) AS n, MAX(ts_ms) AS last_ts
FROM ev WHERE ${where} GROUP BY pid ORDER BY n DESC, last_ts DESC LIMIT 10`;
  sql.occurrences = `WITH ${cte}
SELECT session_id AS session, pid AS person, ts_ms, url, COALESCE(${d.jsonText('props', ['$release'])}, '') AS rel
FROM ev WHERE ${where} AND session_id IS NOT NULL AND session_id <> ''
ORDER BY ts_ms DESC, session_id ASC LIMIT 20`;
  const names = Object.keys(sql);
  const results = await Promise.all(names.map((n) => ctx.execute(sql[n]!)));
  const out: IssueDetail = { breakdowns: {}, people: [], occurrences: [], sql: Object.values(sql) };
  names.forEach((name, i) => {
    const rows = results[i]!;
    if (name === 'people') {
      out.people = rows.map((r) => ({
        person: text(r.person),
        events: num(r.n),
        lastSeen: num(r.last_ts),
      }));
    } else if (name === 'occurrences') {
      // One per session: the latest exception in it.
      const seen = new Set<string>();
      for (const r of rows) {
        const session = text(r.session);
        if (seen.has(session)) continue;
        seen.add(session);
        out.occurrences.push({
          session,
          person: text(r.person),
          ts: num(r.ts_ms),
          url: text(r.url),
          release: text(r.rel),
        });
      }
    } else {
      out.breakdowns[name] = rows.map((r) => ({
        value: text(r.value) || '(none)',
        events: num(r.n),
        users: num(r.users),
      }));
    }
  });
  return out;
}
