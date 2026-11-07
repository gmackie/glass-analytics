/**
 * Lake conformance: every read API gives the same answer in lake mode as on D1.
 *
 * Two Workers get the same events. One keeps them in D1 (SQLite). The other runs in lake mode:
 * its Pipelines streams and Basin SQL calls go to DataFusion (the engine Basin SQL runs), started
 * as a subprocess (datafusion_server.py) with Basin's JSON functions added. Each query compiler's
 * Basin dialect therefore really executes, and LakeStore's request and response handling are
 * exercised too. Needs uv; CI sets DATAFLARE_REQUIRE_PYTHON=1 so a missing uv fails rather
 * than skips.
 */
import assert from 'node:assert/strict';
import { type ChildProcessByStdio, execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAKE_TABLES, type LakeSchemaChange, lakeFields } from '@dataflare/core/lake';
import { LakeStore } from '../src/stores/lake.ts';
import { type TestApp, testApp } from './harness.ts';

const DATAFUSION = 'datafusion==55.0.0';

const uv = (() => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !uv && process.env.DATAFLARE_REQUIRE_PYTHON !== '1' && 'uv is not installed';

/** JSON lines to and from datafusion_server.py, one request at a time. */
class DataFusion {
  private readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  private readonly waiting: ((line: string) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    const script = fileURLToPath(new URL('./datafusion_server.py', import.meta.url));
    this.proc = spawn(
      'uv',
      [
        'run',
        '--no-project',
        '--quiet',
        '--python',
        '3.13',
        '--with',
        DATAFUSION,
        '--with',
        'pyarrow',
        'python',
        script,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.waiting.shift()?.(line));
  }

  request<T>(message: object): Promise<T> {
    const next = this.chain.then(
      () =>
        new Promise<T>((resolve) => {
          this.waiting.push((line) => resolve(JSON.parse(line) as T));
          this.proc.stdin.write(`${JSON.stringify(message)}\n`);
        }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  close() {
    this.proc.stdin.end();
  }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A small but varied week of traffic: sources, pages, sessions, identities, errors, vitals, an experiment. */
function fixture(now: number) {
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const add = (event: string, extra: Record<string, unknown>) =>
    events.push({ id: `fx-${++n}`, event, ...extra });
  const sources = [
    'https://news.ycombinator.com/',
    'https://www.google.com/',
    '',
    'https://x.com/',
  ];
  const pages = ['/', '/pricing', '/docs', '/signup', '/blog/launch'];
  for (let u = 0; u < 24; u++) {
    const device = `dev-${u}`;
    for (let s = 0; s < 1 + (u % 3); s++) {
      const session = `${device}-s${s}`;
      let ts = now - (u % 7) * DAY - s * 5 * HOUR - 20 * 60_000;
      const visited = pages.slice(0, 1 + ((u + s) % pages.length));
      for (const [i, page] of visited.entries()) {
        ts += 30_000;
        const utm = u % 4 === 1 && i === 0 ? '?utm_source=newsletter&utm_campaign=nov' : '';
        add('$pageview', {
          ts,
          distinct_id: device,
          session_id: session,
          url: `https://acme.com${page}${utm}`,
          referrer: i === 0 ? sources[u % sources.length] : `https://acme.com${visited[i - 1]}`,
          title: page,
        });
      }
      if (u % 5 === 0)
        add('$exception', {
          ts: ts + 1000,
          distinct_id: device,
          session_id: session,
          url: 'https://acme.com/docs',
          props: { message: 'TypeError: x is undefined' },
        });
      add('$web_vitals', {
        ts: ts + 2000,
        distinct_id: device,
        session_id: session,
        url: `https://acme.com${visited.at(-1)}`,
        props: { metric: 'LCP', value: 900 + u * 70 },
      });
      if (visited.includes('/signup') && s === 0) {
        add('signup_completed', {
          ts: ts + 3000,
          distinct_id: device,
          session_id: session,
          url: 'https://acme.com/signup',
          props: { plan: u % 2 ? 'pro' : 'free', seats: 1 + (u % 4), trial: u % 3 === 0 },
        });
        if (u % 2)
          add('$identify', {
            ts: ts + 4000,
            distinct_id: device,
            session_id: session,
            url: 'https://acme.com/signup',
            user_id: `user-${u}`,
          });
      }
      if (u % 6 === 0 && s === 0)
        add('purchase', {
          ts: ts + 5000,
          distinct_id: device,
          session_id: session,
          url: 'https://acme.com/pricing',
          props: { value: 49 + u },
        });
    }
    add('$exposure', {
      ts: now - 10 * HOUR + u * 1000,
      distinct_id: device,
      session_id: `${device}-x`,
      url: 'https://acme.com/',
      props: { flag: 'checkout-v2', variant: u % 2 ? 'test' : 'control' },
    });
  }
  return events;
}

const READS: [string, string, unknown?][] = [
  ['GET', '/api/overview?from=-7d'],
  ['GET', '/api/sites?from=-7d'],
  ['POST', '/api/query', { kind: 'web', from: '-7d' }],
  [
    'POST',
    '/api/query',
    { kind: 'web', from: '-7d', filters: [{ property: 'utm_source', value: 'newsletter' }] },
  ],
  ['POST', '/api/query', { kind: 'trends', from: '-7d', series: [{ event: '$pageview' }] }],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      interval: 'hour',
      series: [{ event: '$pageview', math: 'unique_persons' }],
    },
  ],
  [
    'POST',
    '/api/query',
    { kind: 'trends', from: '-7d', series: [{ event: 'signup_completed' }], breakdown: 'plan' },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: 'signup_completed', math: 'sum', property: 'seats' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: '$pageview', math: 'unique_sessions' }],
      breakdown: 'browser',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: 'signup_completed' }],
      filters: [{ property: 'trial', value: true }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: 'signup_completed' }],
      filters: [{ property: 'seats', operator: 'gt', value: 2 }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel',
      from: '-7d',
      steps: [{ event: '$pageview' }, { event: 'signup_completed' }, { event: 'purchase' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel',
      from: '-7d',
      steps: [{ event: '$pageview' }, { event: 'signup_completed' }],
      breakdown: 'utm_source',
      window: '1d',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'retention',
      from: '-7d',
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '$pageview' },
      period: 'day',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'retention',
      from: '-7d',
      cohortEvent: { event: 'signup_completed' },
      returnEvent: { event: '$pageview' },
      period: 'day',
    },
  ],
  ['GET', '/api/events?from=-30d'],
  ['GET', '/api/events/signup_completed?from=-30d'],
  ['GET', '/api/properties/values?property=plan&event=signup_completed'],
  ['GET', '/api/persons/user-3'],
  ['POST', '/api/reports/conversions?from=-7d'],
  ['POST', '/api/reports/sources?from=-7d'],
  ['POST', '/api/reports/health?from=-7d'],
  ['GET', '/api/experiments/checkout-v2'],
];

