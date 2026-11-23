/**
 * Funnels: how many people (or sessions, or groups) complete a sequence of events.
 *
 * Every step-1 event in the range starts an attempt. For each attempt, step k is
 * the first matching event after the step before it (skipping optional steps that
 * weren't done) and within `window` of step 1. Each actor keeps their best
 * attempt: the one that got furthest, then the earliest. That is how PostHog
 * counts, and it means someone who tried twice and converted the second time
 * counts as converted.
 *
 * Orders:
 * - ordered: other events may happen between steps;
 * - strict: each step must be the very next event (Dataflare's own bookkeeping
 *   events such as $pageleave and $web_vitals don't count as "in between");
 * - unordered: the steps may happen in any order within the window.
 *
 * Exclusions drop attempts where an event happened between two steps. All of it
 * compiles to chained CTEs with joins and GROUP BY — no window functions, which
 * are budget-gated in Basin SQL.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import type { Dialect } from '../sql/dialect.ts';
import { breakdownExpr, breakdownProperties, filtersSql } from '../sql/filters.ts';
import { literalRows } from '../sql/rows.ts';
import { type SketchCell, sketchColumns, sketchHistogram, sketchQuantile } from '../sql/sketch.ts';
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
  bucketsBetween,
  type Interval,
  iso,
  parseDuration,
  resolveRange,
  type TimeRange,
  type Zone,
} from '../time.ts';
import {
  type CohortBreakdown,
  isCohortBreakdown,
  type NumericBin,
  numericBins,
} from './breakdowns.ts';
import type { FunnelSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, type Row, zoneOf } from './types.ts';
import { defaultInterval } from './web.ts';

export interface FunnelStepResult {
  label: string;
  event: string;
  optional?: boolean;
  count: number;
  /** Share of step 1 that reached this step. */
  conversionFromStart: number;
  /** Share of the previous step that reached this step. */
  conversionFromPrevious: number;
  /** Mean seconds from the previous step, for actors who reached this step. */
  avgSecondsFromPrevious: number | null;
  /** Median seconds from the previous step (1% accuracy). */
  medianSecondsFromPrevious: number | null;
}

export interface FunnelResult extends ResultBase {
  kind: 'funnel';
  order: 'ordered' | 'strict' | 'unordered';
  windowSeconds: number;
  /** What was counted: "person", "session" or a group type. */
  aggregateBy: string;
  steps: FunnelStepResult[];
  /** Present when the spec has a breakdown: one funnel per value. */
  breakdowns?: { value: string; steps: FunnelStepResult[] }[];
  bins?: NumericBin[];
  /** viz "time_to_convert". */
  timeToConvert?: {
    fromStep: number;
    toStep: number;
    converters: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    histogram: { fromSeconds: number; toSeconds: number; count: number }[];
  };
  /** viz "trends": conversion by when actors entered. */
  trend?: {
    interval: Interval;
    buckets: number[];
    fromStep: number;
    toStep: number;
    series: { breakdown: string | null; entered: number[]; converted: number[]; rate: number[] }[];
  };
}

type Spec = FunnelSpec & { cohortBreakdown?: CohortBreakdown[] };

/** Events Dataflare records about itself, which don't break a strict funnel. */
const BOOKKEEPING = [
  SYSTEM_EVENTS.pageleave,
  SYSTEM_EVENTS.webVitals,
  SYSTEM_EVENTS.exposure,
  SYSTEM_EVENTS.identify,
  SYSTEM_EVENTS.set,
  SYSTEM_EVENTS.groupIdentify,
];

interface ChainOptions {
  bd: string;
  extra: Filter[];
  aggregation: Aggregation;
}

/** Any-order funnels have no exclusions, optional steps or attribution other than the first event. */
function validateUnordered(spec: Spec): void {
  if (spec.exclusions?.length) throw new TypeError('Exclusions need an ordered or strict funnel.');
  if (spec.steps.some((s) => s.optional))
    throw new TypeError('Unordered funnels have no optional steps.');
  const a = spec.breakdownAttribution;
  if (a !== undefined && a !== 'first_touch')
    throw new TypeError('Unordered funnels take the breakdown from the first event (first_touch).');
}

function validate(spec: Spec): void {
  const n = spec.steps.length;
  if (spec.steps[0]!.optional) throw new TypeError('The first funnel step cannot be optional.');
  if ((spec.order ?? 'ordered') === 'unordered') validateUnordered(spec);
  const bad = (spec.exclusions ?? []).find((x) => x.fromStep >= x.toStep || x.toStep > n);
  if (bad) throw new RangeError(`Exclusion "${bad.event}" needs 1 <= fromStep < toStep <= ${n}.`);
  const attribution = spec.breakdownAttribution;
  if (typeof attribution === 'number' && attribution > n)
    throw new RangeError(`breakdownAttribution ${attribution} is past the last step (${n}).`);
}

