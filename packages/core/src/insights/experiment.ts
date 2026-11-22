/**
 * Experiment readout.
 *
 * An actor (a person, or a group for group experiments) enters at their first
 * exposure to the flag: a `$exposure` the SDK logs when a variant is shown, or a
 * custom exposure event, whose `flags` column holds the variant. Actors exposed to
 * more than one variant are left out (or kept on their first, if asked) — a high
 * count means the flag is read inconsistently.
 *
 * Every metric is measured per exposed actor, after their exposure:
 *
 * - conversion: did the event (within a window) — a rate;
 * - mean: how many times they did it, or the sum of a property (winsorised if asked);
 * - ratio: Σ numerator / Σ denominator across actors (e.g. revenue per order), with a
 *   delta-method standard error;
 * - funnel: completed the steps in order after exposure — a rate;
 * - retention: came back in a window after exposure — a rate, over actors exposed
 *   long enough ago.
 *
 * Engines: Bayesian (default) reports the probability each variant beats control
 * and is best of all, with credible intervals; frequentist reports p-values and
 * confidence intervals. A winner needs the first primary metric to clear the
 * confidence level, no sample ratio mismatch, the minimum runtime and the minimum
 * exposures per variant.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import { filtersSql, propertyNumber } from '../sql/filters.ts';
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
  type BayesComparison,
  type Comparison,
  compareEstimates,
  compareMeans,
  compareProportions,
  type MeanComparison,
  meanAndError,
  probabilityToBeBestBeta,
  probabilityToBeBestNormal,
  ratioAndError,
  type SrmResult,
  sampleRatioMismatch,
  sampleSizeForMean,
  sampleSizeForRate,
  wilson,
  zFor,
} from '../stats/tests.ts';
import { DAY_MS, iso, parseDuration, resolveRange } from '../time.ts';
import type { ExperimentMetric, ExperimentSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, type Row, zoneOf } from './types.ts';

export interface MetricVariant {
  variant: string;
  exposures: number;
  /** Rate metrics: actors who converted. */
  conversions?: number;
  /** The variant's value: a rate, a mean per actor, or a ratio. */
  value: number;
  /** Interval of the value at the experiment's confidence. */
  interval: [number, number];
  /** Comparison to control; null for control itself. */
  vsControl: Comparison | null;
  /** P(this variant is the best of all), Bayesian. */
  probabilityToBeBest: number;
}

export interface MetricResult {
  name: string;
  kind: ExperimentMetric['kind'];
  goal: 'increase' | 'decrease';
  variants: MetricVariant[];
  /** Best variant at the confidence level, or null. */
  significantVariant: string | null;
  /** For winsorised means: the bounds values were clamped to. */
  winsorized?: { lower: number | null; upper: number | null };
  /** Daily cumulative values by variant, for the primary metric. */
  timeline?: { days: number[]; variants: Record<string, number[]> };
}

/** Kept for the original readout shape (and the dashboard): conversion on the first primary metric. */
export interface VariantResult {
  variant: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
  rateInterval: [number, number];
  vsControl: BayesComparison | null;
  /** Present when the goal has a `value` property. */
  mean: { value: number; vsControl: MeanComparison | null } | null;
}

export interface ExperimentResult extends ResultBase {
  kind: 'experiment';
  flag: string;
  goal: string;
  engine: 'bayesian' | 'frequentist';
  confidence: number;
  aggregateBy: string;
  variants: VariantResult[];
  /** Primary metrics; the first decides the winner. */
  metrics: MetricResult[];
  secondary: MetricResult[];
  /** People exposed to more than one variant (excluded). */
  excludedMultipleVariants: number;
  srm: SrmResult;
  /** Best variant on the first primary metric when the experiment can call it. */
  winner: string | null;
  /** Why there is no winner yet, when there isn't. */
  status: 'winner' | 'no_winner_yet' | 'too_early' | 'srm' | 'no_data';
  daysRunning: number;
  /** Estimated days until a `mde` change is detectable at the current exposure rate. */
  estimatedDaysToSignificance: number | null;
}

type Spec = ExperimentSpec & {
  startedAt?: number;
  /**
   * Holdout results: compare people in a holdout ("holdout") with everyone exposed to any of
   * these flags otherwise ("experiments").
   */
  holdoutFlags?: string[];
  /** Planning: everyone doing the exposure event counts as one group ("all"). */
  baseline?: boolean;
};

const FLAG_VARIANT = (d: QueryContext['dialect'], flag: string) => d.jsonText('ev.flags', [flag]);

/** The metrics a spec measures, with the simple `goal` form turned into metrics. */
export function metricsOf(spec: ExperimentSpec): {
  primary: ExperimentMetric[];
  secondary: ExperimentMetric[];
} {
  const primary: ExperimentMetric[] = [...(spec.metrics ?? [])];
  if (spec.goal) {
    primary.unshift({
      kind: 'conversion',
      event: spec.goal.event,
      filters: spec.goal.filters,
      name: spec.goal.label,
    });
    if (spec.goal.value) {
      primary.push({
        kind: 'mean',
        event: spec.goal.event,
        filters: spec.goal.filters,
        math: 'sum',
        property: spec.goal.value,
        name: `${spec.goal.value} per person`,
      });
    }
  }
  if (primary.length === 0)
    throw new TypeError('An experiment needs a goal or at least one metric.');
  return { primary, secondary: [...(spec.secondary ?? [])] };
}

