/**
 * The service side of deeper insights: drill-down to actors (JSON and CSV),
 * cohort breakdowns resolved from saved cohorts, and annotations on charts.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup() {
  clearGroupTypeCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
  await t.ingest([
    wire('$identify', {
      id: 'i1',
      distinct_id: 'd1',
      user_id: 'ann',
      props: { $set: { plan: 'pro', email: 'ann@x.com' } },
    }),
    wire('$identify', {
      id: 'i2',
      distinct_id: 'd2',
      user_id: 'bob',
      props: { $set: { plan: 'free' } },
    }),
  ]);
  await t.ingest([
    wire('visit', { id: 'v1', distinct_id: 'd1', user_id: 'ann' }),
    wire('visit', { id: 'v2', distinct_id: 'd1', user_id: 'ann' }),
    wire('visit', { id: 'v3', distinct_id: 'd2', user_id: 'bob' }),
  ]);
}

describe('actors', () => {
  beforeEach(setup);

  it('lists the people behind a trends number, with their properties', async () => {
    const res = await t.json<{
      actors: {
        id: string;
        events: number;
        properties: Record<string, unknown>;
        dashboard: string;
      }[];
      hasMore: boolean;
      summary: string;
    }>('POST', '/api/actors', {
      body: {
        project: 'acme',
        kind: 'trends',
        spec: { series: [{ event: 'visit' }] },
        selection: { series: 0 },
      },
      key: READ,
    });
    assert.deepEqual(
      res.actors.map((a) => [a.id, a.events, a.properties.plan]),
      [
        ['ann', 2, 'pro'],
        ['bob', 1, 'free'],
      ],
    );
    assert.equal(res.hasMore, false);
    assert.match(res.actors[0]!.dashboard, /#\/users\/ann/);
    assert.match(res.summary, /ann@x\.com/);
  });

  it('pages and exports CSV', async () => {
    const page = await t.json<{ actors: { id: string }[]; hasMore: boolean }>(
      'POST',
      '/api/actors',
      {
        body: {
          project: 'acme',
          kind: 'trends',
          spec: { series: [{ event: 'visit' }] },
          selection: { series: 0 },
          limit: 1,
        },
      },
    );
    assert.equal(page.actors.length, 1);
    assert.equal(page.hasMore, true);
    const res = await t.call('POST', '/api/actors?format=csv', {
      body: {
        project: 'acme',
        kind: 'trends',
        spec: { series: [{ event: 'visit' }] },
        selection: { series: 0 },
      },
    });
    assert.equal(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
    const csv = await res.text();
    assert.match(csv.split('\n')[0]!, /^id,type,events,/);
    assert.match(csv, /ann,person,2/);
  });
});

describe('cohort breakdowns', () => {
  beforeEach(setup);

  it('splits a trend by saved cohorts, labelled with their names', async () => {
    for (const [key, name, plan] of [
      ['pro', 'Pro plan', 'pro'],
      ['free', 'Free plan', 'free'],
    ]) {
      await t.json('POST', '/api/cohorts', {
        body: { project: 'acme', key, name, filters: [{ property: 'person.plan', value: plan }] },
      });
    }
    const res = await t.json<{ series: { breakdown: string; total: number }[] }>(
      'POST',
      '/api/query',
      {
        body: {
          kind: 'trends',
          project: 'acme',
          series: [{ event: 'visit' }],
          breakdown: 'cohort',
          breakdownCohorts: ['pro', 'free'],
        },
      },
    );
    assert.deepEqual(
      res.series.map((s) => [s.breakdown, s.total]),
      [
        ['Pro plan', 2],
        ['Free plan', 1],
      ],
    );
  });
});

describe('annotations', () => {
  beforeEach(setup);

  it('creates, lists, attaches to trends and deletes', async () => {
    const created = await t.json<{ id: string }>('POST', '/api/annotations', {
      body: { project: 'acme', at: '-1d', text: 'Launched pricing v2' },
    });
    assert.equal(
      (
        await t.call('POST', '/api/annotations', {
          key: READ,
          body: { project: 'acme', at: 'now', text: 'x' },
        })
      ).status,
      403,
    );
    const list = await t.json<{ annotations: { id: string; text: string }[] }>(
      'GET',
      '/api/annotations?project=acme',
    );
    assert.deepEqual(
      list.annotations.map((a) => a.text),
      ['Launched pricing v2'],
    );
    const trends = await t.json<{ annotations?: { text: string }[] }>('POST', '/api/query', {
      body: { kind: 'trends', project: 'acme', series: [{ event: 'visit' }], from: '-7d' },
    });
    assert.deepEqual(
      trends.annotations?.map((a) => a.text),
      ['Launched pricing v2'],
    );
    await t.json('DELETE', `/api/annotations/${created.id}?project=acme`);
    const after = await t.json<{ annotations: unknown[] }>('GET', '/api/annotations?project=acme');
    assert.equal(after.annotations.length, 0);
  });
});

describe('funnels through the service', () => {
  beforeEach(setup);

  it('lists who dropped off at a step, and runs funnel correlation', async () => {
    await t.ingest([
      wire('checkout', { id: 'c1', distinct_id: 'd1', user_id: 'ann' }),
      wire('purchase', { id: 'p1', distinct_id: 'd1', user_id: 'ann', ts: Date.now() - 500 }),
      wire('checkout', { id: 'c2', distinct_id: 'd2', user_id: 'bob' }),
    ]);
    const spec = { steps: [{ event: 'checkout' }, { event: 'purchase' }] };
    const dropped = await t.json<{ actors: { id: string; properties: Record<string, unknown> }[] }>(
      'POST',
      '/api/actors',
      {
        body: { project: 'acme', kind: 'funnel', spec, selection: { step: 2, status: 'dropped' } },
      },
    );
    assert.deepEqual(
      dropped.actors.map((a) => [a.id, a.properties.plan]),
      [['bob', 'free']],
    );
    const correlation = await t.json<{
      kind: string;
      converters: number;
      dropOffs: number;
      dashboard: string;
    }>('POST', '/api/query', {
      body: { kind: 'funnel_correlation', project: 'acme', ...spec, limit: 5 },
    });
    assert.equal(correlation.kind, 'funnel_correlation');
    assert.equal(correlation.converters, 1);
    assert.equal(correlation.dropOffs, 1);
    // The link opens the funnel editor (where the correlation table lives), not a missing insight.
    const link = new URL(correlation.dashboard.replace('/app#/', '/'));
    assert.equal(link.pathname, '/insights/funnel');
    const linked = JSON.parse(link.searchParams.get('spec')!);
    assert.equal(linked.limit, undefined);
    assert.deepEqual(linked.steps, spec.steps);
  });
});
