/**
 * dataflare-node against the real Worker (on SQLite): events, identify, groups,
 * imports, exceptions, and flags evaluated locally — checked against the
 * Worker's own /f for the same users.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { deriveServerKey } from '@dataflare/core/hash';
import { clearFlagCache } from '../../worker/src/flags.ts';
import { clearGroupTypeCache } from '../../worker/src/ingest.ts';
import { ADMIN, type TestApp, testApp } from '../../worker/test/harness.ts';
import { Dataflare } from '../src/index.ts';

let t: TestApp;
let serverKey: string;
const requests: string[] = [];

/** fetch that sends requests to the test Worker. */
const workerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
  return t.app.fetch(new Request(url, init), t.env);
}) as typeof fetch;

function client(extra: Partial<ConstructorParameters<typeof Dataflare>[0]> = {}) {
  return new Dataflare({
    host: 'https://glass.test',
    project: 'acme',
    serverKey,
    fetch: workerFetch,
    flushIntervalMs: 0,
    pollIntervalMs: 0,
    ...extra,
  });
}

const rows = (sql: string) => t.db.sqlite.prepare(sql).all() as Record<string, unknown>[];

beforeEach(async () => {
  clearGroupTypeCache();
  clearFlagCache();
  requests.length = 0;
  t = testApp();
  serverKey = await deriveServerKey(ADMIN);
  await t.json('POST', '/api/projects', { body: { id: 'acme' } });
});

describe('events', () => {
  it('captures, identifies, groups and flushes', async () => {
    const df = client({ flushIntervalMs: 60_000 });
    df.identify({ distinctId: 'u1', properties: { plan: 'pro' } });
    df.groupIdentify({ groupType: 'company', groupKey: 'acme-inc', properties: { seats: 10 } });
    const id = df.capture({
      distinctId: 'u1',
      event: 'invoice_paid',
      properties: { amount: 49 },
      groups: { company: 'acme-inc' },
    });
    assert.equal(rows('SELECT id FROM events').length, 0);
    await df.shutdown();
    const [paid] = rows(`SELECT id, props, person_props FROM events WHERE event = 'invoice_paid'`);
    assert.equal(paid!.id, id);
    const props = JSON.parse(String(paid!.props));
    assert.equal(props.amount, 49);
    assert.deepEqual(props.$group_props, { company: { seats: 10 } });
    assert.deepEqual(JSON.parse(String(paid!.person_props)), { plan: 'pro' });
  });

  it('sends old events and trusted context as an import', async () => {
    const df = client();
    const old = Date.now() - 200 * 86_400_000;
    df.capture({ distinctId: 'u1', event: 'legacy', timestamp: old, context: { country: 'DE' } });
    await df.flush();
    const [row] = rows(`SELECT ts_ms, country FROM events WHERE event = 'legacy'`);
    assert.equal(Number(row!.ts_ms), old);
    assert.equal(row!.country, 'DE');
    assert.ok(requests.includes('POST /api/import'));
    const result = await df.import([{ distinctId: 'u2', event: 'legacy', timestamp: old }]);
    assert.equal(result.accepted, 1);
  });

  it('captures exceptions, with the release, into an issue', async () => {
    const df = client({ release: 'api@1.2.3' });
    df.captureException(new TypeError('boom'), { distinctId: 'u1', properties: { route: '/pay' } });
    await df.flush();
    const [row] = rows(`SELECT props FROM events WHERE event = '$exception'`);
    const props = JSON.parse(String(row!.props));
    assert.equal(props.type, 'TypeError');
    assert.equal(props.message, 'boom');
    assert.equal(props.route, '/pay');
    assert.equal(props.$release, 'api@1.2.3');
    assert.equal(props.handled, true);
    assert.match(props.stack, /node\.test\.ts/);
    // Error tracking grouped it: server frames (paths, not URLs) count as in-app.
    assert.match(props.$issue_id, /^[0-9a-f]{16}$/);
  });

  it('keeps events queued when the Worker is down, and retries', async () => {
    let down = true;
    const errors: unknown[] = [];
    const df = client({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        down ? new Response('nope', { status: 503 }) : workerFetch(input, init)) as typeof fetch,
      onError: (e) => errors.push(e),
    });
    df.capture({ distinctId: 'u1', event: 'retry_me' });
    await df.flush();
    // capture() tried at once (flushIntervalMs 0) and flush() tried again: both failed and kept it.
    assert.ok(errors.length >= 1);
    assert.equal(rows(`SELECT id FROM events WHERE event = 'retry_me'`).length, 0);
    down = false;
    await df.flush();
    assert.equal(rows(`SELECT id FROM events WHERE event = 'retry_me'`).length, 1);
  });
});