/** The time of the step before step k that was actually done (optional steps may be skipped). */
function prevExpr(spec: Spec, k: number, alias: string): string {
  if (k <= 2) return `${alias}.t1`;
  const before = spec.steps[k - 2]!;
  return before.optional
    ? `COALESCE(${alias}.t${k - 1}, ${prevExpr(spec, k - 1, alias)})`
    : `${alias}.t${k - 1}`;
}

/** Required steps before k must all have happened. */
function aliveExpr(spec: Spec, k: number, alias: string): string[] {
  const out: string[] = [];
  for (let j = 2; j < k; j++)
    if (!spec.steps[j - 1]!.optional) out.push(`${alias}.t${j} IS NOT NULL`);
  return out;
}

const tCols = (n: number, alias?: string) =>
  Array.from({ length: n }, (_, i) => `${alias ? `${alias}.` : ''}t${i + 1}`);

/** Everything one chain needs, worked out once. */
interface Chain {
  spec: Spec;
  d: Dialect;
  n: number;
  order: 'ordered' | 'strict' | 'unordered';
  /** The conversion window in ms, as SQL. */
  W: string;
  /** Step 1 must start inside the range (later steps may finish after it). */
  inRange: string;
}

/** `ev` (the events) and `evb` (each event with a flag per step and exclusion). */
function eventCtes(
  c: Chain,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string[] {
  const { spec, d } = c;
  const names = [...spec.steps.map((s) => s.event), ...(spec.exclusions ?? []).map((x) => x.event)];
  const events = c.order === 'strict' || names.includes('*') ? undefined : names;
  const ev = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    // Later steps may complete after the range ends, but never after the window closes.
    to: range.to + windowMs,
    events,
    filters: [...((spec.filters as Filter[] | undefined) ?? []), ...o.extra],
    aggregation: o.aggregation,
  });
  const cond = (event: string, filters: Filter[] | undefined) =>
    `${event === '*' ? '1 = 1' : `event = ${d.str(event)}`} AND ${filtersSql(filters, d)}`;
  const flags = [
    ...spec.steps.map(
      (s, i) => `CASE WHEN ${cond(s.event, s.filters as Filter[])} THEN 1 ELSE 0 END AS m${i + 1}`,
    ),
    ...(spec.exclusions ?? []).map(
      (x, i) => `CASE WHEN ${cond(x.event, x.filters as Filter[])} THEN 1 ELSE 0 END AS x${i + 1}`,
    ),
    c.order === 'strict'
      ? `CASE WHEN event IN (${BOOKKEEPING.map((e) => d.str(e)).join(', ')}) THEN 1 ELSE 0 END AS noise`
      : '0 AS noise',
  ];
  return [ev, `evb AS (SELECT actor, ts_ms, event, ${o.bd} AS bd, ${flags.join(', ')} FROM ev)`];
}

/** The furthest step reached, from the step times (SQL). */
function reachCase(n: number, alias = ''): string {
  const whens = Array.from(
    { length: n - 1 },
    (_, i) => `WHEN ${alias}t${n - i} IS NOT NULL THEN ${n - i}`,
  );
  return `CASE ${whens.join(' ')} ELSE 1 END`;
}

/** Any order: entry is any step event; a step counts if done within the window. */
function unorderedCtes(c: Chain): string[] {
  const steps = c.spec.steps;
  const any = steps.map((_, i) => `m${i + 1} = 1`).join(' OR ');
  const firsts = steps.map(
    (_, i) => `MIN(CASE WHEN e.m${i + 1} = 1 THEN e.ts_ms END) AS u${i + 1}`,
  );
  const done = steps.map((_, i) => `(CASE WHEN u${i + 1} IS NULL THEN 0 ELSE 1 END)`).join(' + ');
  const uCols = steps.map((_, i) => `u${i + 1}`);
  return [
    `c AS (SELECT DISTINCT actor, ts_ms AS t1, bd AS bd1 FROM evb WHERE (${any}) AND ${c.inRange})`,
    `u AS (
  SELECT c.actor, c.bd1, c.t1, ${firsts.join(', ')}
  FROM c LEFT JOIN evb e ON e.actor = c.actor AND e.ts_ms >= c.t1 AND e.ts_ms <= c.t1 + ${c.W}
  GROUP BY c.actor, c.bd1, c.t1
)`,
    `r AS (SELECT actor, bd1, t1, ${uCols.join(', ')}, ${c.d.greatest(uCols)} AS tend, ${done} AS reach FROM u)`,
  ];
}

