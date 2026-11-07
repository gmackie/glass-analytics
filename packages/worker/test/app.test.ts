import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GLASS_VERSION, UPGRADE_COMMAND } from '@dataflare/core/version';
import { configureLatestCheck } from '../src/latest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { ArrayStream, MemoryR2, READ, SqliteD1, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup(extra: Parameters<typeof testApp>[0] = {}) {
  t = testApp(extra);
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

const rows = (sql: string, ...args: (string | number)[]) =>
  t.db.sqlite.prepare(sql).all(...args) as Record<string, unknown>[];

describe('health and routing', () => {
  beforeEach(() => {
    configureLatestCheck({
      clearCache: true,
      fetch: async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 }),
    });
    return setup();
  });

  it('reports status and when an upgrade is available', async () => {
    const health = await t.json<{
      ok: boolean;
      store: string;
      replay: boolean;
      version: string;
      latest: string;
      upgradeAvailable: boolean;
      upgradeCommand: string;
      summary?: string;
    }>('GET', '/health', { key: null });
    assert.equal(health.ok, true);
    assert.equal(health.store, 'd1');
    assert.equal(health.replay, true);
    assert.equal(health.version, GLASS_VERSION);
    assert.equal(health.latest, '9.9.9');
    assert.equal(health.upgradeAvailable, true);
    assert.equal(health.upgradeCommand, UPGRADE_COMMAND);
    assert.match(health.summary ?? '', /9\.9\.9/);
  });

  it('stays quiet when the deployment matches the latest release', async () => {
    configureLatestCheck({
      clearCache: true,
      fetch: async () => new Response(JSON.stringify({ version: GLASS_VERSION }), { status: 200 }),
    });
    const health = await t.json<{ upgradeAvailable: boolean; latest: string }>('GET', '/health', {
      key: null,
    });
    assert.equal(health.latest, GLASS_VERSION);
    assert.equal(health.upgradeAvailable, false);
  });

  it('serves everything under the /_glass mount prefix too', async () => {
    const res = await t.call('GET', '/_glass/s.js', { key: null });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '/* sdk */');
    assert.equal((await t.ingest([wire('$pageview')])).status, 204);
    const html = await (await t.call('GET', '/_glass/app', { key: null })).text();
    assert.match(html, /<meta name="glass-base" content="\/_glass">/);
  });

  it('explains 404s and serves llms.txt with real URLs', async () => {
    const res = await t.call('GET', '/nope');
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { hint: string }).hint, /llms\.txt/);
    const llms = await (await t.call('GET', '/llms.txt', { key: null })).text();
    assert.match(llms, /https:\/\/glass\.test\/s\.js/);
    assert.match(llms, /query_funnel/);
    assert.match(llms, /Document custom events/);
    assert.match(llms, /how and when the event is fired/);
  });
});

describe('auth', () => {
  beforeEach(() => setup());

  it('requires a key for the API and MCP', async () => {
    assert.equal((await t.call('GET', '/api', { key: null })).status, 401);
    assert.equal((await t.call('GET', '/api', { key: 'wrong' })).status, 401);
    assert.equal((await t.call('POST', '/mcp', { key: null, body: {} })).status, 401);
  });

  it('lets the read key query but not change things', async () => {
    assert.equal((await t.call('GET', '/api/flags', { key: READ })).status, 200);
    const res = await t.call('PUT', '/api/flags/x', { key: READ, body: { rollout: 10 } });
    assert.equal(res.status, 403);
  });
});

describe('ingest', () => {
  beforeEach(() => setup());

  it('rejects unknown projects with a hint', async () => {
    const res = await t.ingest([wire('$pageview')], { project: 'nope' });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { hint: string }).hint, /dataflare projects add/);
  });

  it('enriches events with URL, UTM, referrer, geo and user agent', async () => {
    const res = await t.ingest(
      [
        wire('$pageview', {
          url: 'https://acme.com/pricing?utm_source=hn&utm_campaign=launch',
          referrer: 'https://news.ycombinator.com/item?id=1',
          title: 'Pricing',
        }),
      ],
      { headers: { 'CF-IPCountry': 'GB' } },
    );
    assert.equal(res.status, 204);
    const [e] = rows('SELECT * FROM events');
    assert.equal(e!.path, '/pricing');
    assert.equal(e!.utm_source, 'hn');
    assert.equal(e!.utm_campaign, 'launch');
    assert.equal(e!.referrer_host, 'news.ycombinator.com');
    assert.equal(e!.referrer, 'https://news.ycombinator.com/item');
    assert.equal(e!.country, 'GB');
    assert.equal(e!.browser, 'Chrome');
    assert.equal(e!.os, 'macOS');
    assert.equal(e!.device, 'desktop');
  });

  it('drops bots, malformed events and duplicates', async () => {
    await t.ingest([wire('$pageview')], { headers: { 'User-Agent': 'Googlebot/2.1' } });
    assert.equal(rows('SELECT * FROM events').length, 0);
    const dup = wire('signup');
    await t.ingest([dup, dup, { id: 'x', event: '', ts: 1 }, { event: 'no-id', ts: 1 }]);
    assert.equal(rows('SELECT * FROM events').length, 1);
  });

  it('corrects client clock skew using sent_at', async () => {
    const skewed = Date.now() - 3_600_000; // client clock one hour behind
    await t.call('POST', '/e', {
      key: null,
      body: { project: 'acme', sent_at: skewed, events: [{ ...wire('x'), ts: skewed - 1000 }] },
    });
    const [e] = rows('SELECT ts_ms FROM events');
    assert.ok(Math.abs(Number(e!.ts_ms) - (Date.now() - 1000)) < 5000);
  });

  it('derives daily ids in cookieless mode', async () => {
    const anon = { distinct_id: null, session_id: null };
    const headers = { 'CF-Connecting-IP': '203.0.113.9' };
    await t.ingest([wire('$pageview', anon), wire('$pageview', anon)], { headers });
    await t.ingest([wire('$pageview', anon)], { headers: { 'CF-Connecting-IP': '203.0.113.10' } });
    const ids = rows('SELECT DISTINCT distinct_id FROM events').map((r) => String(r.distinct_id));
    assert.equal(ids.length, 2);
    assert.ok(ids.every((id) => id.startsWith('c_')));
    assert.ok(
      rows('SELECT session_id FROM events').every((r) => String(r.session_id).startsWith('cs_')),
    );
  });
  it('files cookieless replays under the session their events get', async () => {
    const anon = { distinct_id: null, session_id: null, ts: Date.now() };
    const headers = { 'CF-Connecting-IP': '203.0.113.9' };
    await t.ingest([wire('$pageview', anon)], { headers });
    const ps = Date.now();
    const chunk = [{ type: 4, timestamp: ps, data: { href: 'https://acme.com/' } }];
    for (const seq of [0, 1]) {
      const res = await t.call(
        'POST',
        `/r?project=acme&session=cookieless&cl=1&ps=${ps}&seq=${seq}&page=p1&start=${ps}&enc=json`,
        { key: null, body: JSON.stringify(chunk), headers },
      );
      assert.equal(res.status, 204);
    }
    const [event] = rows('SELECT session_id, distinct_id FROM events');
    const replays = rows('SELECT session_id, distinct_id, chunks FROM replays');
    assert.equal(replays.length, 1);
    assert.equal(replays[0]!.session_id, event!.session_id);
    assert.equal(replays[0]!.distinct_id, event!.distinct_id);
    assert.equal(replays[0]!.chunks, 2);
  });
});

