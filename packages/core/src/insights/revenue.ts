/**
 * Revenue analytics (`kind: "revenue"`): money in and recurring revenue.
 *
 * Reads the normalised fields ingest writes (see `core/src/revenue.ts`):
 * `$revenue_base` on payments and refunds, `$subscription_id`/`$mrr` on
 * subscription state. Per period it reports gross revenue, refunds, net revenue,
 * orders, paying customers and ARPU; MRR and ARR at the period's end with the
 * movements behind them (new, expansion, contraction, churned, reactivated);
 * revenue and customer churn; and LTV for monthly periods. Plus revenue by a
 * breakdown (product, first-touch channel or UTM, country, any property) and the
 * top customers — people, or accounts with `aggregateBy` set to a group type.
 *
 * MRR without window functions: each period's end joins the subscription events
 * before it (a VALUES list of ends), takes each subscription's latest state there
 * (a join on MAX(ts)), and compares it with the previous period's.
 */

import type { z } from 'zod/v4';
import type { Filter } from '../filters.ts';
import type { Dialect } from '../sql/dialect.ts';
import { breakdownExpr } from '../sql/filters.ts';
import { type Aggregation, bucketExpr, eventsCte, num, text } from '../sql/source.ts';
import { bucketsBetween, DAY_MS, resolveRange, type TimeRange, type Zone } from '../time.ts';
import { aggregationOf } from './actors.ts';
import { dimensionExpr, SOURCE_DIMENSIONS, type SourceDimension } from './report.ts';
import type { revenueSpec } from './schemas.ts';
import { type QueryContext, type ResultBase, type Row, zoneOf } from './types.ts';

export type RevenueSpec = z.infer<typeof revenueSpec>;

/** How far before the range subscription state is read (a yearly plan renews within it). */
const STATE_LOOKBACK_MS = 400 * DAY_MS;
/** First touch for revenue by channel: pageviews from this long before the range. */
const TOUCH_LOOKBACK_MS = 90 * DAY_MS;

export interface RevenuePeriod {
  gross: number;
  refunds: number;
  net: number;
  orders: number;
  customers: number;
  arpu: number;
  mrr: number;
  arr: number;
  subscriptions: number;
  subscribers: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnedMrr: number;
  reactivatedMrr: number;
  netNewMrr: number;
  /** Churned MRR / MRR at the start of the period. */
  revenueChurn: number;
  /** Subscriptions that churned / subscriptions paying at the start. */
  customerChurn: number;
}