/** Step k: the first matching event after the previous step, inside the window. */
function stepCtes(c: Chain, k: number): string[] {
  const { spec } = c;
  const carried = ['p.actor', 'p.bd1', ...tCols(k - 1, 'p')];
  const join = [
    'e.actor = p.actor',
    `e.m${k} = 1`,
    `e.ts_ms > ${prevExpr(spec, k, 'p')}`,
    `e.ts_ms <= p.t1 + ${c.W}`,
    ...aliveExpr(spec, k, 'p'),
    ...(spec.breakdownAttribution === 'all_steps' ? ['e.bd = p.bd1'] : []),
  ];
  const strict = c.order === 'strict';
  const step = `${strict ? `s${k}r` : `s${k}`} AS (
  SELECT ${carried.join(', ')}, MIN(e.ts_ms) AS t${k}
  FROM s${k - 1} p LEFT JOIN evb e ON ${join.join(' AND ')}
  GROUP BY ${carried.join(', ')}
)`;
  if (!strict) return [step];
  // Any other (non-bookkeeping) event between the previous step and this one breaks it.
  return [
    step,
    `b${k} AS (
  SELECT DISTINCT r.actor, r.t1 FROM s${k}r r JOIN evb e
    ON e.actor = r.actor AND e.noise = 0 AND e.ts_ms > ${prevExpr(spec, k, 'r')} AND e.ts_ms < r.t${k}
)`,
    `s${k} AS (
  SELECT r.actor, r.bd1, ${tCols(k - 1, 'r').join(', ')}, CASE WHEN b.actor IS NULL THEN r.t${k} END AS t${k}
  FROM s${k}r r LEFT JOIN b${k} b ON b.actor = r.actor AND b.t1 = r.t1
)`,
  ];
}

/** `r` from the last step: attempts with an exclusion between their steps are dropped. */
function attemptsCtes(c: Chain): string[] {
  const { spec, n, W } = c;
  const last = `s${n}`;
  if (!spec.exclusions?.length)
    return [
      `r AS (SELECT actor, bd1, ${tCols(n).join(', ')}, ${reachCase(n)} AS reach FROM ${last})`,
    ];
  const any = spec.exclusions
    .map(
      (x, i) =>
        `(e.x${i + 1} = 1 AND e.ts_ms > p.t${x.fromStep} AND e.ts_ms < COALESCE(p.t${x.toStep}, p.t1 + ${W}))`,
    )
    .join(' OR ');
  return [
    `xb AS (SELECT DISTINCT p.actor, p.t1 FROM ${last} p JOIN evb e ON e.actor = p.actor AND (${any}))`,
    `r AS (
  SELECT p.actor, p.bd1, ${tCols(n, 'p').join(', ')}, ${reachCase(n, 'p.')} AS reach
  FROM ${last} p LEFT JOIN xb ON xb.actor = p.actor AND xb.t1 = p.t1
  WHERE xb.actor IS NULL
)`,
  ];
}

function orderedCtes(c: Chain): string[] {
  const steps = Array.from({ length: c.n - 1 }, (_, i) => stepCtes(c, i + 2)).flat();
  return [
    `s1 AS (SELECT DISTINCT actor, ts_ms AS t1, bd AS bd1 FROM evb WHERE m1 = 1 AND ${c.inRange})`,
    ...steps,
    ...attemptsCtes(c),
  ];
}

/** Each actor's best attempt: the furthest, then the earliest. */
const BEST_ATTEMPT = [
  'best AS (SELECT actor, MAX(reach) AS reach FROM r GROUP BY actor)',
  'pick AS (SELECT r.actor, MIN(r.t1) AS t1 FROM r JOIN best b ON b.actor = r.actor AND b.reach = r.reach GROUP BY r.actor)',
  'f0 AS (SELECT r.* FROM r JOIN pick k ON k.actor = r.actor AND k.t1 = r.t1)',
];

