import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { runMaintenance } from '../src/cron.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;
const PSEUDONYM = 'b'.repeat(64);
const IP = { 'CF-Connecting-IP': '203.0.113.7' };

const rows = (sql: string, ...args: (string | number)[]) =>
  t.db.sqlite.prepare(sql).all(...args) as Record<string, unknown>[];

async function setup(policy: Record<string, unknown> = {}) {
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'kids', name: 'Kids' } });
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
  await t.json('PUT', '/api/projects/kids/policy', {
    body: {
      audience: 'minors',
      event_properties: ['lesson_kind'],
      person_properties: ['grade_band'],
      ...policy,
    },
  });
}

/** Everything stored about the project, as one string, to search for leaked values. */
const everything = () =>
  JSON.stringify([
    rows("SELECT * FROM events WHERE project = 'kids'"),
    rows("SELECT * FROM persons WHERE project = 'kids'"),
    rows("SELECT * FROM identities WHERE project = 'kids'"),
    rows("SELECT * FROM replays WHERE project = 'kids'"),
  ]);

describe('student mode: ingest', () => {
  beforeEach(() => setup());

  it('stores no PII even when the SDK is misconfigured', async () => {
    const res = await t.ingest(
      [
        wire('$pageview', {
          distinct_id: 'persistent-device-id',
          session_id: 'persistent-session',
          user_id: 'jane.doe@school.org',
          url: 'https://lms.test/students/884421/report?name=Jane+Doe',
          referrer: 'https://mail.test/inbox?q=jane',
          title: 'Jane Doe — Report card',
        }),
        wire('lesson_completed', {
          distinct_id: 'persistent-device-id',
          props: { lesson_kind: 'video', student_name: 'Jane Doe', phone: '555-123-4567' },
        }),
        wire('$identify', {
          user_id: 'jane.doe@school.org',
          props: { $set: { email: 'jane.doe@school.org', grade_band: '3-5' } },
        }),
        wire('$click', { props: { tag: 'button', text: 'Jane Doe' } }),
      ],
      { project: 'kids', headers: { ...IP, 'CF-IPCountry': 'US' } },
    );
    assert.equal(res.status, 204);
    const stored = everything();
    for (const secret of [
      'jane',
      'Jane',
      '555-123-4567',
      '884421',
      'persistent-device-id',
      'persistent-session',
      'Report card',
      'inbox',
    ])
      assert.ok(!stored.includes(secret), `"${secret}" was stored: ${stored}`);

    const events = rows("SELECT * FROM events WHERE project = 'kids' ORDER BY ts_ms");
    // The $identify without a pseudonym is dropped; the other three are kept, sanitized.
    assert.equal(events.length, 3);
    for (const e of events) {
      assert.match(String(e.distinct_id), /^c_/);
      assert.match(String(e.session_id), /^cs_/);
      assert.equal(e.user_id, null);
      assert.equal(e.title, '');
      assert.equal(e.city, '');
      assert.equal(e.region, '');
      assert.equal(e.country, 'US');
    }
    const byName = (name: string) => events.find((e) => e.event === name)!;
    assert.equal(byName('$pageview').path, '/students/:id/report');
    assert.equal(byName('$pageview').referrer_host, 'mail.test');
    assert.deepEqual(JSON.parse(String(byName('lesson_completed').props)), {
      lesson_kind: 'video',
    });
    assert.deepEqual(JSON.parse(String(byName('$click').props)), { tag: 'button' });
    assert.equal(rows("SELECT * FROM persons WHERE project = 'kids'").length, 0);
  });

  it('links a pseudonym and keeps only allowed person properties', async () => {
    await t.ingest(
      [
        wire('$identify', {
          user_id: PSEUDONYM,
          props: { $set: { grade_band: '3-5', name: 'Jane' } },
        }),
        wire('lesson_completed', { user_id: PSEUDONYM, props: { lesson_kind: 'quiz' } }),
      ],
      { project: 'kids', headers: IP },
    );
    const [person] = rows("SELECT * FROM persons WHERE project = 'kids'");
    assert.equal(person!.person_id, PSEUDONYM);
    assert.deepEqual(JSON.parse(String(person!.props)), { grade_band: '3-5' });
    const [link] = rows("SELECT * FROM identities WHERE project = 'kids'");
    assert.match(String(link!.distinct_id), /^c_/);
    assert.equal(link!.person_id, PSEUDONYM);
  });

  it('leaves other projects alone', async () => {
    await t.ingest([wire('$pageview', { title: 'Pricing', distinct_id: 'device-1' })], {
      project: 'acme',
    });
    const [e] = rows("SELECT * FROM events WHERE project = 'acme'");
    assert.equal(e!.title, 'Pricing');
    assert.equal(e!.distinct_id, 'device-1');
  });
});

