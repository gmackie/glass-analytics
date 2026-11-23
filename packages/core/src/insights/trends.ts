/**
 * Trends: an aggregate of events per time bucket, optionally broken down by a property.
 *
 * Each series compiles to one or two queries depending on its math:
 *
 * - plain aggregates (counts, unique actors, sums, averages, min/max, averages per
 *   actor) are one GROUP BY per bucket plus one for the range totals;
 * - percentiles of a property come back as sketch cells (sql/sketch.ts) and are
 *   resolved in JavaScript; percentiles of per-actor counts as exact count
 *   distributions;
 * - rolling unique counts (wau, mau) join each bucket's window from a VALUES list;
 * - first_time finds each actor's first occurrence over all history.
 *
 * Cumulative totals and smoothing shape the finished series in JavaScript, so
 * they behave the same for every math; formulas are computed from the shaped
 * series, and trend lines are fitted last.
 */

import type { Filter } from '../filters.ts';
import { evaluateFormula, type FormulaNode, parseFormula } from '../formula.ts';
import {
  breakdownExpr,
  breakdownProperties,
  filtersSql,
  propertyNumber,
  propertyText,
} from '../sql/filters.ts';
import { literalRows } from '../sql/rows.ts';
import { exactQuantile, type SketchCell, sketchColumns, sketchQuantile } from '../sql/sketch.ts';
import {
  type Aggregation,
  actorNoun,
  bucketExpr,
  eventsCte,
  num,
  parseAggregation,
  text,
} from '../sql/source.ts';
import {
  bucketStart,
  bucketsBetween,
  DAY_MS,
  type Interval,
  iso,
  localToUtc,
  offsetAt,
  resolveRange,
  type TimeRange,
  type Zone,
} from '../time.ts';
import { type CohortBreakdown, type NumericBin, numericBins } from './breakdowns.ts';
import type { TrendsMath, TrendsSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, zoneOf } from './types.ts';

export type { CohortBreakdown } from './breakdowns.ts';

export interface TrendsSeries {
  label: string;
  /** Breakdown value, or null when the query has no breakdown. */
  breakdown: string | null;
  /** One value per bucket, aligned with `buckets` (cumulative or smoothed when asked). */
  values: number[];
  /** Total over the range. For unique counts this is the number of distinct actors, not a sum. */
  total: number;
  /** Index of the spec series (or formula) this line belongs to. */
  seriesIndex: number;
  math: TrendsMath | 'formula';
  /** The formula, for formula lines. */
  formula?: string;
  /** "percent" when a formula's values are ratios to show as percentages. */
  format?: 'percent';
  /** Least-squares fit of `values`, when `trendLine` is set. */
  trendLine?: number[];
}

export interface TrendsResult extends ResultBase {
  kind: 'trends';
  interval: Interval;
  /** Bucket starts, epoch ms. */
  buckets: number[];
  series: TrendsSeries[];
  /** Formula lines, when the spec has formulas. */
  formulas?: TrendsSeries[];
  /** The previous period of the same length, when `compare` is set. */
  compare?: {
    range: { from: string; to: string };
    buckets: number[];
    series: TrendsSeries[];
    formulas?: TrendsSeries[];
  };
  /** Numeric breakdown ranges, in order, when `breakdownBins` is set. */
  bins?: { label: string; from: number; to: number }[];
}

type Series = TrendsSpec['series'][number];

type Spec = TrendsSpec & { cohortBreakdown?: CohortBreakdown[] };

const QUANTILES: Record<string, number> = {
  median: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};
const PROPERTY_MATHS = new Set<TrendsMath>([
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p75',
  'p90',
  'p95',
  'p99',
]);
const ROLLING_DAYS: Partial<Record<TrendsMath, number>> = { wau: 7, mau: 30 };
/** Maths whose per-breakdown values add up, so small breakdown values can be summed into "Other". */
const ADDITIVE = new Set<TrendsMath>(['total', 'sum', 'revenue', 'first_time']);
/** Revenue in the base currency, written at ingest for revenue events (see settings.revenueEvents). */
export const REVENUE_PROPERTY = '$revenue_base';

const quantileOf = (math: TrendsMath) =>
  QUANTILES[math.replace('_count_per_actor', '')] ?? undefined;

function eventsOf(series: Series): string[] | undefined {
  const list = Array.isArray(series.event) ? series.event : [series.event];
  return list.includes('*') ? undefined : list;
}

function eventName(series: Series): string {
  return Array.isArray(series.event) ? series.event.join(' or ') : series.event;
}