/** `f`, with the breakdown value from the step the attribution names. */
function attributionCtes(c: Chain): string[] {
  const { n } = c;
  const attribution = c.spec.breakdownAttribution ?? 'first_touch';
  if (c.order === 'unordered')
    return ['f AS (SELECT f0.actor, f0.bd1 AS bd, f0.t1, f0.reach, f0.tend FROM f0)'];
  const cols = tCols(n, 'f0').join(', ');
  if (attribution === 'first_touch' || attribution === 'all_steps')
    return [`f AS (SELECT f0.actor, f0.bd1 AS bd, ${cols}, f0.reach FROM f0)`];
  // The breakdown value of the event at the last step reached, or at a given step.
  const lastTouch = attribution === 'last_touch';
  const whens = (then: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `WHEN ${i + 1} THEN ${then(i)}`).join(' ');
  const at = lastTouch ? `CASE f0.reach ${whens((i) => `f0.t${i + 1}`)} END` : `f0.t${attribution}`;
  const match = lastTouch
    ? `(CASE f0.reach ${whens((i) => `e.m${i + 1}`)} END) = 1`
    : `e.m${attribution} = 1`;
  const fallback = lastTouch ? 'f0.bd1' : `'(none)'`;
  return [
    `fl AS (SELECT f0.actor, MIN(e.bd) AS bd FROM f0 JOIN evb e ON e.actor = f0.actor AND e.ts_ms = ${at} AND ${match} GROUP BY f0.actor)`,
    `f AS (SELECT f0.actor, COALESCE(fl.bd, ${fallback}) AS bd, ${cols}, f0.reach FROM f0 LEFT JOIN fl ON fl.actor = f0.actor)`,
  ];
}

/**
 * The CTE chain ending in `f`: one row per actor with their best attempt —
 * `actor`, `bd` (breakdown value), `t1`…`tn` (step times, NULL when not reached;
 * unordered funnels also have `tend`), and `reach`, the furthest step.
 */
export function funnelChain(
  input: FunnelSpec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const spec = input as Spec;
  validate(spec);
  const c: Chain = {
    spec,
    d: ctx.dialect,
    n: spec.steps.length,
    order: spec.order ?? 'ordered',
    W: ctx.dialect.num(windowMs),
    inRange: `ts_ms < ${ctx.dialect.num(range.to)}`,
  };
  const ctes = [
    ...eventCtes(c, ctx, range, windowMs, o),
    ...(c.order === 'unordered' ? unorderedCtes(c) : orderedCtes(c)),
    ...BEST_ATTEMPT,
    ...attributionCtes(c),
  ];
  return `WITH ${ctes.join(',\n')}\n`;
}

/** Whether actor row `f` reached step k (SQL). */
function reached(spec: Spec, k: number, alias = 'f'): string {
  if (k === 1) return '1 = 1';
  return (spec.order ?? 'ordered') === 'unordered'
    ? `${alias}.reach >= ${k}`
    : `${alias}.t${k} IS NOT NULL`;
}

/** Seconds from the previous step to step k (SQL, ms), NULL when not reached. */
function stepDuration(spec: Spec, k: number, alias = 'f'): string {
  if ((spec.order ?? 'ordered') === 'unordered') {
    return k === spec.steps.length ? `(${alias}.tend - ${alias}.t1)` : 'NULL';
  }
  return `(${alias}.t${k} - ${prevExpr(spec, k, alias)})`;
}

/** Duration between two steps (ms) for actors who did both. */
function spanDuration(spec: Spec, from: number, to: number, alias = 'f'): string {
  if ((spec.order ?? 'ordered') === 'unordered') return `(${alias}.tend - ${alias}.t1)`;
  return `(${alias}.t${to} - ${alias}.t${from})`;
}

/** Kept for callers that only want the SQL (CLI `--sql`, tests): the per-breakdown step counts. */
export function compileFunnel(
  spec: FunnelSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
  windowMs: number,
): string[] {
  const breakdowns = breakdownProperties(spec.breakdown);
  const bd = breakdowns.length ? breakdownExpr(breakdowns, ctx.dialect) : "''";
  return [
    stepsSql(spec as Spec, ctx, range, windowMs, {
      bd,
      extra: [],
      aggregation: parseAggregation(spec.aggregateBy),
    }),
  ];
}

function stepsSql(
  spec: Spec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const n = spec.steps.length;
  const cols: string[] = ['COUNT(*) AS n1'];
  for (let k = 2; k <= n; k++) {
    cols.push(`SUM(CASE WHEN ${reached(spec, k)} THEN 1 ELSE 0 END) AS n${k}`);
    const dur = stepDuration(spec, k);
    cols.push(
      dur === 'NULL'
        ? `0 AS dt${k}`
        : `SUM(CASE WHEN ${reached(spec, k)} THEN ${dur} ELSE 0 END) AS dt${k}`,
    );
  }
  return `${funnelChain(spec, ctx, range, windowMs, o)}SELECT f.bd AS bd, ${cols.join(', ')} FROM f GROUP BY f.bd`;
}