describe('flags', () => {
  async function setupFlags() {
    await t.json('POST', '/api/cohorts', {
      body: { project: 'acme', key: 'beta', name: 'Beta', static: true, ids: ['u2', 'u5'] },
    });
    const flags = [
      { key: 'simple', rollout: 50 },
      {
        key: 'pro-only',
        rollout: 0,
        rules: [{ conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100 }],
        payloads: { on: { limit: 100 } },
      },
      {
        key: 'checkout',
        rollout: 100,
        variants: [
          { key: 'control', weight: 50 },
          { key: 'test', weight: 50 },
        ],
        payloads: { control: { color: 'blue' }, test: { color: 'green' } },
      },
      {
        key: 'beta-feature',
        rollout: 0,
        rules: [{ conditions: [{ property: 'cohort', value: 'beta' }], rollout: 100 }],
      },
      {
        key: 'needs-pro-only',
        rollout: 0,
        rules: [{ conditions: [{ property: 'flag.pro-only', value: 'on' }], rollout: 100 }],
      },
      { key: 'per-company', rollout: 50, bucketBy: 'company' },
      { key: 'per-person', rollout: 50, bucketBy: 'person' },
    ];
    for (const f of flags)
      await t.json('PUT', `/api/flags/${f.key}`, { body: { project: 'acme', ...f } });
    // Person properties for /f, set through ingest.
    for (let i = 0; i < 12; i++) {
      await t.ingest([
        {
          id: `id-${i}`,
          event: '$identify',
          ts: Date.now() - 1000,
          distinct_id: `d${i}`,
          user_id: `u${i}`,
          props: { $set: { plan: i % 3 === 0 ? 'pro' : 'free' } },
        },
      ]);
    }
  }

  it('evaluates locally exactly as the Worker does', async () => {
    await setupFlags();
    const df = client();
    for (let i = 0; i < 12; i++) {
      const plan = i % 3 === 0 ? 'pro' : 'free';
      const groups = { company: `co-${i % 4}` };
      const local = await df.getAllFlagsAndPayloads(`d${i}`, {
        userId: `u${i}`,
        personProperties: { plan },
        groups,
        onlyEvaluateLocally: true,
      });
      assert.equal(local.evaluatedLocally, true);
      const remote = await t.json<{
        flags: Record<string, string>;
        payloads?: Record<string, unknown>;
      }>('POST', '/f', {
        key: null,
        body: { project: 'acme', distinct_id: `d${i}`, user_id: `u${i}`, groups },
      });
      assert.deepEqual(local.flags, remote.flags, `user ${i}`);
      assert.deepEqual(local.payloads, remote.payloads ?? {}, `payloads for user ${i}`);
    }
    // One definitions fetch, then everything in-process.
    assert.equal(requests.filter((r) => r === 'GET /api/flags/definitions').length, 1);
  });

  it('asks the Worker when it lacks a property a rule needs', async () => {
    await setupFlags();
    const df = client();
    requests.length = 0;
    const value = await df.getFeatureFlag('pro-only', 'd0', { userId: 'u0' });
    assert.equal(value, 'on');
    assert.ok(requests.includes('POST /f'), 'fell back to /f for person.plan');
    assert.deepEqual(await df.getFeatureFlagPayload('pro-only', 'd0', { userId: 'u0' }), {
      limit: 100,
    });
  });

  it('works without a server key, through the Worker', async () => {
    await setupFlags();
    const df = client({ serverKey: undefined });
    assert.equal(await df.isFeatureEnabled('pro-only', 'd3', { userId: 'u3' }), true);
    assert.ok(!requests.includes('GET /api/flags/definitions'));
  });

  it('records one exposure per user and flag, and bootstraps the browser', async () => {
    await setupFlags();
    const df = client();
    await df.getFeatureFlag('checkout', 'd1', { userId: 'u1' });
    await df.getFeatureFlag('checkout', 'd1', { userId: 'u1' });
    await df.flush();
    const exposures = rows(`SELECT props FROM events WHERE event = '$exposure'`);
    assert.equal(exposures.length, 1);
    assert.equal(JSON.parse(String(exposures[0]!.props)).flag, 'checkout');
    const boot = await df.bootstrap('d1', { userId: 'u1', personProperties: { plan: 'free' } });
    assert.equal(boot.distinctId, 'd1');
    assert.ok(boot.flags.checkout === 'control' || boot.flags.checkout === 'test');
    assert.ok((boot.payloads.checkout as { color: string }).color);
  });

  it('revalidates definitions with ETags', async () => {
    await setupFlags();
    const df = client();
    await df.reloadFeatureFlags();
    const etag = (
      await t.call('GET', '/api/flags/definitions?project=acme', { key: serverKey })
    ).headers.get('ETag');
    const notModified = await t.call('GET', '/api/flags/definitions?project=acme', {
      key: serverKey,
      headers: { 'If-None-Match': etag! },
    });
    assert.equal(notModified.status, 304);
  });
});