describe('identity and persons', () => {
  beforeEach(() => setup());

  it('links devices to users and snapshots person properties onto events', async () => {
    await t.ingest([wire('$pageview', { url: 'https://acme.com/pricing' })]);
    await t.ingest([
      wire('$identify', {
        user_id: 'alice',
        props: { $set: { plan: 'pro', email_domain: 'acme.com' } },
      }),
    ]);
    await t.ingest([wire('purchase', { user_id: 'alice', props: { amount: 49 } })]);

    const [identity] = rows('SELECT * FROM identities');
    assert.deepEqual([identity!.distinct_id, identity!.person_id], ['device-1', 'alice']);
    const purchase = rows(
      "SELECT person_id, person_props FROM events WHERE event = 'purchase'",
    )[0]!;
    assert.equal(purchase.person_id, 'alice');
    assert.equal(JSON.parse(String(purchase.person_props)).plan, 'pro');

    // The anonymous pricing view counts towards alice's funnel.
    const funnel = await t.json<{ steps: { count: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'funnel',
        steps: [
          { event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] },
          { event: 'purchase' },
        ],
      },
    });
    assert.deepEqual(
      funnel.steps.map((s) => s.count),
      [1, 1],
    );

    const person = await t.json<{
      identified: boolean;
      devices: string[];
      recentEvents: unknown[];
    }>('GET', '/api/persons/alice');
    assert.equal(person.identified, true);
    assert.deepEqual(person.devices, ['device-1']);
    assert.equal(person.recentEvents.length, 3);
  });

  it('keeps the first link when a shared device logs in as someone else', async () => {
    await t.ingest([wire('$identify', { user_id: 'alice' })]);
    await t.ingest([wire('$identify', { user_id: 'bob' })]);
    assert.equal(rows('SELECT person_id FROM identities')[0]!.person_id, 'alice');
    await t.ingest([wire('x', { user_id: 'bob' })]);
    assert.equal(rows("SELECT person_id FROM events WHERE event = 'x'")[0]!.person_id, 'bob');
  });

  it('applies $set_once without overwriting', async () => {
    await t.ingest([wire('$identify', { user_id: 'carol', props: { $set: { plan: 'free' } } })]);
    await t.ingest([
      wire('$set', { user_id: 'carol', props: { $set_once: { plan: 'pro', source: 'ad' } } }),
    ]);
    const props = JSON.parse(String(rows('SELECT props FROM persons')[0]!.props));
    assert.deepEqual(props, { plan: 'free', source: 'ad' });
  });

  it('erases a person, their events and replays', async () => {
    await t.ingest([wire('$identify', { user_id: 'dave' }), wire('x', { user_id: 'dave' })]);
    await t.call('POST', '/r?project=acme&session=session-1&seq=0&d=device-1&u=dave&enc=json', {
      key: null,
      body: '[]',
    });
    await t.call('POST', '/r?project=acme&session=session-1&seq=1&d=device-1&u=dave&enc=json', {
      key: null,
      body: '[{"type":4,"timestamp":1}]',
    });
    const res = await t.json<{ eventsDeleted: boolean; replaysDeleted: number }>(
      'DELETE',
      '/api/persons/dave',
    );
    assert.equal(res.eventsDeleted, true);
    assert.equal(res.replaysDeleted, 1);
    assert.equal(rows('SELECT * FROM events').length, 0);
    assert.equal(rows('SELECT * FROM persons').length, 0);
    assert.equal(t.r2.objects.size, 0);
  });

  it('counts identified people and anonymous devices without listing each device', async () => {
    await t.ingest([wire('$pageview', { distinct_id: 'anon-1' })]);
    await t.ingest([wire('$pageview', { distinct_id: 'anon-2' })]);
    const now = Date.now();
    t.db.sqlite
      .prepare(
        'INSERT INTO persons (project, person_id, props, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)',
      )
      .run('acme', 'erin', '{"plan":"pro"}', now, now);
    t.db.sqlite
      .prepare(
        'INSERT INTO identities (project, distinct_id, person_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('acme', 'device-known', 'erin', now);
    await t.ingest([wire('$pageview', { distinct_id: 'device-known', user_id: 'erin' })]);

    const list = await t.json<{
      persons: { id: string }[];
      stats: { identified: number; anonymousDevices: number; days: number };
    }>('GET', '/api/persons');
    assert.equal(list.stats.identified, 1);
    assert.equal(list.stats.anonymousDevices, 2);
    assert.deepEqual(
      list.persons.map((p) => p.id),
      ['erin'],
    );
  });

  it('saves cohorts and counts membership', async () => {
    const now = Date.now();
    for (const [id, plan, device] of [
      ['a', 'pro', 'd1'],
      ['b', 'free', 'd2'],
    ] as const) {
      t.db.sqlite
        .prepare(
          'INSERT INTO persons (project, person_id, props, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)',
        )
        .run('acme', id, JSON.stringify({ plan }), now, now);
      t.db.sqlite
        .prepare(
          'INSERT INTO identities (project, distinct_id, person_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run('acme', device, id, now);
      await t.ingest([wire('signup_completed', { distinct_id: device, user_id: id })]);
    }

    const saved = await t.json<{ key: string; count: number; created: boolean }>(
      'POST',
      '/api/cohorts',
      {
        body: {
          name: 'Pro plan',
          filters: [{ property: 'person.plan', value: 'pro' }],
          didEvent: 'signup_completed',
        },
      },
    );
    assert.equal(saved.created, true);
    assert.equal(saved.key, 'pro-plan');
    assert.equal(saved.count, 1);

    const listed = await t.json<{ cohorts: { key: string; count: number }[] }>(
      'GET',
      '/api/cohorts',
    );
    assert.equal(listed.cohorts.length, 1);
    assert.equal(listed.cohorts[0]!.count, 1);

    const counted = await t.json<{ count: number }>('POST', '/api/cohorts/count', {
      body: { filters: [{ property: 'person.plan', value: 'free' }], didEvent: 'signup_completed' },
    });
    assert.equal(counted.count, 1);

    await t.json('DELETE', '/api/cohorts/pro-plan');
    assert.equal((await t.json<{ cohorts: unknown[] }>('GET', '/api/cohorts')).cohorts.length, 0);
  });

  it('filters insights to a saved cohort and suggests property values', async () => {
    const now = Date.now();
    for (const [id, plan] of [
      ['a', 'pro'],
      ['b', 'free'],
      ['c', 'free'],
    ] as const) {
      t.db.sqlite
        .prepare(
          'INSERT INTO persons (project, person_id, props, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)',
        )
        .run('acme', id, JSON.stringify({ plan }), now, now);
      await t.ingest([wire('signup_completed', { distinct_id: id, user_id: id })]);
    }
    await t.json('POST', '/api/cohorts', {
      body: { name: 'Pro plan', filters: [{ property: 'person.plan', value: 'pro' }] },
    });

    const inCohort = await t.json<{ series: { total: number }[]; dashboard: string }>(
      'POST',
      '/api/query',
      {
        body: {
          kind: 'trends',
          series: [{ event: 'signup_completed' }],
          from: '-1d',
          filters: [{ property: 'cohort', value: 'pro-plan' }],
        },
      },
    );
    assert.equal(inCohort.series[0]!.total, 1);
    assert.doesNotMatch(decodeURIComponent(inCohort.dashboard), /"cohorts"/);
    const outside = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        series: [{ event: 'signup_completed' }],
        from: '-1d',
        filters: [{ property: 'cohort', op: 'neq', value: 'pro-plan' }],
      },
    });
    assert.equal(outside.series[0]!.total, 2);
    const missing = await t.call('POST', '/api/query', {
      body: {
        kind: 'trends',
        series: [{ event: 'signup_completed' }],
        filters: [{ property: 'cohort', value: 'nope' }],
      },
    });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { hint: string }).hint, /pro-plan/);
    const nested = await t.call('POST', '/api/cohorts', {
      body: { name: 'Nested', filters: [{ property: 'cohort', value: 'pro-plan' }] },
    });
    assert.equal(nested.status, 400);

    const values = await t.json<{ values: { value: string; count: number; people: number }[] }>(
      'GET',
      '/api/properties/values?property=person.plan',
    );
    assert.deepEqual(
      values.values.map((v) => [v.value, v.people]),
      [
        ['free', 2],
        ['pro', 1],
      ],
    );
    const searched = await t.json<{ values: { value: string }[] }>(
      'GET',
      '/api/properties/values?property=person.plan&query=PR',
    );
    assert.deepEqual(
      searched.values.map((v) => v.value),
      ['pro'],
    );
    const cohorts = await t.json<{ values: { value: string; label: string }[] }>(
      'GET',
      '/api/properties/values?property=cohort',
    );
    assert.deepEqual(cohorts.values, [
      { value: 'pro-plan', label: 'Pro plan', count: null, people: null },
    ]);
    const personProps = await t.json<{ properties: { name: string; examples: string[] }[] }>(
      'GET',
      '/api/person-properties',
    );
    assert.equal(personProps.properties[0]!.name, 'person.plan');
  });
});