function mediansSql(
  spec: Spec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const d = ctx.dialect;
  const n = spec.steps.length;
  const ks = Array.from({ length: n - 1 }, (_, i) => i + 2);
  const dur = `CASE v.column1 ${ks.map((k) => `WHEN ${k} THEN ${stepDuration(spec, k)}`).join(' ')} END`;
  const sk = sketchColumns(d, 'dur');
  return `${funnelChain(spec, ctx, range, windowMs, o)}SELECT k, bd, ${sk.sign} AS sign, ${sk.key} AS key, COUNT(*) AS n FROM (
  SELECT v.column1 AS k, f.bd AS bd, ${dur} AS dur FROM f CROSS JOIN (${literalRows(ks.map((k) => [k]))}) v
) x WHERE dur IS NOT NULL GROUP BY k, bd, ${sk.sign}, ${sk.key}`;
}

function stepResult(
  spec: Spec,
  i: number,
  counts: Map<number, { n: number; dt: number }>,
  medians: Map<number, SketchCell[]>,
): FunnelStepResult {
  const step = spec.steps[i]!;
  const c = counts.get(i + 1) ?? { n: 0, dt: 0 };
  const first = counts.get(1)?.n ?? 0;
  const prev = i === 0 ? c.n : (counts.get(i)?.n ?? 0);
  // Unordered funnels only time the whole funnel (into the last step).
  const unordered = (spec.order ?? 'ordered') === 'unordered';
  const timed = i > 0 && c.n > 0 && (!unordered || i === spec.steps.length - 1);
  const median = timed ? sketchQuantile(medians.get(i + 1) ?? [], 0.5) : null;
  return {
    label: step.label ?? step.event,
    event: step.event,
    ...(step.optional ? { optional: true } : {}),
    count: c.n,
    conversionFromStart: first ? c.n / first : 0,
    conversionFromPrevious: prev ? c.n / prev : 0,
    avgSecondsFromPrevious: timed ? c.dt / c.n / 1000 : null,
    medianSecondsFromPrevious: median === null ? null : median / 1000,
  };
}

function shapeSteps(
  spec: Spec,
  counts: Map<number, { n: number; dt: number }>,
  medians: Map<number, SketchCell[]>,
): FunnelStepResult[] {
  return spec.steps.map((_, i) => stepResult(spec, i, counts, medians));
}

interface FunnelPart {
  o: ChainOptions;
}

async function partsFor(spec: Spec, ctx: QueryContext, range: TimeRange, aggregation: Aggregation) {
  const d = ctx.dialect;
  const breakdowns = breakdownProperties(spec.breakdown);
  const sql: string[] = [];
  let bins: NumericBin[] | undefined;
  let parts: FunnelPart[];
  if (isCohortBreakdown(breakdowns)) {
    if (!spec.cohortBreakdown?.length) {
      throw new TypeError(
        'breakdown "cohort" needs breakdownCohorts: saved cohort keys (list_cohorts).',
      );
    }
    parts = spec.cohortBreakdown.map((c) => ({
      o: { bd: d.str(c.label), extra: [c.filter], aggregation },
    }));
  } else if (breakdowns.length === 1 && spec.breakdownBins) {
    const b = await numericBins(ctx, range, {
      events: spec.steps.map((s) => s.event),
      filters: spec.filters as Filter[] | undefined,
      aggregation,
      property: breakdowns[0]!,
      bins: spec.breakdownBins,
    });
    sql.push(b.sql);
    bins = b.bins;
    parts = [{ o: { bd: b.expr, extra: [], aggregation } }];
  } else {
    const bd = breakdowns.length ? breakdownExpr(breakdowns, d) : "''";
    parts = [{ o: { bd, extra: [], aggregation } }];
  }
  return { parts, bins, sql, breakdowns };
}

type StepCounts = Map<number, { n: number; dt: number }>;

/** What a funnel run settles before querying: the range, window, view and step span. */
interface FunnelSetup {
  spec: Spec;
  range: TimeRange;
  windowMs: number;
  aggregation: Aggregation;
  n: number;
  order: 'ordered' | 'strict' | 'unordered';
  viz: 'steps' | 'time_to_convert' | 'trends';
  fromStep: number;
  toStep: number;
  interval: Interval;
  zone: Zone;
}

