/**
 * Funnels at PostHog depth: best attempt, orders, exclusions, optional steps,
 * breakdown attribution, aggregation, time to convert, conversion over time,
 * drill-down and correlation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFunnelCorrelation, scoreCorrelation } from '../src/insights/correlation.ts';
import { compileFunnelActors, runFunnel } from '../src/insights/funnel.ts';
import { funnelCorrelationSpec, funnelSpec } from '../src/insights/schemas.ts';
import { context, createDb, DAY, insert, NOW, type TestEvent } from './helpers.ts';

const H = 3_600_000;
const T = NOW - 5 * DAY; // a moment well inside "-7d"
const spec = (s: Record<string, unknown>) => funnelSpec.parse({ from: '-7d', ...s });
const counts = (r: { steps: { count: number }[] }) => r.steps.map((s) => s.count);
const steps = (...events: string[]) => events.map((event) => ({ event }));

function at(
  distinct: string,
  event: string,
  offsetMs: number,
  extra: Partial<TestEvent> = {},
): TestEvent {
  return { distinct_id: distinct, event, ts_ms: T + offsetMs, ...extra };
}

describe('funnel counting', () => {
  it('keeps each actor’s best attempt, not only the first', async () => {
    const db = createDb();
    // p tried on day 0 without converting inside the 1-day window, then converted on day 2.
    insert(db, [at('p', 'a', 0), at('p', 'a', 2 * DAY), at('p', 'b', 2 * DAY + H)]);
    const res = await runFunnel(spec({ steps: steps('a', 'b'), window: '1d' }), context(db));
    assert.deepEqual(counts(res), [1, 1]);
  });

  it('strict order needs each step to be the very next event', async () => {
    const db = createDb();
    insert(db, [
      at('p1', 'a', 0),
      at('p1', 'c', 1000),
      at('p1', 'b', 2000),
      at('p2', 'a', 0),
      // Dataflare's own bookkeeping events don't count as "in between".
      at('p2', '$pageleave', 500),
      at('p2', 'b', 1000),
    ]);
    const ordered = await runFunnel(spec({ steps: steps('a', 'b') }), context(db));
    const strict = await runFunnel(spec({ steps: steps('a', 'b'), order: 'strict' }), context(db));
    assert.deepEqual(counts(ordered), [2, 2]);
    assert.deepEqual(counts(strict), [2, 1]);
  });

  it('unordered funnels accept the steps in any order', async () => {
    const db = createDb();
    insert(db, [at('p1', 'b', 0), at('p1', 'a', 1000), at('p2', 'a', 0), at('p3', 'b', 0)]);
    const ordered = await runFunnel(spec({ steps: steps('a', 'b') }), context(db));
    const unordered = await runFunnel(
      spec({ steps: steps('a', 'b'), order: 'unordered' }),
      context(db),
    );
    assert.deepEqual(counts(ordered), [2, 0]);
    // Everyone who did any step entered; p1 did both.
    assert.deepEqual(counts(unordered), [3, 1]);
    assert.equal(unordered.order, 'unordered');
  });

  it('drops attempts with an exclusion event between two steps', async () => {
    const db = createDb();
    insert(db, [
      at('p1', 'checkout', 0),
      at('p1', 'coupon', 1000),
      at('p1', 'purchase', 2000),
      at('p2', 'checkout', 0),
      at('p2', 'purchase', 2000),
      // A coupon after purchasing doesn't exclude.
      at('p3', 'checkout', 0),
      at('p3', 'purchase', 1000),
      at('p3', 'coupon', 2000),
    ]);
    const res = await runFunnel(
      spec({
        steps: steps('checkout', 'purchase'),
        exclusions: [{ event: 'coupon', fromStep: 1, toStep: 2 }],
      }),
      context(db),
    );
    assert.deepEqual(counts(res), [2, 2]);
  });

  it('counts optional steps without requiring them', async () => {
    const db = createDb();
    insert(db, [
      at('p1', 'a', 0),
      at('p1', 'c', 2000),
      at('p2', 'a', 0),
      at('p2', 'b', 1000),
      at('p2', 'c', 2000),
    ]);
    const res = await runFunnel(
      spec({ steps: [{ event: 'a' }, { event: 'b', optional: true }, { event: 'c' }] }),
      context(db),
    );
    assert.deepEqual(counts(res), [2, 1, 2]);
    assert.equal(res.steps[1]!.optional, true);
  });

  it('aggregates by session', async () => {
    const db = createDb();
    insert(db, [
      at('p', 'a', 0, { session_id: 's1' }),
      at('p', 'b', 1000, { session_id: 's1' }),
      at('p', 'a', DAY, { session_id: 's2' }),
    ]);
    const byPerson = await runFunnel(spec({ steps: steps('a', 'b') }), context(db));
    const bySession = await runFunnel(
      spec({ steps: steps('a', 'b'), aggregateBy: 'session' }),
      context(db),
    );
    assert.deepEqual(counts(byPerson), [1, 1]);
    assert.deepEqual(counts(bySession), [2, 1]);
    assert.match(bySession.summary, /sessions started/);
  });

  it('rejects funnels that make no sense', async () => {
    const db = createDb();
    await assert.rejects(
      runFunnel(spec({ steps: [{ event: 'a', optional: true }, { event: 'b' }] }), context(db)),
      /first funnel step/,
    );
    await assert.rejects(
      runFunnel(
        spec({ steps: steps('a', 'b'), exclusions: [{ event: 'x', fromStep: 2, toStep: 2 }] }),
        context(db),
      ),
      /fromStep < toStep/,
    );
  });
});

describe('funnel breakdown attribution', () => {
  function db() {
    const d = createDb();
    insert(d, [
      at('p1', 'a', 0, { browser: 'Chrome' }),
      at('p1', 'b', 1000, { browser: 'Safari' }),
      at('p2', 'a', 0, { browser: 'Chrome' }),
      at('p2', 'b', 1000, { browser: 'Chrome' }),
      at('p3', 'a', 0, { browser: 'Firefox' }),
    ]);
    return d;
  }
  const byValue = (r: Awaited<ReturnType<typeof runFunnel>>) =>
    Object.fromEntries(r.breakdowns!.map((b) => [b.value, counts(b)]));

  it('takes the value from the first step by default', async () => {
    const res = await runFunnel(
      spec({ steps: steps('a', 'b'), breakdown: 'browser' }),
      context(db()),
    );
    assert.deepEqual(byValue(res), { Chrome: [2, 2], Firefox: [1, 0] });
  });

  it('can take it from the last step reached, or a given step', async () => {
    const last = await runFunnel(
      spec({ steps: steps('a', 'b'), breakdown: 'browser', breakdownAttribution: 'last_touch' }),
      context(db()),
    );
    assert.deepEqual(byValue(last), { Chrome: [1, 1], Safari: [1, 1], Firefox: [1, 0] });
    const step2 = await runFunnel(
      spec({ steps: steps('a', 'b'), breakdown: 'browser', breakdownAttribution: 2 }),
      context(db()),
    );
    assert.deepEqual(byValue(step2), { Chrome: [1, 1], Safari: [1, 1], '(none)': [1, 0] });
  });

  it('with all_steps, the value must match on every step', async () => {
    const res = await runFunnel(
      spec({ steps: steps('a', 'b'), breakdown: 'browser', breakdownAttribution: 'all_steps' }),
      context(db()),
    );
    assert.deepEqual(byValue(res), { Chrome: [2, 1], Firefox: [1, 0] });
  });
});

describe('funnel views', () => {
  function db() {
    const d = createDb();
    insert(d, [
      at('p1', 'a', 0),
      at('p1', 'b', 1 * H),
      at('p2', 'a', 0),
      at('p2', 'b', 2 * H),
      at('p3', 'a', DAY),
      at('p3', 'b', DAY + 3 * H),
      at('p4', 'a', DAY),
    ]);
    return d;
  }

  it('reports mean and median time per step', async () => {
    const res = await runFunnel(spec({ steps: steps('a', 'b') }), context(db()));
    assert.equal(res.steps[1]!.avgSecondsFromPrevious, 7200);
    const median = res.steps[1]!.medianSecondsFromPrevious!;
    assert.ok(Math.abs(median - 7200) / 7200 < 0.01, `median ${median}`);
  });

  it('shows the distribution of time to convert', async () => {
    const res = await runFunnel(
      spec({ steps: steps('a', 'b'), viz: 'time_to_convert' }),
      context(db()),
    );
    const t = res.timeToConvert!;
    assert.equal(t.converters, 3);
    assert.equal(t.averageSeconds, 7200);
    assert.equal(
      t.histogram.reduce((a, b) => a + b.count, 0),
      3,
    );
    assert.match(res.summary, /Median time to convert: 2\.0h/);
  });

  it('shows conversion over time by entry date', async () => {
    const res = await runFunnel(
      spec({ steps: steps('a', 'b'), viz: 'trends', interval: 'day' }),
      context(db()),
    );
    const t = res.trend!;
    const series = t.series[0]!;
    const day0 = t.buckets.indexOf(Math.floor(T / DAY) * DAY);
    assert.equal(series.entered[day0], 2);
    assert.equal(series.converted[day0], 2);
    assert.equal(series.entered[day0 + 1], 2);
    assert.equal(series.rate[day0 + 1], 0.5);
  });

  it('lists who converted and who dropped off at a step', async () => {
    const ctx = context(db());
    const s = spec({ steps: steps('a', 'b') });
    const page = { limit: 10, offset: 0 };
    const converted = await ctx.execute(
      compileFunnelActors(s, ctx, { step: 2, status: 'converted' }, page),
    );
    const dropped = await ctx.execute(
      compileFunnelActors(s, ctx, { step: 2, status: 'dropped' }, page),
    );
    assert.deepEqual(
      converted.map((r) => r.actor),
      ['p1', 'p2', 'p3'],
    );
    assert.deepEqual(
      dropped.map((r) => r.actor),
      ['p4'],
    );
  });
});

describe('funnel correlation', () => {
  it('finds events that go with converting and with dropping off', async () => {
    const db = createDb();
    const events: TestEvent[] = [];
    for (let i = 0; i < 20; i++) {
      const p = `c${i}`;
      events.push(at(p, 'signup', 0), at(p, 'watched_demo', 1000), at(p, 'paid', 2000));
      const q = `d${i}`;
      events.push(at(q, 'signup', 0), at(q, 'saw_error', 1000));
      if (i % 4 === 0) events.push(at(q, 'watched_demo', 1500));
    }
    insert(db, events);
    const res = await runFunnelCorrelation(
      funnelCorrelationSpec.parse({ from: '-7d', steps: steps('signup', 'paid') }),
      context(db),
    );
    assert.equal(res.converters, 20);
    assert.equal(res.dropOffs, 20);
    assert.equal(res.success[0]!.event, 'watched_demo');
    assert.equal(res.success[0]!.significant, true);
    assert.equal(res.failure[0]!.event, 'saw_error');
    assert.match(res.summary, /watched_demo/);
  });

  it('finds property values that go with converting', async () => {
    const db = createDb();
    const events: TestEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(
        at(`pro${i}`, 'signup', 0, { person_props: { plan: 'pro' } }),
        at(`pro${i}`, 'paid', 1000),
      );
      events.push(at(`free${i}`, 'signup', 0, { person_props: { plan: 'free' } }));
    }
    insert(db, events);
    const res = await runFunnelCorrelation(
      funnelCorrelationSpec.parse({
        from: '-7d',
        steps: steps('signup', 'paid'),
        correlation: 'properties',
        properties: ['person.plan'],
      }),
      context(db),
    );
    assert.equal(res.success[0]!.name, 'person.plan = pro');
    assert.equal(res.failure[0]!.name, 'person.plan = free');
  });

  it('scores a 2×2 table', () => {
    const strong = scoreCorrelation(18, 2, 20, 20);
    assert.ok(strong.oddsRatio > 10);
    assert.ok(strong.pValue < 0.001);
    const none = scoreCorrelation(10, 10, 20, 20);
    assert.ok(Math.abs(none.oddsRatio - 1) < 1e-9);
    assert.ok(none.pValue > 0.9);
  });
});
