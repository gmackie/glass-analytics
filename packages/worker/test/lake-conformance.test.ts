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
import { exceptionInfo, fingerprint, issueIdFor } from '@dataflare/core/issues';
import { LAKE_TABLES, type LakeSchemaChange, lakeFields } from '@dataflare/core/lake';
import { configureExports, runExports } from '../src/exports.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { LakeStore } from '../src/stores/lake.ts';
import type { EventStore } from '../src/stores/types.ts';
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
          props: u % 10 === 0 ? CART_ERROR : { message: 'TypeError: x is undefined' },
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
          props: { value: 49 + u, plan: u % 12 ? 'pro' : 'team', sub: `sub-${u}` },
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
  // Every device belongs to one of four companies (group analytics).
  for (const e of events) {
    const m = /^dev-(\d+)/.exec(String(e.distinct_id));
    if (m)
      e.props = {
        ...((e.props as object | undefined) ?? {}),
        $groups: { company: `co-${Number(m[1]) % 4}` },
      };
  }
  return events;
}

/** An exception with a stack (error tracking groups these into issues). */
const CART_ERROR = {
  type: 'TypeError',
  message: "Cannot read properties of undefined (reading 'price')",
  stack:
    "TypeError: Cannot read properties of undefined (reading 'price')\n    at total (https://acme.com/assets/app-BxT8QXh2.js:1:2345)\n    at https://acme.com/assets/app-BxT8QXh2.js:1:99",
  $release: 'v1.4.0',
};
const CART_ISSUE = issueIdFor(await fingerprint(exceptionInfo(CART_ERROR, 'acme.com')));

