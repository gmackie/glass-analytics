/**
 * Experiments through the API: metrics and options stored with the experiment,
 * the lifecycle (pause, resume, reset, archive), duplication, holdouts, web
 * experiments and planning.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearFlagCache } from '../src/flags.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup() {
  clearGroupTypeCache();
  clearFlagCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

type Exp = {
  experiment: { status: string; metrics: unknown[]; holdout: string | null; flag: string };
};
const flagOf = async (key: string) =>
  (await t.json<{ flag: Record<string, unknown> }>('GET', `/api/flags/${key}?project=acme`)).flag;
const act = (key: string, action: string, body: Record<string, unknown> = {}) =>
  t.call('POST', `/api/experiments/${key}/${action}`, { body: { project: 'acme', ...body } });

describe('experiment lifecycle', () => {
  beforeEach(setup);

  it('stores metrics and options and reads them back in results', async () => {
    await t.json('POST', '/api/experiments', {
      body: {
        project: 'acme',
        key: 'pricing',
        metrics: [
          { kind: 'mean', event: 'buy', math: 'sum', property: 'amount', winsorize: { upper: 99 } },
        ],
        secondary: [{ kind: 'conversion', event: 'refund', goal: 'decrease' }],
        engine: 'frequentist',
        confidence: 0.9,
        minimumDays: 0,
      },
    });
    await act('pricing', 'start');
    await t.ingest([
      wire('$exposure', {
        id: 'x1',
        distinct_id: 'a',
        props: { flag: 'pricing', variant: 'control' },
      }),
      wire('buy', { id: 'b1', distinct_id: 'a', props: { amount: 10 } }),
    ]);
    const r = await t.json<{
      results: {
        engine: string;
        confidence: number;
        metrics: { kind: string }[];
        secondary: { goal: string }[];
      };
    }>('GET', '/api/experiments/pricing?project=acme', { key: READ });
    assert.equal(r.results.engine, 'frequentist');
    assert.equal(r.results.confidence, 0.9);
    assert.equal(r.results.metrics[0]!.kind, 'mean');
    assert.equal(r.results.secondary[0]!.goal, 'decrease');
  });

  it('pauses, resumes, stops, resets and archives', async () => {
    await t.json('POST', '/api/experiments', {
      body: { project: 'acme', key: 'e', goal: { event: 'buy' } },
    });
    assert.equal((await act('e', 'pause')).status, 409);
    await act('e', 'start');
    assert.equal((await flagOf('e')).enabled, true);
    await act('e', 'pause');
    assert.equal((await flagOf('e')).enabled, false);
    await act('e', 'resume');
    assert.equal((await flagOf('e')).enabled, true);
    await act('e', 'stop');
    const reset = await t.json<Exp & { experiment: { startedAt: number | null } }>(
      'POST',
      '/api/experiments/e/reset',
      {
        body: { project: 'acme' },
      },
    );
    assert.equal(reset.experiment.status, 'draft');
    assert.equal(reset.experiment.startedAt, null);
    await t.json('POST', '/api/experiments/e/archive', { body: { project: 'acme' } });
    const list = await t.json<{ experiments: unknown[] }>('GET', '/api/experiments?project=acme');
    assert.equal(list.experiments.length, 0);
    const all = await t.json<{ experiments: unknown[] }>(
      'GET',
      '/api/experiments?project=acme&include_archived=true',
    );
    assert.equal(all.experiments.length, 1);
    await t.json('POST', '/api/experiments/e/unarchive', { body: { project: 'acme' } });
  });

  it('edits metrics and duplicates experiments', async () => {
    await t.json('POST', '/api/experiments', {
      body: { project: 'acme', key: 'e', goal: { event: 'buy' } },
    });
    const edited = await t.json<Exp>('PATCH', '/api/experiments/e', {
      body: { project: 'acme', metrics: [{ kind: 'conversion', event: 'signup' }], mde: 0.05 },
    });
    assert.equal(edited.experiment.metrics.length, 1);
    const copy = await t.json<Exp>('POST', '/api/experiments/e/duplicate', {
      body: { project: 'acme', newKey: 'e2' },
    });
    assert.equal(copy.experiment.flag, 'e2');
    assert.equal(copy.experiment.status, 'draft');
    assert.equal(copy.experiment.metrics.length, 1);
  });
});

describe('holdouts', () => {
  beforeEach(setup);

  it('keeps a share of people out and measures them', async () => {
    await t.json('PUT', '/api/holdouts/q1', {
      body: { project: 'acme', name: 'Q1 holdout', percentage: 20 },
    });
    assert.equal(
      (await t.call('PUT', '/api/holdouts/huge', { body: { project: 'acme', percentage: 80 } }))
        .status,
      400,
    );
    await t.json('POST', '/api/experiments', {
      body: { project: 'acme', key: 'e', goal: { event: 'buy' }, holdout: 'q1' },
    });
    assert.deepEqual((await flagOf('e')).holdout, { key: 'q1', percentage: 20 });
    await act('e', 'start');
    const values = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const r = await t.json<{ flags: Record<string, string> }>('POST', '/f', {
        key: null,
        body: { project: 'acme', distinct_id: `d${i}` },
      });
      const v = r.flags.e ?? 'off';
      values.set(v, (values.get(v) ?? 0) + 1);
    }
    const held = values.get('holdout') ?? 0;
    assert.ok(held > 20 && held < 65, `held out ${held} of 200`);
    // Changing the percentage updates the experiments' flags.
    await t.json('PUT', '/api/holdouts/q1', { body: { project: 'acme', percentage: 5 } });
    assert.deepEqual((await flagOf('e')).holdout, { key: 'q1', percentage: 5 });
    await t.ingest([
      wire('$exposure', { id: 'h1', distinct_id: 'a', props: { flag: 'e', variant: 'holdout' } }),
      wire('$exposure', { id: 'h2', distinct_id: 'b', props: { flag: 'e', variant: 'test' } }),
      wire('buy', { id: 'h3', distinct_id: 'b' }),
    ]);
    const results = await t.json<{
      results: { metrics: { variants: { variant: string; exposures: number }[] }[] };
    }>('GET', '/api/holdouts/q1/results?project=acme');
    assert.deepEqual(
      results.results.metrics[0]!.variants.map((v) => [v.variant, v.exposures]),
      [
        ['holdout', 1],
        ['experiments', 1],
      ],
    );
    assert.equal((await t.call('DELETE', '/api/holdouts/q1?project=acme')).status, 409);
    // Shipping gives everyone the variant, holdout included.
    await act('e', 'ship', { variant: 'test' });
    assert.equal((await flagOf('e')).holdout, undefined);
  });
});

describe('web experiments and planning', () => {
  beforeEach(setup);

  it('stores page changes as payloads on every variant', async () => {
    await t.json('POST', '/api/experiments', {
      body: {
        project: 'acme',
        key: 'hero',
        goal: { event: 'signup' },
        transforms: { test: [{ selector: '#hero h1', text: 'Ship faster' }] },
      },
    });
    const flag = await flagOf('hero');
    assert.deepEqual(flag.payloads, {
      control: { type: 'web', transforms: [] },
      test: { type: 'web', transforms: [{ selector: '#hero h1', text: 'Ship faster' }] },
    });
    const bad = await t.call('POST', '/api/experiments', {
      body: { project: 'acme', key: 'x', goal: { event: 'signup' }, transforms: { nope: [] } },
    });
    assert.equal(bad.status, 400);
  });

  it('plans how long an experiment needs', async () => {
    const events = [];
    for (let i = 0; i < 100; i++) {
      events.push(wire('$pageview', { id: `p${i}`, distinct_id: `v${i}` }));
      if (i % 10 === 0)
        events.push(wire('signup', { id: `s${i}`, distinct_id: `v${i}`, ts: Date.now() - 500 }));
    }
    await t.ingest(events.slice(0, 100));
    await t.ingest(events.slice(100));
    const plan = await t.json<{
      baseline: number;
      perVariant: number;
      days: number;
      summary: string;
    }>('POST', '/api/experiments/plan', {
      key: READ,
      body: { project: 'acme', metric: { kind: 'conversion', event: 'signup' } },
    });
    assert.ok(Math.abs(plan.baseline - 0.1) < 0.001, `baseline ${plan.baseline}`);
    assert.ok(plan.perVariant > 10_000);
    assert.ok(plan.days >= 7);
    assert.match(plan.summary, /people per variant/);
  });
});
