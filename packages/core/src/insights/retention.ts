/**
 * Retention: of the people who did X in each period, how many did Y in each
 * later period?
 *
 * - first_time (default): a person's cohort is the period of their first
 *   `cohortEvent` inside the range;
 * - recurring: a person joins every period in which they did `cohortEvent`.
 *
 * Period 0 is the cohort itself (100% by definition); period k counts people who
 * did `returnEvent` k periods later — or, with `cumulative`, in period k or any
 * later one. Return events are counted up to `periods` periods after the range
 * ends (or now, whichever is sooner). With a breakdown, each value of the cohort
 * event's property gets its own table.
 */

import type { Filter } from '../filters.ts';
import { breakdownExpr, breakdownProperties, filtersSql } from '../sql/filters.ts';
import {
  type Aggregation,
  actorNoun,
  bucketExpr,
  eventsCte,
  fixedIntervalMs,
  localTimeSql,
  num,
  parseAggregation,
  text,
} from '../sql/source.ts';
import {
  addMonths,
  DAY_MS,
  iso,
  localToUtc,
  offsetAt,
  resolveRange,
  type TimeRange,
  type Zone,
} from '../time.ts';
import { type CohortBreakdown, isCohortBreakdown } from './breakdowns.ts';
import type { RetentionSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, zoneOf } from './types.ts';

export interface RetentionCohort {
  /** Cohort period start, epoch ms. */
  start: number;
  size: number;
  /** People retained in period 0..periods (index 0 equals `size`). */
  counts: number[];
  rates: number[];
}

export interface RetentionTable {
  cohorts: RetentionCohort[];
  /** Mean retention per period, over cohorts old enough to have that period. */
  average: number[];
}

export interface RetentionResult extends ResultBase, RetentionTable {
  kind: 'retention';
  period: 'hour' | 'day' | 'week' | 'month';
  periods: number;
  retentionType: 'first_time' | 'recurring';
  cumulative: boolean;
  /** One table per breakdown value, when the spec has a breakdown. */
  breakdowns?: ({ value: string } & RetentionTable)[];
}

type Spec = RetentionSpec & { cohortBreakdown?: CohortBreakdown[] };
type Period = NonNullable<RetentionSpec['period']>;
const PERIOD_ADJECTIVE: Record<Period, string> = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

interface BaseOptions {
  /** The breakdown expression, read from the cohort event (aliased "e" for first-time cohorts). */
  bd: (alias?: string) => string;
  extra: Filter[];
  aggregation: Aggregation;
  zone: Zone;
}

/** A property breakdown as an alias-aware expression, or none. */
function breakdownOf(breakdowns: string[], d: QueryContext['dialect']): (alias?: string) => string {
  if (!breakdowns.length || isCohortBreakdown(breakdowns)) return () => "''";
  return (alias) => breakdownExpr(breakdowns, d, alias);
}

interface Compiled {
  head: string;
  key: (ts: string) => string;
  diff: string;
}

function horizonOf(range: TimeRange, period: Period, periods: number): number {
  return period === 'month'
    ? addMonths(range.to, periods + 1)
    : range.to + (periods + 1) * fixedIntervalMs(period);
}

const cond = (step: RetentionSpec['cohortEvent'], d: QueryContext['dialect'], alias?: string) => {
  const col = alias ? `${alias}.event` : 'event';
  return `${step.event === '*' ? '1 = 1' : `${col} = ${d.str(step.event)}`} AND ${filtersSql(step.filters as Filter[] | undefined, d, alias)}`;
};