function metricName(m: ExperimentMetric): string {
  if (m.name) return m.name;
  switch (m.kind) {
    case 'conversion':
      return `${m.event} conversion`;
    case 'mean':
      return m.math === 'sum' ? `${m.property} per person` : `${m.event} per person`;
    case 'ratio':
      return `${m.numerator.event} / ${m.denominator.event}`;
    case 'funnel':
      return `${m.steps.map((s) => s.event).join(' → ')} funnel`;
    case 'retention':
      return `${m.event} retention`;
  }
}

function metricEvents(m: ExperimentMetric): string[] {
  switch (m.kind) {
    case 'ratio':
      return [m.numerator.event, m.denominator.event];
    case 'funnel':
      return m.steps.map((s) => s.event);
    default:
      return [m.event];
  }
}

interface Head {
  sql: string;
  aggregation: Aggregation;
}

/**
 * The shared CTEs: `ev` (the events every metric needs) and `xe` (one row per exposed actor:
 * actor, t0 first exposure, variant), plus `x` (all exposed, with how many variants each saw).
 */
function exposureHead(
  spec: Spec,
  ctx: QueryContext,
  range: { from: number; to: number },
  metrics: ExperimentMetric[],
): Head {
  const d = ctx.dialect;
  const aggregation = parseAggregation(spec.aggregateBy);
  const exposureEvent = spec.exposure?.event ?? SYSTEM_EVENTS.exposure;
  const names = [exposureEvent, ...metrics.flatMap(metricEvents)];
  const events = names.includes('*') ? undefined : names;
  const maxWindow = Math.max(
    0,
    ...metrics.map((m) => (m.kind === 'retention' ? parseDuration(m.to ?? '8d') : 0)),
  );
  const now = ctx.now ?? Date.now();
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: Math.min(range.to + maxWindow, now + DAY_MS),
    events,
    filters: spec.filters as Filter[] | undefined,
    aggregation,
  });
  const viaExposure = exposureEvent === SYSTEM_EVENTS.exposure && !spec.exposure?.event;
  const flagProp = d.jsonText('ev.props', ['flag']);
  const variantProp = d.jsonText('ev.props', ['variant']);
  let variant = viaExposure ? variantProp : FLAG_VARIANT(d, spec.flag);
  let exposureCond = viaExposure
    ? `ev.event = ${d.str(SYSTEM_EVENTS.exposure)} AND ${flagProp} = ${d.str(spec.flag)}`
    : `ev.event = ${d.str(exposureEvent)}`;
  if (spec.holdoutFlags) {
    exposureCond = `ev.event = ${d.str(SYSTEM_EVENTS.exposure)} AND ${flagProp} IN (${spec.holdoutFlags.map((f) => d.str(f)).join(', ')})`;
    variant = `(CASE WHEN ${variantProp} = 'holdout' THEN 'holdout' WHEN ${variantProp} IS NULL OR ${variantProp} = '' THEN NULL ELSE 'experiments' END)`;
  } else if (spec.baseline) {
    exposureCond = `${exposureEvent === '*' ? '1 = 1' : `ev.event = ${d.str(exposureEvent)}`}`;
    variant = "'all'";
  }
  const firstSeen = spec.exposure?.multipleVariants === 'first_seen';
  const sql = `WITH ${cte},
xr AS (
  SELECT ev.actor AS actor, ev.ts_ms AS ts_ms, ${variant} AS variant FROM ev
  WHERE ${exposureCond} AND ev.ts_ms < ${d.num(range.to)} AND ${filtersSql(spec.exposure?.filters as Filter[] | undefined, d, 'ev')}
    AND ${variant} IS NOT NULL AND ${variant} <> ''
),
x AS (SELECT actor, MIN(ts_ms) AS t0, COUNT(DISTINCT variant) AS nv, MIN(variant) AS anyv FROM xr GROUP BY actor),
${
  firstSeen
    ? `xf AS (SELECT x.actor, MIN(xr.variant) AS variant FROM x JOIN xr ON xr.actor = x.actor AND xr.ts_ms = x.t0 GROUP BY x.actor),
xe AS (SELECT x.actor, x.t0, xf.variant FROM x JOIN xf ON xf.actor = x.actor)`
    : 'xe AS (SELECT actor, t0, anyv AS variant FROM x WHERE nv = 1)'
}`;
  return { sql, aggregation };
}

function eventCond(e: { event: string; filters?: unknown[] }, d: QueryContext['dialect']): string {
  return `${e.event === '*' ? '1 = 1' : `ev.event = ${d.str(e.event)}`} AND ${filtersSql(e.filters as Filter[] | undefined, d, 'ev')}`;
}

/** Per-actor value of a count/sum leg, as a CTE body: actor, v. */
function perActorValue(
  leg: { event: string; filters?: unknown[]; math?: 'count' | 'sum'; property?: string },
  d: QueryContext['dialect'],
): string {
  if ((leg.math ?? 'count') === 'sum' && !leg.property) {
    throw new TypeError(`A "sum" metric on ${leg.event} needs a property.`);
  }
  const v =
    (leg.math ?? 'count') === 'sum'
      ? `COALESCE(${propertyNumber(leg.property!, d, 'ev')}, 0)`
      : '1';
  return `SELECT xe.actor, SUM(${v}) AS v FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 AND ${eventCond(leg, d)} GROUP BY xe.actor`;
}