function funnelSetup(spec: Spec, ctx: QueryContext): FunnelSetup {
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const n = spec.steps.length;
  const order = spec.order ?? 'ordered';
  const viz = spec.viz ?? 'steps';
  const fromStep = spec.fromStep ?? 1;
  const toStep = spec.toStep ?? n;
  if (fromStep >= toStep || toStep > n)
    throw new RangeError(`fromStep and toStep need 1 <= fromStep < toStep <= ${n}.`);
  if (order === 'unordered' && (fromStep !== 1 || toStep !== n) && viz !== 'steps')
    throw new TypeError('Unordered funnels measure from the first step done to the last.');
  return {
    spec,
    range,
    windowMs: parseDuration(spec.window ?? '7d'),
    aggregation: parseAggregation(spec.aggregateBy),
    n,
    order,
    viz,
    fromStep,
    toStep,
    interval: spec.interval ?? defaultInterval(range),
    zone: zoneOf(spec, ctx, range),
  };
}

/** Rows from every part (one per cohort, or one), gathered by breakdown value. */
interface Collected {
  byValue: Map<string, StepCounts>;
  medianCells: Map<string, Map<number, SketchCell[]>>;
  ttc: { cells: SketchCell[]; total: number; count: number };
  trendRows: { bucket: number; bd: string; entered: number; converted: number }[];
}

const cell = (row: Row): SketchCell => ({ sign: num(row.sign), key: num(row.key), n: num(row.n) });

function collectSteps(rows: Row[], c: Collected, n: number): void {
  for (const row of rows) {
    const value = text(row.bd);
    const steps = c.byValue.get(value) ?? new Map();
    for (let k = 1; k <= n; k++)
      steps.set(k, { n: num(row[`n${k}`]), dt: k === 1 ? 0 : num(row[`dt${k}`]) });
    c.byValue.set(value, steps);
  }
}

function collectMedians(rows: Row[], c: Collected): void {
  for (const row of rows) {
    const value = text(row.bd);
    const m = c.medianCells.get(value) ?? new Map<number, SketchCell[]>();
    const k = num(row.k);
    m.set(k, [...(m.get(k) ?? []), cell(row)]);
    c.medianCells.set(value, m);
  }
}

function collectTimeToConvert(rows: Row[], c: Collected): void {
  for (const row of rows) {
    c.ttc.cells.push(cell(row));
    c.ttc.total += num(row.total);
    c.ttc.count += num(row.n);
  }
}

function collectTrend(rows: Row[], c: Collected): void {
  for (const row of rows)
    c.trendRows.push({
      bucket: num(row.bucket),
      bd: text(row.bd),
      entered: num(row.entered),
      converted: num(row.converted),
    });
}

/** The view's extra query (time to convert, or conversion over time), with how to read it. */
function viewQuery(
  f: FunnelSetup,
  d: Dialect,
  head: string,
): { sql: string; collect: (rows: Row[], c: Collected) => void } | null {
  const { spec, fromStep, toStep } = f;
  if (f.viz === 'time_to_convert') {
    const sk = sketchColumns(d, 'dur');
    return {
      sql: `${head}SELECT ${sk.sign} AS sign, ${sk.key} AS key, COUNT(*) AS n, SUM(dur) AS total FROM (
  SELECT ${spanDuration(spec, fromStep, toStep)} AS dur FROM f WHERE ${reached(spec, fromStep)} AND ${reached(spec, toStep)}
) x WHERE dur IS NOT NULL GROUP BY ${sk.sign}, ${sk.key}`,
      collect: collectTimeToConvert,
    };
  }
  if (f.viz !== 'trends') return null;
  const bucket = bucketExpr(d, 'f.t1', f.interval, f.zone);
  return {
    sql: `${head}SELECT ${bucket} AS bucket, f.bd AS bd, COUNT(*) AS entered,
  SUM(CASE WHEN ${reached(spec, toStep)} THEN 1 ELSE 0 END) AS converted
FROM f WHERE ${reached(spec, fromStep)} GROUP BY ${bucket}, f.bd`,
    collect: collectTrend,
  };
}

async function runPart(
  f: FunnelSetup,
  o: ChainOptions,
  ctx: QueryContext,
  sql: string[],
  c: Collected,
): Promise<void> {
  const stepsQuery = stepsSql(f.spec, ctx, f.range, f.windowMs, o);
  const mediansQuery = mediansSql(f.spec, ctx, f.range, f.windowMs, o);
  const view = viewQuery(f, ctx.dialect, funnelChain(f.spec, ctx, f.range, f.windowMs, o));
  sql.push(stepsQuery, mediansQuery, ...(view ? [view.sql] : []));
  const [steps, medians, extra] = await Promise.all([
    ctx.execute(stepsQuery),
    ctx.execute(mediansQuery),
    view ? ctx.execute(view.sql) : Promise.resolve([]),
  ]);
  collectSteps(steps, c, f.n);
  collectMedians(medians, c);
  view?.collect(extra, c);
}