describe('saved insights', () => {
  beforeEach(() => setup());

  it('seeds DAU/WAU/retention defaults on a new project', async () => {
    const listed = await t.json<{ insights: { key: string; name: string; kind: string }[] }>(
      'GET',
      '/api/insights',
    );
    const keys = listed.insights.map((i) => i.key).sort();
    assert.deepEqual(keys, [
      'daily-pageviews',
      'daily-retention',
      'dau',
      'mau',
      'wau',
      'weekly-retention',
    ]);
    const dau = listed.insights.find((i) => i.key === 'dau')!;
    assert.equal(dau.name, 'Daily active users');
    assert.equal(dau.kind, 'trends');

    const one = await t.json<{ key: string; description: string }>('GET', '/api/insights/dau');
    assert.equal(one.key, 'dau');
    assert.match(one.description, /Unique people/);
  });

  it('saves, updates and deletes a custom analysis', async () => {
    const saved = await t.json<{ key: string; created: boolean; name: string }>(
      'POST',
      '/api/insights',
      {
        body: {
          name: 'Signups over time',
          description: 'Daily signup count',
          kind: 'trends',
          spec: { series: [{ event: 'signup_completed', math: 'total' }], interval: 'day' },
        },
      },
    );
    assert.equal(saved.created, true);
    assert.equal(saved.key, 'signups-over-time');

    const updated = await t.json<{ created: boolean; description: string }>(
      'POST',
      '/api/insights',
      {
        body: {
          key: 'signups-over-time',
          name: 'Signups over time',
          description: 'Updated blurb',
          kind: 'trends',
          spec: {
            series: [{ event: 'signup_completed', math: 'unique_persons' }],
            interval: 'day',
          },
        },
      },
    );
    assert.equal(updated.created, false);
    assert.equal(updated.description, 'Updated blurb');

    const reserved = await t.call('POST', '/api/insights', {
      body: { name: 'Trends', key: 'trends', kind: 'trends', spec: {} },
    });
    assert.equal(reserved.status, 400);

    await t.json('DELETE', '/api/insights/signups-over-time');
    assert.equal((await t.call('GET', '/api/insights/signups-over-time')).status, 404);
  });
});

describe('query API', () => {
  beforeEach(async () => {
    await setup();
    await t.ingest([
      wire('$pageview', { distinct_id: 'a', session_id: 'sa', url: 'https://acme.com/' }),
      wire('$pageview', { distinct_id: 'a', session_id: 'sa', url: 'https://acme.com/pricing' }),
      wire('$pageview', { distinct_id: 'b', session_id: 'sb', url: 'https://acme.com/' }),
      wire('signup_completed', { distinct_id: 'a', session_id: 'sa', props: { plan: 'pro' } }),
    ]);
  });

  it('answers web, trends and retention queries with SQL and a dashboard link', async () => {
    const web = await t.json<{
      totals: { visitors: number; pageviews: number };
      sql: string[];
      dashboard: string;
    }>('POST', '/api/query', {
      body: { kind: 'web', from: '-1d' },
    });
    assert.equal(web.totals.visitors, 2);
    assert.equal(web.totals.pageviews, 3);
    assert.ok(web.sql.length >= 4);
    assert.match(web.dashboard, /^https:\/\/glass\.test\/app#\/reports/);

    const trends = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: {
        kind: 'trends',
        series: [{ event: 'signup_completed' }],
        breakdown: 'plan',
        from: '-1d',
      },
    });
    assert.equal(trends.series[0]!.total, 1);

    const retention = await t.json<{ cohorts: unknown[] }>('POST', '/api/query', {
      body: {
        kind: 'retention',
        cohortEvent: { event: 'signup_completed' },
        returnEvent: { event: '$pageview' },
        from: '-7d',
      },
    });
    assert.equal(retention.cohorts.length, 1);
  });

  it('returns readable validation errors', async () => {
    const res = await t.call('POST', '/api/query', {
      body: { kind: 'funnel', steps: [{ event: 'only-one' }] },
    });
    assert.equal(res.status, 400);
    const unknown = await t.call('POST', '/api/query', { body: { kind: 'paths' } });
    assert.match(
      ((await unknown.json()) as { hint: string }).hint,
      /web, trends, funnel, retention/,
    );
  });

  it('runs read-only SQL and refuses writes', async () => {
    const res = await t.json<{ rows: { n: number }[] }>('POST', '/api/sql', {
      body: { query: "SELECT COUNT(*) AS n FROM events WHERE event = '$pageview'" },
    });
    assert.equal(res.rows[0]!.n, 3);
    const bad = await t.call('POST', '/api/sql', { body: { query: 'DELETE FROM events' } });
    assert.equal(bad.status, 400);
  });

  it('fails loudly if a read-only query ever writes', async () => {
    const store = new D1Store(new SqliteD1());
    assert.equal((await store.query('SELECT 1 AS n'))[0]?.n, 1);
    await assert.rejects(
      store.query(
        "INSERT INTO flags (project, key, definition, created_at, updated_at) VALUES ('p', 'k', '{}', 1, 1) RETURNING key",
      ),
      /changed the database/,
    );
    // The INSERT above went through before the check threw, so there is a row to delete.
    await assert.rejects(store.query('DELETE FROM flags RETURNING *'), /changed the database/);
  });

  it('lists and describes events, and flags undocumented ones', async () => {
    const list = await t.json<{
      events: { event: string; count: number }[];
      undocumented: string[];
    }>('GET', '/api/events');
    assert.deepEqual(list.undocumented, ['signup_completed']);
    await t.json('PUT', '/api/events/signup_completed', {
      body: { description: 'Account created', properties: { plan: 'Chosen plan' } },
    });
    const described = await t.json<{
      description: string;
      properties: { name: string; description: string; examples: string[] }[];
    }>('GET', '/api/events/signup_completed');
    assert.equal(described.description, 'Account created');
    assert.deepEqual(described.properties[0], {
      name: 'plan',
      types: ['string'],
      coverage: 1,
      examples: ['pro'],
      description: 'Chosen plan',
    });
  });

  it('gives an overview with movers', async () => {
    const o = await t.json<{
      web: { totals: { visitors: number } };
      events: { event: string }[];
      summary: string;
    }>('GET', '/api/overview?from=-1d');
    assert.equal(o.web.totals.visitors, 2);
    assert.ok(o.events.some((e) => e.event === 'signup_completed'));
    assert.match(o.summary, /2 visitors/);
  });
});