/** SQL for the set of converted actors (binomial metrics), as a CTE body selecting `actor`. */
function convertedSql(
  m: ExperimentMetric,
  d: QueryContext['dialect'],
): { ctes: string[]; set: string } {
  if (m.kind === 'conversion') {
    const within =
      m.within === undefined ? '' : ` AND ev.ts_ms <= xe.t0 + ${d.num(parseDuration(m.within))}`;
    return {
      ctes: [
        `mc AS (SELECT DISTINCT xe.actor FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0${within} AND ${eventCond(m, d)})`,
      ],
      set: 'mc',
    };
  }
  if (m.kind === 'retention') {
    const from = parseDuration(m.from ?? '1d');
    const to = parseDuration(m.to ?? '8d');
    return {
      ctes: [
        `mc AS (SELECT DISTINCT xe.actor FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 + ${d.num(from)} AND ev.ts_ms < xe.t0 + ${d.num(to)} AND ${eventCond(m, d)})`,
      ],
      set: 'mc',
    };
  }
  if (m.kind === 'funnel') {
    const w = d.num(parseDuration(m.window ?? '7d'));
    const ctes = [
      `f1 AS (SELECT xe.actor, MIN(ev.ts_ms) AS t1 FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 AND ${eventCond(m.steps[0]!, d)} GROUP BY xe.actor)`,
    ];
    // Each step: the first matching event after the previous one, within the window of step 1.
    for (let k = 2; k <= m.steps.length; k++) {
      ctes.push(
        `f${k} AS (SELECT p.actor, p.t1, MIN(ev.ts_ms) AS t${k} FROM f${k - 1} p JOIN ev ON ev.actor = p.actor AND ev.ts_ms > p.t${k - 1} AND ev.ts_ms <= p.t1 + ${w} AND ${eventCond(m.steps[k - 1]!, d)} GROUP BY p.actor, p.t1)`,
      );
    }
    ctes.push(`mc AS (SELECT DISTINCT actor FROM f${m.steps.length})`);
    return { ctes, set: 'mc' };
  }
  throw new TypeError(`${m.kind} is not a rate metric`);
}

interface VariantStats {
  variant: string;
  n: number;
  /** Rate: conversions. Mean: Σv. Ratio: Σx. */
  a: number;
  /** Mean: Σv². Ratio: Σy. */
  b: number;
  c: number;
  dd: number;
  e: number;
}

const isRate = (m: ExperimentMetric) =>
  m.kind === 'conversion' || m.kind === 'funnel' || m.kind === 'retention';

type MeanMetric = Extract<ExperimentMetric, { kind: 'mean' }>;
type RatioMetric = Extract<ExperimentMetric, { kind: 'ratio' }>;

type Measured = {
  stats: VariantStats[];
  winsorized?: { lower: number | null; upper: number | null };
  timelineSql: string;
};

const STAT_FIELDS = ['a', 'b', 'c', 'dd', 'e'] as const;

/** Rows of (variant, n, a, b, …) as stats; columns a query doesn't return are 0. */
function toStats(rows: Row[]): VariantStats[] {
  return rows.map((r) => {
    const out: VariantStats = {
      variant: text(r.variant),
      n: num(r.n),
      a: 0,
      b: 0,
      c: 0,
      dd: 0,
      e: 0,
    };
    for (const f of STAT_FIELDS) out[f] = num(r[f]);
    return out;
  });
}

const dayOf = (ctx: QueryContext, now: number) => (ts: string) =>
  bucketExpr(ctx.dialect, ts, 'day', zoneOf({}, ctx, { from: 0, to: now }));

async function measureRate(
  m: ExperimentMetric,
  head: Head,
  ctx: QueryContext,
  sql: string[],
  now: number,
): Promise<Measured> {
  const d = ctx.dialect;
  const day = dayOf(ctx, now);
  const { ctes } = convertedSql(m, d);
  // Retention needs actors exposed long enough ago to have had the whole window.
  const eligible =
    m.kind === 'retention'
      ? `WHERE xe.t0 + ${d.num(parseDuration(m.to ?? '8d'))} <= ${d.num(now)}`
      : '';
  const base = `${head.sql},\n${ctes.join(',\n')}`;
  const converted =
    'SUM(CASE WHEN mc.actor IS NULL THEN 0 ELSE 1 END) AS a\nFROM xe LEFT JOIN mc ON mc.actor = xe.actor';
  const q = `${base}\nSELECT xe.variant AS variant, COUNT(*) AS n, ${converted} ${eligible} GROUP BY xe.variant`;
  sql.push(q);
  return {
    stats: toStats(await ctx.execute(q)),
    timelineSql: `${base}\nSELECT ${day('xe.t0')} AS day, xe.variant AS variant, COUNT(*) AS n, ${converted} ${eligible} GROUP BY ${day('xe.t0')}, xe.variant`,
  };
}

