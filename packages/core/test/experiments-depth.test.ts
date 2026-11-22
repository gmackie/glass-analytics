/**
 * Experiments at PostHog depth: every metric kind, both engines, winsorising,
 * exposure handling, the minimum-runtime gate, group experiments, holdouts and
 * planning.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planExperiment, runExperiment } from '../src/insights/experiment.ts';
import { experimentSpec } from '../src/insights/schemas.ts';
import { context, createDb, DAY, insert, NOW, type TestEvent } from './helpers.ts';

const T0 = NOW - 10 * DAY;
const H = 3_600_000;

function fixture(): TestEvent[] {
  const events: TestEvent[] = [];
  for (let i = 0; i < 400; i++) {
    const variant = i % 2 ? 'test' : 'control';
    const p = `${variant}-${i}`;
    events.push({
      distinct_id: p,
      event: '$exposure',
      ts_ms: T0 + i * 1000,
      props: { flag: 'exp', variant },
    });
    // A purchase before exposure never counts.
    if (i % 10 === 0)
      events.push({ distinct_id: p, event: 'buy', ts_ms: T0 - H, props: { amount: 999 } });
    // Conversion: 20% of control, 40% of test buy afterwards.
    const buys = variant === 'test' ? i % 5 < 2 : i % 5 < 1;
    if (buys) {
      events.push({ distinct_id: p, event: 'view', ts_ms: T0 + i * 1000 + H });
      events.push({
        distinct_id: p,
        event: 'buy',
        ts_ms: T0 + i * 1000 + 2 * H,
        props: { amount: variant === 'test' ? 15 : 10 },
      });
    }
    // Retention: half come back two days later.
    if (i % 4 < 2) events.push({ distinct_id: p, event: 'visit', ts_ms: T0 + i * 1000 + 2 * DAY });
  }
  // One test whale distorts the mean, unless winsorised.
  events.push({
    distinct_id: 'test-1',
    event: 'buy',
    ts_ms: T0 + 3 * H,
    props: { amount: 100_000 },
  });
  // Two people saw both variants.
  for (const p of ['both-1', 'both-2']) {
    events.push({
      distinct_id: p,
      event: '$exposure',
      ts_ms: T0,
      props: { flag: 'exp', variant: 'control' },
    });
    events.push({
      distinct_id: p,
      event: '$exposure',
      ts_ms: T0 + 1000,
      props: { flag: 'exp', variant: 'test' },
    });
  }
  return events;
}

const spec = (s: Record<string, unknown>) =>
  experimentSpec.parse({ flag: 'exp', variants: ['control', 'test'], from: T0 - DAY, ...s });

function db() {
  const d = createDb();
  insert(d, fixture());
  return d;
}

describe('experiment metrics', () => {
  it('measures conversion after exposure, excluding people who saw both variants', async () => {
    const r = await runExperiment(spec({ goal: { event: 'buy' } }), context(db()), {
      startedAt: T0,
    });
    const [control, test] = r.metrics[0]!.variants;
    assert.equal(control!.exposures, 200);
    assert.equal(control!.conversions, 40);
    assert.equal(test!.conversions, 80);
    assert.equal(r.excludedMultipleVariants, 2);
    assert.equal(r.status, 'winner');
    assert.equal(r.winner, 'test');
    assert.ok(test!.probabilityToBeBest > 0.99);
    // The original shape is kept.
    assert.equal(r.variants[1]!.conversionRate, 0.4);
  });

  it('keeps people who saw both variants on their first, if asked', async () => {
    const r = await runExperiment(
      spec({ goal: { event: 'buy' }, exposure: { multipleVariants: 'first_seen' } }),
      context(db()),
      { startedAt: T0 },
    );
    assert.equal(r.metrics[0]!.variants[0]!.exposures, 202);
  });

  it('measures means, with and without winsorising', async () => {
    const r = await runExperiment(
      spec({
        metrics: [
          { kind: 'mean', event: 'buy', math: 'sum', property: 'amount', name: 'raw' },
          {
            kind: 'mean',
            event: 'buy',
            math: 'sum',
            property: 'amount',
            name: 'clamped',
            winsorize: { upper: 99 },
          },
          { kind: 'mean', event: 'buy', name: 'purchases per person' },
        ],
      }),
      context(db()),
      { startedAt: T0 },
    );
    const [raw, clamped, count] = r.metrics;
    assert.ok(raw!.variants[1]!.value > 500, `raw test mean ${raw!.variants[1]!.value}`);
    assert.ok(clamped!.variants[1]!.value < 10, `clamped test mean ${clamped!.variants[1]!.value}`);
    assert.ok(clamped!.winsorized!.upper! < 100);
    assert.equal(count!.variants[0]!.value, 0.2);
  });

  it('measures ratios, funnels and retention', async () => {
    const r = await runExperiment(
      spec({
        metrics: [
          {
            kind: 'ratio',
            numerator: { event: 'buy', math: 'sum', property: 'amount' },
            denominator: { event: 'buy' },
            name: 'revenue per order',
          },
          { kind: 'funnel', steps: [{ event: 'view' }, { event: 'buy' }], window: '1d' },
          { kind: 'retention', event: 'visit', from: '1d', to: '3d' },
        ],
      }),
      context(db()),
      { startedAt: T0 },
    );
    const [ratio, funnel, retention] = r.metrics;
    assert.equal(ratio!.variants[0]!.value, 10);
    assert.equal(funnel!.variants[0]!.value, 0.2);
    assert.equal(funnel!.variants[1]!.value, 0.4);
    assert.equal(retention!.variants[0]!.value, 0.5);
  });

  it('computes secondary metrics and goal direction', async () => {
    const r = await runExperiment(
      spec({
        goal: { event: 'buy' },
        secondary: [
          { kind: 'conversion', event: 'visit', goal: 'decrease', name: 'support visits' },
        ],
      }),
      context(db()),
      { startedAt: T0 },
    );
    assert.equal(r.secondary.length, 1);
    assert.equal(r.secondary[0]!.goal, 'decrease');
    assert.equal(r.secondary[0]!.variants.length, 2);
  });
});

describe('experiment decisions', () => {
  it('reports p-values with the frequentist engine', async () => {
    const r = await runExperiment(
      spec({ goal: { event: 'buy' }, engine: 'frequentist', confidence: 0.99 }),
      context(db()),
      {
        startedAt: T0,
      },
    );
    const test = r.metrics[0]!.variants[1]!;
    assert.ok(test.vsControl!.pValue < 0.001);
    assert.equal(r.winner, 'test');
    assert.match(r.summary, /p = 0\.0/);
  });

  it('waits for the minimum runtime and exposures', async () => {
    const r = await runExperiment(
      spec({ goal: { event: 'buy' }, minimumDays: 30 }),
      context(db()),
      { startedAt: T0 },
    );
    assert.equal(r.status, 'too_early');
    assert.equal(r.winner, null);
    const few = await runExperiment(
      spec({ goal: { event: 'buy' }, minimumExposures: 1000 }),
      context(db()),
      {
        startedAt: T0,
      },
    );
    assert.equal(few.status, 'too_early');
  });

  it('flags a sample ratio mismatch', async () => {
    const r = await runExperiment(spec({ goal: { event: 'buy' } }), context(db()), {
      startedAt: T0,
      weights: { control: 90, test: 10 },
    });
    assert.equal(r.status, 'srm');
  });

  it('draws a daily timeline for the first metric', async () => {
    const r = await runExperiment(spec({ goal: { event: 'buy' } }), context(db()), {
      startedAt: T0,
    });
    const t = r.metrics[0]!.timeline!;
    assert.ok(t.days.length >= 1);
    assert.equal(t.variants.test!.at(-1), 0.4);
  });

  it('randomises by group', async () => {
    const d = createDb();
    insert(d, [
      {
        distinct_id: 'u1',
        event: '$exposure',
        ts_ms: T0,
        props: { flag: 'exp', variant: 'control', $groups: { company: 'a' } },
      },
      {
        distinct_id: 'u2',
        event: '$exposure',
        ts_ms: T0,
        props: { flag: 'exp', variant: 'control', $groups: { company: 'a' } },
      },
      {
        distinct_id: 'u3',
        event: '$exposure',
        ts_ms: T0,
        props: { flag: 'exp', variant: 'test', $groups: { company: 'b' } },
      },
      { distinct_id: 'u3', event: 'buy', ts_ms: T0 + H, props: { $groups: { company: 'b' } } },
    ]);
    const r = await runExperiment(
      spec({ goal: { event: 'buy' }, aggregateBy: 'company' }),
      context(d),
      { startedAt: T0 },
    );
    assert.deepEqual(
      r.metrics[0]!.variants.map((v) => [v.variant, v.exposures, v.conversions]),
      [
        ['control', 1, 0],
        ['test', 1, 1],
      ],
    );
    assert.equal(r.aggregateBy, 'company');
  });
});

describe('holdouts and planning', () => {
  it('compares the people held out with everyone in the experiments', async () => {
    const d = createDb();
    const events: TestEvent[] = [];
    for (let i = 0; i < 100; i++) {
      const held = i < 10;
      const flag = i % 2 ? 'exp-a' : 'exp-b';
      events.push({
        distinct_id: `p${i}`,
        event: '$exposure',
        ts_ms: T0,
        props: { flag, variant: held ? 'holdout' : i % 3 ? 'test' : 'control' },
      });
      if (!held && i % 2) events.push({ distinct_id: `p${i}`, event: 'buy', ts_ms: T0 + H });
    }
    insert(d, events);
    const r = await runExperiment(
      {
        ...spec({
          metrics: [{ kind: 'conversion', event: 'buy' }],
          minimumDays: 0,
          minimumExposures: 0,
        }),
        variants: undefined,
        holdoutFlags: ['exp-a', 'exp-b'],
      } as never,
      context(d),
      { startedAt: T0, weights: { holdout: 10, experiments: 90 } },
    );
    assert.deepEqual(
      r.metrics[0]!.variants.map((v) => [v.variant, v.exposures]),
      [
        ['holdout', 10],
        ['experiments', 90],
      ],
    );
    assert.equal(r.metrics[0]!.variants[0]!.value, 0);
  });

  it('plans how long an experiment needs from recent traffic', async () => {
    const d = createDb();
    const events: TestEvent[] = [];
    for (let i = 0; i < 700; i++) {
      events.push({ distinct_id: `v${i}`, event: '$pageview', ts_ms: NOW - (i % 14) * DAY - H });
      // Half an hour after their visit (ranges end at "now", exclusive).
      if (i % 10 === 0)
        events.push({ distinct_id: `v${i}`, event: 'signup', ts_ms: NOW - (i % 14) * DAY - H / 2 });
    }
    insert(d, events);
    const plan = await planExperiment(
      { metric: { kind: 'conversion', event: 'signup' }, mde: 0.2 },
      context(d),
    );
    assert.ok(Math.abs(plan.baseline - 0.1) < 0.02, `baseline ${plan.baseline}`);
    assert.ok(Math.abs(plan.peoplePerDay - 50) < 1, `per day ${plan.peoplePerDay}`);
    assert.ok(plan.perVariant! > 3000 && plan.perVariant! < 4500, `per variant ${plan.perVariant}`);
    assert.equal(plan.days, Math.max(7, Math.ceil((plan.perVariant! * 2) / plan.peoplePerDay)));
    assert.match(plan.summary, /people per variant/);
  });
});