function seriesLabel(s: Series): string {
  if (s.label) return s.label;
  const math = s.math ?? 'total';
  const name = eventName(s);
  if (math === 'total') return name;
  return `${name} (${math}${s.property ? ` of ${s.property}` : ''})`;
}

/** What a compiled series needs: its SQL and how to turn rows into values per breakdown. */
interface SeriesPlan {
  sql: string[];
  shape(rows: Record<string, unknown>[][]): {
    values: Map<string, Map<number, number>>;
    totals: Map<string, number>;
    /** Breakdown ranking weight: the total, or the number of events for percentiles. */
    rank: Map<string, number>;
  };
}

interface CompileContext {
  ctx: QueryContext;
  range: TimeRange;
  zone: Zone;
  interval: Interval;
  buckets: number[];
  aggregation: Aggregation;
  bd: string;
  /** Extra filters (cohort breakdown). */
  extra: Filter[];
}

function mathOf(series: Series): TrendsMath {
  const math = series.math ?? 'total';
  if (PROPERTY_MATHS.has(math) && !series.property) {
    throw new TypeError(
      `Series "${eventName(series)}" uses math "${math}" but has no "property". Name a numeric property, e.g. "amount".`,
    );
  }
  if (math === 'unique_groups' && !series.groupType) {
    throw new TypeError(
      `Series "${eventName(series)}" uses math "unique_groups" but has no "groupType", e.g. "company".`,
    );
  }
  return math;
}

/** The inner rows every math reads: bucket, breakdown value, actor, session, value. */
function innerRows(series: Series, c: CompileContext, withBucket = true): string {
  const d = c.ctx.dialect;
  const math = mathOf(series);
  const property = math === 'revenue' ? `props.${REVENUE_PROPERTY}` : series.property;
  const val = property ? propertyNumber(property, d) : 'NULL';
  const grp = math === 'unique_groups' ? propertyText(`group.${series.groupType}`, d) : `''`;
  const events = eventsOf(series);
  // Spec-level and cohort filters are applied in the events CTE; these are the series' own.
  const where = [
    events ? `event IN (${events.map((e) => d.str(e)).join(', ')})` : '1 = 1',
    filtersSql(series.filters, d),
  ];
  if (math === 'unique_groups') where.push(`${grp} IS NOT NULL AND ${grp} <> ''`);
  const bucket = withBucket ? `${bucketExpr(d, 'ts_ms', c.interval, c.zone)} AS bucket, ` : '';
  return `SELECT ${bucket}${c.bd} AS bd, actor, session_id, ts_ms, ${val} AS val, ${grp} AS grp
    FROM ev WHERE ${where.join(' AND ')}`;
}

function aggregateSql(math: TrendsMath, d: QueryContext['dialect']): string {
  switch (math) {
    case 'total':
      return 'COUNT(*)';
    case 'dau':
    case 'unique_persons':
      return 'COUNT(DISTINCT actor)';
    case 'unique_sessions':
      return 'COUNT(DISTINCT session_id)';
    case 'unique_groups':
      return 'COUNT(DISTINCT grp)';
    case 'sum':
    case 'revenue':
      return 'SUM(val)';
    case 'avg':
      return 'AVG(val)';
    case 'min':
      return 'MIN(val)';
    case 'max':
      return 'MAX(val)';
    case 'avg_count_per_actor':
      return `(COUNT(*) * 1.0 / COUNT(DISTINCT actor))`;
    default:
      throw new TypeError(`No plain aggregate for math "${math}" (${d.name})`);
  }
}

/** Group rows into value maps: bd → bucket → value. */
function collect(
  rows: Record<string, unknown>[],
  value: (r: Record<string, unknown>) => number,
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const bd = text(r.bd);
    const m = out.get(bd) ?? new Map<number, number>();
    m.set(num(r.bucket), value(r));
    out.set(bd, m);
  }
  return out;
}

