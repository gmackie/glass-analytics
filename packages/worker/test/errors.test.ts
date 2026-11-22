/**
 * Error tracking end to end: exceptions become issues at ingest, issues resolve,
 * regress, suppress and merge, alerts go out through a destination, and stacks
 * are mapped back to source with an uploaded source map.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { transformSync } from 'esbuild';
import { runMaintenance } from '../src/cron.ts';
import { clearDestinationCache, configureDeliveries } from '../src/destinations.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { clearIssueRateLimits } from '../src/issues.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;
let posted: { url: string; body: string }[] = [];

async function setup() {
  clearGroupTypeCache();
  clearDestinationCache();
  clearIssueRateLimits();
  posted = [];
  configureDeliveries({
    fetch: async (input, init) => {
      posted.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('ok');
    },
  });
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

const stackAt = (bundle: string, column: number, fn = 'total') =>
  `TypeError: boom\n    at ${fn} (https://acme.com/assets/${bundle}:1:${column})\n    at https://acme.com/assets/${bundle}:1:99`;

function exception(
  message: string,
  extra: Record<string, unknown> = {},
  props: Record<string, unknown> = {},
) {
  return wire('$exception', {
    props: { type: 'TypeError', message, stack: stackAt('app-BxT8QXh2.js', 2345), ...props },
    ...extra,
  });
}

type Issue = {
  id: string;
  status: string;
  type: string;
  message: string;
  events: number;
  users: number;
  series: number[];
  regressedAt: string | null;
};
const list = (q = '') =>
  t.json<{ issues: Issue[]; summary: string }>('GET', `/api/issues?project=acme${q}`, {
    key: READ,
  });
const tick = () => runMaintenance(t.env, new D1Store(t.db), Date.now(), { hourly: false });

describe('issues', () => {
  beforeEach(setup);

  it('groups exceptions into issues and tags each event with its issue', async () => {
    await t.ingest([
      exception('Cart 12 not found', { distinct_id: 'a' }),
      exception('Cart 98 not found', { distinct_id: 'b' }),
      exception('Cart 98 not found', { distinct_id: 'b', session_id: 'session-2' }),
      exception(
        'Payment declined',
        { distinct_id: 'c' },
        { type: 'PaymentError', stack: stackAt('checkout-Zq81LmP0.js', 10, 'pay') },
      ),
      wire('$pageview'),
    ]);
    const { issues, summary } = await list();
    assert.equal(issues.length, 2);
    const cart = issues[0]!;
    assert.deepEqual(
      [cart.type, cart.events, cart.users, cart.status],
      ['TypeError', 3, 2, 'active'],
    );
    assert.equal(
      cart.series.reduce((a, b) => a + b, 0),
      3,
    );
    assert.match(summary, /2 issues with 4 exceptions/);
    const { results } = await t.db
      .prepare(
        "SELECT json_extract(props, '$.\"$issue_id\"') AS issue FROM events WHERE event = '$exception'",
      )
      .all<{ issue: string }>();
    assert.ok(results.every((r) => r.issue && issues.some((i) => i.id === r.issue)));
    // An uncaught error from a new build (another bundle hash) is the same issue.
    await t.ingest([exception('Cart 5 not found', {}, { stack: stackAt('app-NEWHASH1.js', 777) })]);
    assert.equal((await list()).issues.find((i) => i.id === cart.id)?.events, 4);
  });

  it('shows an issue with breakdowns, people and replays at the moment', async () => {
    await t.ingest([
      exception(
        'Cart 1 not found',
        { distinct_id: 'a', session_id: 's1', url: 'https://acme.com/cart' },
        { $release: 'v2' },
      ),
      exception(
        'Cart 2 not found',
        { distinct_id: 'b', session_id: 's2', url: 'https://acme.com/cart' },
        { $release: 'v2' },
      ),
    ]);
    const [issue] = (await list()).issues;
    await t.db
      .prepare(
        "INSERT INTO replays (project, session_id, distinct_id, started_at, ended_at) VALUES ('acme', 's1', 'a', ?, ?)",
      )
      .bind(Date.now() - 60_000, Date.now())
      .run();
    const got = await t.json<{
      issue: { id: string };
      range: { events: number; users: number };
      breakdowns: Record<string, { value: string; events: number }[]>;
      people: { person: string }[];
      occurrences: { session: string; replay: string | null }[];
      stack: { frames: { function: string; inApp: boolean }[] };
      summary: string;
    }>('GET', `/api/issues/${issue!.id}?project=acme`, { key: READ });
    assert.deepEqual([got.range.events, got.range.users], [2, 2]);
    assert.deepEqual(got.breakdowns.release, [{ value: 'v2', events: 2, users: 2 }]);
    assert.deepEqual(got.breakdowns.path?.[0], { value: '/cart', events: 2, users: 2 });
    assert.deepEqual(got.breakdowns.handled?.[0]?.value, 'false');
    assert.equal(got.people.length, 2);
    const s1 = got.occurrences.find((o) => o.session === 's1');
    assert.match(s1!.replay!, /replays\/s1\?project=acme&t=\d+/);
    assert.equal(got.occurrences.find((o) => o.session === 's2')?.replay, null);
    assert.deepEqual(
      got.stack.frames.map((f) => [f.function, f.inApp]),
      [
        ['total', true],
        ['', true],
      ],
    );
    // The issue is named after its first exception; the sample is the latest.
    assert.match(got.summary, /TypeError: Cart 1 not found/);
  });

  it('resolves, regresses and alerts through a destination', async () => {
    const { destination } = await t.json<{ destination: { id: string } }>(
      'POST',
      '/api/destinations',
      {
        body: {
          project: 'acme',
          template: 'slack',
          events: ['$issue_alert'],
          inputs: { url: 'https://hooks.slack.com/x' },
        },
      },
    );
    await t.json('PATCH', '/api/settings', {
      body: {
        project: 'acme',
        settings: {
          errorAlerts: { destination: destination.id, spike: { count: 5, minutes: 10 } },
        },
      },
    });
    await t.ingest([exception('Cart 1 not found')]);
    await tick();
    assert.equal(posted.length, 1);
    assert.match(
      JSON.parse(posted[0]!.body).text,
      /^New issue in acme: TypeError: Cart 1 not found \(on \/\) https:\/\/glass\.test\/app#\/errors\/[0-9a-f]{16}\?project=acme$/,
    );
    const [issue] = (await list()).issues;
    const resolved = await t.json<{ issue: { status: string } }>(
      'PATCH',
      `/api/issues/${issue!.id}`,
      {
        body: { project: 'acme', status: 'resolved', assignee: 'ann' },
      },
    );
    assert.equal(resolved.issue.status, 'resolved');
    assert.equal((await list()).issues.length, 0);
    await new Promise((r) => setTimeout(r, 5));
    // An exception from before the resolve (a late batch) is not a regression; one after is.
    await t.ingest([exception('Cart 6 not found', { ts: Date.now() - 60_000 })]);
    assert.equal((await list()).issues.length, 0);
    await t.ingest([exception('Cart 7 not found', { ts: Date.now() })]);
    const again = (await list()).issues[0]!;
    assert.equal(again.status, 'active');
    assert.ok(again.regressedAt);
    await tick();
    assert.match(JSON.parse(posted[1]!.body).text, /^Regression in acme/);
    // Five in ten minutes (counting the three so far): a spike, alerted once per window.
    await t.ingest([exception('Cart 8 not found'), exception('Cart 9 not found')]);
    await t.ingest([exception('Cart 10 not found')]);
    await tick();
    const texts = posted.map((p) => JSON.parse(p.body).text as string);
    assert.equal(texts.filter((x) => x.startsWith('Spike')).length, 1);
    assert.match(texts.find((x) => x.startsWith('Spike'))!, /happened 5 times in 10 minutes/);
  });

  it('drops exceptions of suppressed issues, and over the per-minute limit', async () => {
    await t.json('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { errorRateLimitPerMinute: 3 } },
    });
    await t.ingest([1, 2, 3, 4, 5].map((n) => exception(`Cart ${n} not found`)));
    const [issue] = (await list()).issues;
    assert.equal(issue!.events, 3);
    await t.json('PATCH', `/api/issues/${issue!.id}`, {
      body: { project: 'acme', status: 'suppressed' },
    });
    clearIssueRateLimits();
    await t.ingest([exception('Cart 6 not found')]);
    const got = await t.json<{ issue: { occurrences: number; dropped: number; status: string } }>(
      'GET',
      `/api/issues/${issue!.id}?project=acme`,
    );
    assert.deepEqual(
      [got.issue.occurrences, got.issue.dropped, got.issue.status],
      [3, 3, 'suppressed'],
    );
    const stored = await t.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE event = '$exception'")
      .first<{ n: number }>();
    assert.equal(stored?.n, 3);
  });

  it('merges issues, and new exceptions join the one kept', async () => {
    await t.ingest([
      exception('Cart 1 not found'),
      exception('Checkout failed', {}, { stack: stackAt('checkout.js', 5, 'submit') }),
    ]);
    const [a, b] = (await list()).issues;
    const merged = await t.json<{ issue: { id: string; occurrences: number } }>(
      'POST',
      `/api/issues/${a!.id}/merge`,
      {
        body: { project: 'acme', ids: [b!.id] },
      },
    );
    assert.equal(merged.issue.occurrences, 2);
    await t.ingest([
      exception('Checkout failed', {}, { stack: stackAt('checkout.js', 5, 'submit') }),
    ]);
    const after = (await list()).issues;
    assert.deepEqual(
      after.map((i) => [i.id, i.events]),
      [[a!.id, 3]],
    );
    // The merged id still opens the issue it was merged into.
    const viaOld = await t.json<{ issue: { id: string }; merged: string[] }>(
      'GET',
      `/api/issues/${b!.id}?project=acme`,
    );
    assert.deepEqual([viaOld.issue.id, viaOld.merged], [a!.id, [b!.id]]);
  });

  it('lists top issues in site health', async () => {
    await t.ingest([
      exception('Cart 1 not found'),
      exception('Cart 2 not found'),
      wire('$pageview'),
    ]);
    const health = await t.json<{
      topIssues: { type: string; errors: number; link: string }[];
      summary: string;
    }>('POST', '/api/reports/health', { body: { project: 'acme' } });
    assert.deepEqual([health.topIssues[0]?.type, health.topIssues[0]?.errors], ['TypeError', 2]);
    assert.match(health.summary, /Top issue: TypeError/);
  });
});

describe('source maps', () => {
  beforeEach(setup);

  const SOURCE = [
    'export function total(cart) {',
    '  return cart.items.reduce((sum, item) => sum + item.price, 0);',
    '}',
    "export function checkout(cart) { if (!cart) throw new TypeError('no cart'); return total(cart); }",
  ].join('\n');

  it('maps stack frames to the original source', async () => {
    const built = transformSync(SOURCE, {
      minify: true,
      sourcemap: 'external',
      sourcefile: 'src/cart.js',
      sourcesContent: true,
    });
    const column = built.code.indexOf('throw') + 1;
    // Uploading needs the server or admin key.
    const denied = await t.call(
      'PUT',
      '/api/sourcemaps?project=acme&release=v3&path=/assets/app-v3.js',
      { key: READ, body: built.map },
    );
    assert.equal(denied.status, 403);
    const bad = await t.call(
      'PUT',
      '/api/sourcemaps?project=acme&release=v3&path=/assets/app-v3.js',
      { body: '{"version":3}' },
    );
    assert.equal(bad.status, 400);
    const up = await t.call(
      'PUT',
      '/api/sourcemaps?project=acme&release=v3&path=https://acme.com/assets/app-v3.js',
      {
        body: built.map,
      },
    );
    assert.equal(up.status, 201);
    assert.equal(((await up.json()) as { path: string }).path, '/assets/app-v3.js');
    await t.ingest([
      exception(
        'no cart',
        {},
        {
          stack: `TypeError: no cart\n    at checkout (https://acme.com/assets/app-v3.js:1:${column})`,
          $release: 'v3',
        },
      ),
    ]);
    const [issue] = (await list()).issues;
    const got = await t.json<{
      stack: {
        mapped: number;
        frames: {
          original?: { source: string; line: number; column: number; context?: { line: string } };
        }[];
      };
      summary: string;
    }>('GET', `/api/issues/${issue!.id}?project=acme`, { key: READ });
    assert.equal(got.stack.mapped, 1);
    const original = got.stack.frames[0]!.original!;
    assert.deepEqual([original.source, original.line], ['src/cart.js', 4]);
    assert.equal(original.column, SOURCE.split('\n')[3]!.indexOf('throw') + 1);
    assert.match(original.context!.line, /throw new TypeError/);
    assert.match(got.summary, /src\/cart\.js:4/);
    // A map for another release isn't used for this exception.
    const list2 = await t.json<{ sourcemaps: { release: string; path: string }[] }>(
      'GET',
      '/api/sourcemaps?project=acme',
      { key: READ },
    );
    assert.deepEqual(
      list2.sourcemaps.map((m) => [m.release, m.path]),
      [['v3', '/assets/app-v3.js']],
    );
    const deleted = await t.json<{ deleted: number }>(
      'DELETE',
      '/api/sourcemaps?project=acme&release=v3',
    );
    assert.equal(deleted.deleted, 1);
    assert.equal(t.r2.objects.size, 0);
  });
});