describe('feature flags', () => {
  beforeEach(() => setup());

  it('evaluates flags server-side with person targeting', async () => {
    await t.json('PUT', '/api/flags/beta', {
      body: {
        rollout: 0,
        rules: [{ conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100 }],
      },
    });
    await t.ingest([wire('$identify', { user_id: 'alice', props: { $set: { plan: 'pro' } } })]);
    const evaluate = (body: object) =>
      t.json<{ flags: Record<string, string> }>('POST', '/f', {
        key: null,
        body: { project: 'acme', ...body },
      });
    assert.deepEqual((await evaluate({ distinct_id: 'device-1' })).flags, { beta: 'on' });
    assert.deepEqual((await evaluate({ distinct_id: 'someone-else' })).flags, {});
    assert.deepEqual((await evaluate({ distinct_id: null })).flags, {});
  });

  it('validates definitions', async () => {
    const res = await t.call('PUT', '/api/flags/bad', { body: { rollout: 150 } });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^Invalid request — rollout: /);
  });
});

describe('experiments', () => {
  beforeEach(() => setup());

  it('runs the full lifecycle: create, start, measure, ship', async () => {
    const created = await t.json<{ experiment: { flag: string; status: string } }>(
      'POST',
      '/api/experiments',
      {
        body: {
          key: 'checkout-v2',
          goal: { event: 'purchase' },
          hypothesis: 'A shorter form converts better',
        },
      },
    );
    assert.equal(created.experiment.status, 'draft');
    const flag = await t.json<{ flag: { enabled: boolean } }>('GET', '/api/flags/checkout-v2');
    assert.equal(flag.flag.enabled, false, 'flag stays off until the experiment starts');

    await t.json('POST', '/api/experiments/checkout-v2/start');
    const events = [];
    for (let i = 0; i < 40; i++) {
      const variant = i % 2 ? 'test' : 'control';
      events.push(
        wire('$exposure', {
          distinct_id: `u${i}`,
          ts: Date.now() - 5000,
          props: { flag: 'checkout-v2', variant },
        }),
      );
      if (variant === 'test' || i % 4 === 0)
        events.push(wire('purchase', { distinct_id: `u${i}`, ts: Date.now() - 1000 }));
    }
    await t.ingest(events);
    const res = await t.json<{
      results: {
        variants: { variant: string; exposures: number; conversions: number }[];
        srm: { mismatch: boolean };
      };
    }>('GET', '/api/experiments/checkout-v2');
    assert.deepEqual(
      res.results.variants.map((v) => [v.variant, v.exposures, v.conversions]),
      [
        ['control', 20, 10],
        ['test', 20, 20],
      ],
    );
    assert.equal(res.results.srm.mismatch, false);

    await t.json('POST', '/api/experiments/checkout-v2/ship', { body: { variant: 'test' } });
    const flags = await t.json<{ flags: Record<string, string> }>('POST', '/f', {
      key: null,
      body: { project: 'acme', distinct_id: 'anyone' },
    });
    assert.equal(flags.flags['checkout-v2'], 'test');
  });
});

