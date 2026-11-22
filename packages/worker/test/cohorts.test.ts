/**
 * Cohorts through the API: behavioural definitions, static lists, members and
 * CSV, freezing, references between cohorts, saving a selection, and flag
 * targeting through materialised membership.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { runMaintenance } from '../src/cron.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup() {
  clearGroupTypeCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
  const now = Date.now();
  await t.ingest([
    wire('$identify', {
      id: 'i1',
      distinct_id: 'd1',
      user_id: 'ann',
      props: { $set: { plan: 'pro' } },
    }),
    wire('$identify', {
      id: 'i2',
      distinct_id: 'd2',
      user_id: 'bob',
      props: { $set: { plan: 'free' } },
    }),
    wire('$identify', {
      id: 'i3',
      distinct_id: 'd3',
      user_id: 'cat',
      props: { $set: { plan: 'free' } },
    }),
  ]);
  await t.ingest([
    ...[1, 2, 3].map((n) =>
      wire('report', { id: `r${n}`, distinct_id: 'd1', user_id: 'ann', ts: now - n * 1000 }),
    ),
    wire('report', { id: 'r4', distinct_id: 'd2', user_id: 'bob' }),
    wire('visit', { id: 'v1', distinct_id: 'd3', user_id: 'cat' }),
  ]);
}

const powerUsers = {
  groups: [
    {
      conditions: [
        { type: 'performed', event: 'report', count: { op: 'gte', value: 3 }, within: '7d' },
      ],
    },
  ],
};

describe('cohort definitions', () => {
  beforeEach(setup);

  it('saves, counts and lists behavioural cohorts', async () => {
    const saved = await t.json<{ count: number; summary: string; kind: string }>(
      'POST',
      '/api/cohorts',
      {
        body: { project: 'acme', key: 'power', name: 'Power users', definition: powerUsers },
      },
    );
    assert.equal(saved.count, 1);
    assert.equal(saved.kind, 'dynamic');
    assert.match(saved.summary, /did report at least 3 times in the last 7 days/);
    const count = await t.json<{ count: number }>('POST', '/api/cohorts/count', {
      body: {
        project: 'acme',
        definition: {
          groups: [{ conditions: [{ type: 'not_performed', event: 'report', within: '7d' }] }],
        },
      },
    });
    assert.equal(count.count, 1); // cat
    const list = await t.json<{ cohorts: { key: string; count: number; summary: string }[] }>(
      'GET',
      '/api/cohorts?project=acme',
      { key: READ },
    );
    assert.deepEqual(
      list.cohorts.map((c) => [c.key, c.count]),
      [['power', 1]],
    );
  });

  it('filters any insight by a behavioural cohort', async () => {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'power', name: 'Power', definition: powerUsers },
    });
    const res = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        project: 'acme',
        series: [{ event: 'report' }],
        filters: [{ property: 'cohort', value: 'power' }],
      },
    });
    assert.equal(res.series[0]!.total, 3);
  });

  it('lets cohorts refer to cohorts, but not in a loop or while in use', async () => {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'power', name: 'Power', definition: powerUsers },
    });
    const nested = await t.json<{ count: number }>('POST', '/api/cohorts', {
      body: {
        project: 'acme',
        key: 'pro-power',
        name: 'Pro power users',
        definition: {
          groups: [
            {
              conditions: [
                { type: 'cohort', key: 'power' },
                { type: 'property', property: 'person.plan', value: 'pro' },
              ],
            },
          ],
        },
      },
    });
    assert.equal(nested.count, 1);
    const loop = await t.call('POST', '/api/cohorts', {
      body: {
        project: 'acme',
        key: 'power',
        name: 'Power',
        definition: { groups: [{ conditions: [{ type: 'cohort', key: 'pro-power' }] }] },
      },
    });
    assert.equal(loop.status, 400);
    assert.match(((await loop.json()) as { error: string }).error, /loop/);
    const del = await t.call('DELETE', '/api/cohorts/power?project=acme');
    assert.equal(del.status, 409);
  });
});

describe('static cohorts', () => {
  beforeEach(setup);

  it('holds an explicit list that can be edited and exported', async () => {
    const saved = await t.json<{ count: number; kind: string }>('POST', '/api/cohorts', {
      body: {
        project: 'acme',
        key: 'beta',
        name: 'Beta testers',
        static: true,
        ids: ['ann', 'cat'],
      },
    });
    assert.equal(saved.kind, 'static');
    assert.equal(saved.count, 2);
    const edited = await t.json<{ count: number }>('PATCH', '/api/cohorts/beta/members', {
      body: { project: 'acme', add: ['bob'], remove: ['cat'] },
    });
    assert.equal(edited.count, 2);
    const members = await t.json<{ people: { id: string; properties: { plan?: string } }[] }>(
      'GET',
      '/api/cohorts/beta/members?project=acme',
    );
    assert.deepEqual(
      members.people.map((p) => [p.id, p.properties.plan]),
      [
        ['ann', 'pro'],
        ['bob', 'free'],
      ],
    );
    // Pages through the query string (numbers arrive as text).
    const second = await t.json<{ people: { id: string }[]; offset: number; hasMore: boolean }>(
      'GET',
      '/api/cohorts/beta/members?project=acme&limit=1&offset=1',
    );
    assert.deepEqual(
      [second.people.map((p) => p.id), second.offset, second.hasMore],
      [['bob'], 1, false],
    );
    const csv = await (
      await t.call('GET', '/api/cohorts/beta/members?project=acme&format=csv')
    ).text();
    assert.match(csv, /^id,type,events,plan/);
    const res = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        project: 'acme',
        series: [{ event: 'report' }],
        filters: [{ property: 'cohort', value: 'beta' }],
      },
    });
    assert.equal(res.series[0]!.total, 4);
  });

  it('freezes a dynamic cohort, and saves a chart selection as a cohort', async () => {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'power', name: 'Power', definition: powerUsers },
    });
    const frozen = await t.json<{ key: string; kind: string; count: number }>(
      'POST',
      '/api/cohorts/power/duplicate',
      {
        body: { project: 'acme', newKey: 'power-nov' },
      },
    );
    assert.deepEqual([frozen.key, frozen.kind, frozen.count], ['power-nov', 'static', 1]);
    const fromChart = await t.json<{ key: string; count: number }>('POST', '/api/actors', {
      body: {
        project: 'acme',
        kind: 'trends',
        spec: { series: [{ event: 'report' }] },
        selection: { series: 0 },
        saveAsCohort: { name: 'Reporters' },
      },
    });
    assert.deepEqual([fromChart.key, fromChart.count], ['reporters', 2]);
    const readOnly = await t.call('POST', '/api/actors', {
      key: READ,
      body: {
        project: 'acme',
        kind: 'trends',
        spec: { series: [{ event: 'report' }] },
        selection: { series: 0 },
        saveAsCohort: { name: 'X' },
      },
    });
    assert.equal(readOnly.status, 403);
  });
});

describe('flags targeting cohorts', () => {
  beforeEach(setup);

  const evaluate = async (distinct: string, user: string) =>
    (
      await t.json<{ flags: Record<string, string> }>('POST', '/f', {
        key: null,
        body: { project: 'acme', distinct_id: distinct, user_id: user },
      })
    ).flags;

  it('serves a flag to a dynamic cohort once its membership is materialised', async () => {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'power', name: 'Power', definition: powerUsers },
    });
    await t.json('PUT', '/api/flags/new-editor', {
      body: {
        project: 'acme',
        rollout: 0,
        rules: [{ conditions: [{ property: 'cohort', value: 'power' }], rollout: 100 }],
      },
    });
    // Saving the flag materialises the cohort it targets, so it works straight away…
    assert.equal((await evaluate('d1', 'ann'))['new-editor'], 'on');
    // …and the maintenance task only refreshes it once it is an hour old.
    const fresh = await runMaintenance(t.env, new D1Store(t.db), Date.now(), { hourly: false });
    assert.equal(fresh.tasks.flagCohorts, 0);
    const later = await runMaintenance(t.env, new D1Store(t.db), Date.now() + 61 * 60_000, {
      hourly: false,
    });
    assert.equal(later.tasks.flagCohorts, 1);
    assert.equal((await evaluate('d2', 'bob'))['new-editor'], undefined);
    // Saving the cohort again re-materialises it straight away.
    await t.json('POST', '/api/cohorts', {
      body: {
        project: 'acme',
        key: 'power',
        name: 'Power',
        definition: {
          groups: [{ conditions: [{ type: 'performed', event: 'report', within: '7d' }] }],
        },
      },
    });
    assert.equal((await evaluate('d2', 'bob'))['new-editor'], 'on');
    assert.equal((await t.call('DELETE', '/api/cohorts/power?project=acme')).status, 409);
  });

  it('serves a flag to a static cohort immediately', async () => {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'beta', name: 'Beta', static: true, ids: ['bob'] },
    });
    await t.json('PUT', '/api/flags/beta-feature', {
      body: {
        project: 'acme',
        rollout: 0,
        rules: [{ conditions: [{ property: 'cohort', value: 'beta' }], rollout: 100 }],
      },
    });
    assert.equal((await evaluate('d2', 'bob'))['beta-feature'], 'on');
    assert.equal((await evaluate('d1', 'ann'))['beta-feature'], undefined);
  });
});