function addCounts(into: StepCounts, steps: StepCounts): StepCounts {
  for (const [k, c] of steps) {
    const t = into.get(k) ?? { n: 0, dt: 0 };
    into.set(k, { n: t.n + c.n, dt: t.dt + c.dt });
  }
  return into;
}

function mergeCells(maps: Map<number, SketchCell[]>[]): Map<number, SketchCell[]> {
  const out = new Map<number, SketchCell[]>();
  for (const m of maps) for (const [k, cells] of m) out.set(k, [...(out.get(k) ?? []), ...cells]);
  return out;
}

/** Breakdown values in their natural order (bins, chosen cohorts), or null to rank by entries. */
function fixedOrderOf(
  spec: Spec,
  bins: NumericBin[] | undefined,
  breakdowns: string[],
): string[] | null {
  if (bins) return [...bins.map((b) => b.label), '(none)'];
  if (spec.cohortBreakdown?.length && isCohortBreakdown(breakdowns))
    return spec.cohortBreakdown.map((x) => x.label);
  return null;
}

function breakdownResults(
  spec: Spec,
  c: Collected,
  bins: NumericBin[] | undefined,
  breakdowns: string[],
) {
  const shape = (value: string, steps: StepCounts) => ({
    value,
    steps: shapeSteps(spec, steps, c.medianCells.get(value) ?? new Map()),
  });
  const fixed = fixedOrderOf(spec, bins, breakdowns);
  if (fixed) return fixed.filter((v) => c.byValue.has(v)).map((v) => shape(v, c.byValue.get(v)!));
  const limit = spec.breakdownLimit ?? 10;
  const ranked = [...c.byValue.entries()].sort(
    (a, b) => (b[1].get(1)?.n ?? 0) - (a[1].get(1)?.n ?? 0),
  );
  const top = ranked.slice(0, limit).map(([value, steps]) => shape(value, steps));
  const rest = ranked.slice(limit);
  if (!rest.length) return top;
  const other = rest.reduce((acc, [, steps]) => addCounts(acc, steps), new Map() as StepCounts);
  const cells = mergeCells(rest.map(([v]) => c.medianCells.get(v) ?? new Map()));
  return [...top, { value: 'Other', steps: shapeSteps(spec, other, cells) }];
}

function timeToConvertResult(
  f: FunnelSetup,
  ttc: Collected['ttc'],
): NonNullable<FunnelResult['timeToConvert']> {
  const median = sketchQuantile(ttc.cells, 0.5);
  return {
    fromStep: f.fromStep,
    toStep: f.toStep,
    converters: ttc.count,
    averageSeconds: ttc.count ? ttc.total / ttc.count / 1000 : null,
    medianSeconds: median === null ? null : median / 1000,
    histogram: sketchHistogram(ttc.cells, 15).map((b) => ({
      fromSeconds: b.from / 1000,
      toSeconds: b.to / 1000,
      count: b.count,
    })),
  };
}

function trendResult(
  f: FunnelSetup,
  rows: Collected['trendRows'],
  broken: boolean,
): NonNullable<FunnelResult['trend']> {
  const buckets = bucketsBetween(f.range, f.interval, f.zone);
  const index = new Map(buckets.map((b, i) => [b, i]));
  const keys = broken ? [...new Set(rows.map((r) => r.bd))] : [''];
  const series = keys.map((key) => {
    const entered = new Array<number>(buckets.length).fill(0);
    const converted = new Array<number>(buckets.length).fill(0);
    for (const r of rows.filter((x) => x.bd === key)) {
      const slot = index.get(r.bucket);
      if (slot === undefined) continue;
      entered[slot]! += r.entered;
      converted[slot]! += r.converted;
    }
    return {
      breakdown: broken ? key : null,
      entered,
      converted,
      rate: entered.map((e, i) => (e ? converted[i]! / e : 0)),
    };
  });
  return { interval: f.interval, buckets, fromStep: f.fromStep, toStep: f.toStep, series };
}

function funnelSummary(result: FunnelResult, aggregation: Aggregation): string {
  const s = result.steps;
  if (s[0]!.count === 0) return `No one did "${s[0]!.label}" in this range.`;
  const last = s[s.length - 1]!;
  const worst = s
    .slice(1)
    .reduce(
      (w, step) => (step.conversionFromPrevious < w.conversionFromPrevious ? step : w),
      s[1]!,
    );
  const who = `${fmt(s[0]!.count)} ${actorNoun(aggregation, s[0]!.count)}`;
  const order = result.order === 'ordered' ? '' : ` [${result.order}]`;
  const drop =
    worst.conversionFromPrevious < 1
      ? `Biggest drop-off: into "${worst.label}" (${fmt(worst.conversionFromPrevious, 'percent')} of the previous step).`
      : 'No drop-off between steps.';
  const median = last.medianSecondsFromPrevious;
  const ttc = result.timeToConvert?.medianSeconds;
  return (
    `${who} started; ${fmt(last.count)} completed (${fmt(last.conversionFromStart, 'percent')})${order}. ${drop}` +
    (median !== null ? ` Median time into the last step: ${formatSeconds(median)}.` : '') +
    (ttc != null ? ` Median time to convert: ${formatSeconds(ttc)}.` : '')
  );
}