function plainPlan(series: Series, c: CompileContext, spec: Spec, filters: Filter[]): SeriesPlan {
  const d = c.ctx.dialect;
  const math = mathOf(series);
  const head = `WITH ${eventsCteWith(series, c, spec, filters)}`;
  let perBucket: string;
  let totals: string;
  if (math === 'min_count_per_actor' || math === 'max_count_per_actor') {
    const agg = math === 'min_count_per_actor' ? 'MIN(c)' : 'MAX(c)';
    perBucket = `${head}
SELECT bucket, bd, ${agg} AS agg FROM (
  SELECT bucket, bd, actor, COUNT(*) AS c FROM (${innerRows(series, c)}) t GROUP BY bucket, bd, actor
) x GROUP BY bucket, bd ORDER BY bucket LIMIT 50000`;
    totals = `${head}
SELECT bd, ${agg} AS agg FROM (
  SELECT bd, actor, COUNT(*) AS c FROM (${innerRows(series, c, false)}) t GROUP BY bd, actor
) x GROUP BY bd ORDER BY agg DESC, bd ASC LIMIT 1000`;
  } else {
    const agg = aggregateSql(math, d);
    perBucket = `${head}
SELECT bucket, bd, ${agg} AS agg
FROM (${innerRows(series, c)}) t
GROUP BY bucket, bd
ORDER BY bucket
LIMIT 50000`;
    totals = `${head}
SELECT bd, ${agg} AS agg
FROM (${innerRows(series, c, false)}) t
GROUP BY bd
ORDER BY agg DESC, bd ASC
LIMIT 1000`;
  }
  return {
    sql: [perBucket, totals],
    shape([rows, totalRows]) {
      const totalsMap = new Map(totalRows!.map((r) => [text(r.bd), num(r.agg)]));
      return { values: collect(rows!, (r) => num(r.agg)), totals: totalsMap, rank: totalsMap };
    },
  };
}

/** Percentiles: sketch cells for a property, exact count distributions per actor. */
function distributionPlan(
  series: Series,
  c: CompileContext,
  spec: Spec,
  filters: Filter[],
): SeriesPlan {
  const d = c.ctx.dialect;
  const math = mathOf(series);
  const q = quantileOf(math)!;
  const head = `WITH ${eventsCteWith(series, c, spec, filters)}`;
  const perActor = math.endsWith('_count_per_actor');
  let perBucket: string;
  let totals: string;
  if (perActor) {
    perBucket = `${head}
SELECT bucket, bd, 0 AS sign, c AS k, COUNT(*) AS n FROM (
  SELECT bucket, bd, actor, COUNT(*) AS c FROM (${innerRows(series, c)}) t GROUP BY bucket, bd, actor
) x GROUP BY bucket, bd, c LIMIT 100000`;
    totals = `${head}
SELECT bd, 0 AS sign, c AS k, COUNT(*) AS n FROM (
  SELECT bd, actor, COUNT(*) AS c FROM (${innerRows(series, c, false)}) t GROUP BY bd, actor
) x GROUP BY bd, c LIMIT 100000`;
  } else {
    const sk = sketchColumns(d, 'val');
    perBucket = `${head}
SELECT bucket, bd, ${sk.sign} AS sign, ${sk.key} AS k, COUNT(*) AS n
FROM (${innerRows(series, c)}) t WHERE val IS NOT NULL
GROUP BY bucket, bd, ${sk.sign}, ${sk.key} LIMIT 100000`;
    totals = `${head}
SELECT bd, ${sk.sign} AS sign, ${sk.key} AS k, COUNT(*) AS n
FROM (${innerRows(series, c, false)}) t WHERE val IS NOT NULL
GROUP BY bd, ${sk.sign}, ${sk.key} LIMIT 100000`;
  }
  const resolve = (cells: SketchCell[]) =>
    (perActor
      ? exactQuantile(
          cells.map((x) => ({ value: x.key, n: x.n })),
          q,
        )
      : sketchQuantile(cells, q)) ?? 0;
  return {
    sql: [perBucket, totals],
    shape([rows, totalRows]) {
      const groups = new Map<string, Map<number, SketchCell[]>>();
      for (const r of rows!) {
        const bd = text(r.bd);
        const byBucket = groups.get(bd) ?? new Map<number, SketchCell[]>();
        const b = num(r.bucket);
        const list = byBucket.get(b) ?? [];
        list.push({ sign: num(r.sign), key: num(r.k), n: num(r.n) });
        byBucket.set(b, list);
        groups.set(bd, byBucket);
      }
      const values = new Map<string, Map<number, number>>();
      for (const [bd, byBucket] of groups) {
        values.set(bd, new Map([...byBucket].map(([b, cells]) => [b, resolve(cells)])));
      }
      const totalCells = new Map<string, SketchCell[]>();
      for (const r of totalRows!) {
        const bd = text(r.bd);
        const list = totalCells.get(bd) ?? [];
        list.push({ sign: num(r.sign), key: num(r.k), n: num(r.n) });
        totalCells.set(bd, list);
      }
      const totals = new Map([...totalCells].map(([bd, cells]) => [bd, resolve(cells)]));
      const rank = new Map(
        [...totalCells].map(([bd, cells]) => [bd, cells.reduce((a, x) => a + x.n, 0)]),
      );
      return { values, totals, rank };
    },
  };
}