/** The CTEs every retention query shares: `c` (actor, cohort bucket, bd) and `a` (actor, return bucket). */
function compileBase(spec: Spec, ctx: QueryContext, range: TimeRange, o: BaseOptions): Compiled {
  const d = ctx.dialect;
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const now = ctx.now ?? Date.now();
  const horizon = horizonOf(range, period, periods);
  const events =
    spec.cohortEvent.event === '*' || spec.returnEvent.event === '*'
      ? undefined
      : [spec.cohortEvent.event, spec.returnEvent.event];
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: Math.min(horizon, now + DAY_MS),
    events,
    filters: [...((spec.filters as Filter[] | undefined) ?? []), ...o.extra],
    aggregation: o.aggregation,
  });
  // Month buckets are compared by month index (year*12+month), others by bucket start ms.
  const key = (ts: string) =>
    period === 'month'
      ? d.monthIndex(localTimeSql(d, ts, o.zone))
      : bucketExpr(d, ts, period, o.zone);
  const step = period === 'month' ? 1 : fixedIntervalMs(period);
  const diff = `(a.abucket - c.cbucket) / ${step}`;
  const inRange = `ts_ms < ${d.num(range.to)}`;
  const cohort =
    (spec.retentionType ?? 'first_time') === 'recurring'
      ? `c AS (
  SELECT actor, ${key('ts_ms')} AS cbucket, MIN(${o.bd()}) AS bd
  FROM ev WHERE ${cond(spec.cohortEvent, d)} AND ${inRange}
  GROUP BY actor, ${key('ts_ms')}
)`
      : `first_seen AS (
  SELECT actor, MIN(ts_ms) AS t0 FROM ev WHERE ${cond(spec.cohortEvent, d)} AND ${inRange} GROUP BY actor
),
c AS (
  SELECT fs.actor, ${key('fs.t0')} AS cbucket, MIN(${o.bd('e')}) AS bd
  FROM first_seen fs JOIN ev e ON e.actor = fs.actor AND e.ts_ms = fs.t0 AND ${cond(spec.cohortEvent, d, 'e')}
  GROUP BY fs.actor, ${key('fs.t0')}
)`;
  const head = `WITH ${cte},
${cohort},
a AS (
  SELECT DISTINCT actor, ${key('ts_ms')} AS abucket
  FROM ev
  WHERE ${cond(spec.returnEvent, d)}
)`;
  return { head, key, diff };
}

export function compileRetention(
  spec: RetentionSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
): string {
  const breakdowns = breakdownProperties(spec.breakdown);
  const zone = zoneOf(spec, ctx, {
    from: range.from,
    to: horizonOf(range, spec.period ?? 'week', spec.periods ?? 8),
  });
  return retentionSql(spec as Spec, ctx, range, {
    bd: breakdownOf(breakdowns, ctx.dialect),
    extra: [],
    aggregation: parseAggregation(spec.aggregateBy),
    zone,
  });
}

function retentionSql(spec: Spec, ctx: QueryContext, range: TimeRange, o: BaseOptions): string {
  const d = ctx.dialect;
  const periods = spec.periods ?? 8;
  const base = compileBase(spec, ctx, range, o);
  const sizes = 'SELECT cbucket AS cohort, bd, 0 AS k, COUNT(*) AS n FROM c GROUP BY cbucket, bd';
  if (spec.cumulative) {
    // Each person's furthest return; the JavaScript side turns it into "k or later".
    return `${base.head},
mx AS (
  SELECT c.actor, c.cbucket, c.bd, MAX(${base.diff}) AS kmax
  FROM c JOIN a ON a.actor = c.actor
  WHERE a.abucket > c.cbucket AND ${base.diff} <= ${d.num(periods)}
  GROUP BY c.actor, c.cbucket, c.bd
)
SELECT cbucket AS cohort, bd, kmax AS k, COUNT(*) AS n FROM mx GROUP BY cbucket, bd, kmax
UNION ALL
${sizes}`;
  }
  return `${base.head}
SELECT c.cbucket AS cohort, c.bd AS bd, ${base.diff} AS k, COUNT(DISTINCT c.actor) AS n
FROM c JOIN a ON a.actor = c.actor
WHERE a.abucket > c.cbucket AND ${base.diff} <= ${d.num(periods)}
GROUP BY c.cbucket, c.bd, ${base.diff}
UNION ALL
${sizes}`;
}

type RetentionRow = { cohort: number; k: number; n: number };

/** Counts per cohort and period; with `cumulative`, period k counts everyone who got to k or later. */
function countsByCohort(
  rows: RetentionRow[],
  periods: number,
  cumulative: boolean,
): Map<number, number[]> {
  const byCohort = new Map<number, number[]>();
  for (const row of rows) {
    if (row.k < 0 || row.k > periods) continue;
    const counts = byCohort.get(row.cohort) ?? new Array<number>(periods + 1).fill(0);
    counts[row.k] = (counts[row.k] ?? 0) + row.n;
    byCohort.set(row.cohort, counts);
  }
  // Rows hold each person's furthest period: period k counts everyone whose furthest is k or more.
  if (cumulative)
    for (const counts of byCohort.values())
      for (let k = periods - 1; k >= 1; k--) counts[k]! += counts[k + 1]!;
  return byCohort;
}