export interface RevenueResult extends ResultBase {
  kind: 'revenue';
  currency: string;
  interval: string;
  buckets: number[];
  periods: RevenuePeriod[];
  totals: {
    gross: number;
    refunds: number;
    net: number;
    orders: number;
    customers: number;
    arpu: number;
    mrr: number;
    arr: number;
    netNewMrr: number;
    /** Average monthly revenue churn over the range (monthly periods). */
    revenueChurn: number | null;
    /** MRR per paying customer / monthly customer churn (monthly periods with churn). */
    ltv: number | null;
  };
  breakdown: {
    by: string;
    values: { value: string; net: number; customers: number; series: number[] }[];
  } | null;
  topCustomers: {
    actor: string;
    net: number;
    orders: number;
    mrr: number;
    firstAt: string;
    lastAt: string;
  }[];
  /** Revenue events with no exchange rate for their currency (left out of the totals). */
  unconverted: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const FIRST_TOUCH = new Set([
  'channel',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'entry_page',
]);

/** What every revenue query shares. */
interface RevenueSetup {
  spec: RevenueSpec;
  ctx: QueryContext;
  d: Dialect;
  range: TimeRange;
  interval: 'day' | 'week' | 'month';
  zone: Zone;
  buckets: number[];
  /** The bucket of `ts_ms`, as SQL. */
  bucket: string;
  aggregation: Aggregation;
  filters: Filter[];
  currency: string;
  /** `$revenue_base` as a number, as SQL. */
  rev: string;
  /** The `ev` CTE of events that carry revenue, and `x` reading the amount from it. */
  money: string;
  x: string;
}

function revenueSetup(spec: RevenueSpec, ctx: QueryContext): RevenueSetup {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-6mo', spec.to, ctx.now);
  const interval = spec.interval ?? 'month';
  const zone = zoneOf(spec, ctx, { from: range.from - STATE_LOOKBACK_MS, to: range.to });
  const aggregation = aggregationOf(spec);
  const filters = (spec.filters ?? []) as Filter[];
  const rev = d.jsonNumber('props', ['$revenue_base']);
  return {
    spec,
    ctx,
    d,
    range,
    interval,
    zone,
    buckets: bucketsBetween(range, interval, zone),
    bucket: bucketExpr(d, 'ts_ms', interval, zone),
    aggregation,
    filters,
    currency: (spec.currency ?? 'USD').toUpperCase(),
    rev,
    money: eventsCte(d, {
      project: ctx.project,
      ...range,
      filters: [...filters, { property: 'props.$revenue_base', op: 'is_set' }],
      aggregation,
    }),
    x: `x AS (SELECT ts_ms, pid, actor, country, props, ${rev} AS r FROM ev)`,
  };
}

/** Payments and refunds: per period, paying customers, top customers, and amounts with no rate. */
function salesQueries(r: RevenueSetup): Record<string, string> {
  const head = `WITH ${r.money},\n${r.x}`;
  const unconverted = eventsCte(r.d, {
    project: r.ctx.project,
    ...r.range,
    filters: [...r.filters, { property: 'props.$revenue_unconverted', op: 'is_set' }],
  });
  return {
    sales: `${head}
SELECT ${r.bucket} AS b,
  SUM(CASE WHEN r > 0 THEN r ELSE 0 END) AS gross,
  SUM(CASE WHEN r < 0 THEN r ELSE 0 END) AS refunds,
  SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END) AS orders,
  COUNT(DISTINCT CASE WHEN r > 0 THEN actor END) AS customers
FROM x GROUP BY ${r.bucket} ORDER BY b`,
    totals: `${head}\nSELECT COUNT(DISTINCT CASE WHEN r > 0 THEN actor END) AS customers FROM x`,
    top: `${head}
SELECT actor, SUM(r) AS net, SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END) AS orders, MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts
FROM x GROUP BY actor ORDER BY net DESC, actor ASC LIMIT ${Math.min(r.spec.limit ?? 10, 100)}`,
    unconverted: `WITH ${unconverted}\nSELECT COUNT(*) AS n FROM ev`,
  };
}

/** MRR state at each period's end (and at the end of the period before the first). */
function mrrQueries(r: RevenueSetup): Record<string, string> {
  const { d, range, buckets } = r;
  const ends = [buckets[0] ?? range.from, ...buckets.slice(1), range.to];
  const values = ends.map((e, i) => `(${i - 1}, ${d.num(e)})`).join(', ');
  const subscriptions = eventsCte(d, {
    project: r.ctx.project,
    from: range.from - STATE_LOOKBACK_MS,
    to: range.to,
    filters: [...r.filters, { property: 'props.$subscription_id', op: 'is_set' }],
    aggregation: r.aggregation,
  });
  const stateCtes = `WITH ${subscriptions},
s AS (
  SELECT ${d.jsonText('props', ['$subscription_id'])} AS sub, actor, ts_ms,
    ${d.jsonNumber('props', ['$mrr'])} AS mrr, ${d.jsonNumber('props', ['$mrr_grace_days'])} AS grace
  FROM ev
),
w AS (SELECT column1 AS i, column2 AS e FROM (VALUES ${values}) v),
latest AS (SELECT w.i AS i, w.e AS e, s.sub AS sub, MAX(s.ts_ms) AS t FROM w JOIN s ON s.ts_ms < w.e GROUP BY w.i, w.e, s.sub),
state AS (
  SELECT latest.i AS i, latest.sub AS sub, MAX(s.actor) AS actor,
    MAX(CASE WHEN s.grace IS NOT NULL AND latest.e - s.ts_ms > s.grace * ${DAY_MS} THEN 0 ELSE COALESCE(s.mrr, 0) END) AS mrr
  FROM latest JOIN s ON s.sub = latest.sub AND s.ts_ms = latest.t
  GROUP BY latest.i, latest.sub
)`;
  return {
    mrr: `${stateCtes},
firsts AS (SELECT sub, MIN(i) AS fi FROM state WHERE mrr > 0 GROUP BY sub),
moves AS (
  SELECT cur.i AS i, cur.actor AS actor, cur.mrr AS now_mrr, COALESCE(prev.mrr, 0) AS before_mrr, firsts.fi AS fi
  FROM state cur
  LEFT JOIN state prev ON prev.sub = cur.sub AND prev.i = cur.i - 1
  LEFT JOIN firsts ON firsts.sub = cur.sub
  WHERE cur.i >= 0
)
SELECT i,
  SUM(now_mrr) AS mrr,
  SUM(CASE WHEN now_mrr > 0 THEN 1 ELSE 0 END) AS subscriptions,
  COUNT(DISTINCT CASE WHEN now_mrr > 0 THEN actor END) AS subscribers,
  SUM(CASE WHEN before_mrr = 0 AND now_mrr > 0 AND fi = i THEN now_mrr ELSE 0 END) AS new_mrr,
  SUM(CASE WHEN before_mrr = 0 AND now_mrr > 0 AND fi < i THEN now_mrr ELSE 0 END) AS reactivated_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr > before_mrr THEN now_mrr - before_mrr ELSE 0 END) AS expansion_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr > 0 AND now_mrr < before_mrr THEN before_mrr - now_mrr ELSE 0 END) AS contraction_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr = 0 THEN before_mrr ELSE 0 END) AS churned_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr = 0 THEN 1 ELSE 0 END) AS churned,
  SUM(CASE WHEN before_mrr > 0 THEN 1 ELSE 0 END) AS paying_at_start,
  SUM(before_mrr) AS start_mrr
FROM moves GROUP BY i ORDER BY i`,
    mrrByActor: `${stateCtes}
SELECT actor, SUM(mrr) AS mrr FROM state WHERE i = ${ends.length - 2} AND mrr > 0 GROUP BY actor ORDER BY mrr DESC, actor ASC LIMIT 500`,
  };
}

/** Revenue by a first-touch source: each person's first pageview's channel, referrer, UTM or page. */
function firstTouchQuery(r: RevenueSetup, by: SourceDimension): string {
  const pv = eventsCte(r.d, {
    project: r.ctx.project,
    from: r.range.from - TOUCH_LOOKBACK_MS,
    to: r.range.to,
    events: ['$pageview'],
    name: 'pv',
  });
  const bucket = bucketExpr(r.d, 'x.ts_ms', r.interval, r.zone);
  return `WITH ${r.money},
${pv},
${r.x},
pfirst AS (SELECT pid, MIN(ts_ms) AS t FROM pv GROUP BY pid),
ptouch AS (
  SELECT pv.pid AS pid, MIN(${dimensionExpr(by, 'pv')}) AS val
  FROM pv JOIN pfirst ON pfirst.pid = pv.pid AND pv.ts_ms = pfirst.t GROUP BY pv.pid
)
SELECT ${bucket} AS b, COALESCE(ptouch.val, '(unknown)') AS val, SUM(x.r) AS net, COUNT(DISTINCT x.actor) AS customers
FROM x LEFT JOIN ptouch ON ptouch.pid = x.pid
GROUP BY ${bucket}, COALESCE(ptouch.val, '(unknown)')`;
}

function breakdownQuery(r: RevenueSetup, by: string): string {
  if (FIRST_TOUCH.has(by)) return firstTouchQuery(r, by as SourceDimension);
  const expr = breakdownExpr(by === 'product' ? 'props.$revenue_product' : by, r.d);
  return `WITH ${r.money}
SELECT ${r.bucket} AS b, ${expr} AS val, SUM(${r.rev}) AS net, COUNT(DISTINCT actor) AS customers
FROM ev GROUP BY ${r.bucket}, ${expr}`;
}

const emptyPeriod = (): RevenuePeriod => ({
  gross: 0,
  refunds: 0,
  net: 0,
  orders: 0,
  customers: 0,
  arpu: 0,
  mrr: 0,
  arr: 0,
  subscriptions: 0,
  subscribers: 0,
  newMrr: 0,
  expansionMrr: 0,
  contractionMrr: 0,
  churnedMrr: 0,
  reactivatedMrr: 0,
  netNewMrr: 0,
  revenueChurn: 0,
  customerChurn: 0,
});

function addSales(p: RevenuePeriod, r: Row): void {
  p.gross = round2(num(r.gross));
  p.refunds = round2(num(r.refunds));
  p.net = round2(p.gross + p.refunds);
  p.orders = num(r.orders);
  p.customers = num(r.customers);
  p.arpu = p.customers ? round2(p.net / p.customers) : 0;
}

const ratio = (a: number, b: number) => (b ? a / b : 0);

function addMrr(p: RevenuePeriod, r: Row): void {
  p.mrr = round2(num(r.mrr));
  p.arr = round2(p.mrr * 12);
  p.subscriptions = num(r.subscriptions);
  p.subscribers = num(r.subscribers);
  p.newMrr = round2(num(r.new_mrr));
  p.expansionMrr = round2(num(r.expansion_mrr));
  p.contractionMrr = round2(num(r.contraction_mrr));
  p.churnedMrr = round2(num(r.churned_mrr));
  p.reactivatedMrr = round2(num(r.reactivated_mrr));
  p.netNewMrr = round2(
    p.newMrr + p.expansionMrr + p.reactivatedMrr - p.contractionMrr - p.churnedMrr,
  );
  p.revenueChurn = ratio(num(r.churned_mrr), num(r.start_mrr));
  p.customerChurn = ratio(num(r.churned), num(r.paying_at_start));
}

function periodsFrom(
  r: RevenueSetup,
  results: Record<string, Row[]>,
  slot: Map<number, number>,
): RevenuePeriod[] {
  const periods = r.buckets.map(emptyPeriod);
  for (const row of results.sales!) {
    const p = periods[slot.get(num(row.b)) ?? -1];
    if (p) addSales(p, row);
  }
  for (const row of results.mrr!) {
    const p = periods[num(row.i)];
    if (p) addMrr(p, row);
  }
  return periods;
}

/** Average monthly revenue and customer churn over periods with subscriptions (monthly only). */
function churnAverages(periods: RevenuePeriod[], monthly: boolean) {
  const churnPeriods = periods.filter((p) => p.mrr > 0 || p.churnedMrr > 0);
  if (!monthly || !churnPeriods.length) return { revenue: null, customer: null };
  const mean = (k: 'revenueChurn' | 'customerChurn') =>
    churnPeriods.reduce((n, p) => n + p[k], 0) / churnPeriods.length;
  return { revenue: mean('revenueChurn'), customer: mean('customerChurn') };
}

type ByValue = { net: number; customers: number; series: number[] };

/** Breakdown values: top ten by net revenue, the rest as "Other". */
function breakdownResult(
  rows: Row[],
  by: string,
  buckets: number[],
  slot: Map<number, number>,
): RevenueResult['breakdown'] {
  const totalsBy = new Map<string, ByValue>();
  for (const r of rows) {
    const v = text(r.val) || '(none)';
    const e = totalsBy.get(v) ?? { net: 0, customers: 0, series: buckets.map(() => 0) };
    e.net += num(r.net);
    e.customers += num(r.customers);
    const i = slot.get(num(r.b));
    if (i !== undefined) e.series[i] = round2(e.series[i]! + num(r.net));
    totalsBy.set(v, e);
  }
  const sorted = [...totalsBy].sort((a, b) => b[1].net - a[1].net || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 10);
  const rest = sorted.slice(10);
  const add = (acc: ByValue, [, e]: [string, ByValue]) => ({
    net: acc.net + e.net,
    customers: acc.customers + e.customers,
    series: acc.series.map((n, i) => round2(n + e.series[i]!)),
  });
  if (rest.length)
    top.push(['Other', rest.reduce(add, { net: 0, customers: 0, series: buckets.map(() => 0) })]);
  return {
    by: FIRST_TOUCH.has(by)
      ? `first-touch ${SOURCE_DIMENSIONS[by as SourceDimension].toLowerCase()}`
      : by,
    values: top.map(([value, e]) => ({
      value,
      net: round2(e.net),
      customers: e.customers,
      series: e.series,
    })),
  };
}

function topCustomersOf(results: Record<string, Row[]>): RevenueResult['topCustomers'] {
  const mrrBy = new Map(results.mrrByActor!.map((r) => [text(r.actor), round2(num(r.mrr))]));
  return results.top!.map((r) => ({
    actor: text(r.actor),
    net: round2(num(r.net)),
    orders: num(r.orders),
    mrr: mrrBy.get(text(r.actor)) ?? 0,
    firstAt: new Date(num(r.first_ts)).toISOString(),
    lastAt: new Date(num(r.last_ts)).toISOString(),
  }));
}

const PAYING: Record<string, string> = { person: 'customers', session: 'sessions' };

function mrrSentences(
  last: RevenuePeriod,
  churn: number | null,
  ltv: number | null,
  money: (n: number) => string,
): string[] {
  const out = [
    `MRR ${money(last.mrr)} (ARR ${money(last.arr)}), ${last.netNewMrr >= 0 ? '+' : ''}${money(last.netNewMrr)} in the last period: new ${money(last.newMrr)}, expansion ${money(last.expansionMrr)}, reactivated ${money(last.reactivatedMrr)}, contraction ${money(last.contractionMrr)}, churned ${money(last.churnedMrr)}.`,
  ];
  if (churn !== null)
    out.push(
      `Revenue churn ${(churn * 100).toFixed(1)}% a month${ltv ? `, LTV about ${money(ltv)}` : ''}.`,
    );
  return out;
}

function revenueSummary(
  r: RevenueSetup,
  t: RevenueResult['totals'],
  last: RevenuePeriod | undefined,
  breakdown: RevenueResult['breakdown'],
  unconverted: number,
): string {
  if (t.net === 0 && !last?.mrr)
    return 'No revenue in this range. Set revenueEvents (update_settings) or connect Stripe (connect_stripe).';
  const money = (n: number) =>
    new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: r.currency,
      maximumFractionDigits: 0,
    }).format(n);
  const who =
    typeof r.aggregation === 'object' ? `${r.aggregation.group} accounts` : PAYING[r.aggregation]!;
  const refunds = t.refunds ? `, refunds ${money(Math.abs(t.refunds))}` : '';
  const parts = [
    `Net revenue ${money(t.net)} (gross ${money(t.gross)}${refunds}) from ${t.customers} paying ${who}.`,
  ];
  if (last && (last.mrr > 0 || last.churnedMrr > 0))
    parts.push(...mrrSentences(last, t.revenueChurn, t.ltv, money));
  const top = breakdown?.values[0];
  if (top) parts.push(`Top ${breakdown!.by}: ${top.value} (${money(top.net)}).`);
  if (unconverted)
    parts.push(
      `${unconverted} revenue events had no exchange rate for their currency and are left out.`,
    );
  return parts.join(' ');
}