/** wau / mau: unique actors in the N days up to the end of each bucket. */
function rollingPlan(series: Series, c: CompileContext, spec: Spec, filters: Filter[]): SeriesPlan {
  const d = c.ctx.dialect;
  const days = ROLLING_DAYS[mathOf(series)]!;
  if (c.buckets.length > 400) {
    throw new RangeError(
      `${series.math} over ${c.buckets.length} intervals is too many; use a longer interval (e.g. "day" or "week") or a shorter range.`,
    );
  }
  const windows = c.buckets.map((b, i) => {
    const end = Math.min(c.buckets[i + 1] ?? c.range.to, c.range.to);
    const lastDay = bucketStart(Math.max(b, end - 1), 'day', c.zone);
    const lastLocal = lastDay + offsetAt(c.zone, lastDay);
    return {
      b,
      s: localToUtc(c.zone, lastLocal - (days - 1) * DAY_MS),
      e: localToUtc(c.zone, lastLocal + DAY_MS),
    };
  });
  const from = Math.min(c.range.from, ...windows.map((w) => w.s));
  const values = literalRows(windows.map((w) => [d.num(w.b), d.num(w.s), d.num(w.e)]));
  const head = `WITH ${eventsCteWith(series, c, spec, filters, from)},
w AS (SELECT column1 AS b, column2 AS s, column3 AS e FROM (${values}) v),
a AS (SELECT DISTINCT bd, actor, ${bucketExpr(d, 'ts_ms', 'day', c.zone)} AS day FROM (${innerRows(series, c, false)}) t)`;
  const perBucket = `${head}
SELECT b AS bucket, bd, COUNT(*) AS agg FROM (
  SELECT DISTINCT w.b, a.bd, a.actor FROM w JOIN a ON a.day >= w.s AND a.day < w.e
) x GROUP BY b, bd ORDER BY b LIMIT 50000`;
  return {
    sql: [perBucket],
    shape([rows]) {
      const values = collect(rows!, (r) => num(r.agg));
      const last = c.buckets.at(-1)!;
      // The total of a rolling count is where it ends: this week's or this month's actives.
      const totals = new Map([...values].map(([bd, m]) => [bd, m.get(last) ?? 0]));
      return { values, totals, rank: totals };
    },
  };
}

/** first_time: actors whose first-ever matching event falls in each bucket. */
function firstTimePlan(
  series: Series,
  c: CompileContext,
  spec: Spec,
  filters: Filter[],
): SeriesPlan {
  const d = c.ctx.dialect;
  // "First ever" means all history, not just the range.
  const head = `WITH ${eventsCteWith(series, c, spec, filters, 0)},
f AS (SELECT actor, MIN(ts_ms) AS t0 FROM (${innerRows(series, c, false)}) t GROUP BY actor),
fe AS (
  SELECT f.actor, f.t0, MIN(t.bd) AS bd
  FROM f JOIN (${innerRows(series, c, false)}) t ON t.actor = f.actor AND t.ts_ms = f.t0
  GROUP BY f.actor, f.t0
)`;
  const inRange = `t0 >= ${d.num(c.range.from)} AND t0 < ${d.num(c.range.to)}`;
  const perBucket = `${head}
SELECT ${bucketExpr(d, 't0', c.interval, c.zone)} AS bucket, bd, COUNT(*) AS agg
FROM fe WHERE ${inRange} GROUP BY ${bucketExpr(d, 't0', c.interval, c.zone)}, bd ORDER BY bucket LIMIT 50000`;
  const totals = `${head}
SELECT bd, COUNT(*) AS agg FROM fe WHERE ${inRange} GROUP BY bd ORDER BY agg DESC, bd ASC LIMIT 1000`;
  return {
    sql: [perBucket, totals],
    shape([rows, totalRows]) {
      const totalsMap = new Map(totalRows!.map((r) => [text(r.bd), num(r.agg)]));
      return { values: collect(rows!, (r) => num(r.agg)), totals: totalsMap, rank: totalsMap };
    },
  };
}

function eventsCteWith(
  series: Series,
  c: CompileContext,
  spec: Spec,
  filters: Filter[],
  from = c.range.from,
): string {
  return eventsCte(c.ctx.dialect, {
    project: c.ctx.project,
    from,
    to: c.range.to,
    events: eventsOf(series),
    filters: [...(spec.filters ?? []), ...filters] as Filter[],
    aggregation: c.aggregation,
  });
}