export async function runFunnel(input: FunnelSpec, ctx: QueryContext): Promise<FunnelResult> {
  const spec = input as Spec;
  validate(spec);
  const f = funnelSetup(spec, ctx);
  const { parts, bins, sql, breakdowns } = await partsFor(spec, ctx, f.range, f.aggregation);
  const c: Collected = {
    byValue: new Map(),
    medianCells: new Map(),
    ttc: { cells: [], total: 0, count: 0 },
    trendRows: [],
  };
  await Promise.all(parts.map(({ o }) => runPart(f, o, ctx, sql, c)));
  const total = [...c.byValue.values()].reduce(
    (acc, steps) => addCounts(acc, steps),
    new Map() as StepCounts,
  );
  const result: FunnelResult = {
    kind: 'funnel',
    order: f.order,
    windowSeconds: f.windowMs / 1000,
    aggregateBy: typeof f.aggregation === 'object' ? f.aggregation.group : f.aggregation,
    steps: shapeSteps(spec, total, mergeCells([...c.medianCells.values()])),
    sql,
    range: { from: iso(f.range.from), to: iso(f.range.to) },
    summary: '',
  };
  if (bins) result.bins = bins;
  if (breakdowns.length) result.breakdowns = breakdownResults(spec, c, bins, breakdowns);
  if (f.viz === 'time_to_convert') result.timeToConvert = timeToConvertResult(f, c.ttc);
  if (f.viz === 'trends') result.trend = trendResult(f, c.trendRows, breakdowns.length > 0);
  result.summary = funnelSummary(result, f.aggregation);
  return result;
}

export function formatSeconds(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

// ── Drill-down ───────────────────────────────────────────────────────────────

/**
 * The actors who reached a step (status "converted"), or reached the step before
 * it but not it ("dropped"). SQL selecting `actor` and `n` (always 1).
 */
/** The chain options for drilling into one breakdown value (a cohort adds its filter). */
function actorChainOptions(spec: Spec, d: Dialect, breakdown: string | undefined): ChainOptions {
  const breakdowns = breakdownProperties(spec.breakdown);
  const aggregation = parseAggregation(spec.aggregateBy);
  if (!isCohortBreakdown(breakdowns))
    return { bd: breakdowns.length ? breakdownExpr(breakdowns, d) : "''", extra: [], aggregation };
  const c =
    breakdown === undefined
      ? undefined
      : spec.cohortBreakdown?.find((x) => x.label === breakdown || x.key === breakdown);
  return c
    ? { bd: d.str(c.label), extra: [c.filter], aggregation }
    : { bd: "''", extra: [], aggregation };
}

export function compileFunnelActors(
  input: FunnelSpec,
  ctx: QueryContext,
  selection: { step?: number; status?: 'converted' | 'dropped'; breakdown?: string },
  page: { limit: number; offset: number },
): string {
  const spec = input as Spec;
  const d = ctx.dialect;
  const n = spec.steps.length;
  const step = selection.step ?? n;
  if (step < 1 || step > n) throw new RangeError(`step must be between 1 and ${n}.`);
  const status = selection.status ?? 'converted';
  if (status === 'dropped' && step === 1)
    throw new RangeError('No one drops off before the first step; use step 2 or later.');
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const o = actorChainOptions(spec, d, selection.breakdown);
  const where = [
    status === 'converted'
      ? reached(spec, step)
      : `${reached(spec, step - 1)} AND NOT (${reached(spec, step)})`,
  ];
  const breakdowns = breakdownProperties(spec.breakdown);
  if (selection.breakdown !== undefined && breakdowns.length && !isCohortBreakdown(breakdowns))
    where.push(`f.bd = ${d.str(selection.breakdown)}`);
  return `${funnelChain(spec, ctx, range, parseDuration(spec.window ?? '7d'), o)}SELECT f.actor AS actor, 1 AS n FROM f WHERE ${where.join(' AND ')}
ORDER BY f.actor LIMIT ${d.num(page.limit)} OFFSET ${d.num(page.offset)}`;
}