/** The value at a percentile of per-actor values: exact for counts, from the sketch for sums. */
async function percentileOf(m: MeanMetric, base: string, ctx: QueryContext, sql: string[]) {
  const counts = (m.math ?? 'count') === 'count';
  const sk = sketchColumns(ctx.dialect, 'v');
  const q = counts
    ? `${base}\nSELECT 0 AS sign, v AS k, COUNT(*) AS n FROM vals GROUP BY v`
    : `${base}\nSELECT ${sk.sign} AS sign, ${sk.key} AS k, COUNT(*) AS n FROM vals GROUP BY ${sk.sign}, ${sk.key}`;
  sql.push(q);
  const cells = (await ctx.execute(q)).map((r) => ({
    sign: num(r.sign),
    key: num(r.k),
    n: num(r.n),
  }));
  return (p: number) =>
    counts
      ? exactQuantile(
          cells.map((c) => ({ value: c.key, n: c.n })),
          p,
        )
      : sketchQuantile(cells as SketchCell[], p);
}

/** Winsorising: the bounds, and the value expression clamped to them. */
async function winsorize(m: MeanMetric, base: string, ctx: QueryContext, sql: string[]) {
  const w = m.winsorize;
  if (!w || (w.lower === undefined && w.upper === undefined)) return { value: 'v' };
  const quantile = await percentileOf(m, base, ctx, sql);
  const lower = w.lower !== undefined ? quantile(w.lower / 100) : null;
  const upper = w.upper !== undefined ? quantile(w.upper / 100) : null;
  const d = ctx.dialect;
  // No values yet means nothing to clamp.
  const clamps = [
    ...(lower !== null ? [`WHEN v < ${d.num(lower)} THEN ${d.num(lower)}`] : []),
    ...(upper !== null ? [`WHEN v > ${d.num(upper)} THEN ${d.num(upper)}`] : []),
  ];
  return {
    value: clamps.length ? `(CASE ${clamps.join(' ')} ELSE v END)` : 'v',
    winsorized: { lower, upper },
  };
}

async function measureMean(
  m: MeanMetric,
  head: Head,
  ctx: QueryContext,
  sql: string[],
  now: number,
): Promise<Measured> {
  const day = dayOf(ctx, now);
  const base = `${head.sql},
mv AS (${perActorValue(m, ctx.dialect)}),
vals AS (SELECT xe.actor, xe.t0, xe.variant, COALESCE(mv.v, 0) AS v FROM xe LEFT JOIN mv ON mv.actor = xe.actor)`;
  const { value, winsorized } = await winsorize(m, base, ctx, sql);
  const sums = `COUNT(*) AS n, SUM(${value}) AS a, SUM(${value} * ${value}) AS b FROM vals`;
  const q = `${base}\nSELECT variant, ${sums} GROUP BY variant`;
  sql.push(q);
  return {
    stats: toStats(await ctx.execute(q)),
    ...(winsorized ? { winsorized } : {}),
    timelineSql: `${base}\nSELECT ${day('t0')} AS day, variant, ${sums} GROUP BY ${day('t0')}, variant`,
  };
}

async function measureRatio(
  m: RatioMetric,
  head: Head,
  ctx: QueryContext,
  sql: string[],
  now: number,
): Promise<Measured> {
  const d = ctx.dialect;
  const day = dayOf(ctx, now);
  const base = `${head.sql},
mn AS (${perActorValue(m.numerator, d)}),
md AS (${perActorValue(m.denominator, d)}),
vals AS (
  SELECT xe.actor, xe.t0, xe.variant, COALESCE(mn.v, 0) AS x, COALESCE(md.v, 0) AS y
  FROM xe LEFT JOIN mn ON mn.actor = xe.actor LEFT JOIN md ON md.actor = xe.actor
)`;
  const sums =
    'COUNT(*) AS n, SUM(x) AS a, SUM(y) AS b, SUM(x * x) AS c, SUM(y * y) AS dd, SUM(x * y) AS e FROM vals';
  const q = `${base}\nSELECT variant, ${sums} GROUP BY variant`;
  sql.push(q);
  return {
    stats: toStats(await ctx.execute(q)),
    timelineSql: `${base}\nSELECT ${day('t0')} AS day, variant, ${sums} GROUP BY ${day('t0')}, variant`,
  };
}

function measure(
  m: ExperimentMetric,
  head: Head,
  ctx: QueryContext,
  sql: string[],
  now: number,
): Promise<Measured> {
  if (isRate(m)) return measureRate(m, head, ctx, sql, now);
  if (m.kind === 'mean') return measureMean(m, head, ctx, sql, now);
  return measureRatio(m as RatioMetric, head, ctx, sql, now);
}

/** The value and its standard error for a variant's stats. */
function estimate(m: ExperimentMetric, s: VariantStats): { value: number; se: number } {
  if (isRate(m)) {
    const p = s.n ? s.a / s.n : 0;
    return { value: p, se: s.n ? Math.sqrt((p * (1 - p)) / s.n) : 0 };
  }
  if (m.kind === 'mean') {
    const r = meanAndError({ n: s.n, sum: s.a, sumSquares: s.b });
    return { value: r.mean, se: r.se };
  }
  const r = ratioAndError({ n: s.n, sumX: s.a, sumY: s.b, sumX2: s.c, sumY2: s.dd, sumXY: s.e });
  return { value: r.ratio, se: r.se };
}

const zeroStats = (variant: string): VariantStats => ({
  variant,
  n: 0,
  a: 0,
  b: 0,
  c: 0,
  dd: 0,
  e: 0,
});