function planFor(series: Series, c: CompileContext, spec: Spec, filters: Filter[]): SeriesPlan {
  const math = mathOf(series);
  if (ROLLING_DAYS[math]) return rollingPlan(series, c, spec, filters);
  if (math === 'first_time') return firstTimePlan(series, c, spec, filters);
  if (quantileOf(math) !== undefined) return distributionPlan(series, c, spec, filters);
  return plainPlan(series, c, spec, filters);
}

/** Kept for callers that compiled one series directly (CLI `--sql`, tests). */
export function compileTrendsSeries(
  spec: TrendsSpec,
  series: Series,
  ctx: QueryContext,
  range: { from: number; to: number },
) {
  const interval = spec.interval ?? 'day';
  const zone = zoneOf(spec, ctx, range);
  const breakdowns = breakdownProperties(spec.breakdown);
  const c: CompileContext = {
    ctx,
    range,
    zone,
    interval,
    buckets: bucketsBetween(range, interval, zone),
    aggregation: parseAggregation(spec.aggregateBy),
    bd: breakdowns.length ? breakdownExpr(breakdowns, ctx.dialect) : "''",
    extra: [],
  };
  const plan = planFor(series, c, spec, []);
  return { perBucket: plan.sql[0]!, totals: plan.sql[1] ?? plan.sql[0]! };
}

/** Running totals, then a trailing moving average. */
function shape(line: TrendsSeries, spec: TrendsSpec): TrendsSeries {
  let values = line.values;
  if (spec.cumulative) {
    let sum = 0;
    values = values.map((v) => (sum += v));
  }
  if (spec.smoothing && spec.smoothing > 1) {
    const k = spec.smoothing;
    values = values.map((_, i) => {
      const window = values.slice(Math.max(0, i - k + 1), i + 1);
      return window.reduce((a, v) => a + v, 0) / window.length;
    });
  }
  return { ...line, values };
}