/** Whole periods since `start` (calendar months for monthly cohorts). */
function elapsedPeriods(start: number, now: number, period: string, zone: Zone): number {
  if (period !== 'month')
    return Math.floor((now - start) / fixedIntervalMs(period as 'hour' | 'day' | 'week'));
  const a = new Date(start + offsetAt(zone, start));
  const b = new Date(now + offsetAt(zone, now));
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** The average at period k over cohorts old enough to have had it: weighted by size, or simple. */
function averageAt(cohorts: RetentionCohort[], k: number, simple: boolean): number {
  if (simple)
    return cohorts.length ? cohorts.reduce((a, c) => a + (c.rates[k] ?? 0), 0) / cohorts.length : 0;
  const people = cohorts.reduce((a, c) => a + c.size, 0);
  return people ? cohorts.reduce((a, c) => a + (c.counts[k] ?? 0), 0) / people : 0;
}

function table(rows: RetentionRow[], spec: Spec, zone: Zone, now: number): RetentionTable {
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const toStart = (cohort: number) =>
    period === 'month'
      ? localToUtc(zone, Date.UTC(Math.floor(cohort / 12), cohort % 12, 1))
      : cohort;
  const cohorts: RetentionCohort[] = [
    ...countsByCohort(rows, periods, Boolean(spec.cumulative)).entries(),
  ]
    .sort((a, b) => a[0] - b[0])
    .map(([cohort, counts]) => {
      const size = counts[0] ?? 0;
      return {
        start: toStart(cohort),
        size,
        counts,
        rates: counts.map((c) => (size ? c / size : 0)),
      };
    });
  const eligible = (k: number) =>
    cohorts.filter((c) => elapsedPeriods(c.start, now, period, zone) >= k && c.size > 0);
  const average = Array.from({ length: periods + 1 }, (_, k) =>
    averageAt(eligible(k), k, spec.meanMethod === 'simple'),
  );
  return { cohorts, average };
}

/** The tables per breakdown value: chosen cohorts in order, or the biggest values first. */
function breakdownTables(
  rows: (RetentionRow & { bd: string })[],
  spec: Spec,
  byCohort: boolean,
  zone: Zone,
  now: number,
): RetentionResult['breakdowns'] {
  const values = [...new Set(rows.map((r) => r.bd))];
  const size = (v: string) =>
    rows.filter((r) => r.bd === v && r.k === 0).reduce((a, r) => a + r.n, 0);
  const ordered = byCohort
    ? spec.cohortBreakdown!.map((c) => c.label).filter((l) => values.includes(l))
    : values.sort((a, b) => size(b) - size(a)).slice(0, spec.breakdownLimit ?? 10);
  return ordered.map((value) => ({
    value,
    ...table(
      rows.filter((r) => r.bd === value),
      spec,
      zone,
      now,
    ),
  }));
}

function retentionSummary(spec: Spec, result: RetentionResult, aggregation: Aggregation): string {
  const period = result.period;
  const total = result.cohorts.reduce((a, c) => a + c.size, 0);
  if (total === 0) return `No one did "${spec.cohortEvent.event}" in this range.`;
  const avg = result.average;
  const recurring = result.retentionType === 'recurring' ? 'recurring ' : '';
  const later = result.periods >= 4 ? `, ${period} 4 ${fmt(avg[4] ?? 0, 'percent')}` : '';
  const best = result.breakdowns?.length
    ? ` Best ${period}-1 retention: ${[...result.breakdowns].sort((a, b) => (b.average[1] ?? 0) - (a.average[1] ?? 0))[0]!.value}.`
    : '';
  return (
    `${fmt(total)} ${actorNoun(aggregation, total)} in ${result.cohorts.length} ${PERIOD_ADJECTIVE[period]} ${recurring}cohorts. ` +
    `Average retention${spec.cumulative ? ' (on or after)' : ''}: ${period} 1 ${fmt(avg[1] ?? 0, 'percent')}${later}.${best}`
  );
}

export async function runRetention(
  input: RetentionSpec,
  ctx: QueryContext,
): Promise<RetentionResult> {
  const spec = input as Spec;
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const now = ctx.now ?? Date.now();
  const aggregation = parseAggregation(spec.aggregateBy);
  const zone = zoneOf(spec, ctx, { from: range.from, to: horizonOf(range, period, periods) });
  const breakdowns = breakdownProperties(spec.breakdown);
  const byCohort = isCohortBreakdown(breakdowns);
  if (byCohort && !spec.cohortBreakdown?.length)
    throw new TypeError(
      'breakdown "cohort" needs breakdownCohorts: saved cohort keys (list_cohorts).',
    );
  const parts = byCohort
    ? spec.cohortBreakdown!.map((c) => ({ bd: () => d.str(c.label), extra: [c.filter] }))
    : [{ bd: breakdownOf(breakdowns, d), extra: [] as Filter[] }];
  const sql: string[] = [];
  const rows: (RetentionRow & { bd: string })[] = [];
  const runPart = async (p: (typeof parts)[number]) => {
    const q = retentionSql(spec, ctx, range, { bd: p.bd, extra: p.extra, aggregation, zone });
    sql.push(q);
    for (const r of await ctx.execute(q))
      rows.push({ cohort: num(r.cohort), bd: text(r.bd), k: num(r.k), n: num(r.n) });
  };
  await Promise.all(parts.map(runPart));
  const result: RetentionResult = {
    kind: 'retention',
    period,
    periods,
    retentionType:
      (spec.retentionType ?? 'first_time') === 'recurring' ? 'recurring' : 'first_time',
    cumulative: Boolean(spec.cumulative),
    ...table(rows, spec, zone, now),
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary: '',
  };
  if (breakdowns.length) result.breakdowns = breakdownTables(rows, spec, byCohort, zone, now);
  result.summary = retentionSummary(spec, result, aggregation);
  return result;
}

// ── Drill-down ───────────────────────────────────────────────────────────────

/**
 * The actors in one retention cell: the cohort that started at `cohort` (the
 * result's `start`), and of them those who came back in `period` (0: the whole
 * cohort). SQL selecting `actor` and `n` (always 1).
 */
export function compileRetentionActors(
  input: RetentionSpec,
  ctx: QueryContext,
  selection: { cohort: number; period: number; breakdown?: string },
  page: { limit: number; offset: number },
): string {
  const spec = input as Spec;
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const aggregation = parseAggregation(spec.aggregateBy);
  const zone = zoneOf(spec, ctx, { from: range.from, to: horizonOf(range, period, periods) });
  const breakdowns = breakdownProperties(spec.breakdown);
  let bd = breakdownOf(breakdowns, d);
  let extra: Filter[] = [];
  if (isCohortBreakdown(breakdowns) && selection.breakdown !== undefined) {
    const c = spec.cohortBreakdown?.find(
      (x) => x.label === selection.breakdown || x.key === selection.breakdown,
    );
    if (c) {
      bd = () => d.str(c.label);
      extra = [c.filter];
    }
  }
  const base = compileBase(spec, ctx, range, { bd, extra, aggregation, zone });
  const local = selection.cohort + offsetAt(zone, selection.cohort);
  const cohortKey =
    period === 'month'
      ? new Date(local).getUTCFullYear() * 12 + new Date(local).getUTCMonth()
      : selection.cohort;
  const where = [`c.cbucket = ${d.num(cohortKey)}`];
  if (selection.breakdown !== undefined && breakdowns.length && !isCohortBreakdown(breakdowns)) {
    where.push(`c.bd = ${d.str(selection.breakdown)}`);
  }
  const pageSql = `ORDER BY actor LIMIT ${d.num(page.limit)} OFFSET ${d.num(page.offset)}`;
  if (selection.period === 0) {
    return `${base.head}
SELECT c.actor AS actor, 1 AS n FROM c WHERE ${where.join(' AND ')} ${pageSql}`;
  }
  const k = d.num(selection.period);
  const match = spec.cumulative
    ? `${base.diff} >= ${k} AND ${base.diff} <= ${d.num(periods)}`
    : `${base.diff} = ${k}`;
  return `${base.head}
SELECT DISTINCT c.actor AS actor, 1 AS n FROM c JOIN a ON a.actor = c.actor
WHERE ${where.join(' AND ')} AND a.abucket > c.cbucket AND ${match}
${pageSql}`;
}