interface Analysis {
  m: ExperimentMetric;
  rows: VariantStats[];
  estimates: { value: number; se: number }[];
  confidence: number;
  lower: boolean;
}

/** Variant `i` against control (row 0), or null for control and empty variants. */
function versusControl(a: Analysis, i: number): Comparison | null {
  const control = a.rows[0]!;
  const r = a.rows[i]!;
  if (i === 0 || control.n === 0 || r.n === 0) return null;
  if (!isRate(a.m))
    return compareEstimates(a.estimates[0]!, a.estimates[i]!, a.confidence, a.lower);
  return compareProportions(
    { exposures: control.n, conversions: control.a },
    { exposures: r.n, conversions: r.a },
    a.confidence,
    a.lower,
  );
}

function variantResult(a: Analysis, i: number, best: number[]): MetricVariant {
  const r = a.rows[i]!;
  const e = a.estimates[i]!;
  const z = zFor(a.confidence);
  const interval: [number, number] = isRate(a.m)
    ? wilson(r.a, r.n, z)
    : [e.value - z * e.se, e.value + z * e.se];
  return {
    variant: r.variant,
    exposures: r.n,
    ...(isRate(a.m) ? { conversions: r.a } : {}),
    value: e.value,
    interval,
    vsControl: versusControl(a, i),
    probabilityToBeBest: best[i] ?? 0,
  };
}

/** The variant that wins: Bayesian by chance to beat control, frequentist by p-value. */
function significantOf(
  variants: MetricVariant[],
  engine: 'bayesian' | 'frequentist',
  confidence: number,
  lower: boolean,
): string | null {
  const candidates = variants.filter((v) => v.vsControl);
  if (engine === 'bayesian') {
    const chance = (v: MetricVariant) => v.vsControl!.probabilityToBeatControl;
    const top = [...candidates].sort((x, y) => chance(y) - chance(x))[0];
    return top && chance(top) >= confidence ? top.variant : null;
  }
  const better = (v: MetricVariant) =>
    lower ? v.vsControl!.expectedLift < 0 : v.vsControl!.expectedLift > 0;
  const winners = candidates.filter((v) => better(v) && v.vsControl!.pValue < 1 - confidence);
  return winners.sort((x, y) => x.vsControl!.pValue - y.vsControl!.pValue)[0]?.variant ?? null;
}

function analyse(
  m: ExperimentMetric,
  stats: VariantStats[],
  order: string[],
  engine: 'bayesian' | 'frequentist',
  confidence: number,
): MetricResult {
  const lower = m.goal === 'decrease';
  const by = new Map(stats.map((s) => [s.variant, s]));
  const rows = order.map((v) => by.get(v) ?? zeroStats(v));
  const a: Analysis = { m, rows, estimates: rows.map((r) => estimate(m, r)), confidence, lower };
  const best = isRate(m)
    ? probabilityToBeBestBeta(
        rows.map((r) => ({ exposures: r.n, conversions: r.a })),
        lower,
      )
    : probabilityToBeBestNormal(a.estimates, lower);
  const variants = rows.map((_, i) => variantResult(a, i, best));
  return {
    name: metricName(m),
    kind: m.kind,
    goal: lower ? 'decrease' : 'increase',
    variants,
    significantVariant: significantOf(variants, engine, confidence, lower),
  };
}

/** Daily cumulative values by variant (by first-exposure day). */
async function timeline(
  m: ExperimentMetric,
  q: string,
  ctx: QueryContext,
  order: string[],
  sql: string[],
): Promise<MetricResult['timeline']> {
  sql.push(q);
  const rows = await ctx.execute(q);
  const days = [...new Set(rows.map((r) => num(r.day)))].sort((a, b) => a - b);
  const variants: Record<string, number[]> = {};
  for (const v of order) {
    const acc: VariantStats = { variant: v, n: 0, a: 0, b: 0, c: 0, dd: 0, e: 0 };
    variants[v] = days.map((day) => {
      const r = rows.find((x) => num(x.day) === day && text(x.variant) === v);
      if (r) {
        acc.n += num(r.n);
        acc.a += num(r.a);
        acc.b += num(r.b);
        acc.c += num(r.c);
        acc.dd += num(r.dd);
        acc.e += num(r.e);
      }
      return estimate(m, acc).value;
    });
  }
  return { days, variants };
}

export interface ExperimentOptions {
  /** Variant weights from the flag, for the sample ratio check. Defaults to equal weights. */
  weights?: Record<string, number>;
  /** When the experiment started (for runtime and the timeline). Defaults to the first exposure. */
  startedAt?: number | null;
  /** Skip the per-day timeline (cheaper, e.g. in listings). */
  timeline?: boolean;
}

export function compileExperiment(
  spec: ExperimentSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
): string {
  const { primary } = metricsOf(spec);
  const head = exposureHead(spec, ctx, range, primary);
  return `${head.sql}\nSELECT variant, COUNT(*) AS exposures FROM xe GROUP BY variant`;
}

/** Who was exposed: variants in display order, exposures per variant, and the first exposure. */
interface Exposures {
  order: string[];
  counts: Map<string, number>;
  /** Actors who saw more than one variant (left out). */
  excluded: number;
  first: number;
  total: number;
}