/** Fields that legitimately differ by store: generated SQL, links, store names and freshness notes. */
const IGNORED = new Set([
  'sql',
  'dashboard',
  'store',
  'tables',
  'freshness',
  'freshnessSeconds',
  'generatedAt',
  'updated_at',
  'created_at',
  'started_at',
  'link',
  'links',
]);

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !IGNORED.has(k))
        .map(([k, v]) => [k, normalise(v)]),
    );
  return value;
}

/** A schema change for the split run: events_v2 adds a column the compilers never read. */
const V2: LakeSchemaChange[] = [
  { version: 2, table: 'events', add: [{ name: 'locale', type: 'string', required: false }] },
];

/**
 * One conformance run. With `split`, the lake has had a schema change: event batches alternate
 * between `events` (version 1) and `events_v2`, and queries read both through a UNION ALL.
 */
function conformance(name: string, split: boolean) {
  describe(name, { skip }, () => {
    let df: DataFusion;
    let d1: TestApp;
    let lake: TestApp;

    before(async () => {
      // One frozen clock, so both Workers resolve `-7d` to the same instant.
      mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 5, 15, 30) });
      df = new DataFusion();
      for (const table of ['events', 'identities'] as const)
        await df.request({ op: 'schema', table, fields: LAKE_TABLES[table].fields });
      // A version applies to the whole lake: upgrade creates events_v2 and identities_v2.
      if (split)
        for (const table of ['events', 'identities'] as const)
          await df.request({
            op: 'schema',
            table: `${table}_v2`,
            fields: lakeFields(table, 2, V2),
          });
      const sent = { events: 0, identities: 0 };
      const stream = (table: 'events' | 'identities') => ({
        send: async (rows: object[]) => {
          const v2 = split && sent[table]++ % 2 === 1;
          await df.request({
            op: 'write',
            table: v2 ? `${table}_v2` : table,
            rows: v2 && table === 'events' ? rows.map((r) => ({ ...r, locale: 'en-GB' })) : rows,
          });
        },
      });
      const basin = (async (_url: string, init: RequestInit) => {
        const reply = await df.request<{ success: boolean }>({
          op: 'query',
          sql: JSON.parse(String(init.body)).query,
        });
        return Response.json(reply, { status: reply.success ? 200 : 400 });
      }) as typeof fetch;

      d1 = testApp();
      lake = testApp(
        {
          GLASS_STORE: 'lake',
          EVENTS_STREAM: stream('events'),
          IDENTITIES_STREAM: stream('identities'),
          CF_ACCOUNT_ID: 'acct',
          LAKE_BUCKET: 'lake',
          CF_API_TOKEN: 'tok',
          ...(split ? { LAKE_VERSIONS: '1,2' } : {}),
        },
        { createStore: (e) => new LakeStore(e, basin, split ? V2 : []) },
      );
      const events = fixture(Date.now());
      for (const app of [d1, lake]) {
        await app.json('POST', '/api/projects', { body: { id: 'acme' } });
        await app.json('POST', '/api/experiments', {
          body: { key: 'checkout-v2', goal: { event: 'purchase' } },
        });
        await app.json('POST', '/api/experiments/checkout-v2/start');
        // Batches as the SDK sends them, so identities resolve in the same order in both stores.
        for (let i = 0; i < events.length; i += 25) await app.ingest(events.slice(i, i + 25));
      }
    });

    after(() => {
      mock.timers.reset();
      df?.close();
    });

    for (const [method, path, body] of READS) {
      it(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`, async () => {
        const [a, b] = await Promise.all(
          [d1, lake].map(async (app) => {
            const res = await app.call(method, path, body === undefined ? {} : { body });
            const text = await res.text();
            assert.equal(res.status, 200, `${app === d1 ? 'D1' : 'lake'}: ${text.slice(0, 600)}`);
            return JSON.parse(text) as unknown;
          }),
        );
        assert.deepEqual(normalise(b), normalise(a));
      });
    }
  });
}

conformance('lake conformance', false);
conformance('lake conformance across schema versions', true);