describe('student mode: replay', () => {
  const chunk = [
    { type: 4, timestamp: Date.now(), data: { href: 'https://lms.test/s/123456?n=jane' } },
    {
      type: 2,
      timestamp: Date.now(),
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'p',
              attributes: { title: 'Jane Doe' },
              childNodes: [{ type: 3, id: 3, textContent: 'Jane Doe' }],
            },
          ],
        },
      },
    },
    {
      type: 5,
      timestamp: Date.now(),
      data: { tag: 'glass:console', payload: { message: 'jane' } },
    },
  ];
  const upload = (gzip = false) =>
    t.call(
      'POST',
      `/r?project=kids&session=sdk-session&d=sdk-device&u=jane%40x.org&seq=0&page=p1&start=${Date.now()}&href=${encodeURIComponent('https://lms.test/s/123456?n=jane')}${gzip ? '&enc=gzip' : '&enc=json'}`,
      { key: null, headers: IP, body: JSON.stringify(chunk) },
    );

  it('is refused while the policy has replay off', async () => {
    await setup();
    const res = await upload();
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { hint: string }).hint, /scrubbed/);
    assert.equal(t.r2.objects.size, 0);
  });

  it('is masked on the server when the policy allows scrubbed replay', async () => {
    await setup({ replay: 'scrubbed' });
    assert.equal((await upload()).status, 204);
    const [key] = [...t.r2.objects.keys()];
    assert.match(key!, /^replays\/kids\/cs_/);
    const stored = gunzipSync(t.r2.objects.get(key!)!).toString();
    assert.ok(
      !stored.includes('Jane') && !stored.includes('jane') && !stored.includes('123456'),
      stored,
    );
    assert.ok(stored.includes('**** ***'));
    const [row] = rows("SELECT * FROM replays WHERE project = 'kids'");
    assert.equal(row!.user_id, null);
    assert.equal(row!.start_url, 'https://lms.test/s/:id');
    assert.match(String(row!.distinct_id), /^c_/);
    assert.ok(!everything().includes('jane'));
  });
});

describe('student mode: audit log', () => {
  beforeEach(() => setup());

  it('records reads of a student project, not of others', async () => {
    await t.json('GET', '/api/overview?project=kids', { key: READ });
    await t.json('GET', '/api/overview?project=acme', { key: READ });
    await t.call('GET', '/api/persons?project=kids', {
      key: READ,
      headers: { 'Cf-Access-Authenticated-User-Email': 'teacher-admin@district.test' },
    });
    const { entries } = await t.json<{
      entries: { operation: string; scope: string; actor: string; surface: string }[];
    }>('GET', '/api/projects/kids/audit');
    const reads = entries.filter((e) => e.operation.startsWith('GET'));
    assert.deepEqual(reads.map((e) => [e.operation, e.scope, e.actor, e.surface]).sort(), [
      ['GET /api/overview', 'read', 'read-key', 'api'],
      ['GET /api/persons', 'read', 'teacher-admin@district.test', 'api'],
    ]);
    // Turning student mode on was recorded too.
    assert.ok(entries.some((e) => e.operation === 'set_project_policy'));
    assert.equal(rows("SELECT * FROM audit_log WHERE project = 'acme'").length, 0);
  });

  it('records SQL against every student project, whatever project it names', async () => {
    await t.json('POST', '/api/sql', {
      key: READ,
      body: { project: 'acme', query: "SELECT count(*) AS n FROM events WHERE project = 'kids'" },
    });
    const [entry] = rows(
      "SELECT * FROM audit_log WHERE project = 'kids' AND operation = 'POST /api/sql'",
    );
    assert.match(String(entry!.detail), /project = 'kids'/);
  });

  it('records MCP tool calls with the tool name', async () => {
    const res = await t.call('POST', '/mcp', {
      key: READ,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'overview', arguments: { project: 'kids' } },
      },
    });
    assert.equal(res.status, 200);
    const [entry] = rows("SELECT * FROM audit_log WHERE project = 'kids' AND surface = 'mcp'");
    assert.equal(entry!.operation, 'tool:overview');
    assert.match(String(entry!.detail), /kids/);
  });

  it('is admin-only, as is changing the policy', async () => {
    assert.equal((await t.call('GET', '/api/projects/kids/audit', { key: READ })).status, 403);
    const put = await t.call('PUT', '/api/projects/kids/policy', {
      key: READ,
      body: { audience: 'general' },
    });
    assert.equal(put.status, 403);
    const policy = await t.json<{ policy: { audience: string } }>(
      'GET',
      '/api/projects/kids/policy',
      {
        key: READ,
      },
    );
    assert.equal(policy.policy.audience, 'minors');
  });
});

describe('student mode: policy and retention', () => {
  beforeEach(() => setup({ retention_days: 30 }));

  it('validates the policy with readable errors', async () => {
    const res = await t.call('PUT', '/api/projects/kids/policy', {
      body: { audience: 'minors', pseudonym_pattern: 'abc', surprise: true },
    });
    assert.equal(res.status, 400);
  });

  it('deletes a student project’s old events and people sooner than the deployment', async () => {
    await t.ingest(
      [
        wire('$identify', { user_id: PSEUDONYM, props: { $set: { grade_band: 'k-2' } } }),
        wire('lesson_completed'),
      ],
      { project: 'kids', headers: IP },
    );
    await t.ingest([wire('$pageview')], { project: 'acme' });
    // Forty days later, past the project's 30 days but with no deployment-wide retention.
    await runMaintenance(t.env, new D1Store(t.db), Date.now() + 40 * 86_400_000);
    assert.equal(rows("SELECT * FROM events WHERE project = 'kids'").length, 0);
    assert.equal(rows("SELECT * FROM persons WHERE project = 'kids'").length, 0);
    assert.equal(rows("SELECT * FROM identities WHERE project = 'kids'").length, 0);
    assert.equal(rows("SELECT * FROM events WHERE project = 'acme'").length, 1);
  });

  it('turns off cleanly', async () => {
    await t.json('PUT', '/api/projects/kids/policy', { body: { audience: 'general' } });
    await t.ingest([wire('$pageview', { title: 'Lesson' })], { project: 'kids' });
    const [e] = rows("SELECT * FROM events WHERE project = 'kids'");
    assert.equal(e!.title, 'Lesson');
    const offRecord = rows(
      "SELECT * FROM audit_log WHERE project = 'kids' AND operation = 'set_project_policy'",
    );
    assert.equal(offRecord.length, 2);
  });
});