describe('session replay', () => {
  beforeEach(() => setup());

  it('stores chunks, indexes sessions and summarises them as text', async () => {
    const T = Date.now() - 60_000;
    const chunk0 = [
      { type: 4, timestamp: T, data: { href: 'https://acme.com/checkout' } },
      {
        type: 2,
        timestamp: T,
        data: {
          node: {
            id: 1,
            type: 0,
            childNodes: [
              {
                id: 2,
                type: 2,
                tagName: 'button',
                childNodes: [{ id: 3, type: 3, textContent: 'Pay' }],
              },
            ],
          },
        },
      },
    ];
    const chunk1 = [1000, 1200, 1400].map((dt) => ({
      type: 3,
      timestamp: T + dt,
      data: { source: 2, type: 2, id: 2 },
    }));
    const gz = async (value: unknown) =>
      new Uint8Array(
        await new Response(
          new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      );
    const q = (seq: number, extra: string) =>
      `/r?project=acme&session=s-9&seq=${seq}&d=device-1&start=${T}&end=${T + 1400}${extra}`;
    assert.equal(
      (await t.call('POST', q(0, '&enc=gzip'), { key: null, body: await gz(chunk0) })).status,
      204,
    );
    assert.equal(
      (
        await t.call('POST', q(1, '&enc=json&clicks=3&errors=1'), {
          key: null,
          body: JSON.stringify(chunk1),
        })
      ).status,
      204,
    );
    await t.ingest([
      wire('$exception', {
        session_id: 's-9',
        ts: T + 1500,
        props: { type: 'TypeError', message: 'card is undefined' },
      }),
    ]);

    const list = await t.json<{ replays: { session: string; clicks: number; errors: number }[] }>(
      'GET',
      '/api/replays?with_errors=true',
    );
    assert.deepEqual(
      list.replays.map((r) => [r.session, r.clicks, r.errors]),
      [['s-9', 3, 1]],
    );
    const events = await t.json<{ events: unknown[] }>('GET', '/api/replays/s-9/events');
    assert.equal(events.events.length, 5);
    const summary = await t.json<{ transcript: string }>('GET', '/api/replays/s-9/summary');
    assert.match(summary.transcript, /Rage-clicked "Pay" \(button\) ×3/);
    assert.match(summary.transcript, /ERROR TypeError: card is undefined/);
  });

  it('keeps chunks from different page loads of the same session apart', async () => {
    // Every page load restarts seq at 0; the page id must stop later pages overwriting earlier ones.
    const chunk = (href: string, ts: number) =>
      JSON.stringify([{ type: 4, timestamp: ts, data: { href } }]);
    await t.call('POST', '/r?project=acme&session=multi&seq=0&page=aaa&start=1000&enc=json', {
      key: null,
      body: chunk('/one', 1000),
    });
    await t.call('POST', '/r?project=acme&session=multi&seq=0&page=bbb&start=2000&enc=json', {
      key: null,
      body: chunk('/two', 2000),
    });
    const events = await t.json<{ events: { data: { href: string } }[] }>(
      'GET',
      '/api/replays/multi/events',
    );
    assert.deepEqual(
      events.events.map((e) => e.data.href),
      ['/one', '/two'],
    );
  });

  it('labels each click against the page load it happened on', async () => {
    // Node ids restart on every page load: node 2 is a different button on each page.
    const T = Date.now() - 60_000;
    const snapshot = (ts: number, label: string) => ({
      type: 2,
      timestamp: ts,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [
            {
              id: 2,
              type: 2,
              tagName: 'button',
              childNodes: [{ id: 3, type: 3, textContent: label }],
            },
          ],
        },
      },
    });
    const click = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 2, type: 2, id: 2 } });
    const upload = (page: string, events: { timestamp: number }[]) =>
      t.call(
        'POST',
        `/r?project=acme&session=pages&seq=0&page=${page}&start=${events[0]!.timestamp}&enc=json`,
        { key: null, body: JSON.stringify(events) },
      );
    await upload('aaa', [snapshot(T, 'Choose Team'), click(T + 500)]);
    await upload('bbb', [snapshot(T + 1000, 'Create account'), click(T + 1500)]);
    const { transcript } = await t.json<{ transcript: string }>(
      'GET',
      '/api/replays/pages/summary',
    );
    assert.match(
      transcript,
      /00:00 Clicked "Choose Team" \(button\)\n00:01 Clicked "Create account" \(button\)/,
    );
  });

  describe('search, snapshots, notes and analysis', () => {
    // Three sessions: one with a rage-clicked Pay button and an error on /checkout, one that bought, one quiet.
    const T = Date.now() - 2 * 3_600_000;
    const button = (label: string) => ({
      type: 2,
      timestamp: 0,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [
            {
              id: 2,
              type: 2,
              tagName: 'body',
              childNodes: [
                {
                  id: 3,
                  type: 2,
                  tagName: 'button',
                  attributes: { id: 'pay' },
                  childNodes: [{ id: 4, type: 3, textContent: label }],
                },
              ],
            },
          ],
        },
      },
    });
    async function record(
      session: string,
      start: number,
      opts: { rage?: boolean; href: string; extra?: string },
    ) {
      const events: Record<string, unknown>[] = [
        { type: 4, timestamp: start, data: { href: opts.href, width: 1280, height: 800 } },
        { ...button('Pay now'), timestamp: start },
      ];
      if (opts.rage)
        for (const dt of [1000, 1200, 1400])
          events.push({ type: 3, timestamp: start + dt, data: { source: 2, type: 2, id: 3 } });
      events.push({ type: 3, timestamp: start + 20_000, data: { source: 1, positions: [] } });
      const q = `/r?project=acme&session=${session}&seq=0&page=p1&d=dev-${session}&start=${start}&end=${start + 20_000}&href=${encodeURIComponent(opts.href)}&enc=json${opts.extra ?? ''}`;
      assert.equal(
        (await t.call('POST', q, { key: null, body: JSON.stringify(events) })).status,
        204,
      );
    }

    beforeEach(async () => {
      await record('rage', T, {
        rage: true,
        href: 'https://acme.com/checkout',
        extra: '&clicks=3&rage=1&errors=1&failed=1',
      });
      await record('buyer', T + 60_000, { href: 'https://acme.com/checkout' });
      await record('quiet', T + 120_000, { href: 'https://acme.com/blog' });
      await t.ingest([
        wire('$pageview', {
          session_id: 'rage',
          distinct_id: 'dev-rage',
          ts: T,
          path: '/checkout',
          url: 'https://acme.com/checkout',
        }),
        wire('$exception', {
          session_id: 'rage',
          distinct_id: 'dev-rage',
          ts: T + 1500,
          props: {
            type: 'TypeError',
            message: 'card is undefined',
            stack: 'TypeError: card is undefined\n    at pay (checkout.js:12:3)',
          },
        }),
        wire('$pageview', {
          session_id: 'buyer',
          distinct_id: 'dev-buyer',
          ts: T + 60_000,
          path: '/checkout',
          url: 'https://acme.com/checkout',
        }),
        wire('purchase', { session_id: 'buyer', distinct_id: 'dev-buyer', ts: T + 70_000 }),
        wire('$pageview', {
          session_id: 'quiet',
          distinct_id: 'dev-quiet',
          ts: T + 120_000,
          path: '/blog',
          url: 'https://acme.com/blog',
        }),
      ]);
    });

    const sessions = async (query: string) =>
      (
        await t.json<{ replays: { session: string }[]; total: number }>(
          'GET',
          `/api/replays?${query}`,
        )
      ).replays.map((r) => r.session);

    it('filters by signals, visited URL, events that did or did not happen, and sorts', async () => {
      assert.deepEqual(await sessions('has=rage_clicks'), ['rage']);
      assert.deepEqual(await sessions('has=failed_requests,errors'), ['rage']);
      assert.deepEqual(await sessions('url=/checkout'), ['buyer', 'rage']);
      assert.deepEqual(await sessions('url=/checkout&not_event=purchase'), ['rage']);
      assert.deepEqual(await sessions('did_event=purchase'), ['buyer']);
      assert.deepEqual(
        await sessions(
          `filters=${encodeURIComponent(JSON.stringify([{ property: 'path', value: '/blog' }]))}`,
        ),
        ['quiet'],
      );
      assert.deepEqual(await sessions('sort=most_frustrated&limit=1'), ['rage']);
      assert.deepEqual(await sessions('sort=oldest'), ['rage', 'buyer', 'quiet']);
      const page = await t.json<{ total: number; replays: unknown[]; summary: string }>(
        'GET',
        '/api/replays?limit=2&offset=2',
      );
      assert.equal(page.total, 3);
      assert.equal(page.replays.length, 1);
    });

    it('returns a structured timeline with links to each moment', async () => {
      const s = await t.json<{
        transcript: string;
        timeline: { kind: string; selector?: string }[];
        highlights: { at: string; link: string }[];
      }>('GET', '/api/replays/rage/summary?format=json');
      assert.match(
        s.transcript,
        /Rage-clicked "Pay now" \(button\) ×3 · #pay \[dead click: nothing changed; an error followed\]/,
      );
      assert.match(s.transcript, /at pay \(checkout.js:12:3\)/);
      assert.ok(s.timeline.some((i) => i.kind === 'click' && i.selector === '#pay'));
      assert.match(s.highlights[0]!.link, /#\/replays\/rage\?project=acme&t=\d+/);
    });

    it('describes the screen at a moment', async () => {
      const shot = await t.json<{ url: string; viewport: string; screen: string }>(
        'GET',
        '/api/replays/rage/snapshot?at=00:01',
      );
      assert.equal(shot.url, 'https://acme.com/checkout');
      assert.equal(shot.viewport, '1280×800');
      assert.match(shot.screen, /\[button: Pay now\]/);
      assert.equal((await t.call('GET', '/api/replays/rage/snapshot?at=soon')).status, 400);
    });

    it('keeps notes on the timeline, writable only with the admin key', async () => {
      const added = await t.json<{ note: { id: string; at: string } }>(
        'POST',
        '/api/replays/rage/notes',
        { body: { at: '00:01', text: 'Pay throws when the card form is empty' } },
      );
      assert.equal(added.note.at, '00:01');
      assert.equal(
        (
          await t.call('POST', '/api/replays/rage/notes', {
            key: READ,
            body: { at: '00:01', text: 'x' },
          })
        ).status,
        403,
      );
      const s = await t.json<{ transcript: string; notes: { id: string }[] }>(
        'GET',
        '/api/replays/rage/summary',
      );
      assert.match(s.transcript, /00:01 Note \(agent\): Pay throws when the card form is empty/);
      await t.json('DELETE', `/api/replays/rage/notes/${s.notes[0]!.id}`);
      assert.doesNotMatch(
        (await t.json<{ transcript: string }>('GET', '/api/replays/rage/summary')).transcript,
        /Note/,
      );
    });

    it('summarises finished sessions hourly so they can be searched and analysed', async () => {
      await t.app.scheduled({}, t.env);
      assert.equal(rows('SELECT * FROM replays WHERE summary_chunks IS NULL').length, 0);
      assert.deepEqual(await sessions('search=pay now'), ['rage']);
      assert.deepEqual(await sessions('search=card is undefined'), ['rage']);
      const a = await t.json<{
        analysed: number;
        rageClicks: { what: string; examples: { link: string }[] }[];
        errors: { what: string }[];
        exitPages: { what: string }[];
      }>('GET', '/api/replays/analyse');
      assert.equal(a.analysed, 3);
      assert.equal(a.rageClicks[0]!.what, '"Pay now" (button) · #pay');
      assert.match(a.rageClicks[0]!.examples[0]!.link, /replays\/rage/);
      assert.deepEqual(
        a.errors.map((e) => e.what),
        ['TypeError: card is undefined'],
      );
      assert.deepEqual(
        a.exitPages.map((e) => e.what),
        ['https://acme.com/checkout'],
      );
    });

    it('re-summarises a session when new chunks arrive', async () => {
      await t.app.scheduled({}, t.env);
      await t.call(
        'POST',
        `/r?project=acme&session=quiet&seq=1&page=p1&start=${T + 121_000}&end=${T + 125_000}&enc=json`,
        { key: null, body: '[]' },
      );
      const row = rows("SELECT chunks, summary_chunks FROM replays WHERE session_id = 'quiet'")[0]!;
      assert.notEqual(row.chunks, row.summary_chunks);
    });

    it('erases notes and cached summaries with the session', async () => {
      await t.json('POST', '/api/replays/rage/notes', { body: { at: 1000, text: 'n' } });
      await t.app.scheduled({}, t.env);
      await t.json('DELETE', '/api/persons/dev-rage');
      assert.equal(rows("SELECT * FROM replay_notes WHERE session_id = 'rage'").length, 0);
      assert.equal((await t.call('GET', '/api/replays/rage/summary')).status, 404);
    });
  });

  it('explains when replay is disabled', async () => {
    t = testApp({ REPLAYS: undefined });
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    const res = await t.call('POST', '/r?project=acme&session=s&seq=0', { key: null, body: '[]' });
    assert.equal(res.status, 501);
    assert.match(((await res.json()) as { hint: string }).hint, /dataflare upgrade/);
  });
});

