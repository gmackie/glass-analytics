/**
 * Trends at PostHog depth: every math, formulas, display transforms, comparison,
 * numeric and cohort breakdowns, group aggregation and drill-down to actors.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Filter } from '../src/filters.ts';
import { trendsSpec } from '../src/insights/schemas.ts';
import { compileTrendsActors, runTrends } from '../src/insights/trends.ts';
import { exactQuantile, sketchQuantile } from '../src/sql/sketch.ts';
import { context, createDb, DAY, insert, NOW } from './helpers.ts';

const spec = (s: Record<string, unknown>) => trendsSpec.parse(s);

function db() {
  const d = createDb();
  // a: active 10 days ago and today; b: 3 days ago; c: today (twice).
  insert(d, [
    { event: 'visit', distinct_id: 'a', daysAgo: 10, props: { amount: 10 } },
    { event: 'visit', distinct_id: 'a', daysAgo: 0, props: { amount: 20 } },
    { event: 'visit', distinct_id: 'b', daysAgo: 3, props: { amount: 30 } },
    { event: 'visit', distinct_id: 'c', daysAgo: 0, props: { amount: 40 } },
    { event: 'visit', distinct_id: 'c', daysAgo: 0, props: { amount: 1000 } },
    { event: 'buy', distinct_id: 'a', daysAgo: 0, props: { amount: 5 } },
    { event: 'buy', distinct_id: 'c', daysAgo: 0, props: { amount: 7 } },
  ]);
  return d;
}

const last = (values: number[]) => values.at(-1)!;

describe('trends maths', () => {
  it('counts any of several events', async () => {
    const res = await runTrends(
      spec({ series: [{ event: ['visit', 'buy'] }], from: '-30d' }),
      context(db()),
    );
    assert.equal(res.series[0]!.total, 7);
  });

  it('counts unique actors per day (dau) and in rolling windows (wau, mau)', async () => {
    const ctx = context(db());
    const res = await runTrends(
      spec({
        series: [
          { event: 'visit', math: 'dau' },
          { event: 'visit', math: 'wau' },
          { event: 'visit', math: 'mau' },
        ],
        from: '-14d',
        interval: 'day',
      }),
      ctx,
    );
    const [dau, wau, mau] = res.series;
    assert.equal(last(dau!.values), 2); // a, c today
    assert.equal(last(wau!.values), 3); // a, b, c in the last 7 days
    assert.equal(last(mau!.values), 3);
    // Four days ago, the 7-day window (days -10 to -4) holds only a's visit from 10 days ago.
    const fourAgo = res.buckets.findIndex(
      (b) => b === Math.floor((NOW - 4 * DAY - 60_000) / DAY) * DAY,
    );
    assert.equal(wau!.values[fourAgo], 1);
    // The total of a rolling count is its last value.
    assert.equal(wau!.total, 3);
  });

  it('counts first-time actors against all history', async () => {
    const res = await runTrends(
      spec({ series: [{ event: 'visit', math: 'first_time' }], from: '-5d' }),
      context(db()),
    );
    // a first visited 10 days ago, before the range: only b and c are new.
    assert.equal(res.series[0]!.total, 2);
  });

  it('aggregates a property: sum, avg, min, max and percentiles', async () => {
    const ctx = context(db());
    const res = await runTrends(
      spec({
        series: ['sum', 'avg', 'min', 'max', 'median', 'p90'].map((math) => ({
          event: 'visit',
          math,
          property: 'amount',
        })),
        from: '-30d',
      }),
      ctx,
    );
    const [sum, avg, min, max, median, p90] = res.series.map((s) => s.total);
    assert.equal(sum, 1100);
    assert.equal(avg, 220);
    assert.equal(min, 10);
    assert.equal(max, 1000);
    // Sketch percentiles are within 1% of the true value.
    assert.ok(Math.abs(median! - 30) / 30 < 0.01, `median ${median}`);
    assert.ok(Math.abs(p90! - 1000) / 1000 < 0.01, `p90 ${p90}`);
  });

  it('aggregates how often each actor did it', async () => {
    const res = await runTrends(
      spec({
        series: [
          { event: 'visit', math: 'avg_count_per_actor' },
          { event: 'visit', math: 'max_count_per_actor' },
          { event: 'visit', math: 'median_count_per_actor' },
        ],
        from: '-30d',
      }),
      context(db()),
    );
    const [avg, max, median] = res.series.map((s) => s.total);
    assert.equal(avg, 5 / 3);
    assert.equal(max, 2);
    assert.equal(median, 2); // counts 2, 1, 2
  });

  it('counts groups, and aggregates by group', async () => {
    const d = createDb();
    insert(d, [
      { event: 'report', distinct_id: 'u1', props: { $groups: { company: 'acme' } } },
      { event: 'report', distinct_id: 'u2', props: { $groups: { company: 'acme' } } },
      { event: 'report', distinct_id: 'u3', props: { $groups: { company: 'globex' } } },
      { event: 'report', distinct_id: 'u4' },
    ]);
    const res = await runTrends(
      spec({
        series: [
          { event: 'report', math: 'unique_groups', groupType: 'company' },
          { event: 'report', math: 'unique_persons' },
        ],
        from: '-7d',
      }),
      context(d),
    );
    assert.equal(res.series[0]!.total, 2);
    assert.equal(res.series[1]!.total, 4);
    const byGroup = await runTrends(
      spec({
        series: [{ event: 'report', math: 'unique_persons' }],
        from: '-7d',
        aggregateBy: 'company',
      }),
      context(d),
    );
    assert.equal(byGroup.series[0]!.total, 2);
    assert.match(byGroup.summary, /company groups/);
  });

  it('explains a missing property or group type', async () => {
    await assert.rejects(
      runTrends(spec({ series: [{ event: 'visit', math: 'p95' }] }), context(db())),
      /no "property"/,
    );
    await assert.rejects(
      runTrends(spec({ series: [{ event: 'visit', math: 'unique_groups' }] }), context(db())),
      /groupType/,
    );
  });
});

describe('trends formulas and transforms', () => {
  it('computes formulas per bucket and per breakdown value', async () => {
    const d = createDb();
    insert(d, [
      { event: 'visit', distinct_id: 'a', browser: 'Chrome' },
      { event: 'visit', distinct_id: 'b', browser: 'Chrome' },
      { event: 'visit', distinct_id: 'c', browser: 'Safari' },
      { event: 'buy', distinct_id: 'a', browser: 'Chrome' },
      { event: 'buy', distinct_id: 'c', browser: 'Safari' },
    ]);
    const res = await runTrends(
      spec({
        series: [{ event: 'visit' }, { event: 'buy' }],
        formulas: [{ expr: 'B / A * 100', label: 'Conversion %' }],
        breakdown: 'browser',
        from: '-7d',
      }),
      context(d),
    );
    const byBrowser = Object.fromEntries(res.formulas!.map((f) => [f.breakdown, f.total]));
    assert.deepEqual(byBrowser, { Chrome: 50, Safari: 100 });
    assert.equal(res.formulas![0]!.math, 'formula');

    // A percent formula keeps its ratio and says how to show it; functions work too.
    const pct = await runTrends(
      spec({
        series: [{ event: 'visit' }, { event: 'buy' }],
        formulas: [{ expr: 'round(B / A, 2)', format: 'percent' }],
        from: '-7d',
      }),
      context(d),
    );
    assert.equal(pct.formulas![0]!.total, 0.67);
    assert.equal(pct.formulas![0]!.format, 'percent');
    assert.equal(pct.formulas![0]!.breakdown, null);
  });

  it('makes cumulative, smoothed and trend lines', async () => {
    const d = createDb();
    insert(
      d,
      [1, 2, 3, 4].flatMap((n, i) =>
        Array.from({ length: n }, () => ({ event: 'x', daysAgo: 3 - i })),
      ),
    );
    const base = { series: [{ event: 'x' }], from: '-4d', interval: 'day' };
    const plain = await runTrends(spec(base), context(d));
    const counts = plain.series[0]!.values.slice(-4);
    assert.deepEqual(counts, [1, 2, 3, 4]);
    const cumulative = await runTrends(spec({ ...base, cumulative: true }), context(d));
    assert.deepEqual(cumulative.series[0]!.values.slice(-4), [1, 3, 6, 10]);
    const smooth = await runTrends(spec({ ...base, smoothing: 2 }), context(d));
    assert.deepEqual(smooth.series[0]!.values.slice(-3), [1.5, 2.5, 3.5]);
    const trend = await runTrends(spec({ ...base, trendLine: true }), context(d));
    const line = trend.series[0]!.trendLine!;
    // A straight line through rising points rises.
    assert.ok(line.at(-1)! > line[0]!);
  });

  it('computes formulas from cumulative series, so they end at the formula of the totals', async () => {
    const d = createDb();
    insert(d, [
      { event: 'visit', distinct_id: 'a', daysAgo: 2 },
      { event: 'visit', distinct_id: 'b', daysAgo: 2 },
      { event: 'buy', distinct_id: 'a', daysAgo: 2 },
      { event: 'visit', distinct_id: 'c', daysAgo: 1 },
      { event: 'visit', distinct_id: 'd', daysAgo: 1 },
      { event: 'buy', distinct_id: 'c', daysAgo: 1 },
      { event: 'buy', distinct_id: 'd', daysAgo: 1 },
    ]);
    const res = await runTrends(
      spec({
        series: [{ event: 'visit' }, { event: 'buy' }],
        formulas: [{ expr: 'B / A * 100' }],
        cumulative: true,
        from: '-3d',
        interval: 'day',
      }),
      context(d),
    );
    const f = res.formulas![0]!;
    // Day by day: 1/2 = 50%, then (1+2)/(2+2) = 75% (not 50% + 100%).
    assert.deepEqual(f.values.slice(-3, -1), [50, 75]);
    assert.equal(f.values.at(-1), f.total);
    assert.equal(f.total, 75);
  });

  it('compares with the previous period', async () => {
    const d = createDb();
    insert(d, [
      { event: 'x', daysAgo: 1 },
      { event: 'x', daysAgo: 1 },
      { event: 'x', daysAgo: 8 },
    ]);
    const res = await runTrends(
      spec({ series: [{ event: 'x' }], from: '-7d', compare: true }),
      context(d),
    );
    assert.equal(res.series[0]!.total, 2);
    assert.equal(res.compare!.series[0]!.total, 1);
    assert.equal(res.compare!.buckets.length, res.buckets.length);
  });

  it('limits minute intervals to short ranges', async () => {
    await assert.rejects(
      runTrends(spec({ series: [{ event: 'x' }], interval: 'minute', from: '-7d' }), context(db())),
      /up to two days/,
    );
    const ok = await runTrends(
      spec({ series: [{ event: 'visit' }], interval: 'minute', from: '-1h' }),
      context(db()),
    );
    assert.equal(ok.buckets.length, 60);
  });
});

describe('trends breakdowns', () => {
  it('groups a numeric property into equal ranges', async () => {
    const d = createDb();
    insert(
      d,
      [0, 10, 20, 30, 40, 50, 60, 70, 80, 100].map((seats) => ({
        event: 'signup',
        props: { seats },
      })),
    );
    const res = await runTrends(
      spec({ series: [{ event: 'signup' }], breakdown: 'seats', breakdownBins: 4, from: '-7d' }),
      context(d),
    );
    assert.deepEqual(
      res.bins!.map((b) => b.label),
      ['0 – 25', '25 – 50', '50 – 75', '75 – 100'],
    );
    const counts = Object.fromEntries(res.series.map((s) => [s.breakdown, s.total]));
    assert.deepEqual(counts, { '0 – 25': 3, '25 – 50': 2, '50 – 75': 3, '75 – 100': 2 });
  });

  it('breaks down by saved cohorts', async () => {
    const d = createDb();
    insert(d, [
      { event: 'visit', distinct_id: 'p1', person_props: { plan: 'pro' } },
      { event: 'visit', distinct_id: 'p2', person_props: { plan: 'pro' } },
      { event: 'visit', distinct_id: 'f1', person_props: { plan: 'free' } },
    ]);
    const cohort = (key: string, plan: string): Filter => ({
      property: 'cohort',
      value: key,
      cohorts: {
        [key]: {
          project: 'p',
          from: NOW - 30 * DAY,
          to: NOW,
          filters: [{ property: 'person.plan', value: plan }],
        },
      },
    });
    const res = await runTrends(
      {
        ...spec({
          series: [{ event: 'visit' }],
          breakdown: 'cohort',
          breakdownCohorts: ['pro', 'free'],
          from: '-7d',
        }),
        cohortBreakdown: [
          { key: 'pro', label: 'Pro', filter: cohort('pro', 'pro') },
          { key: 'free', label: 'Free', filter: cohort('free', 'free') },
        ],
      } as never,
      context(d),
    );
    assert.deepEqual(
      res.series.map((s) => [s.breakdown, s.total]),
      [
        ['Pro', 2],
        ['Free', 1],
      ],
    );
  });
});

describe('trends drill-down', () => {
  it('lists the actors behind a point', async () => {
    const d = db();
    const ctx = context(d);
    const s = spec({ series: [{ event: 'visit' }], from: '-14d', interval: 'day' });
    const res = await runTrends(s, ctx);
    const today = res.buckets.at(-1)!;
    const sql = compileTrendsActors(s, ctx, { series: 0, bucket: today }, { limit: 10, offset: 0 });
    const actors = await ctx.execute(sql);
    assert.deepEqual(
      actors.map((a) => [a.actor, Number(a.n)]),
      [
        ['c', 2],
        ['a', 1],
      ],
    );
    // wau: everyone active in the 7 days up to that point.
    const wau = spec({ series: [{ event: 'visit', math: 'wau' }], from: '-14d', interval: 'day' });
    const rolling = await ctx.execute(
      compileTrendsActors(wau, ctx, { series: 0, bucket: today }, { limit: 10, offset: 0 }),
    );
    assert.deepEqual(rolling.map((a) => a.actor).sort(), ['a', 'b', 'c']);
  });
});

describe('sketch quantiles', () => {
  it('is within 1% on skewed data and exact for counts', () => {
    const values = Array.from({ length: 10_000 }, (_, i) => Math.exp(i / 1000));
    const cells = new Map<number, number>();
    const gamma = Math.log(1.02);
    for (const v of values) {
      const k = Math.floor(Math.log(v) / gamma);
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
    const sketch = [...cells].map(([key, n]) => ({ sign: 1, key, n }));
    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
      const truth = sorted[Math.ceil(q * sorted.length) - 1]!;
      const got = sketchQuantile(sketch, q)!;
      assert.ok(Math.abs(got - truth) / truth < 0.01, `q${q}: ${got} vs ${truth}`);
    }
    assert.equal(
      exactQuantile(
        [
          { value: 1, n: 5 },
          { value: 3, n: 5 },
        ],
        0.5,
      ),
      1,
    );
    assert.equal(sketchQuantile([{ sign: 0, key: 0, n: 3 }], 0.5), 0);
    assert.ok(sketchQuantile([{ sign: -1, key: 100, n: 1 }], 0.5)! < 0);
  });
});