function variantOrder(spec: Spec, rows: Row[]): string[] {
  if (spec.holdoutFlags) return ['holdout', 'experiments'];
  if (spec.variants) return spec.variants;
  const seen = rows.map((r) => text(r.variant)).filter((v) => v !== 'holdout');
  return [
    ...(seen.includes('control') ? ['control'] : []),
    ...seen.filter((v) => v !== 'control').sort(),
  ];
}

function exposuresFrom(spec: Spec, rows: Row[]): Exposures {
  const order = variantOrder(spec, rows);
  const counts = new Map(rows.map((r) => [text(r.variant), num(r.exposures)]));
  return {
    order,
    counts,
    excluded: num(rows[0]?.multi),
    first: Math.min(...rows.map((r) => num(r.first_exposure)), Number.POSITIVE_INFINITY),
    total: order.reduce((a, v) => a + (counts.get(v) ?? 0), 0),
  };
}

interface Readiness {
  daysRunning: number;
  minimumDays: number;
  minimumExposures: number;
  /** Every variant has the minimum exposures. */
  enough: boolean;
}

function readiness(
  spec: Spec,
  x: Exposures,
  startedAt: number,
  now: number,
  rangeTo: number,
): Readiness {
  const minimumExposures = spec.minimumExposures ?? 100;
  return {
    daysRunning: Math.max(0, (Math.min(now, rangeTo) - startedAt) / DAY_MS),
    minimumDays: spec.minimumDays ?? 7,
    minimumExposures,
    enough: x.order.length > 1 && x.order.every((v) => (x.counts.get(v) ?? 0) >= minimumExposures),
  };
}

function statusOf(
  x: Exposures,
  srmMismatch: boolean,
  ready: Readiness,
  decider: MetricResult,
): ExperimentResult['status'] {
  if (x.total === 0) return 'no_data';
  if (srmMismatch) return 'srm';
  if (ready.daysRunning < ready.minimumDays || !ready.enough) return 'too_early';
  return decider.significantVariant ? 'winner' : 'no_winner_yet';
}

/** People needed per variant to detect `mde` on the first metric, from control's numbers. */
function sampleNeeded(
  m0: ExperimentMetric,
  control: VariantStats,
  mde: number,
  confidence: number,
): number {
  if (isRate(m0)) return sampleSizeForRate(Math.max(0.001, control.a / control.n), mde, confidence);
  const e = estimate(m0, control);
  return sampleSizeForMean(e.value, e.se * Math.sqrt(control.n), mde, confidence);
}

/** Days until an `mde` change on the first metric is detectable at the current exposure pace. */
function daysToSignificance(
  m0: ExperimentMetric,
  control: VariantStats | undefined,
  x: Exposures,
  ready: Readiness,
  plan: { mde: number; confidence: number },
): number | null {
  // A rate with no conversions yet has no baseline to plan from.
  if (!control || control.n === 0 || (isRate(m0) && control.a === 0)) return null;
  const needed = sampleNeeded(m0, control, plan.mde, plan.confidence);
  const perDayPerVariant = x.total / Math.max(1, ready.daysRunning) / Math.max(1, x.order.length);
  if (perDayPerVariant <= 0 || !Number.isFinite(needed)) return null;
  const have = Math.min(...x.order.map((v) => x.counts.get(v) ?? 0));
  return Math.max(
    Math.ceil(Math.max(0, needed - have) / perDayPerVariant),
    Math.ceil(Math.max(0, ready.minimumDays - ready.daysRunning)),
  );
}

/** Sums of a mean metric for one variant, for the original mean comparison. */
function meanSums(stats: VariantStats[] | undefined, variant: string | undefined) {
  const s = stats?.find((y) => y.variant === variant);
  return { n: s?.n ?? 0, sum: s?.a ?? 0, sumSquares: s?.b ?? 0 };
}

/** The original result shape: conversion on the first rate metric, and the mean of a goal value. */
function legacyVariants(
  spec: Spec,
  x: Exposures,
  all: ExperimentMetric[],
  metrics: MetricResult[],
  measured: Measured[],
): VariantResult[] {
  const rate = metrics.find((_, i) => isRate(all[i]!)) ?? null;
  const meanMetric = spec.goal?.value ? metrics.find((r) => r.kind === 'mean') : undefined;
  const meanStats = meanMetric ? measured[metrics.indexOf(meanMetric)]?.stats : undefined;
  const control = meanMetric?.variants[0];
  return x.order.map((v, i) => {
    const r = rate?.variants[i];
    const mean = meanMetric?.variants[i];
    const c = r?.vsControl;
    return {
      variant: v,
      exposures: x.counts.get(v) ?? 0,
      conversions: r?.conversions ?? 0,
      conversionRate: r?.value ?? 0,
      rateInterval: r?.interval ?? [0, 0],
      vsControl: c
        ? {
            probabilityToBeatControl: c.probabilityToBeatControl,
            expectedLift: c.expectedLift,
            liftInterval: c.liftInterval,
          }
        : null,
      mean: mean
        ? {
            value: mean.value,
            vsControl:
              i === 0
                ? null
                : compareMeans(
                    meanSums(meanStats, control?.variant),
                    meanSums(meanStats, mean.variant),
                  ),
          }
        : null,
    };
  });
}