describe('key events, reports and usage', () => {
  beforeEach(() => setup());

  it('marks key events and reports their conversion rates overall and by channel', async () => {
    await t.ingest([
      wire('$pageview', {
        distinct_id: 'a',
        session_id: 'sa',
        referrer: 'https://www.google.com/',
      }),
      wire('$pageview', {
        distinct_id: 'b',
        session_id: 'sb',
        url: 'https://acme.com/?utm_source=meta&utm_medium=paid_social',
      }),
      wire('signup_completed', { distinct_id: 'a', session_id: 'sa' }),
      wire('shared_result', { distinct_id: 'b', session_id: 'sb' }),
    ]);
    const marked = await t.json<{ role: string; keyEvents: unknown[] }>(
      'PUT',
      '/api/events/signup_completed/role',
      { body: { role: 'conversion' } },
    );
    assert.equal(marked.role, 'conversion');
    await t.json('PUT', '/api/events/shared_result/role', { body: { role: 'important' } });
    assert.equal(
      (await t.call('PUT', '/api/events/x/role', { key: READ, body: { role: 'conversion' } }))
        .status,
      403,
    );

    const events = await t.json<{ events: { event: string; role: string | null }[] }>(
      'GET',
      '/api/events',
    );
    assert.equal(events.events.find((e) => e.event === 'signup_completed')?.role, 'conversion');

    const conv = await t.json<{
      visitors: number;
      goals: { event: string; rate: number }[];
      converted: { rate: number };
    }>('POST', '/api/reports/conversions', { body: {} });
    assert.equal(conv.visitors, 2);
    assert.deepEqual(
      conv.goals.map((g) => [g.event, g.rate]),
      [
        ['signup_completed', 0.5],
        ['shared_result', 0.5],
      ],
    );
    assert.equal(conv.converted.rate, 0.5);

    const channels = await t.json<{ rows: { value: string; converted: number }[] }>(
      'POST',
      '/api/reports/sources',
      { body: { dimension: 'channel' } },
    );
    assert.deepEqual(Object.fromEntries(channels.rows.map((r) => [r.value, r.converted])), {
      'Organic search': 1,
      Paid: 0,
    });
    const filtered = await t.json<{ visitors: number }>('POST', '/api/reports/conversions', {
      body: { filters: [{ property: 'utm_source', value: 'meta' }] },
    });
    assert.equal(filtered.visitors, 1);

    const overview = await t.json<{ keyEvents: { event: string }[]; summary: string }>(
      'GET',
      '/api/overview',
    );
    assert.equal(overview.keyEvents[0]?.event, 'signup_completed');
    assert.match(overview.summary, /Key events:/);

    await t.json('PUT', '/api/events/shared_result/role', { body: { role: 'none' } });
    assert.equal(
      (await t.json<{ goals: unknown[] }>('POST', '/api/reports/conversions', { body: {} })).goals
        .length,
      1,
    );
  });

  it('reports site health', async () => {
    await t.ingest([
      wire('$pageview', {
        distinct_id: 'a',
        session_id: 's1',
        url: 'https://acme.com/old',
        title: 'Page not found',
      }),
      wire('$exception', {
        distinct_id: 'a',
        session_id: 's1',
        url: 'https://acme.com/old',
        props: { message: 'boom' },
      }),
    ]);
    const h = await t.json<{
      errors: { total: number; sessionRate: number };
      notFound: { path: string }[];
    }>('POST', '/api/reports/health', { body: {} });
    assert.equal(h.errors.total, 1);
    assert.equal(h.errors.sessionRate, 1);
    assert.equal(h.notFound[0]?.path, '/old');
  });

  it('estimates usage and cost with recommendations', async () => {
    await t.ingest(
      Array.from({ length: 40 }, (_, i) =>
        wire(i % 4 ? '$click' : '$pageview', { distinct_id: `d${i % 5}` }),
      ),
    );
    const u = await t.json<{
      monthly: { events: number };
      lines: { resource: string; overageUsd: number }[];
      overageUsd: number;
      summary: string;
      projects: { project: string }[];
    }>('GET', '/api/usage');
    assert.equal(u.monthly.events, Math.round((40 * 30) / 7));
    assert.ok(u.lines.some((l) => l.resource === 'D1 rows written'));
    assert.equal(u.overageUsd, 0);
    assert.match(u.summary, /Within the Workers Paid allowances/);
    assert.deepEqual(
      u.projects.map((p) => p.project),
      ['acme'],
    );
  });
});

