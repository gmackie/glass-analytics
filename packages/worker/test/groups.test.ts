/**
 * Group tools: types, search, a group's detail, its properties, and erasing it
 * (its key and snapshots leave its events; the events stay with their people).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

describe('groups', () => {
  beforeEach(async () => {
    clearGroupTypeCache();
    t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
    await t.ingest([
      wire('$groupidentify', {
        props: {
          $group_type: 'company',
          $group_key: 'initech',
          $group_set: { plan: 'pro', seats: 12 },
        },
      }),
      wire('report_run', { distinct_id: 'ann', props: { $groups: { company: 'initech' } } }),
      wire('report_run', { distinct_id: 'bob', props: { $groups: { company: 'initech' } } }),
      wire('report_run', { distinct_id: 'cy', props: { $groups: { company: 'globex' } } }),
    ]);
  });

  it('lists types, searches groups and shows one', async () => {
    const types = await t.json<{ types: { type: string; groups: number }[] }>(
      'GET',
      '/api/groups/types?project=acme',
      { key: READ },
    );
    // Groups seen on events are recorded too, with or without properties.
    assert.deepEqual(
      types.types.map((x) => [x.type, x.groups]),
      [['company', 2]],
    );
    const found = await t.json<{ groups: { key: string; properties: Record<string, unknown> }[] }>(
      'GET',
      '/api/groups?project=acme&type=company&search=pro',
      { key: READ },
    );
    assert.deepEqual(
      found.groups.map((g) => [g.key, g.properties.seats]),
      [['initech', 12]],
    );
    const g = await t.json<{
      properties: Record<string, unknown>;
      activity: { events: number; people: number };
      members: { person: string }[];
      topEvents: { event: string; count: number }[];
    }>('GET', '/api/groups/company/initech?project=acme', { key: READ });
    assert.equal(g.properties.plan, 'pro');
    assert.deepEqual([g.activity.events, g.activity.people], [2, 2]);
    assert.deepEqual(g.members.map((m) => m.person).sort(), ['ann', 'bob']);
    assert.deepEqual(g.topEvents, [{ event: 'report_run', count: 2 }]);
    // A group with no properties (no $groupidentify) opens too.
    const globex = await t.json<{ activity: { events: number } }>(
      'GET',
      '/api/groups/company/globex?project=acme',
    );
    assert.equal(globex.activity.events, 1);
    assert.equal((await t.call('GET', '/api/groups/company/nobody?project=acme')).status, 404);
  });

  it("shows a person's groups on their page", async () => {
    await t.json('PATCH', '/api/groups/company/initech?project=acme', {
      body: { properties: { name: 'Initech' } },
    });
    const ann = await t.json<{
      groups: { type: string; key: string; name: string | null; link: string }[];
      summary: string;
    }>('GET', '/api/persons/ann?project=acme', { key: READ });
    assert.deepEqual(
      ann.groups.map((g) => [g.type, g.key, g.name]),
      [['company', 'initech', 'Initech']],
    );
    assert.match(ann.groups[0]!.link, /groups\/company\/initech/);
    assert.match(ann.summary, /in company initech/);
    // Someone whose events name no group has none.
    await t.ingest([wire('report_run', { distinct_id: 'dee' })]);
    const dee = await t.json<{ groups: unknown[] }>('GET', '/api/persons/dee?project=acme');
    assert.deepEqual(dee.groups, []);
  });

  it('sets properties and adds types, up to five', async () => {
    const r = await t.json<{ properties: Record<string, unknown> }>(
      'PATCH',
      '/api/groups/company/initech',
      {
        body: { project: 'acme', properties: { plan: 'enterprise', seats: null } },
      },
    );
    assert.deepEqual(r.properties, { plan: 'enterprise' });
    assert.equal(
      (
        await t.call('PATCH', '/api/groups/company/initech', {
          key: READ,
          body: { project: 'acme', properties: {} },
        })
      ).status,
      403,
    );
    for (const type of ['workspace', 'team', 'org', 'region']) {
      await t.json('PUT', `/api/groups/types/${type}`, {
        body: { project: 'acme', singular: type },
      });
    }
    const sixth = await t.call('PUT', '/api/groups/types/cluster', { body: { project: 'acme' } });
    assert.equal(sixth.status, 409);
  });

  it('erases a group from its events', async () => {
    const r = await t.json<{ deleted: boolean; events: string }>(
      'DELETE',
      '/api/groups/company/initech?project=acme',
    );
    assert.deepEqual([r.deleted, r.events], [true, 'deleted']);
    const { results } = await t.db
      .prepare(
        "SELECT distinct_id, props FROM events WHERE event = 'report_run' ORDER BY distinct_id",
      )
      .all<{
        distinct_id: string;
        props: string;
      }>();
    assert.deepEqual(
      results.map((x) => [
        x.distinct_id,
        JSON.parse(x.props).$groups?.company ?? null,
        JSON.parse(x.props).$group_props?.company ?? null,
      ]),
      [
        ['ann', null, null],
        ['bob', null, null],
        ['cy', 'globex', null],
      ],
    );
    assert.equal((await t.call('GET', '/api/groups/company/initech?project=acme')).status, 404);
  });
});