/** "variant: 4.2%, 87% chance to beat control (lift 12%)" for each variant of the deciding metric. */
function variantLine(v: MetricVariant, rate: boolean, engine: 'bayesian' | 'frequentist'): string {
  const shown = rate ? fmt(v.value, 'percent') : fmt(v.value, 'decimal');
  const c = v.vsControl;
  if (!c) return `${v.variant}: ${shown} (control)`;
  const lift = `lift ${fmt(c.expectedLift, 'percent')}`;
  return engine === 'bayesian'
    ? `${v.variant}: ${shown}, ${fmt(c.probabilityToBeatControl, 'percent')} chance to beat control (${lift})`
    : `${v.variant}: ${shown}, p = ${c.pValue.toFixed(3)} (${lift})`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function tooEarly(ready: Readiness, days: number | null, mde: number): string {
  const waits = [
    ready.daysRunning < ready.minimumDays
      ? `${plural(Math.ceil(ready.minimumDays - ready.daysRunning), 'more day')}`
      : null,
    ready.enough ? null : `${ready.minimumExposures} exposures per variant`,
  ].filter(Boolean);
  const pace =
    days !== null ? ` (about ${days} more days to detect a ${Math.round(mde * 100)}% change)` : '';
  return `Too early to call: wait for ${waits.join(' and ')}${pace}.`;
}

function verdictOf(
  status: ExperimentResult['status'],
  o: {
    winner: string | null;
    decider: MetricResult;
    confidence: number;
    engine: string;
    days: number | null;
    mde: number;
    ready: Readiness;
  },
): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (status === 'srm')
    return 'Sample ratio mismatch detected (p < 0.001): exposure tracking or assignment is broken; do not trust these results.';
  if (status === 'too_early') return tooEarly(o.ready, o.days, o.mde);
  if (status === 'winner')
    return `"${o.winner}" is winning on ${o.decider.name} at ${pct(o.confidence)} ${o.engine === 'bayesian' ? 'probability' : 'confidence'}.`;
  if (status === 'no_winner_yet')
    return o.days !== null
      ? `No winner yet; roughly ${o.days} more days to detect a ${pct(o.mde)} change at the current pace.`
      : 'No winner yet.';
  return '';
}