describe('MCP server', () => {
  beforeEach(() => setup());
  const rpc = (body: unknown, key?: string) =>
    t.call('POST', '/mcp', {
      body,
      key,
      headers: { Accept: 'application/json, text/event-stream' },
    });

  it('initializes and lists tools with JSON Schemas', async () => {
    const init = (await (
      await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })
    ).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'glass');
    assert.match(init.result.instructions, /overview/);
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const list = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { type: string; properties: Record<string, unknown> };
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    const names = list.result.tools.map((x) => x.name);
    for (const expected of [
      'overview',
      'query_funnel',
      'query_retention',
      'sql',
      'summarise_replay',
      'replay_snapshot',
      'analyse_replays',
      'annotate_replay',
      'create_experiment',
    ]) {
      assert.ok(names.includes(expected), expected);
    }
    const funnel = list.result.tools.find((x) => x.name === 'query_funnel')!;
    assert.equal(funnel.inputSchema.type, 'object');
    assert.ok('steps' in funnel.inputSchema.properties);
    assert.equal(funnel.annotations.readOnlyHint, true);
  });

  it('calls tools and reports errors as tool results', async () => {
    await t.ingest([wire('$pageview')]);
    const call = async (name: string, args: unknown, key?: string) =>
      (
        (await (
          await rpc(
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
            key,
          )
        ).json()) as {
          result: {
            content: { text: string }[];
            isError?: boolean;
            structuredContent?: { summary: string };
          };
        }
      ).result;

    const overview = await call('overview', { from: '-1d' });
    assert.equal(overview.isError, undefined);
    assert.match(overview.structuredContent!.summary, /1 visitors/);

    const denied = await call('save_flag', { key: 'x' }, READ);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /admin key/);

    const invalid = await call('query_funnel', { steps: [] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0]!.text, /Invalid arguments/);

    const unknown = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' })).json()) as {
      error: { code: number };
    };
    assert.equal(unknown.error.code, -32601);
  });
});

