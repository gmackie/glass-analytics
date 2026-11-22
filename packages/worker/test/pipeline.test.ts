/**
 * The data pipeline end to end: destinations (queue and outbox, retries, failure
 * logs, test sends, encrypted secrets), transformations at ingest, and batch
 * exports to S3/R2, an HTTP endpoint and BigQuery.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gunzip } from '@dataflare/core/exports';
import { runMaintenance } from '../src/cron.ts';
import {
  clearDestinationCache,
  configureDeliveries,
  type DeliveryMessage,
  MAX_ATTEMPTS,
} from '../src/destinations.ts';
import type { QueueMessage } from '../src/env.ts';
import { configureExports, windowEnd } from '../src/exports.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { clearTransformationCache } from '../src/transformations.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

/** PEM armour for a key generated in the test (the label is split so secret scanners don't flag the source). */
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const pkcs8Pem = (der: Uint8Array) =>
  `-----BEGIN ${PEM_LABEL}-----\n${Buffer.from(der).toString('base64')}\n-----END ${PEM_LABEL}-----\n`;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
let sent: Sent[] = [];
/** How the fake network answers: a status per call (default 200). */
let answer: (url: string) => number = () => 200;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const raw = init?.body;
  const body = raw instanceof Uint8Array ? await gunzip(raw) : typeof raw === 'string' ? raw : '';
  sent.push({ url, method: init?.method ?? 'GET', headers, body });
  if (url.includes('oauth2.googleapis.com/token')) {
    return Response.json({ access_token: 'ya29.token', expires_in: 3600 });
  }
  const status = answer(url);
  return new Response(status === 200 ? '{}' : 'nope', { status });
};

