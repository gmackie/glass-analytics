/**
 * Feature flags at PostHog depth: payloads, dependencies, bucketing by person or
 * group, early access, overrides, debug reasons, history, schedules and usage.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { evaluateFlagsDetailed, type FlagDefinition, validateFlagSet } from '@dataflare/core/flags';
import { runMaintenance } from '../src/cron.ts';
import { clearFlagCache } from '../src/flags.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup() {
  clearGroupTypeCache();
  clearFlagCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

type F = {
  flags: Record<string, string>;
  payloads?: Record<string, unknown>;
  reasons?: Record<string, string>;
  [k: string]: unknown;
};
const evaluate = (body: Record<string, unknown>) =>
  t.json<F>('POST', '/f', { key: null, body: { project: 'acme', ...body } });
const save = (key: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.call('PUT', `/api/flags/${key}`, { body: { project: 'acme', ...body }, headers });

describe('flag evaluation', () => {
  beforeEach(setup);

  it('returns payloads for the value a user gets', async () => {
    await save('pricing', {
      variants: [
        { key: 'control', weight: 50 },
        { key: 'test', weight: 50 },
      ],
      payloads: { control: { price: 10 }, test: { price: 12 } },
    });
    const r = await evaluate({ distinct_id: 'd1' });
    const v = r.flags.pricing!;
    assert.deepEqual(r.payloads?.pricing, { price: v === 'control' ? 10 : 12 });
    const bad = await save('pricing', { payloads: { nope: 1 } });
    assert.equal(bad.status, 400);
  });

  it('evaluates flags that depend on other flags, and refuses loops', async () => {
    await save('base', { rollout: 100 });
    await save('dependent', {
      rollout: 0,
      rules: [{ conditions: [{ property: 'flag.base', value: 'on' }], rollout: 100 }],
    });
    assert.equal((await evaluate({ distinct_id: 'd1' })).flags.dependent, 'on');
    await save('base', { enabled: false });
    assert.equal((await evaluate({ distinct_id: 'd1' })).flags.dependent, undefined);
    const loop = await save('base', {
      rules: [{ conditions: [{ property: 'flag.dependent', value: 'on' }] }],
    });
    assert.equal(loop.status, 400);
    assert.match(((await loop.json()) as { error: string }).error, /loop/);
    assert.equal((await t.call('DELETE', '/api/flags/base?project=acme')).status, 409);
  });

  it('buckets by person across devices, and by group', async () => {
    await save('per-person', { rollout: 50, bucketBy: 'person' });
    await save('per-company', { rollout: 50, bucketBy: 'company' });
    // The same person on many devices always gets the same value.
    const values = new Set<string | undefined>();
    for (let i = 0; i < 10; i++)
      values.add((await evaluate({ distinct_id: `dev-${i}`, user_id: 'ann' })).flags['per-person']);
    assert.equal(values.size, 1);
    // Everyone in a company shares a value; no company, no flag.
    const company = new Set<string | undefined>();
    for (let i = 0; i < 10; i++)
      company.add(
        (await evaluate({ distinct_id: `u-${i}`, groups: { company: 'acme-inc' } })).flags[
          'per-company'
        ],
      );
    assert.equal(company.size, 1);
    const none = await evaluate({ distinct_id: 'x', debug: true });
    assert.equal(none.flags['per-company'], undefined);
    assert.match(none.reasons!['per-company']!, /no company group/);
  });

  it('targets group properties', async () => {
    await t.ingest([
      wire('$groupidentify', {
        id: 'g',
        props: { $group_type: 'company', $group_key: 'big', $group_set: { tier: 'enterprise' } },
      }),
    ]);
    await save('enterprise-only', {
      rollout: 0,
      rules: [
        { conditions: [{ property: 'group.company.tier', value: 'enterprise' }], rollout: 100 },
      ],
    });
    assert.equal(
      (await evaluate({ distinct_id: 'd', groups: { company: 'big' } })).flags['enterprise-only'],
      'on',
    );
    assert.equal(
      (await evaluate({ distinct_id: 'd', groups: { company: 'small' } })).flags['enterprise-only'],
      undefined,
    );
  });

  it('offers early-access features people can opt into', async () => {
    await save('new-editor', {
      rollout: 0,
      earlyAccess: { name: 'New editor', description: 'Try it first', stage: 'beta' },
    });
    const before = await evaluate({ distinct_id: 'd1', user_id: 'ann', early_access: true });
    assert.equal(before.flags['new-editor'], undefined);
    assert.deepEqual(before.earlyAccess, [
      {
        key: 'new-editor',
        name: 'New editor',
        description: 'Try it first',
        stage: 'beta',
        enrolled: null,
      },
    ]);
    // What glass.optIn('new-editor') sends.
    await t.ingest([
      wire('$set', {
        id: 'opt',
        distinct_id: 'd1',
        user_id: 'ann',
        props: { $set: { $early_access: { 'new-editor': true } } },
      }),
    ]);
    const after = await evaluate({
      distinct_id: 'd1',
      user_id: 'ann',
      early_access: true,
      debug: true,
    });
    assert.equal(after.flags['new-editor'], 'on');
    assert.equal(after.reasons!['new-editor'], 'opted in');
    assert.equal((after.earlyAccess as { enrolled: boolean }[])[0]!.enrolled, true);
  });

  it('tells the SDK when URL overrides are allowed', async () => {
    await save('x', { rollout: 100 });
    assert.equal((await evaluate({ distinct_id: 'd' })).allowOverrides, undefined);
    await t.json('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { allowFlagOverrides: true } },
    });
    assert.equal((await evaluate({ distinct_id: 'd' })).allowOverrides, true);
  });

  it('explains every value for a user (evaluate_flags)', async () => {
    await save('off', { enabled: false });
    await save('everyone', { rollout: 100 });
    const r = await t.json<{ reasons: Record<string, string>; summary: string }>(
      'POST',
      '/api/flags/evaluate',
      {
        key: READ,
        body: { project: 'acme', distinct_id: 'd1' },
      },
    );
    assert.equal(r.reasons.off, 'disabled');
    assert.equal(r.reasons.everyone, 'rollout');
    assert.match(r.summary, /everyone: on/);
  });
});

describe('flag history and schedules', () => {
  beforeEach(setup);

  it('records who changed what', async () => {
    await save('x', { rollout: 10 }, { 'X-Glass-Actor': 'Ann' });
    await save('x', { rollout: 20 });
    const h = await t.json<{ history: { action: string; actor: string; changed: string[] }[] }>(
      'GET',
      '/api/flags/x/history?project=acme',
    );
    assert.deepEqual(
      h.history.map((c) => [c.action, c.changed]),
      [
        ['update', ['rollout']],
        ['create', []],
      ],
    );
    assert.equal(h.history[1]!.actor, 'Ann (admin key)');
  });

  it('applies scheduled changes when they are due', async () => {
    await save('promo', { rollout: 100 });
    const at = Date.now() + 60 * 60_000;
    const res = await t.json<{ schedule: { id: string } }>('POST', '/api/flags/promo/schedule', {
      body: { project: 'acme', at, change: { enabled: false } },
    });
    const early = await runMaintenance(t.env, new D1Store(t.db), Date.now(), { hourly: false });
    assert.equal(early.tasks.flagSchedules, 0);
    const due = await runMaintenance(t.env, new D1Store(t.db), at + 1000, { hourly: false });
    assert.equal(due.tasks.flagSchedules, 1);
    clearFlagCache();
    const flag = await t.json<{ flag: { enabled: boolean } }>(
      'GET',
      '/api/flags/promo?project=acme',
    );
    assert.equal(flag.flag.enabled, false);
    const list = await t.json<{ schedules: { id: string; status: string }[] }>(
      'GET',
      '/api/flags/schedules?project=acme',
    );
    assert.deepEqual(
      list.schedules.map((s) => [s.id, s.status]),
      [[res.schedule.id, 'done']],
    );
    const history = await t.json<{ history: { actor: string }[] }>(
      'GET',
      '/api/flags/promo/history?project=acme',
    );
    assert.equal(history.history[0]!.actor, 'schedule');
  });

  it('refuses past times, unknown fields and cancels', async () => {
    await save('x', { rollout: 100 });
    assert.equal(
      (
        await t.call('POST', '/api/flags/x/schedule', {
          body: { project: 'acme', at: Date.now() - 1000, change: { rollout: 1 } },
        })
      ).status,
      400,
    );
    const s = await t.json<{ schedule: { id: string } }>('POST', '/api/flags/x/schedule', {
      body: { project: 'acme', at: Date.now() + 60_000, change: { rollout: 5 } },
    });
    await t.json('DELETE', `/api/flags/schedules/${s.schedule.id}?project=acme`);
    assert.equal(
      (await t.call('DELETE', `/api/flags/schedules/${s.schedule.id}?project=acme`)).status,
      404,
    );
  });

  it('shows who has seen a flag', async () => {
    await save('checkout', {
      variants: [
        { key: 'control', weight: 50 },
        { key: 'test', weight: 50 },
      ],
    });
    await t.ingest([
      wire('$exposure', {
        id: 'e1',
        distinct_id: 'a',
        props: { flag: 'checkout', variant: 'control' },
      }),
      wire('$exposure', {
        id: 'e2',
        distinct_id: 'b',
        props: { flag: 'checkout', variant: 'test' },
      }),
      wire('$exposure', {
        id: 'e3',
        distinct_id: 'b',
        props: { flag: 'checkout', variant: 'test' },
      }),
    ]);
    const usage = await t.json<{
      series: { seriesIndex: number; breakdown: string; total: number }[];
      summary: string;
    }>('GET', '/api/flags/checkout/usage?project=acme');
    const people = Object.fromEntries(
      usage.series.filter((s) => s.seriesIndex === 1).map((s) => [s.breakdown, s.total]),
    );
    assert.deepEqual(people, { control: 1, test: 1 });
  });
});

describe('flag dependency order (core)', () => {
  it('evaluates dependencies first and marks loops', () => {
    const flags: FlagDefinition[] = [
      {
        key: 'c',
        enabled: true,
        rollout: 0,
        rules: [{ conditions: [{ property: 'flag.b', value: 'on' }], rollout: 100 }],
      },
      {
        key: 'b',
        enabled: true,
        rollout: 0,
        rules: [{ conditions: [{ property: 'flag.a', value: 'on' }], rollout: 100 }],
      },
      { key: 'a', enabled: true, rollout: 100 },
      {
        key: 'x',
        enabled: true,
        rollout: 100,
        rules: [{ conditions: [{ property: 'flag.y', value: 'on' }] }],
      },
      {
        key: 'y',
        enabled: true,
        rollout: 100,
        rules: [{ conditions: [{ property: 'flag.x', value: 'on' }] }],
      },
    ];
    const r = evaluateFlagsDetailed(flags, { distinct_id: 'd' });
    assert.equal(r.c!.value, 'on');
    assert.match(r.x!.reason, /loop/);
    assert.ok(validateFlagSet(flags).some((p) => /loop: x, y/.test(p)));
  });
});
