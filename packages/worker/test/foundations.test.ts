/**
 * Foundations: historical import, the server key, project settings (time zone,
 * internal traffic), group ingest and the five-minute maintenance tick.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { deriveServerKey } from '@dataflare/core/hash';
import { CRON_SCHEDULE, FREQUENT_TASKS, isHourlyTick, runMaintenance } from '../src/cron.ts';
import { boundedProps, clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { ADMIN, READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;
const DAY = 86_400_000;

async function setup() {
  clearGroupTypeCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

const rows = (sql: string, ...args: (string | number)[]) =>
  t.db.sqlite.prepare(sql).all(...args) as Record<string, unknown>[];

describe('historical import', () => {
  beforeEach(setup);

  it('keeps old timestamps on import but not on public ingest', async () => {
    const old = Date.now() - 400 * DAY;
    await t.ingest([wire('$pageview', { id: 'public-old', ts: old })]);
    const res = await t.json<{ accepted: number; project: string }>('POST', '/api/import', {
      body: {
        project: 'acme',
        events: [
          {
            id: 'imported-old',
            event: 'order_paid',
            ts: old,
            distinct_id: 'u1',
            user_id: 'u1',
            props: { amount: 49 },
            context: { country: 'FR', browser: 'Firefox' },
          },
        ],
      },
    });
    assert.equal(res.accepted, 1);
    const [pub] = rows("SELECT ts_ms FROM events WHERE id = 'public-old'");
    const [imp] = rows(
      "SELECT ts_ms, country, browser, person_id FROM events WHERE id = 'imported-old'",
    );
    // Public ingest still treats a 400-day-old timestamp as a clock error (7 days at most).
    assert.ok(Number(pub!.ts_ms) >= Date.now() - 7 * DAY - 60_000);
    assert.equal(Number(imp!.ts_ms), old);
    assert.equal(imp!.country, 'FR');
    assert.equal(imp!.browser, 'Firefox');
    assert.equal(imp!.person_id, 'u1');
  });

  it('de-duplicates retried imports by id', async () => {
    const event = { id: 'dup-1', event: 'x', ts: Date.now() - 90 * DAY, distinct_id: 'd' };
    await t.json('POST', '/api/import', { body: { project: 'acme', events: [event] } });
    await t.json('POST', '/api/import', { body: { project: 'acme', events: [event] } });
    assert.equal(rows("SELECT id FROM events WHERE id = 'dup-1'").length, 1);
  });

  it('needs the server or admin key, and caps the batch size', async () => {
    const body = { project: 'acme', events: [wire('x')] };
    assert.equal((await t.call('POST', '/api/import', { body, key: READ })).status, 403);
    assert.equal((await t.call('POST', '/api/import', { body, key: null })).status, 401);
    const server = await deriveServerKey(ADMIN);
    assert.equal((await t.call('POST', '/api/import', { body, key: server })).status, 200);
    const many = {
      project: 'acme',
      events: Array.from({ length: 1001 }, (_, i) => wire('x', { id: `m${i}` })),
    };
    assert.equal((await t.call('POST', '/api/import', { body: many })).status, 413);
  });

  it('limits the server key to server paths', async () => {
    const server = await deriveServerKey(ADMIN);
    const res = await t.call('POST', '/api/query', {
      key: server,
      body: { kind: 'web', project: 'acme' },
    });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /server key only/);
    assert.equal((await t.call('POST', '/mcp', { key: server, body: {} })).status, 403);
  });

  it('drops the largest properties first when an event is too big', () => {
    const props = { small: 'a', big: 'x'.repeat(9000), medium: 'y'.repeat(100) };
    const stored = JSON.parse(boundedProps(props)) as Record<string, unknown>;
    assert.equal(stored.small, 'a');
    assert.equal(stored.medium, 'y'.repeat(100));
    assert.equal(stored.big, undefined);
    assert.deepEqual(stored.$truncated_keys, ['big']);
  });
});

describe('project settings', () => {
  beforeEach(setup);

  it('saves, validates and clears settings', async () => {
    const saved = await t.json<{ settings: Record<string, unknown>; summary: string }>(
      'PATCH',
      '/api/settings',
      { body: { project: 'acme', settings: { timezone: 'Europe/London', baseCurrency: 'gbp' } } },
    );
    assert.equal(saved.settings.timezone, 'Europe/London');
    assert.equal(saved.settings.baseCurrency, 'GBP');
    assert.match(saved.summary, /Europe\/London/);
    const bad = await t.call('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { timezone: 'Mars/Base' } },
    });
    assert.equal(bad.status, 400);
    const cleared = await t.json<{ settings: Record<string, unknown> }>('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { timezone: null } },
    });
    assert.equal(cleared.settings.timezone, undefined);
    assert.equal(cleared.settings.baseCurrency, 'GBP');
    assert.equal((await t.call('PATCH', '/api/settings', { key: READ, body: {} })).status, 403);
  });

  it('leaves out internal traffic when a query asks to', async () => {
    await t.json('PATCH', '/api/settings', {
      body: {
        project: 'acme',
        settings: { internalFilters: [{ property: 'host', op: 'contains', value: 'localhost' }] },
      },
    });
    await t.ingest([
      wire('$pageview', { id: 'a', url: 'https://acme.com/' }),
      wire('$pageview', { id: 'b', url: 'http://localhost:3000/' }),
    ]);
    const all = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: { kind: 'trends', project: 'acme', series: [{ event: '$pageview' }] },
    });
    const external = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        project: 'acme',
        series: [{ event: '$pageview' }],
        filterTestAccounts: true,
      },
    });
    assert.equal(all.series[0]!.total, 2);
    assert.equal(external.series[0]!.total, 1);
  });

  it('buckets reports in the project time zone', async () => {
    await t.json('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { timezone: 'America/New_York' } },
    });
    await t.ingest([wire('$pageview')]);
    const res = await t.json<{ buckets: number[] }>('POST', '/api/query', {
      body: { kind: 'trends', project: 'acme', series: [{ event: '$pageview' }], from: '-3d' },
    });
    // New York midnight is 04:00 or 05:00 UTC, never 00:00.
    for (const b of res.buckets) assert.notEqual(new Date(b).getUTCHours(), 0);
  });
});

describe('group ingest', () => {
  beforeEach(setup);

  it('registers types, stores group properties and snapshots them on events', async () => {
    await t.ingest([
      wire('$groupidentify', {
        id: 'gi',
        props: {
          $group_type: 'company',
          $group_key: 'acme-inc',
          $group_set: { plan: 'enterprise', seats: 40 },
        },
      }),
    ]);
    await t.ingest([
      wire('report_created', { id: 'r1', props: { $groups: { company: 'acme-inc' }, size: 3 } }),
    ]);
    const [group] = rows("SELECT props FROM groups WHERE type = 'company' AND key = 'acme-inc'");
    assert.deepEqual(JSON.parse(String(group!.props)), { plan: 'enterprise', seats: 40 });
    const [event] = rows("SELECT props FROM events WHERE id = 'r1'");
    const props = JSON.parse(String(event!.props));
    assert.deepEqual(props.$groups, { company: 'acme-inc' });
    assert.deepEqual(props.$group_props, { company: { plan: 'enterprise', seats: 40 } });
    assert.equal(props.size, 3);
  });

  it('keeps at most five group types and ignores malformed groups', async () => {
    const groups = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => [t, `${t}1`]));
    await t.ingest([
      wire('x', { id: 'g6', props: { $groups: { ...groups, 'bad"type': 'k', ok: '' } } }),
    ]);
    const types = rows("SELECT type FROM group_types WHERE project = 'acme' ORDER BY idx").map(
      (r) => r.type,
    );
    assert.equal(types.length, 5);
    const [event] = rows("SELECT props FROM events WHERE id = 'g6'");
    const stored = JSON.parse(String(event!.props)).$groups as Record<string, string>;
    assert.equal(Object.keys(stored).length, 5);
    assert.equal(stored['bad"type'], undefined);
  });

  it('filters and breaks down by group key and group property', async () => {
    await t.ingest([
      wire('$groupidentify', {
        id: 'g1',
        props: { $group_type: 'company', $group_key: 'big', $group_set: { plan: 'enterprise' } },
      }),
      wire('$groupidentify', {
        id: 'g2',
        props: { $group_type: 'company', $group_key: 'small', $group_set: { plan: 'free' } },
      }),
    ]);
    await t.ingest([
      wire('report_created', { id: 'e1', props: { $groups: { company: 'big' } } }),
      wire('report_created', { id: 'e2', props: { $groups: { company: 'big' } } }),
      wire('report_created', { id: 'e3', props: { $groups: { company: 'small' } } }),
    ]);
    const res = await t.json<{ series: { breakdown: string; total: number }[] }>(
      'POST',
      '/api/query',
      {
        body: {
          kind: 'trends',
          project: 'acme',
          series: [{ event: 'report_created' }],
          breakdown: 'group.company.plan',
        },
      },
    );
    const byPlan = Object.fromEntries(res.series.map((s) => [s.breakdown, s.total]));
    assert.deepEqual(byPlan, { enterprise: 2, free: 1 });
    const filtered = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        project: 'acme',
        series: [{ event: 'report_created' }],
        filters: [{ property: 'group.company', value: 'small' }],
      },
    });
    assert.equal(filtered.series[0]!.total, 1);
  });
});

describe('maintenance ticks', () => {
  it('runs housekeeping once an hour on the five-minute schedule', () => {
    const at = (m: number) => Date.UTC(2026, 10, 17, 10, m);
    assert.equal(isHourlyTick(CRON_SCHEDULE, at(15)), true);
    assert.equal(isHourlyTick(CRON_SCHEDULE, at(20)), false);
    assert.equal(isHourlyTick(CRON_SCHEDULE, at(0)), false);
    // Deployments still on the hourly trigger do it every time.
    assert.equal(isHourlyTick('17 * * * *', at(17)), true);
  });

  it('runs frequent tasks every tick and survives a failing one', async () => {
    const app = testApp();
    const calls: string[] = [];
    FREQUENT_TASKS.push(
      {
        name: 'test-ok',
        run: async () => {
          calls.push('ok');
          return 3;
        },
      },
      {
        name: 'test-broken',
        run: async () => {
          throw new Error('boom');
        },
      },
    );
    try {
      const result = await runMaintenance(app.env, new D1Store(app.db), Date.now(), {
        hourly: false,
      });
      assert.equal(result.hourly, false);
      assert.equal(result.tasks['test-ok'], 3);
      assert.match(String(result.tasks['test-broken']), /boom/);
      assert.deepEqual(calls, ['ok']);
    } finally {
      FREQUENT_TASKS.splice(
        FREQUENT_TASKS.findIndex((t) => t.name === 'test-ok'),
        2,
      );
    }
  });
});
