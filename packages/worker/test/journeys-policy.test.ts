import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READ, testApp, wire } from './harness.ts';

const catalog = {
  version: 1,
  events: [
    {
      name: 'lesson_completed',
      description: 'A synthetic milestone',
      properties: { kind: { type: 'string', values: ['practice', 'review'] } },
    },
  ],
};
describe('collection controls and journey surfaces', () => {
  it('saves higher policy revisions only, enforces admin scope and keeps disabled capture out of all stores', async () => {
    const t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    const body = { project: 'acme', policy: { revision: 1, profile: 'disabled' } };
    assert.equal((await t.call('PUT', '/api/capture-policy', { key: READ, body })).status, 403);
    assert.equal((await t.call('PUT', '/api/capture-policy', { body })).status, 200);
    assert.equal((await t.call('PUT', '/api/capture-policy', { body })).status, 200);
    assert.equal(
      (
        await t.call('PUT', '/api/capture-policy', {
          body: { project: 'acme', policy: { revision: 1, profile: 'standard' } },
        })
      ).status,
      409,
    );
    await t.ingest([wire('$identify', { user_id: 'student' }), wire('lesson_completed')]);
    assert.equal(t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, 0);
    assert.equal(t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM identities').get()?.n, 0);
    assert.equal(
      (await t.call('POST', '/r?project=acme&session=s&seq=0', { key: null })).status,
      403,
    );
    assert.equal(
      (await t.call('POST', '/f', { key: null, body: { project: 'acme', distinct_id: 'x' } }))
        .status,
      403,
    );
    assert.equal(
      (await t.call('GET', '/api/capture-policy?project=acme', { key: READ })).status,
      403,
    );
  });
  it('requires bounded aggregate strings, rejects unknown fields and strips identities/URLs/geo/flags before persistence', async () => {
    const t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    const put = (policy: unknown) =>
      t.call('PUT', '/api/capture-policy', { body: { project: 'acme', policy } });
    assert.equal((await put({ revision: 1, profile: 'aggregate' })).status, 400);
    assert.equal(
      (
        await put({
          revision: 1,
          profile: 'aggregate',
          catalog: {
            version: 1,
            events: [
              {
                name: 'lesson_completed',
                description: 'Test',
                properties: { name: { type: 'string' } },
              },
            ],
          },
        })
      ).status,
      400,
    );
    assert.equal((await put({ revision: 1, profile: 'aggregate', catalog })).status, 200);
    await t.ingest(
      [
        wire('lesson_completed', {
          id: 'allowed',
          user_id: 'student',
          url: 'https://acme.com/student/alice?name=alice',
          title: 'Alice',
          referrer: 'https://school.example/alice',
          props: { kind: 'practice' },
          flags: { flag: 'on' },
        }),
        wire('lesson_completed', { props: { kind: 'alice@example.com' } }),
        wire('lesson_completed', { props: { kind: 'practice', secret: 'private' } }),
        wire('unknown'),
        wire('$identify', { user_id: 'student' }),
      ],
      { headers: { 'CF-Connecting-IP': '192.0.2.3', 'CF-IPCountry': 'US' } },
    );
    const rows = t.db.sqlite.prepare('SELECT * FROM events').all();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.user_id, null);
    assert.match(String(row.distinct_id), /^a_[a-f0-9]{64}$/);
    assert.notEqual(row.id, 'allowed');
    for (const field of [
      'url',
      'path',
      'title',
      'country',
      'region',
      'city',
      'referrer',
      'browser',
      'os',
      'device',
    ])
      assert.equal(row[field], '');
    assert.equal(row.person_props, '{}');
    assert.equal(row.flags, '{}');
    assert.equal(t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM persons').get()?.n, 0);
    assert.equal(
      (await t.call('POST', '/api/query', { body: { kind: 'journeys', project: 'acme' } })).status,
      403,
    );
    assert.equal(
      (await t.call('POST', '/f', { key: null, body: { project: 'acme', distinct_id: 'x' } }))
        .status,
      403,
    );
    t.db.sqlite.prepare('UPDATE capture_policies SET policy = ?').run('{invalid');
    assert.equal((await t.ingest([wire('lesson_completed')])).status, 503);
  });
  it('serves and saves journeys through the API and exposes the same MCP query', async () => {
    const t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    await t.ingest([
      wire('start', { ts: Date.now() - 4000 }),
      wire('finish', { ts: Date.now() - 2000 }),
    ]);
    const result = await t.json<{
      kind: string;
      sessions: number;
      dashboard: string;
      sql: string[];
    }>('POST', '/api/query', {
      body: { kind: 'journeys', project: 'acme', anchor: { event: 'start' } },
    });
    assert.equal(result.kind, 'journeys');
    assert.equal(result.sessions, 1);
    assert.ok(result.dashboard.includes('insights/journeys'));
    assert.equal(result.sql.length, 1);
    const saved = await t.json<{ key: string }>('POST', '/api/insights', {
      body: {
        project: 'acme',
        name: 'Journey test',
        kind: 'journeys',
        spec: { anchor: { event: 'start' } },
      },
    });
    assert.equal(
      (await t.json<{ kind: string }>('GET', `/api/insights/${saved.key}?project=acme`)).kind,
      'journeys',
    );
    const response = await t.call('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_journeys',
          arguments: { project: 'acme', anchor: { event: 'start' } },
        },
      },
    });
    const data = (await response.json()) as {
      result: { isError?: boolean; structuredContent: { sessions: number } };
    };
    assert.equal(data.result.isError, undefined);
    assert.equal(data.result.structuredContent.sessions, result.sessions);
  });
});