export async function runExperiment(
  input: ExperimentSpec,
  ctx: QueryContext,
  options: ExperimentOptions = {},
): Promise<ExperimentResult> {
  const spec = input as Spec;
  const now = ctx.now ?? Date.now();
  const range = resolveRange(spec.from ?? '-90d', spec.to, now);
  const engine = spec.engine ?? 'bayesian';
  const confidence = spec.confidence ?? 0.95;
  const { primary, secondary } = metricsOf(spec);
  const all = [...primary, ...secondary];
  const head = exposureHead(spec, ctx, range, all);
  const sql: string[] = [];

  // Exposures per variant, and actors who saw more than one.
  const exposureQuery = `${head.sql}
SELECT variant, COUNT(*) AS exposures, MIN(t0) AS first_exposure, (SELECT COUNT(*) FROM x WHERE nv > 1) AS multi FROM xe GROUP BY variant`;
  sql.push(exposureQuery);
  const x = exposuresFrom(spec, await ctx.execute(exposureQuery));

  const measured = await Promise.all(all.map((m) => measure(m, head, ctx, sql, now)));
  const results = all.map((m, i) => {
    const r = analyse(m, measured[i]!.stats, x.order, engine, confidence);
    if (measured[i]!.winsorized) r.winsorized = measured[i]!.winsorized;
    return r;
  });
  const metrics = results.slice(0, primary.length);
  const secondaryResults = results.slice(primary.length);
  if (options.timeline !== false && x.order.length)
    metrics[0]!.timeline = await timeline(primary[0]!, measured[0]!.timelineSql, ctx, x.order, sql);

  const srm = sampleRatioMismatch(
    x.order.map((v) => x.counts.get(v) ?? 0),
    x.order.map((v) => options.weights?.[v] ?? 1),
  );
  const startedAt = options.startedAt ?? (Number.isFinite(x.first) ? x.first : now);
  const ready = readiness(spec, x, startedAt, now, range.to);
  const decider = metrics[0]!;
  const status = statusOf(x, srm.mismatch, ready, decider);
  const winner = status === 'winner' ? decider.significantVariant : null;
  const mde = spec.mde ?? 0.1;
  const control = measured[0]!.stats.find((st) => st.variant === x.order[0]);
  const days =
    status === 'winner'
      ? null
      : daysToSignificance(primary[0]!, control, x, ready, { mde, confidence });
  const verdict = verdictOf(status, { winner, decider, confidence, engine, days, mde, ready });
  const lines = decider.variants.map((v) => variantLine(v, isRate(primary[0]!), engine));
  const secondaryNotes = secondaryResults
    .filter((r) => r.significantVariant)
    .map((r) => `${r.name}: ${r.significantVariant} better`);
  const aggregation = parseAggregation(spec.aggregateBy);
  const exposed = `${fmt(x.total)} ${actorNoun(aggregation, x.total)} exposed ${ready.daysRunning < 1 ? 'today' : `over ${ready.daysRunning.toFixed(1)} days`}`;
  const secondaryText = secondaryNotes.length ? ` Secondary: ${secondaryNotes.join('; ')}.` : '';
  return {
    kind: 'experiment',
    flag: spec.flag,
    goal: metricName(primary[0]!),
    engine,
    confidence,
    aggregateBy: typeof aggregation === 'object' ? aggregation.group : aggregation,
    variants: legacyVariants(spec, x, all, metrics, measured),
    metrics,
    secondary: secondaryResults,
    excludedMultipleVariants: x.excluded,
    srm,
    winner,
    status,
    daysRunning: ready.daysRunning,
    estimatedDaysToSignificance: days,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      x.total === 0
        ? `No exposures to "${spec.flag}" yet.`
        : `${exposed}. ${decider.name}: ${lines.join('; ')}. ${verdict}${secondaryText}`,
  };
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface ExperimentPlan {
  kind: 'experiment_plan';
  metric: string;
  /** The metric's current value among people doing the traffic event (rate, mean or ratio). */
  baseline: number;
  /** Standard deviation per person, for means and ratios. */
  standardDeviation: number | null;
  mde: number;
  confidence: number;
  variants: number;
  /** People needed in each variant. */
  perVariant: number | null;
  /** New people reaching the experiment per day (from the look-back). */
  peoplePerDay: number;
  /** Days to reach the sample size, and never fewer than the minimum runtime. */
  days: number | null;
  sql: string[];
  range: { from: string; to: string };
  summary: string;
}

/** People per variant to detect `mde` (infinite with no baseline yet). */
function planSampleSize(
  rate: boolean,
  n: number,
  baseline: number,
  sd: number | null,
  mde: number,
  confidence: number,
): number {
  if (!n) return Number.POSITIVE_INFINITY;
  return rate
    ? sampleSizeForRate(baseline, mde, confidence)
    : sampleSizeForMean(baseline, sd ?? 0, mde, confidence);
}

/** Days to reach the sample at the current pace, never fewer than the minimum; null if it can't. */
function planDays(
  perVariant: number,
  variants: number,
  perDay: number,
  minimumDays: number,
): number | null {
  if (!Number.isFinite(perVariant) || perDay <= 0) return null;
  return Math.max(minimumDays, Math.ceil((perVariant * variants) / perDay));
}

/**
 * How long an experiment needs: the metric's baseline among recent traffic, the sample size per
 * variant to detect `mde`, and the days that takes at the recent rate of new people.
 */
export async function planExperiment(
  input: {
    metric: ExperimentMetric;
    traffic?: { event: string; filters?: Filter[] };
    variants?: number;
    mde?: number;
    confidence?: 0.9 | 0.95 | 0.99;
    exposurePercentage?: number;
    lookback?: string;
    minimumDays?: number;
    aggregateBy?: string;
    filters?: Filter[];
  },
  ctx: QueryContext,
): Promise<ExperimentPlan> {
  const now = ctx.now ?? Date.now();
  const lookback = input.lookback ?? '-14d';
  const range = resolveRange(lookback, 'now', now);
  const days = Math.max(1, (range.to - range.from) / DAY_MS);
  const traffic = input.traffic ?? { event: SYSTEM_EVENTS.pageview };
  const spec: Spec = {
    flag: '$plan',
    metrics: [input.metric],
    exposure: { event: traffic.event, filters: traffic.filters },
    baseline: true,
    aggregateBy: input.aggregateBy,
    filters: input.filters,
    from: range.from,
    to: range.to,
  } as Spec;
  const head = exposureHead(spec, ctx, range, [input.metric]);
  const sql: string[] = [];
  const countQuery = `${head.sql}\nSELECT COUNT(*) AS n FROM xe`;
  sql.push(countQuery);
  const people = num((await ctx.execute(countQuery))[0]?.n);
  const measured = await measure(input.metric, head, ctx, sql, now);
  const stats = measured.stats[0] ?? zeroStats('all');
  const e = estimate(input.metric, stats);
  const mde = input.mde ?? 0.1;
  const confidence = input.confidence ?? 0.95;
  const variants = input.variants ?? 2;
  const rate = isRate(input.metric);
  const sd = rate ? null : e.se * Math.sqrt(Math.max(1, stats.n));
  const perVariant = planSampleSize(rate, stats.n, e.value, sd, mde, confidence);
  const share = Math.min(100, Math.max(1, input.exposurePercentage ?? 100)) / 100;
  const peoplePerDay = (people / days) * share;
  const needDays = planDays(perVariant, variants, peoplePerDay, input.minimumDays ?? 7);
  const name = metricName(input.metric);
  const shown = rate ? fmt(e.value, 'percent') : fmt(e.value, 'decimal');
  return {
    kind: 'experiment_plan',
    metric: name,
    baseline: e.value,
    standardDeviation: sd,
    mde,
    confidence,
    variants,
    perVariant: Number.isFinite(perVariant) ? perVariant : null,
    peoplePerDay,
    days: needDays,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      needDays === null
        ? `Not enough recent data to plan: ${name} is ${shown} over ${fmt(people)} people in ${Math.round(days)} days.`
        : `${name} is ${shown} today. To detect a ${Math.round(mde * 100)}% change at ${Math.round(confidence * 100)}% with ${variants} variants you need about ${fmt(perVariant)} people per variant: roughly ${needDays} days at ${fmt(peoplePerDay)} new people a day${share < 1 ? ` (${Math.round(share * 100)}% of traffic)` : ''}.`,
  };
}