async function setup(env: Parameters<typeof testApp>[0] = {}) {
  clearGroupTypeCache();
  clearDestinationCache();
  clearTransformationCache();
  sent = [];
  answer = () => 200;
  configureDeliveries({ fetch: fakeFetch });
  configureExports({ fetch: fakeFetch });
  t = testApp(env);
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

const tick = (at = Date.now()) => runMaintenance(t.env, new D1Store(t.db), at, { hourly: false });

async function slack(extra: Record<string, unknown> = {}) {
  const res = await t.json<{ destination: { id: string } }>('POST', '/api/destinations', {
    body: {
      project: 'acme',
      template: 'slack',
      name: 'Signups to Slack',
      events: ['signup'],
      inputs: {
        url: 'https://hooks.slack.com/services/T0/B0/secret-path',
        message: '{event} from {props.plan}',
      },
      ...extra,
    },
  });
  return res.destination.id;
}

describe('destinations', () => {
  beforeEach(() => setup());

  it('lists templates and keeps secrets encrypted and hidden', async () => {
    const templates = await t.json<{ templates: { id: string }[] }>(
      'GET',
      '/api/destinations/templates',
      { key: READ },
    );
    for (const id of ['webhook', 'slack', 'meta-capi', 'ga4', 'hubspot', 'posthog']) {
      assert.ok(
        templates.templates.some((x) => x.id === id),
        id,
      );
    }
    const id = await slack();
    const got = await t.json<{ destination: Record<string, unknown> }>(
      'GET',
      `/api/destinations/${id}?project=acme`,
      {
        key: READ,
      },
    );
    assert.ok(!JSON.stringify(got).includes('secret-path'));
    assert.deepEqual(got.destination.secretsSet, ['url']);
    const row = await t.db
      .prepare('SELECT secrets FROM destinations WHERE id = ?')
      .bind(id)
      .first<{ secrets: string }>();
    assert.ok(row?.secrets && !row.secrets.includes('secret-path'));
    // Read keys can't change destinations.
    const denied = await t.call('POST', '/api/destinations', {
      key: READ,
      body: { project: 'acme', template: 'slack' },
    });
    assert.equal(denied.status, 403);
    // A template's required inputs are checked.
    const bad = await t.call('POST', '/api/destinations', {
      body: { project: 'acme', template: 'slack', inputs: {} },
    });
    assert.equal(bad.status, 400);
  });

  it('delivers matching events through the outbox when no queue is bound', async () => {
    await slack({ filters: [{ property: 'plan', value: 'pro' }] });
    await t.ingest([
      wire('signup', { props: { plan: 'pro' } }),
      wire('signup', { props: { plan: 'free' } }),
      wire('pageview'),
    ]);
    const pending = await t.db
      .prepare('SELECT COUNT(*) AS n FROM delivery_outbox')
      .first<{ n: number }>();
    assert.equal(pending?.n, 1);
    const result = await tick();
    assert.equal(result.tasks.deliveries, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, 'https://hooks.slack.com/services/T0/B0/secret-path');
    assert.deepEqual(JSON.parse(sent[0]!.body), { text: 'signup from pro' });
    const activity = await t.json<{ activity: { totals: { delivered: number }; pending: number } }>(
      'GET',
      '/api/destinations/' +
        (await t.json<{ destinations: { id: string }[] }>('GET', '/api/destinations?project=acme'))
          .destinations[0]!.id +
        '?project=acme',
    );
    assert.equal(activity.activity.totals.delivered, 1);
    assert.equal(activity.activity.pending, 0);
  });

  it('retries with backoff, logs what keeps failing, and retries on request', async () => {
    const id = await slack();
    answer = () => 503;
    await t.ingest([wire('signup', { props: { plan: 'pro' } })]);
    let now = Date.now();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await tick(now);
      const r = await t.db
        .prepare('SELECT attempts, next_at FROM delivery_outbox')
        .first<{ attempts: number; next_at: number }>();
      assert.equal(r?.attempts, i);
      now = r!.next_at;
    }
    await tick(now);
    assert.equal(sent.length, MAX_ATTEMPTS);
    const got = await t.json<{
      activity: { failures: { error: string }[]; totals: { failed: number } };
    }>('GET', `/api/destinations/${id}?project=acme`);
    assert.equal(got.activity.totals.failed, 1);
    assert.match(got.activity.failures[0]!.error, /HTTP 503/);
    // A client error is not retried.
    answer = () => 200;
    const retried = await t.json<{ retried: number }>('POST', `/api/destinations/${id}/retry`, {
      body: { project: 'acme' },
    });
    assert.equal(retried.retried, 1);
    await tick();
    assert.equal(sent.length, MAX_ATTEMPTS + 1);
    answer = () => 404;
    await t.ingest([wire('signup')]);
    await tick();
    const after = await t.json<{ activity: { totals: { failed: number } } }>(
      'GET',
      `/api/destinations/${id}?project=acme`,
    );
    assert.equal(after.activity.totals.failed, 2);
  });

  it('sends through Cloudflare Queues when bound, and the consumer acks or retries', async () => {
    const queued: { body: unknown }[] = [];
    await setup({
      DELIVERIES: { send: async () => {}, sendBatch: async (m) => void queued.push(...m) },
    });
    await slack();
    await t.ingest([
      wire('signup', { props: { plan: 'pro' } }),
      wire('signup', { props: { plan: 'team' } }),
    ]);
    assert.equal(queued.length, 2);
    assert.equal(
      (await t.db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').first<{ n: number }>())?.n,
      0,
    );
    const outcomes: string[] = [];
    const message = (body: unknown, attempts: number): QueueMessage<DeliveryMessage> => ({
      id: String(Math.random()),
      body: body as DeliveryMessage,
      attempts,
      ack: () => outcomes.push('ack'),
      retry: (o) => outcomes.push(`retry ${o?.delaySeconds}`),
    });
    // The second delivery fails, so its message is retried with backoff.
    answer = (url) =>
      new URL(url).hostname === 'hooks.slack.com' && sent.length === 2 ? 500 : 200;
    await t.app.queue(
      {
        queue: 'glass-deliveries',
        messages: [message(queued[0]!.body, 1), message(queued[1]!.body, 2)],
      },
      t.env,
    );
    assert.deepEqual(outcomes, ['ack', 'retry 40']);
    // The usage estimate counts the queue's operations: a write, a read and a delete per delivery.
    const usage = await t.json<{ lines: { resource: string; monthly: number }[] }>(
      'GET',
      '/api/usage',
    );
    assert.equal(usage.lines.find((l) => l.resource === 'Queue operations')?.monthly, 12.86);
  });

  it('falls back to the outbox when the queue refuses a send', async () => {
    await setup({
      DELIVERIES: {
        send: async () => {},
        sendBatch: async () => {
          throw new Error('Queue quota exceeded');
        },
      },
    });
    await slack();
    const res = await t.ingest([wire('signup')]);
    assert.ok(res.ok);
    assert.equal(
      (await t.db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').first<{ n: number }>())?.n,
      1,
    );
  });

  it('sends a test event and reports the outcome', async () => {
    const id = await slack();
    const ok = await t.json<{ ok: boolean; event: { event: string } }>(
      'POST',
      `/api/destinations/${id}/test`,
      {
        body: { project: 'acme' },
      },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.event.event, 'signup');
    answer = () => 401;
    const failed = await t.json<{ ok: boolean; error: string }>(
      'POST',
      `/api/destinations/${id}/test`,
      {
        body: { project: 'acme' },
      },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /401/);
  });

  it('skips disabled and deleted destinations', async () => {
    const id = await slack();
    await t.json('PUT', `/api/destinations/${id}`, { body: { project: 'acme', enabled: false } });
    await t.ingest([wire('signup')]);
    assert.equal(
      (await t.db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').first<{ n: number }>())?.n,
      0,
    );
    await t.json('PUT', `/api/destinations/${id}`, { body: { project: 'acme', enabled: true } });
    await t.ingest([wire('signup')]);
    await t.json('DELETE', `/api/destinations/${id}?project=acme`);
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(
      (await t.db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').first<{ n: number }>())?.n,
      0,
    );
  });
});

describe('transformations', () => {
  beforeEach(() => setup());

  const props = async () => {
    const { results } = await t.db
      .prepare('SELECT event, props FROM events ORDER BY ts_ms')
      .all<{ event: string; props: string }>();
    return results.map((r) => ({ event: r.event, ...JSON.parse(r.props) }));
  };

  it('applies rules at ingest, in order, before anything is stored or forwarded', async () => {
    await slack({ events: ['*'] });
    await t.json('POST', '/api/transformations', {
      body: { project: 'acme', position: 1, rule: { kind: 'drop_event', events: ['debug'] } },
    });
    await t.json('POST', '/api/transformations', {
      body: {
        project: 'acme',
        position: 2,
        rule: { kind: 'drop_properties', properties: ['password'] },
      },
    });
    await t.json('POST', '/api/transformations', {
      body: { project: 'acme', position: 3, rule: { kind: 'redact', name: 'No emails' } },
    });
    await t.ingest([
      wire('signup', { props: { plan: 'pro', password: 'hunter2', note: 'mail ann@example.com' } }),
      wire('debug', { props: { trace: 'x' } }),
    ]);
    assert.deepEqual(await props(), [{ event: 'signup', plan: 'pro', note: 'mail [redacted]' }]);
    await tick();
    assert.equal(sent.length, 1);
    assert.ok(!sent[0]!.body.includes('hunter2'));
    const list = await t.json<{ transformations: { applied: number; position: number }[] }>(
      'GET',
      '/api/transformations?project=acme',
      {
        key: READ,
      },
    );
    assert.deepEqual(
      list.transformations.map((x) => [x.position, x.applied]),
      [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
    );
  });

  it('tries a rule on a sample without saving it', async () => {
    const r = await t.json<{ dropped: boolean; after: { props: Record<string, unknown> } }>(
      'POST',
      '/api/transformations/test',
      {
        key: READ,
        body: {
          project: 'acme',
          rule: { kind: 'hash_properties', properties: ['email'] },
          event: { event: 'signup', props: { email: 'ann@example.com' } },
        },
      },
    );
    assert.equal(r.dropped, false);
    assert.match(String(r.after.props.email), /^[0-9a-f]{64}$/);
    assert.equal(
      (await t.json<{ transformations: unknown[] }>('GET', '/api/transformations?project=acme'))
        .transformations.length,
      0,
    );
  });

  it('rejects invalid rules', async () => {
    const res = await t.call('POST', '/api/transformations', {
      body: { project: 'acme', rule: { kind: 'rename_property' } },
    });
    assert.equal(res.status, 400);
  });
});

describe('batch exports', () => {
  beforeEach(() => setup());
  afterEach(() => {
    answer = () => 200;
  });

  const later = () => Date.now() + 2 * 3_600_000;

  it('writes gzipped JSONL files to S3-compatible storage, signed with SigV4', async () => {
    await t.ingest([wire('signup', { props: { plan: 'pro' } }), wire('pageview')]);
    const created = await t.json<{ export: { id: string; secretsSet: string[] } }>(
      'POST',
      '/api/exports',
      {
        body: {
          project: 'acme',
          target: 's3',
          settings: {
            endpoint: 'https://acct.r2.cloudflarestorage.com',
            bucket: 'warehouse',
            region: 'auto',
            prefix: 'events/',
            accessKeyId: 'AKID',
            secretAccessKey: 'SECRET',
          },
          from: '-1h',
        },
      },
    );
    assert.deepEqual(created.export.secretsSet.sort(), ['accessKeyId', 'secretAccessKey']);
    const at = later();
    const result = await tick(at);
    assert.equal(result.tasks.exports, 2);
    assert.equal(sent.length, 1);
    const put = sent[0]!;
    assert.equal(put.method, 'PUT');
    assert.match(
      put.url,
      /^https:\/\/acct\.r2\.cloudflarestorage\.com\/warehouse\/events\/acme\/\d{4}\/\d\d\/\d\d\/\d\d\/\d+-\d+-0000\.jsonl\.gz$/,
    );
    assert.match(
      put.headers.authorization!,
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/,
    );
    const lines = put.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event).sort(), ['pageview', 'signup']);
    assert.equal(lines.find((l) => l.event === 'signup').props.plan, 'pro');
    // The watermark moved to the end of the window; nothing more to do until the next hour.
    const list = await t.json<{ exports: { watermark: string; running: boolean }[] }>(
      'GET',
      '/api/exports?project=acme',
    );
    assert.equal(list.exports[0]!.watermark, new Date(windowEnd('hour', at)).toISOString());
    assert.equal((await tick(at)).tasks.exports, 0);
    const runs = await t.json<{ runs: { status: string; rows: number; files: number }[] }>(
      'GET',
      `/api/exports/${created.export.id}/runs?project=acme`,
    );
    assert.deepEqual(
      runs.runs.map((r) => [r.status, r.rows, r.files]),
      [['done', 2, 1]],
    );
    // A backfill sends the same events again.
    await t.json('POST', `/api/exports/${created.export.id}/backfill`, {
      body: { project: 'acme', from: '-1d' },
    });
    assert.equal((await tick(at)).tasks.exports, 2);
  });

  it('records a failed run and tries again on the next tick', async () => {
    await t.ingest([wire('signup')]);
    const { export: e } = await t.json<{ export: { id: string } }>('POST', '/api/exports', {
      body: {
        project: 'acme',
        target: 'http',
        format: 'csv',
        settings: { url: 'https://etl.example.com/in', headers: { 'X-Token': 't' } },
        from: '-1h',
      },
    });
    answer = () => 500;
    const at = later();
    assert.equal((await tick(at)).tasks.exports, 0);
    answer = () => 200;
    assert.equal((await tick(at)).tasks.exports, 1);
    const post = sent.at(-1)!;
    assert.equal(post.headers['content-type'], 'text/csv');
    assert.equal(post.headers['x-token'], 't');
    assert.match(post.body.split('\n')[0]!, /^id,project,event/);
    const runs = await t.json<{ runs: { status: string; error?: string }[] }>(
      'GET',
      `/api/exports/${e.id}/runs?project=acme`,
    );
    assert.deepEqual(runs.runs.map((r) => r.status).sort(), ['done', 'failed']);
    assert.match(runs.runs.find((r) => r.status === 'failed')!.error!, /HTTP 500/);
  });

  it('streams rows into BigQuery with a service-account token', async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const serviceAccount = {
      client_email: 'export@acme.iam.gserviceaccount.com',
      private_key: pkcs8Pem(der),
    };
    await t.ingest([wire('signup', { props: { plan: 'pro' } })]);
    await t.json('POST', '/api/exports', {
      body: {
        project: 'acme',
        target: 'bigquery',
        settings: {
          projectId: 'acme-dw',
          dataset: 'analytics',
          table: 'events',
          serviceAccount: JSON.stringify(serviceAccount),
        },
        from: '-1h',
      },
    });
    assert.equal((await tick(later())).tasks.exports, 1);
    const urls = sent.map((s) => s.url);
    assert.ok(urls.some((u) => u.endsWith('/projects/acme-dw/datasets/analytics/tables')));
    const insert = sent.find((s) => s.url.endsWith('/tables/events/insertAll'))!;
    assert.equal(insert.headers.authorization, 'Bearer ya29.token');
    const body = JSON.parse(insert.body);
    assert.equal(body.rows.length, 1);
    assert.equal(JSON.parse(body.rows[0].json.props).plan, 'pro');
  });

  it('needs the settings its target uses', async () => {
    const res = await t.call('POST', '/api/exports', {
      body: { project: 'acme', target: 's3', settings: { bucket: 'b' } },
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /endpoint/);
  });
});