const READS: [string, string, unknown?][] = [
  // Group analytics: counted by company instead of person.
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      aggregateBy: 'company',
      series: [{ event: '$pageview', math: 'dau' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: '$pageview', math: 'unique_groups', groupType: 'company' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel',
      from: '-7d',
      aggregateBy: 'company',
      steps: [{ event: '$pageview' }, { event: 'signup_completed' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'retention',
      from: '-7d',
      period: 'day',
      aggregateBy: 'company',
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '$pageview' },
    },
  ],
  ['POST', '/api/query', { kind: 'revenue', from: '-30d', aggregateBy: 'company' }],
  ['GET', '/api/groups/company/co-1?from=-7d'],
  ['GET', '/api/groups?type=company'],
  ['POST', '/api/query', { kind: 'revenue', from: '-30d', interval: 'week' }],
  ['POST', '/api/query', { kind: 'revenue', from: '-14d', interval: 'day', breakdown: 'product' }],
  [
    'POST',
    '/api/query',
    { kind: 'revenue', from: '-30d', breakdown: 'channel', aggregateBy: 'session' },
  ],
  ['POST', '/api/reports/sources?from=-7d', { dimension: 'utm_source' }],
  ['GET', '/api/issues?from=-7d'],
  ['GET', `/api/issues/${CART_ISSUE}?from=-7d`],
  ['GET', '/api/issues?from=-7d&order=users&filters=[{"property":"browser","value":"Chrome"}]'],
  ['GET', '/api/overview?from=-7d'],
  ['GET', '/api/sites?from=-7d'],
  ['GET', '/api/traffic?from=-7d&limit=1&offset=1'],
  ['GET', '/api/traffic/breakdown?from=-7d'],
  ['GET', '/api/traffic/breakdown?from=-7d&project=acme'],
  ['GET', '/api/traffic?from=-7d&path=%2F'],
  ['GET', '/api/traffic?from=-7d&project=acme&path=%2F'],
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
      kind: 'trends',
      from: '-7d',
      series: [
        { event: '$pageview', math: 'dau' },
        { event: '$pageview', math: 'wau' },
        { event: '$pageview', math: 'mau' },
        { event: 'signup_completed', math: 'first_time' },
      ],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [
        { event: 'signup_completed', math: 'median', property: 'seats' },
        { event: 'signup_completed', math: 'p90', property: 'seats' },
        { event: 'signup_completed', math: 'min', property: 'seats' },
        { event: 'signup_completed', math: 'max', property: 'seats' },
        { event: '$pageview', math: 'avg_count_per_actor' },
        { event: '$pageview', math: 'median_count_per_actor' },
        { event: '$pageview', math: 'max_count_per_actor' },
      ],
      breakdown: 'device',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: ['signup_completed', 'purchase'] }, { event: '$pageview' }],
      formulas: [{ expr: 'A / B * 100' }],
      cumulative: true,
      compare: true,
      timezone: 'Europe/London',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: 'signup_completed' }],
      breakdown: 'seats',
      breakdownBins: 3,
      aggregateBy: 'session',
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
      kind: 'funnel',
      from: '-7d',
      steps: [
        { event: '$pageview' },
        { event: 'signup_completed', optional: true },
        { event: 'purchase' },
      ],
      exclusions: [{ event: '$web_vitals', fromStep: 2, toStep: 3 }],
      breakdown: 'device',
      breakdownAttribution: 'last_touch',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel',
      from: '-7d',
      steps: [{ event: '$pageview' }, { event: '$web_vitals' }],
      order: 'strict',
      viz: 'time_to_convert',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel',
      from: '-7d',
      steps: [{ event: 'signup_completed' }, { event: '$pageview' }],
      order: 'unordered',
      viz: 'trends',
      aggregateBy: 'session',
      interval: 'day',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel_correlation',
      from: '-7d',
      steps: [{ event: '$pageview' }, { event: 'signup_completed' }],
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'funnel_correlation',
      from: '-7d',
      steps: [{ event: '$pageview' }, { event: 'purchase' }],
      correlation: 'properties',
      properties: ['device', 'utm_source'],
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
  [
    'POST',
    '/api/query',
    {
      kind: 'retention',
      from: '-7d',
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '*' },
      period: 'day',
      retentionType: 'recurring',
      cumulative: true,
      breakdown: 'device',
      meanMethod: 'simple',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'retention',
      from: '-2d',
      cohortEvent: { event: '$pageview' },
      returnEvent: { event: '$pageview' },
      period: 'hour',
      periods: 6,
      aggregateBy: 'session',
      timezone: 'America/New_York',
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'trends',
      from: '-7d',
      series: [{ event: '$pageview', math: 'unique_persons' }],
      breakdown: 'cohort',
      breakdownCohorts: ['engaged', 'vips'],
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
      filters: [{ property: 'cohort', value: 'vips' }],
    },
  ],
  ['POST', '/api/query', { kind: 'paths', from: '-7d' }],
  [
    'POST',
    '/api/query',
    { kind: 'paths', from: '-7d', steps: 3, collapseRepeats: false, aggregateBy: 'session' },
  ],
  [
    'POST',
    '/api/query',
    { kind: 'paths', from: '-7d', start: { value: '/pri*' }, include: { events: true } },
  ],
  ['POST', '/api/query', { kind: 'paths', from: '-7d', end: { value: '/signup' }, steps: 4 }],
  [
    'POST',
    '/api/query',
    { kind: 'paths', from: '-7d', start: { value: '/' }, end: { value: '/docs' } },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'paths',
      from: '-7d',
      groups: ['/blog/*'],
      exclude: ['/docs'],
      perStep: 2,
      minPeople: 2,
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'paths',
      from: '-7d',
      cleaning: [
        { match: '/b*_launch', alias: '/blog' },
        { match: '/sign*', alias: '/join' },
      ],
      boundary: { minutes: 600 },
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'paths',
      from: '-7d',
      funnel: {
        spec: { steps: [{ event: '$pageview' }, { event: 'signup_completed' }] },
        step: 2,
        mode: 'before',
      },
    },
  ],
  [
    'POST',
    '/api/query',
    {
      kind: 'paths',
      from: '-7d',
      funnel: {
        spec: { steps: [{ event: '$pageview' }, { event: 'signup_completed' }] },
        step: 2,
        mode: 'dropoff',
      },
    },
  ],
  [
    'POST',
    '/api/actors',
    { kind: 'paths', spec: { from: '-7d' }, selection: { node: '1:/', target: '2:/pricing' } },
  ],
  ['GET', '/api/paths/suggest-rules'],
  ['GET', '/api/cohorts'],
  ['GET', '/api/cohorts/engaged/members'],
  ['GET', '/api/events?from=-30d'],
  ['GET', '/api/events/signup_completed?from=-30d'],
  ['GET', '/api/properties/values?property=plan&event=signup_completed'],
  ['GET', '/api/persons/user-3'],
  ['POST', '/api/reports/conversions?from=-7d'],
  ['POST', '/api/reports/sources?from=-7d'],
  ['POST', '/api/reports/health?from=-7d'],
  ['GET', '/api/experiments/checkout-v2'],
  ['GET', '/api/experiments/checkout-metrics'],
  [
    'POST',
    '/api/experiments/plan',
    { metric: { kind: 'conversion', event: 'signup_completed' }, lookback: '-7d', mde: 0.2 },
  ],
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
    let stores: Map<TestApp, EventStore>;

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
      stores = new Map<TestApp, EventStore>([
        [d1, new D1Store(d1.db)],
        [lake, new LakeStore(lake.env, basin, split ? V2 : [])],
      ]);
      const events = fixture(Date.now());
      for (const app of [d1, lake]) {
        // Group types are cached per isolate by project; these two apps share one isolate and project.
        clearGroupTypeCache();
        app.db.sqlite.exec('UPDATE traffic_collection SET started_ms = 1');
        await app.json('POST', '/api/projects', { body: { id: 'acme' } });
        // Purchases are revenue (and subscription payments, for MRR).
        await app.json('PATCH', '/api/settings', {
          body: {
            project: 'acme',
            settings: {
              baseCurrency: 'GBP',
              revenueEvents: [
                {
                  event: 'purchase',
                  amountProperty: 'value',
                  productProperty: 'plan',
                  subscriptionProperty: 'sub',
                },
              ],
            },
          },
        });
        await app.json('POST', '/api/experiments', {
          body: { key: 'checkout-v2', goal: { event: 'purchase' } },
        });
        await app.json('POST', '/api/experiments/checkout-v2/start');
        await app.json('POST', '/api/experiments', {
          body: {
            key: 'checkout-metrics',
            flag: 'checkout-v2',
            metrics: [
              {
                kind: 'mean',
                event: 'purchase',
                math: 'sum',
                property: 'value',
                winsorize: { upper: 95 },
              },
              {
                kind: 'ratio',
                numerator: { event: 'purchase', math: 'sum', property: 'value' },
                denominator: { event: '$pageview' },
              },
              {
                kind: 'funnel',
                steps: [{ event: '$pageview' }, { event: 'purchase' }],
                window: '1d',
              },
              { kind: 'retention', event: '$pageview', from: '1h', to: '2h' },
            ],
            secondary: [{ kind: 'conversion', event: 'signup_completed', within: '1d' }],
            engine: 'frequentist',
            minimumDays: 0,
            minimumExposures: 0,
          },
        });
        await app.json('POST', '/api/experiments/checkout-metrics/start');
        await app.json('POST', '/api/cohorts', {
          body: {
            key: 'engaged',
            name: 'Engaged',
            definition: {
              groups: [
                {
                  match: 'any',
                  conditions: [
                    {
                      type: 'performed',
                      event: '$pageview',
                      count: { op: 'gte', value: 3 },
                      within: '7d',
                    },
                    {
                      type: 'performed_regularly',
                      event: '$pageview',
                      period: 'day',
                      periods: 7,
                      minPeriods: 2,
                    },
                  ],
                },
                { conditions: [{ type: 'not_performed', event: 'purchase', within: '7d' }] },
              ],
            },
          },
        });
        await app.json('POST', '/api/cohorts', {
          body: { key: 'vips', name: 'VIPs', static: true, ids: ['user-1', 'user-3', 'user-5'] },
        });
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

    it('compares revenue that is really there', async () => {
      const r = await d1.json<{ totals: { net: number; mrr: number; customers: number } }>(
        'POST',
        '/api/query',
        {
          body: { kind: 'revenue', from: '-30d' },
        },
      );
      assert.ok(
        r.totals.net > 0 && r.totals.mrr > 0 && r.totals.customers > 1,
        JSON.stringify(r.totals),
      );
    });

    it('batch exports send the same rows from both stores', async () => {
      const exported = new Map<TestApp, Record<string, unknown>[]>();
      for (const app of [d1, lake]) {
        const rows: Record<string, unknown>[] = [];
        configureExports({
          fetch: async (_url, init) => {
            for (const line of String(init?.body).trim().split('\n')) rows.push(JSON.parse(line));
            return new Response('{}');
          },
        });
        await app.json('POST', '/api/exports', {
          body: {
            project: 'acme',
            target: 'http',
            settings: { url: 'https://etl.test/in' },
            from: '-30d',
          },
        });
        // Pages of 2,000, five a tick: enough ticks to finish the window.
        for (let i = 0; i < 5; i++)
          await runExports(app.env, stores.get(app)!, Date.now() + 2 * 3_600_000);
        exported.set(
          app,
          rows.sort((x, y) => String(x.id).localeCompare(String(y.id))),
        );
      }
      const fromD1 = exported.get(d1)!;
      assert.ok(fromD1.length > 100, `${fromD1.length} rows`);
      assert.deepEqual(normalise(exported.get(lake)), normalise(fromD1));
    });
  });
}

conformance('lake conformance', false);
conformance('lake conformance across schema versions', true);