describe('lake store', () => {
  it('streams events to Pipelines and queries Basin SQL', async () => {
    const events = new ArrayStream();
    const identities = new ArrayStream();
    const queries: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      if (url.includes('/basin-sql/')) return new Response('not found', { status: 404 }); // exercise the fallback path
      return Response.json({ success: true, result: { schema: [{ name: 'n' }], rows: [[7]] } });
    }) as typeof fetch;
    const { LakeStore } = await import('../src/stores/lake.ts');
    const env = {
      GLASS_STORE: 'lake',
      EVENTS_STREAM: events,
      IDENTITIES_STREAM: identities,
      CF_ACCOUNT_ID: 'acct',
      LAKE_BUCKET: 'glass-data',
      CF_API_TOKEN: 'tok',
    };
    t = testApp(env, { createStore: (e) => new LakeStore(e, fakeFetch) });
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });

    await t.ingest([wire('$pageview'), wire('$identify', { user_id: 'alice' })]);
    assert.equal(events.records.length, 2);
    assert.match(String((events.records[0] as { ts: string }).ts), /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(
      identities.records.map((r) => (r as { person_id: string }).person_id),
      ['alice'],
    );
    assert.equal(
      t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()!.n,
      0,
      'events are not written to D1',
    );

    const res = await t.json<{ rows: { n: number }[] }>('POST', '/api/sql', {
      body: { query: 'SELECT COUNT(*) AS n FROM glass.events' },
    });
    assert.deepEqual(res.rows, [{ n: 7 }]);

    await t.call('POST', '/api/query', {
      body: {
        kind: 'trends',
        series: [{ event: 'signup', math: 'unique_persons' }],
        filters: [{ property: 'plan', value: 'pro' }],
      },
    });
    const trendsSql = queries.at(-1)!;
    assert.match(trendsSql, /FROM glass\.events e/);
    assert.match(trendsSql, /FROM glass\.identities/);
    assert.match(trendsSql, /json_as_text\(e\.props, 'plan'\) = 'pro'/);
    assert.doesNotMatch(trendsSql, /json_extract|strftime/);
  });

  it('queues a person erasure for the lake maintenance job', async () => {
    const { LakeStore } = await import('../src/stores/lake.ts');
    const env = {
      GLASS_STORE: 'lake',
      EVENTS_STREAM: new ArrayStream(),
      IDENTITIES_STREAM: new ArrayStream(),
      CF_ACCOUNT_ID: 'acct',
      LAKE_BUCKET: 'glass-data',
      CF_API_TOKEN: 'tok',
    };
    t = testApp(env, {
      createStore: (e) => new LakeStore(e, (async () => Response.json([])) as never),
    });
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    await t.ingest([wire('$identify', { user_id: 'erin' })]);
    const res = await t.json<{ eventsDeleted: boolean; eventsQueued: boolean; summary: string }>(
      'DELETE',
      '/api/persons/erin',
    );
    assert.equal(res.eventsDeleted, false);
    assert.equal(res.eventsQueued, true);
    assert.match(res.summary, /queued for deletion/);
    const queued = t.db.sqlite
      .prepare('SELECT project, ids, done_at FROM lake_deletions')
      .all() as { project: string; ids: string; done_at: number | null }[];
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.project, 'acme');
    assert.deepEqual(JSON.parse(queued[0]!.ids).sort(), ['device-1', 'erin']);
    assert.equal(queued[0]!.done_at, null);
  });

  it('calls fetch as a plain function, as Workers require', async () => {
    const { LakeStore } = await import('../src/stores/lake.ts');
    const realFetch = globalThis.fetch;
    // Workers' fetch throws when called with any other `this`, e.g. as a method of the store.
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json({ success: true, result: { rows: [{ n: 1 }] } }));
    } as typeof fetch;
    try {
      const store = new LakeStore({
        CF_ACCOUNT_ID: 'a',
        LAKE_BUCKET: 'b',
        CF_API_TOKEN: 't',
      } as never);
      assert.equal((await store.query('SELECT 1 AS n'))[0]?.n, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reads the Basin SQL response format', async () => {
    const { normaliseRows } = await import('../src/stores/lake.ts');
    // Recorded from production Basin SQL (5 Nov 2026); request_id shortened.
    const body = {
      result: {
        request_id: 'dqe-prod-1',
        schema: [{ name: 'n', descriptor: { type: { name: 'int64' }, nullable: false } }],
        rows: [{ n: 178 }],
        metrics: { r2_requests_count: 3, files_scanned: 5, bytes_scanned: 7954, cache_hits: 0 },
      },
      success: true,
      errors: [],
      messages: [],
    };
    assert.deepEqual(normaliseRows(body), [{ n: 178 }]);
  });

  it('normalises the result shapes analytics APIs return', async () => {
    const { normaliseRows } = await import('../src/stores/lake.ts');
    assert.deepEqual(normaliseRows([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(normaliseRows({ result: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepEqual(
      normaliseRows({ result: { rows: [[1, 'x']], schema: [{ name: 'a' }, { name: 'b' }] } }),
      [{ a: 1, b: 'x' }],
    );
    assert.deepEqual(normaliseRows({ meta: [{ name: 'a' }], data: [{ a: 2 }] }), [{ a: 2 }]);
    assert.deepEqual(normaliseRows({ columns: ['a'], rows: [[3]] }), [{ a: 3 }]);
    assert.deepEqual(normaliseRows(null), []);
  });
});

describe('maintenance', () => {
  it('deletes events and replays past their retention', async () => {
    await setup({ GLASS_RETENTION_DAYS: '30', GLASS_REPLAY_RETENTION_DAYS: '7' });
    await t.ingest([wire('recent')]);
    t.db.sqlite.exec(
      `UPDATE events SET ts_ms = ${Date.now() - 40 * 86_400_000} WHERE event = 'recent'`,
    );
    await t.ingest([wire('fresh')]);
    const old = Date.now() - 10 * 86_400_000;
    await t.call('POST', `/r?project=acme&session=old&seq=0&start=${old}&end=${old}&enc=json`, {
      key: null,
      body: '[]',
    });
    await t.call('POST', `/r?project=acme&session=old&seq=1&start=${old}&end=${old}&enc=json`, {
      key: null,
      body: '[{"type":4,"timestamp":1}]',
    });
    await t.app.scheduled({}, t.env);
    assert.deepEqual(
      rows('SELECT event FROM events').map((r) => r.event),
      ['fresh'],
    );
    assert.equal(rows('SELECT * FROM replays').length, 0);
  });
});

describe('D1 limits, idempotent replay uploads and resumable erasure', () => {
  beforeEach(() => setup());

  const now = Date.now();
  const addPerson = (id: string) =>
    t.db.sqlite
      .prepare(
        'INSERT INTO persons (project, person_id, props, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)',
      )
      .run('acme', id, '{}', 1, 1);
  /** A replay session for `user`, with `chunks` R2 objects and a note. */
  const addSession = (session: string, user: string, chunks = 1) => {
    t.db.sqlite
      .prepare(
        'INSERT INTO replays (project, session_id, distinct_id, user_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('acme', session, `device-${user}`, user, now, now);
    t.db.sqlite
      .prepare(
        'INSERT INTO replay_notes (project, session_id, id, ts_ms, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('acme', session, 'n1', now, 'note', now);
    for (let i = 0; i < chunks; i++) {
      t.r2.objects.set(
        `replays/acme/${session}/${String(i).padStart(6, '0')}.json.gz`,
        new Uint8Array([1]),
      );
    }
    t.r2.objects.set(`summaries/acme/${session}.json`, new Uint8Array([1]));
  };

  it('stamps person properties onto a batch covering more people than D1 binds at once', async () => {
    // The harness rejects statements with over 100 parameters, as D1 does.
    for (let i = 0; i < 200; i++) addPerson(`user-${i}`);
    const res = await t.ingest(
      Array.from({ length: 200 }, (_, i) => wire('x', { user_id: `user-${i}` })),
    );
    assert.ok(res.ok, await res.text());
    assert.equal(rows("SELECT * FROM events WHERE event = 'x'").length, 200);
    assert.equal(rows('SELECT * FROM persons WHERE last_seen = 1').length, 0);
  });

  it('erases a person with more device links than D1 binds at once', async () => {
    addPerson('dave');
    for (let i = 0; i < 60; i++) {
      t.db.sqlite
        .prepare(
          'INSERT INTO identities (project, distinct_id, person_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run('acme', `dev-${i}`, 'dave', now);
    }
    await t.ingest(Array.from({ length: 60 }, (_, i) => wire('x', { distinct_id: `dev-${i}` })));
    addSession('s-device', 'someone-else');
    t.db.sqlite.exec("UPDATE replays SET distinct_id = 'dev-59' WHERE session_id = 's-device'");
    const res = await t.json<{ complete: boolean; replaysDeleted: number }>(
      'DELETE',
      '/api/persons/dave',
    );
    assert.equal(res.complete, true);
    assert.equal(res.replaysDeleted, 1);
    assert.equal(rows('SELECT * FROM events').length, 0);
    assert.equal(rows('SELECT * FROM identities').length, 0);
  });

  it('finishes erasing a person with more replays than one request deletes', async () => {
    addPerson('dave');
    for (let i = 0; i < 130; i++) addSession(`s-${i}`, 'dave');
    addSession('s-long', 'dave', 1001); // more chunks than one R2 listing returns
    addSession('s-other', 'erin');
    const res = await t.json<{ complete: boolean; replaysDeleted: number; summary: string }>(
      'DELETE',
      '/api/persons/dave',
    );
    assert.equal(res.complete, false);
    assert.equal(res.replaysDeleted, 100);
    assert.match(res.summary, /hourly maintenance job/);
    // Not finished, so the person and the erasure record stay until the job is done.
    assert.equal(rows('SELECT * FROM persons').length, 1);
    assert.equal(rows('SELECT * FROM erasures').length, 1);

    await t.app.scheduled({}, t.env);
    assert.deepEqual(
      rows('SELECT session_id FROM replays').map((r) => r.session_id),
      ['s-other'],
    );
    assert.equal(rows("SELECT * FROM replay_notes WHERE session_id != 's-other'").length, 0);
    assert.deepEqual(
      [...t.r2.objects.keys()].filter((k) => !k.includes('s-other')),
      [],
    );
    assert.equal(rows('SELECT * FROM persons').length, 0);
    assert.equal(rows('SELECT * FROM erasures').length, 0);
  });

  it('resumes an erasure that failed between R2 and D1', async () => {
    addPerson('dave');
    for (let i = 0; i < 5; i++) addSession(`s-${i}`, 'dave');
    const realDelete = t.r2.delete.bind(t.r2);
    let calls = 0;
    t.r2.delete = async (keys) => {
      if (++calls === 4) throw new Error('R2 unavailable');
      return realDelete(keys);
    };
    const failed = await t.call('DELETE', '/api/persons/dave');
    assert.equal(failed.status, 500);
    // Every index row survives a failure part way through the R2 deletes, so nothing is orphaned.
    assert.equal(rows('SELECT * FROM replays').length, 5);
    t.r2.delete = realDelete;
    await t.app.scheduled({}, t.env);
    assert.equal(rows('SELECT * FROM replays').length, 0);
    assert.equal(rows('SELECT * FROM replay_notes').length, 0);
    assert.equal(t.r2.objects.size, 0);
    assert.equal(rows('SELECT * FROM persons').length, 0);
  });

  it('counts a retried replay upload once', async () => {
    const url = '/r?project=acme&session=retry&seq=0&page=p1&start=1000&end=2000&clicks=2&enc=json';
    for (let i = 0; i < 2; i++) {
      const res = await t.call('POST', url, { key: null, body: '[{"type":4,"timestamp":1000}]' });
      assert.ok(res.ok);
    }
    await t.call('POST', url.replace('seq=0', 'seq=1'), {
      key: null,
      body: '[{"type":3,"timestamp":1500}]',
    });
    const [row] = rows("SELECT chunks, pages, clicks FROM replays WHERE session_id = 'retry'");
    assert.deepEqual({ ...row }, { chunks: 2, pages: 1, clicks: 4 });
    assert.equal(t.r2.objects.size, 2);
  });

  it('reads replays left in a legacy bucket, moves them across, and erases from both', async () => {
    const legacy = new MemoryR2();
    t.env.REPLAYS_LEGACY = legacy;
    await t.call('POST', `/r?project=acme&session=old&seq=0&page=p1&start=${now}&u=dave&enc=json`, {
      key: null,
      body: `[{"type":4,"timestamp":${now}}]`,
    });
    // As before 0.8.1: the Worker wrote to what is now the legacy bucket.
    for (const [key, value] of t.r2.objects) legacy.objects.set(key, value);
    t.r2.objects.clear();
    const before = await t.json<{ events: unknown[] }>('GET', '/api/replays/old/events');
    assert.equal(before.events.length, 1);

    await t.app.scheduled({}, t.env);
    assert.equal(legacy.objects.size, 0);
    assert.equal(t.r2.objects.size, 1);
    const after = await t.json<{ events: unknown[] }>('GET', '/api/replays/old/events');
    assert.equal(after.events.length, 1);

    legacy.objects.set('replays/acme/old/000000000000999-p0-000000.json.gz', new Uint8Array([1]));
    addPerson('dave');
    await t.json('DELETE', '/api/persons/dave');
    assert.equal(legacy.objects.size, 0);
    assert.equal(t.r2.objects.size, 0);
  });
});