/** A least-squares line through the (shaped) values. */
function withTrendLine(line: TrendsSeries, spec: TrendsSpec): TrendsSeries {
  const values = line.values;
  const out: TrendsSeries = { ...line };
  if (spec.trendLine && values.length > 1) {
    const n = values.length;
    const mx = (n - 1) / 2;
    const my = values.reduce((a, v) => a + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    values.forEach((v, i) => {
      sxy += (i - mx) * (v - my);
      sxx += (i - mx) ** 2;
    });
    const slope = sxx ? sxy / sxx : 0;
    out.trendLine = values.map((_, i) => my + slope * (i - mx));
  }
  return out;
}

type Formula = NonNullable<TrendsSpec['formulas']>[number];

/** One formula's line for one breakdown value (or the only line, without a breakdown). */
function formulaLine(
  f: Formula,
  index: number,
  tree: FormulaNode,
  inputs: (TrendsSeries | null)[],
  buckets: number[],
  key: string | null,
): TrendsSeries {
  const at = (b: number) => inputs.map((s) => s?.values[b] ?? 0);
  const label = f.label ?? f.expr;
  return {
    label: key ? `${label} · ${key}` : label,
    breakdown: key,
    values: buckets.map((_, b) => evaluateFormula(tree, at(b))),
    total: evaluateFormula(
      tree,
      inputs.map((s) => s?.total ?? 0),
    ),
    seriesIndex: index,
    math: 'formula',
    formula: f.expr,
    ...(f.format === 'percent' ? { format: 'percent' as const } : {}),
  };
}

function formulaLines(spec: TrendsSpec, series: TrendsSeries[], buckets: number[]): TrendsSeries[] {
  if (!spec.formulas?.length) return [];
  const keys = [...new Set(series.map((s) => s.breakdown ?? ''))];
  const broken = series.some((s) => s.breakdown !== null);
  return spec.formulas.flatMap((f, fi) => {
    const tree = parseFormula(f.expr, spec.series.length);
    return keys.map((key) => {
      const inputs = spec.series.map(
        (_, i) => series.find((s) => s.seriesIndex === i && (s.breakdown ?? '') === key) ?? null,
      );
      return formulaLine(f, fi, tree, inputs, buckets, broken ? key : null);
    });
  });
}

type Shaped = ReturnType<SeriesPlan['shape']>;

/** What a trends run settles before querying. */
interface TrendsSetup {
  spec: Spec;
  range: TimeRange;
  interval: Interval;
  zone: Zone;
  buckets: number[];
  index: Map<number, number>;
  aggregation: Aggregation;
  breakdowns: string[];
  byCohort: boolean;
}

function trendsSetup(spec: Spec, ctx: QueryContext): TrendsSetup {
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const interval = spec.interval ?? 'day';
  if (interval === 'minute' && range.to - range.from > 2 * DAY_MS)
    throw new RangeError(
      '"minute" intervals work for ranges up to two days; use "hour" for longer.',
    );
  const breakdowns = breakdownProperties(spec.breakdown);
  const byCohort = breakdowns.length === 1 && breakdowns[0] === 'cohort';
  if (byCohort && !spec.cohortBreakdown?.length)
    throw new TypeError(
      'breakdown "cohort" needs breakdownCohorts: the saved cohort keys to compare (list_cohorts).',
    );
  const zone = zoneOf(spec, ctx, range);
  const buckets = bucketsBetween(range, interval, zone);
  return {
    spec,
    range,
    interval,
    zone,
    buckets,
    index: new Map(buckets.map((b, i) => [b, i])),
    aggregation: parseAggregation(spec.aggregateBy),
    breakdowns,
    byCohort,
  };
}

/** The breakdown column, and numeric bins when the breakdown is split into ranges. */
async function breakdownColumn(t: TrendsSetup, ctx: QueryContext, sql: string[]) {
  const { spec, breakdowns, byCohort } = t;
  const expr = breakdowns.length && !byCohort ? breakdownExpr(breakdowns, ctx.dialect) : "''";
  if (!spec.breakdownBins || breakdowns.length !== 1 || byCohort) return { expr, bins: undefined };
  const b = await numericBins(ctx, t.range, {
    events: [...new Set(spec.series.flatMap((s) => eventsOf(s) ?? ['*']))],
    filters: spec.filters as Filter[] | undefined,
    aggregation: t.aggregation,
    property: breakdowns[0]!,
    bins: spec.breakdownBins,
  });
  sql.push(b.sql);
  return { expr: b.expr, bins: b.bins };
}

interface Part {
  series: Series;
  i: number;
  bd: string;
  extra: Filter[];
}

/** Each series runs once, or once per cohort when breaking down by cohort. */
function trendParts(t: TrendsSetup, ctx: QueryContext, bdExpr: string): Part[] {
  return t.spec.series.flatMap((series, i) =>
    t.byCohort
      ? t.spec.cohortBreakdown!.map((cohort) => ({
          series,
          i,
          bd: ctx.dialect.str(cohort.label),
          extra: [cohort.filter],
        }))
      : [{ series, i, bd: bdExpr, extra: [] as Filter[] }],
  );
}

async function runTrendPart(p: Part, t: TrendsSetup, ctx: QueryContext, sql: string[]) {
  const c: CompileContext = {
    ctx,
    range: t.range,
    zone: t.zone,
    interval: t.interval,
    buckets: t.buckets,
    aggregation: t.aggregation,
    bd: p.bd,
    extra: p.extra,
  };
  const plan = planFor(p.series, c, t.spec, p.extra);
  sql.push(...plan.sql);
  const rows = await Promise.all(plan.sql.map((q) => ctx.execute(q)));
  return { ...p, shaped: plan.shape(rows) };
}

/** One series' values, totals and ranks, from its part (or its parts, one per cohort). */
function mergeShaped(results: (Part & { shaped: Shaped })[], i: number): Shaped {
  const out: Shaped = { values: new Map(), totals: new Map(), rank: new Map() };
  for (const r of results.filter((x) => x.i === i)) {
    for (const [k, v] of r.shaped.values) out.values.set(k, v);
    for (const [k, v] of r.shaped.totals) out.totals.set(k, v);
    for (const [k, v] of r.shaped.rank) out.rank.set(k, v);
  }
  return out;
}

/** The breakdown values to show, and the rest (summed into "Other" where that adds up). */
function keptKeys(
  t: TrendsSetup,
  m: Shaped,
  bins: NumericBin[] | undefined,
): { keep: string[]; other: string[] } {
  if (!t.breakdowns.length) return { keep: [''], other: [] };
  if (bins || t.byCohort) {
    const order = bins
      ? [...bins.map((b) => b.label), '(none)']
      : t.spec.cohortBreakdown!.map((c) => c.label);
    return { keep: order.filter((k) => m.values.has(k) || m.totals.has(k)), other: [] };
  }
  const limit = t.spec.breakdownLimit ?? 10;
  const ranked = [...new Set([...m.rank.keys(), ...m.values.keys()])].sort(
    (a, b) => (m.rank.get(b) ?? 0) - (m.rank.get(a) ?? 0) || a.localeCompare(b),
  );
  return { keep: ranked.slice(0, limit), other: ranked.slice(limit) };
}

/** A breakdown value's values, one per bucket. */
function rowOf(t: TrendsSetup, m: Shaped, key: string): number[] {
  const arr = new Array<number>(t.buckets.length).fill(0);
  for (const [b, v] of m.values.get(key) ?? []) {
    const slot = t.index.get(b);
    if (slot !== undefined) arr[slot] = (arr[slot] ?? 0) + v;
  }
  return arr;
}

function seriesLines(
  t: TrendsSetup,
  i: number,
  m: Shaped,
  bins: NumericBin[] | undefined,
): TrendsSeries[] {
  const series = t.spec.series[i]!;
  const math = mathOf(series);
  const label = seriesLabel(series);
  const broken = t.breakdowns.length > 0;
  const { keep, other } = keptKeys(t, m, bins);
  const lines: TrendsSeries[] = keep.map((key) => ({
    label: broken ? `${label} · ${key}` : label,
    breakdown: broken ? key : null,
    values: rowOf(t, m, key),
    total: m.totals.get(key) ?? 0,
    seriesIndex: i,
    math,
  }));
  if (!other.length || !ADDITIVE.has(math)) return lines;
  const values = new Array<number>(t.buckets.length).fill(0);
  for (const key of other)
    rowOf(t, m, key).forEach((v, b) => {
      values[b]! += v;
    });
  const total = other.reduce((a, k) => a + (m.totals.get(k) ?? 0), 0);
  return [
    ...lines,
    { label: `${label} · Other`, breakdown: 'Other', values, total, seriesIndex: i, math },
  ];
}

/** The same query over the previous period of the same length. */
async function previousPeriod(
  t: TrendsSetup,
  ctx: QueryContext,
  sql: string[],
): Promise<TrendsResult['compare']> {
  const length = t.range.to - t.range.from;
  const prev = await runTrends(
    { ...t.spec, from: t.range.from - length, to: t.range.from, compare: false } as TrendsSpec,
    ctx,
  );
  sql.push(...prev.sql);
  return {
    range: prev.range,
    buckets: prev.buckets,
    series: prev.series,
    ...(prev.formulas ? { formulas: prev.formulas } : {}),
  };
}

function trendsSummary(t: TrendsSetup, shown: TrendsSeries[]): string {
  const head = shown
    .slice(0, 5)
    .map((s) => `${s.label}: ${fmt(s.total, Number.isInteger(s.total) ? 'count' : 'decimal')}`)
    .join('; ');
  const counted =
    t.aggregation === 'person' ? '' : ` Unique counts are of ${actorNoun(t.aggregation)}.`;
  const zone = t.zone.name === 'UTC' ? '' : ` (${t.zone.name})`;
  const period = `${iso(t.range.from).slice(0, 10)} to ${iso(t.range.to).slice(0, 10)} by ${t.interval}${zone}`;
  return `${period}. ${head ? `${head}.` : 'No data.'}${counted}`;
}

export async function runTrends(input: TrendsSpec, ctx: QueryContext): Promise<TrendsResult> {
  const spec = input as Spec;
  const t = trendsSetup(spec, ctx);
  const sql: string[] = [];
  const { expr, bins } = await breakdownColumn(t, ctx, sql);
  const results = await Promise.all(
    trendParts(t, ctx, expr).map((p) => runTrendPart(p, t, ctx, sql)),
  );
  const out = spec.series.flatMap((_, i) => seriesLines(t, i, mergeShaped(results, i), bins));
  // Formulas read the shaped series, so with running totals "B / A" is cumulative B over
  // cumulative A (it ends at the formula of the totals), not a running sum of daily ratios.
  const shaped = out.map((l) => shape(l, spec));
  const series = shaped.map((l) => withTrendLine(l, spec));
  const formulas = formulaLines(spec, shaped, t.buckets).map((l) => withTrendLine(l, spec));
  const compare = spec.compare ? await previousPeriod(t, ctx, sql) : undefined;
  return {
    kind: 'trends',
    interval: t.interval,
    buckets: t.buckets,
    series,
    ...(formulas.length ? { formulas } : {}),
    ...(compare ? { compare } : {}),
    ...(bins ? { bins } : {}),
    sql,
    range: { from: iso(t.range.from), to: iso(t.range.to) },
    summary: trendsSummary(t, spec.formulaOnly && formulas.length ? formulas : series),
  };
}

// ── Drill-down ───────────────────────────────────────────────────────────────

export interface TrendsActorSelection {
  /** Index of the series (in spec order). */
  series: number;
  /** Bucket start (from `buckets`); omit for the whole range. */
  bucket?: number;
  /** Breakdown value; omit for all values. */
  breakdown?: string;
}

/**
 * The actors behind one point of a trends chart: who did the series' events in that
 * bucket (or, for wau/mau, in the window ending there; for first_time, for the first
 * time there), with how many matching events each. Returns SQL selecting `actor` and `n`.
 */
/** The time window behind one point: its bucket, or the whole rolling window for WAU/MAU. */
function pointWindow(
  selection: TrendsActorSelection,
  math: TrendsMath,
  t: { range: TimeRange; buckets: number[]; zone: Zone },
): { from: number; to: number } {
  if (selection.bucket === undefined) return { from: t.range.from, to: t.range.to };
  const i = t.buckets.indexOf(selection.bucket);
  if (i < 0) throw new RangeError('That bucket is not in the range of this spec.');
  const from = selection.bucket;
  const to = Math.min(t.buckets[i + 1] ?? t.range.to, t.range.to);
  const days = ROLLING_DAYS[math];
  if (!days) return { from, to };
  const lastDay = bucketStart(Math.max(from, to - 1), 'day', t.zone);
  const local = lastDay + offsetAt(t.zone, lastDay);
  return {
    from: localToUtc(t.zone, local - (days - 1) * DAY_MS),
    to: localToUtc(t.zone, local + DAY_MS),
  };
}

/** The cohort a selection's breakdown value names, when breaking down by cohort. */
function selectedCohort(spec: Spec, breakdowns: string[], value: string | undefined) {
  if (breakdowns[0] !== 'cohort' || !value) return undefined;
  return spec.cohortBreakdown?.find((c) => c.label === value || c.key === value);
}

export function compileTrendsActors(
  input: TrendsSpec,
  ctx: QueryContext,
  selection: TrendsActorSelection,
  page: { limit: number; offset: number },
): string {
  const spec = input as Spec;
  const series = spec.series[selection.series];
  if (!series)
    throw new RangeError(`No series ${selection.series}; the spec has ${spec.series.length}.`);
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const interval = spec.interval ?? 'day';
  const zone = zoneOf(spec, ctx, range);
  const buckets = bucketsBetween(range, interval, zone);
  const breakdowns = breakdownProperties(spec.breakdown);
  const cohort = selectedCohort(spec, breakdowns, selection.breakdown);
  const bd = breakdowns.length && breakdowns[0] !== 'cohort' ? breakdownExpr(breakdowns, d) : "''";
  const c: CompileContext = {
    ctx,
    range,
    zone,
    interval,
    buckets,
    aggregation: parseAggregation(spec.aggregateBy),
    bd,
    extra: cohort ? [cohort.filter] : [],
  };
  const math = mathOf(series);
  const { from, to } = pointWindow(selection, math, { range, buckets, zone });
  const bdCond =
    selection.breakdown !== undefined && !cohort && breakdowns.length
      ? `AND bd = ${d.str(selection.breakdown)}`
      : '';
  const historyFrom = math === 'first_time' ? 0 : from;
  const head = `WITH ${eventsCteWith(series, c, spec, c.extra, Math.min(historyFrom, from))}`;
  const page_ = `ORDER BY n DESC, actor ASC LIMIT ${d.num(page.limit)} OFFSET ${d.num(page.offset)}`;
  const rows = innerRows(series, c, false);
  if (math === 'first_time') {
    return `${head},
f AS (SELECT actor, MIN(ts_ms) AS t0 FROM (${rows}) t GROUP BY actor),
fe AS (SELECT f.actor, f.t0, MIN(t.bd) AS bd FROM f JOIN (${rows}) t ON t.actor = f.actor AND t.ts_ms = f.t0 GROUP BY f.actor, f.t0)
SELECT actor, 1 AS n FROM fe WHERE t0 >= ${d.num(from)} AND t0 < ${d.num(to)} ${bdCond}
${page_}`;
  }
  return `${head}
SELECT actor, COUNT(*) AS n FROM (${rows}) t
WHERE ts_ms >= ${d.num(from)} AND ts_ms < ${d.num(to)} ${bdCond}
GROUP BY actor
${page_}`;
}