export async function runRevenue(spec: RevenueSpec, ctx: QueryContext): Promise<RevenueResult> {
  const r = revenueSetup(spec, ctx);
  const sql: Record<string, string> = {
    ...salesQueries(r),
    ...mrrQueries(r),
    ...(spec.breakdown ? { breakdown: breakdownQuery(r, spec.breakdown) } : {}),
  };
  const names = Object.keys(sql);
  const results: Record<string, Row[]> = Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await ctx.execute(sql[n]!)] as const)),
  );
  const slot = new Map(r.buckets.map((b, i) => [b, i]));
  const periods = periodsFrom(r, results, slot);
  const sum = (k: keyof RevenuePeriod) => round2(periods.reduce((n, p) => n + p[k], 0));
  const last = periods.at(-1);
  const customers = num(results.totals![0]?.customers);
  const gross = sum('gross');
  const refunds = sum('refunds');
  const net = round2(gross + refunds);
  const churn = churnAverages(periods, r.interval === 'month');
  const arpa = last?.subscribers ? last.mrr / last.subscribers : 0;
  const ltv = churn.customer ? round2(arpa / churn.customer) : null;
  const breakdown =
    spec.breakdown && results.breakdown
      ? breakdownResult(results.breakdown, spec.breakdown, r.buckets, slot)
      : null;
  const unconverted = num(results.unconverted![0]?.n);
  const totals: RevenueResult['totals'] = {
    gross,
    refunds,
    net,
    orders: periods.reduce((n, p) => n + p.orders, 0),
    customers,
    arpu: customers ? round2(net / customers) : 0,
    mrr: last?.mrr ?? 0,
    arr: last?.arr ?? 0,
    netNewMrr: sum('netNewMrr'),
    revenueChurn: churn.revenue,
    ltv,
  };
  return {
    kind: 'revenue',
    currency: r.currency,
    interval: r.interval,
    buckets: r.buckets,
    periods,
    totals,
    breakdown,
    topCustomers: topCustomersOf(results),
    unconverted,
    summary: revenueSummary(r, totals, last, breakdown, unconverted),
    sql: Object.values(sql),
    range: { from: new Date(r.range.from).toISOString(), to: new Date(r.range.to).toISOString() },
  };
}
