/**
 * Dashboard smoke run (local only, not part of CI): start the dev Worker in memory, seed errors,
 * revenue, groups and pipelines, open every page in Chromium, and save a screenshot of each plus
 * any console errors. Usage: node scripts/ui-smoke.ts <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { transformSync } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { startDevServer } from '../packages/worker/test/server.ts';

const out = process.argv[2] ?? 'test-results/ui';
/** UI_ONLY=flag,insights-map runs just those pages, for a quick look while working on them. */
const only = process.env.UI_ONLY ? new Set(process.env.UI_ONLY.split(',')) : null;
mkdirSync(out, { recursive: true });
const server = await startDevServer({ port: 0, demoPort: 0, memory: true });
const base = server.glassUrl;
// Destinations post here (never to a real service).
const echo = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const hook = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/hook`;
// A real minified bundle with its source map, so the issue page shows mapped frames.
const SOURCE = [
  'export function total(cart) {',
  '  return cart.items.reduce((sum, item) => sum + item.price, 0);',
  '}',
  'export function checkout(cart) {',
  '  if (!cart.items) {',
  "    throw new TypeError('Cart has no items');",
  '  }',
  '  return total(cart);',
  '}',
].join('\n');
const built = transformSync(SOURCE, {
  minify: true,
  sourcemap: 'external',
  sourcefile: 'src/cart.js',
  sourcesContent: true,
});
const throwColumn = built.code.indexOf('throw') + 1;
/**
 * A full-page screenshot from the top, so sticky headers and the sidebar sit where they belong.
 * With a dialog open, just the window: its fixed backdrop only covers the viewport.
 */
const shot = async (p: Page, path: string) => {
  const dialog = (await p.locator('.modal-overlay').count()) > 0;
  if (!dialog) await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(150);
  await p.screenshot({ path, fullPage: !dialog });
};
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer dev-admin-key',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
};
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const now = Date.now();
let n = 0;
const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  id: `seed-${++n}`,
  event,
  ts: now - Math.floor(Math.random() * 6 * 86_400_000) - 60_000,
  distinct_id: `dev-${n % 7}`,
  session_id: `s-${n % 11}`,
  url: `https://demo.test/${['', 'pricing', 'checkout', 'docs'][n % 4]}`,
  ...extra,
});
await call('PATCH', '/api/settings', {
  project: 'demo',
  settings: {
    baseCurrency: 'GBP',
    revenueEvents: [
      {
        event: 'order_paid',
        amountProperty: 'amount',
        productProperty: 'plan',
        subscriptionProperty: 'sub',
      },
    ],
    internalFilters: [{ property: 'person.email', op: 'contains', value: '@demo.test' }],
  },
});
const events = [];
for (let i = 0; i < 60; i++) {
  const company = `co-${i % 3}`;
  events.push(ev('$pageview', { props: { $groups: { company } } }));
  if (i % 3 === 0) {
    events.push(
      ev('$exception', {
        props: {
          type: 'TypeError',
          message: `Cannot read properties of undefined (reading 'price') #${i}`,
          stack: `TypeError: boom\n    at a (https://demo.test/assets/app-BxT8QXh2.js:1:${throwColumn})\n    at b (https://demo.test/assets/app-BxT8QXh2.js:1:1)\n    at https://cdn.vendor.test/lib.js:3:10`,
          $release: 'v1.4.0',
          $groups: { company },
        },
      }),
    );
  }
  if (i % 7 === 0)
    events.push(
      ev('$exception', {
        props: { type: 'RangeError', message: 'Invalid time value', handled: true },
      }),
    );
  if (i % 5 === 0)
    events.push(
      ev('order_paid', {
        props: {
          amount: 29 + (i % 4) * 20,
          plan: ['starter', 'pro', 'team'][i % 3],
          sub: `sub-${i % 6}`,
          $groups: { company },
        },
      }),
    );
}
// Journeys for the paths chart: visitors who follow a few common routes through the site.
const ROUTES = [
  ['', 'pricing', 'signup', 'checkout'],
  ['', 'pricing', 'docs'],
  ['', 'features', 'pricing', 'signup'],
  ['blog/launch', '', 'pricing'],
  ['blog/launch', 'blog/tips', 'features'],
  ['docs', 'docs/api', 'pricing', 'signup'],
  ['', 'docs', 'pricing'],
];
for (let v = 0; v < 70; v++) {
  const route = ROUTES[(v * 5 + (v % 3)) % ROUTES.length]!.slice(0, 2 + (v % 3));
  const start = now - ((v * 37) % 5) * 86_400_000 - 3_600_000 - v * 61_000;
  for (const [i, page] of route.entries())
    events.push(
      ev('$pageview', {
        ts: start + i * 45_000,
        distinct_id: `walker-${v}`,
        session_id: `walk-${v}`,
        url: `https://demo.test/${page}`,
      }),
    );
}
await call(
  'POST',
  '/e',
  { project: 'demo', sent_at: Date.now(), lib: 'seed', events },
  { 'User-Agent': UA, 'Content-Type': 'text/plain' },
);
await call('POST', '/api/projects', { id: 'shop', name: 'Shop' }).catch(() => {});
// People with properties, and cohorts of every kind: by behaviour, two groups with a cohort reference, a list.
for (const [id, name, plan] of [
  ['dev-1', 'Ada Lovelace', 'pro'],
  ['dev-2', 'Grace Hopper', 'team'],
  ['dev-3', 'Alan Turing', 'starter'],
] as const)
  await call('PATCH', `/api/persons/${id}`, {
    project: 'demo',
    properties: { name, email: `${id}@example.com`, plan },
  });
await call('PATCH', '/api/groups/company/co-1?project=demo', { properties: { name: 'Initech' } });
await call('POST', '/api/cohorts', {
  project: 'demo',
  key: 'buyers',
  name: 'Repeat buyers',
  description: 'Paid at least twice this month',
  definition: {
    groups: [
      {
        conditions: [
          { type: 'performed', event: 'order_paid', count: { op: 'gte', value: 2 }, within: '30d' },
        ],
      },
    ],
  },
});
await call('POST', '/api/cohorts', {
  project: 'demo',
  key: 'healthy-pro',
  name: 'Healthy paying accounts',
  definition: {
    groups: [
      {
        match: 'any',
        conditions: [
          { type: 'property', property: 'person.plan', op: 'in', value: ['pro', 'team'] },
          { type: 'cohort', key: 'buyers' },
        ],
      },
      {
        conditions: [
          { type: 'not_performed', event: '$exception', within: '7d' },
          {
            type: 'performed_regularly',
            event: '$pageview',
            period: 'day',
            periods: 7,
            minPeriods: 2,
          },
        ],
      },
    ],
  },
});
// Visits from a few countries (imported, so they keep their country), and a note on the charts.
await call('POST', '/api/import', {
  project: 'demo',
  events: ['GB', 'GB', 'GB', 'US', 'US', 'DE', 'FR', 'IN', 'BR', 'JP', 'AU', 'SG'].map(
    (country, i) => ({
      id: `geo-${i}`,
      event: '$pageview',
      ts: now - (i % 5) * 86_400_000 - 7_200_000,
      distinct_id: `geo-${i % 4}`,
      url: 'https://demo.test/',
      context: { country },
    }),
  ),
});
await call('POST', '/api/annotations', {
  project: 'demo',
  at: new Date(now - 3 * 86_400_000).toISOString(),
  text: 'Launched pricing v2',
});
await call('POST', '/api/cohorts', {
  project: 'demo',
  key: 'beta',
  name: 'Beta testers',
  static: true,
  ids: ['dev-1', 'dev-2', 'dev-5'],
});
const dest = await call('POST', '/api/destinations', {
  project: 'demo',
  template: 'slack',
  name: 'Signups to Slack',
  events: ['signup_completed'],
  inputs: { url: hook },
});
await call(
  'PUT',
  '/api/sourcemaps?project=demo&release=v1.4.0&path=/assets/app-BxT8QXh2.js',
  built.map,
);
await call('POST', '/api/transformations', {
  project: 'demo',
  rule: { kind: 'redact', patterns: ['email'] },
});
await call('POST', '/api/exports', {
  project: 'demo',
  target: 'http',
  settings: { url: hook },
});
const issues = await call('GET', '/api/issues?project=demo&from=-7d');
// An experiment with two primary metrics, a guardrail and a holdout, started a week ago.
await call('PUT', '/api/holdouts/q4-holdout', { project: 'demo', percentage: 10 });
await call('POST', '/api/experiments', {
  project: 'demo',
  key: 'checkout-test',
  hypothesis: 'A shorter checkout gets more people to pay',
  metrics: [
    { kind: 'conversion', event: 'order_paid', name: 'Paid' },
    {
      kind: 'mean',
      event: 'order_paid',
      math: 'sum',
      property: 'amount',
      name: 'Revenue per person',
    },
  ],
  secondary: [{ kind: 'conversion', event: '$exception', goal: 'decrease', name: 'Errors' }],
  holdout: 'q4-holdout',
  minimumDays: 0,
});
await call('POST', '/api/experiments/checkout-test/start', { project: 'demo' });
const exposures = [];
for (let i = 0; i < 80; i++) {
  const variant = i % 2 ? 'test' : 'control';
  // After the start: only exposures from then on count.
  const ts = Date.now() + i;
  exposures.push({
    id: `exp-${i}`,
    event: '$exposure',
    ts,
    distinct_id: `exp-user-${i}`,
    session_id: `xs-${i}`,
    url: 'https://demo.test/checkout',
    props: { flag: 'checkout-test', variant },
    flags: { 'checkout-test': variant },
  });
  if (i % (variant === 'test' ? 3 : 5) === 0)
    exposures.push({
      id: `exp-paid-${i}`,
      event: 'order_paid',
      ts: ts + 1,
      distinct_id: `exp-user-${i}`,
      session_id: `xs-${i}`,
      url: 'https://demo.test/checkout',
      props: { amount: 40 + (i % 3) * 10 },
      flags: { 'checkout-test': variant },
    });
}
await call('POST', '/api/import', { project: 'demo', events: exposures });
await call('PUT', '/api/flags/new-checkout', {
  project: 'demo',
  description: 'The redesigned checkout',
  rollout: 50,
  variants: [
    { key: 'control', weight: 50 },
    { key: 'test', weight: 50 },
  ],
  payloads: { control: { cta: 'Buy now' }, test: { cta: 'Get it today' } },
  bucketBy: 'person',
  rules: [
    { conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100, variant: 'test' },
  ],
  earlyAccess: { name: 'New checkout', stage: 'beta', description: 'A faster checkout' },
});
await call('POST', '/api/flags/new-checkout/schedule', {
  project: 'demo',
  at: new Date(Date.now() + 86_400_000).toISOString(),
  change: { rollout: 100 },
});

// A dashboard from a template, a note, a channel and a weekly report of it.
const board = (await call('POST', '/api/dashboards/from-template', {
  project: 'demo',
  template: 'website',
})) as { id: string };
await call('POST', `/api/dashboards/${board.id}/tiles`, {
  project: 'demo',
  text: '## This week\nTraffic from the **launch post** is in. Check the [docs](https://dataflare.dev/docs).',
  width: 12,
});
const boardTiles = (await call('GET', `/api/dashboards/${board.id}?project=demo`)) as {
  tiles: { insight?: { key: string } | null }[];
};
const savedKey = boardTiles.tiles[0]!.insight!.key;
const channel = (await call('POST', '/api/destinations', {
  project: 'demo',
  name: '#growth',
  template: 'slack',
  enabled: false,
  events: ['$report'],
  filters: [],
  inputs: { url: 'https://hooks.slack.com/services/T000/B000/XXXX' },
})) as { destination: { id: string } };
await call('POST', '/api/subscriptions', {
  project: 'demo',
  target: 'dashboard',
  targetId: board.id,
  channels: { destinations: [channel.destination.id] },
  schedule: { frequency: 'weekly', weekday: 'mon', time: '09:00' },
});
const insight = (kind: string, spec: Record<string, unknown>, from = '-7d') =>
  `insights/new/${kind}?project=demo&from=${from}&spec=${encodeURIComponent(JSON.stringify(spec))}`;
const routes: [string, string][] = [
  ['errors', 'errors?project=demo&from=-7d'],
  ['issue', `errors/${issues.issues[0].id}?project=demo&from=-7d`],
  ['revenue', 'revenue?project=demo&from=-30d&interval=week&breakdown=product'],
  ['groups', 'groups?project=demo'],
  ['group', 'groups/company/co-1?project=demo&from=-7d'],
  ['destinations', 'pipelines/destinations?project=demo'],
  ['destination', `pipelines/destinations/${dest.destination.id}?project=demo`],
  ['destination-new', 'pipelines/destinations/new?project=demo&template=meta-capi'],
  ['destination-pick', 'pipelines/destinations/new?project=demo'],
  ['transformations', 'pipelines/transformations?project=demo'],
  ['imports', 'pipelines/imports?project=demo'],
  ['exports', 'pipelines/exports?project=demo'],
  ['settings', 'settings?project=demo'],
  ['dashboards', 'dashboards?project=demo&from=-7d'],
  ['insight-saved', `insights/${savedKey}?project=demo&from=-7d`],
  ['dashboard', `dashboards/${board.id}?project=demo&from=-7d`],
  [
    'insights-trends',
    'insights/new/trends?project=demo&from=-7d&spec=%7B%22series%22%3A%5B%7B%22event%22%3A%22%24pageview%22%2C%22math%22%3A%22total%22%7D%2C%7B%22event%22%3A%22%24exception%22%2C%22math%22%3A%22total%22%7D%5D%2C%22interval%22%3A%22day%22%2C%22aggregateBy%22%3A%22company%22%2C%22formulas%22%3A%5B%7B%22expr%22%3A%22B%20/%20A%20%2A%20100%22%7D%5D%2C%22cumulative%22%3Atrue%7D',
  ],
  [
    'insights-funnel-ttc',
    'insights/new/funnel?project=demo&from=-7d&spec=%7B%22steps%22%3A%5B%7B%22event%22%3A%22%24pageview%22%7D%2C%7B%22event%22%3A%22order_paid%22%7D%5D%2C%22window%22%3A%227d%22%2C%22order%22%3A%22strict%22%2C%22viz%22%3A%22time_to_convert%22%7D',
  ],
  [
    'insights-funnel',
    'insights/new/funnel?project=demo&from=-7d&spec=%7B%22steps%22%3A%5B%7B%22event%22%3A%22%24pageview%22%7D%2C%7B%22event%22%3A%22order_paid%22%7D%5D%2C%22window%22%3A%227d%22%2C%22exclusions%22%3A%5B%7B%22event%22%3A%22%24exception%22%2C%22fromStep%22%3A1%2C%22toStep%22%3A2%7D%5D%7D',
  ],
  [
    'insights-retention',
    'insights/new/retention?project=demo&from=-7d&spec=%7B%22cohortEvent%22%3A%7B%22event%22%3A%22%24pageview%22%7D%2C%22returnEvent%22%3A%7B%22event%22%3A%22%24pageview%22%7D%2C%22period%22%3A%22day%22%2C%22periods%22%3A6%2C%22retentionType%22%3A%22recurring%22%2C%22cumulative%22%3Atrue%2C%22aggregateBy%22%3A%22company%22%7D',
  ],
  ['insights-paths', insight('paths', { steps: 4 })],
  ['insights-paths-top', insight('paths', { steps: 4, display: 'top' })],
  [
    'insights-paths-funnel',
    insight('paths', {
      steps: 3,
      funnel: {
        spec: {
          steps: [
            { event: '$pageview' },
            { event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] },
          ],
        },
        step: 2,
        mode: 'after',
      },
    }),
  ],
  [
    'insights-table',
    insight('trends', {
      series: [{ event: '$pageview' }],
      breakdown: ['path'],
      display: 'table',
      interval: 'day',
    }),
  ],
  [
    'insights-pie',
    insight('trends', { series: [{ event: '$pageview' }], breakdown: ['path'], display: 'pie' }),
  ],
  [
    'insights-values',
    insight('trends', {
      series: [{ event: '$pageview' }],
      breakdown: ['path'],
      display: 'bar_value',
    }),
  ],
  [
    'insights-map',
    insight('trends', {
      series: [{ event: '$pageview' }],
      breakdown: ['country'],
      breakdownLimit: 50,
      display: 'world_map',
    }),
  ],
  [
    'insights-stacked',
    insight('trends', {
      series: [{ event: '$pageview' }],
      breakdown: ['path'],
      display: 'area',
      percentStack: true,
      showValues: true,
    }),
  ],
  [
    'insights-trendline',
    insight('trends', {
      series: [{ event: '$pageview' }, { event: '$exception' }],
      display: 'bar',
      trendLine: true,
      logScale: true,
      showValues: true,
    }),
  ],
  [
    'insights-cohorts',
    insight('trends', {
      series: [{ event: '$pageview' }],
      breakdown: ['cohort'],
      breakdownCohorts: ['buyers', 'beta'],
    }),
  ],
  [
    'insights-bins',
    insight('trends', {
      series: [{ event: 'order_paid' }],
      breakdown: ['props.amount'],
      breakdownBins: 5,
    }),
  ],
  [
    'insights-funnel-optional',
    insight('funnel', {
      steps: [
        { event: '$pageview' },
        { event: '$exception', optional: true },
        { event: 'order_paid' },
      ],
      window: '7d',
      breakdown: ['path'],
      breakdownAttribution: 'last_touch',
    }),
  ],
  [
    'insights-correlation',
    insight('funnel', { steps: [{ event: '$pageview' }, { event: 'order_paid' }], window: '7d' }),
  ],
  [
    'insights-retention-hour',
    insight(
      'retention',
      {
        cohortEvent: { event: '*' },
        returnEvent: { event: '*' },
        period: 'hour',
        periods: 6,
        breakdown: ['path'],
      },
      '-2d',
    ),
  ],
  ['people', 'users?project=demo'],
  ['person', 'users/dev-1?project=demo'],
  ['cohorts', 'users?tab=cohorts&project=demo'],
  ['cohorts-members', 'users?tab=cohorts&project=demo&view=members'],
  ['flag', 'flags/new-checkout?project=demo'],
  ['experiments-list', 'experiments?project=demo'],
  ['experiment', 'experiments/checkout-test?project=demo'],
  ['experiment-new', 'experiments/new?project=demo'],
  ['holdout', 'experiments/holdouts/q4-holdout?project=demo'],
  // A project with no data: every page's empty state.
  ['empty-destinations', 'pipelines/destinations?project=shop'],
  ['empty-transformations', 'pipelines/transformations?project=shop'],
  ['empty-exports', 'pipelines/exports?project=shop'],
  ['empty-errors', 'errors?project=shop&from=-7d'],
  ['empty-revenue', 'revenue?project=shop'],
  ['empty-groups', 'groups?project=shop'],
  ['empty-flags', 'flags?project=shop'],
  ['empty-experiments', 'experiments?project=shop'],
  ['empty-cohorts', 'users?tab=cohorts&project=shop'],
  ['empty-people', 'users?project=shop'],
  ['empty-settings', 'settings?project=shop'],
];
const browser = await chromium.launch({ args: [`--user-agent=${UA}`] });
const problems: string[] = [];
async function session(theme: 'light' | 'dark', width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addInitScript((t) => localStorage.setItem('glass:theme', t), theme);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${theme}/${width} ${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${theme}/${width} ${page.url()}: ${e.message}`));
  page.on('response', async (r) => {
    if (r.status() >= 400)
      problems.push(
        `${theme}/${width} HTTP ${r.status()} ${r.request().method()} ${r.url()}: ${(await r.text().catch(() => '')).slice(0, 200)}`,
      );
  });
  // Ignore what the first load (signing in with the key) reports, but keep earlier sessions' problems.
  const before = problems.length;
  await page.goto(`${base}/app?project=demo#key=dev-admin-key`);
  await page.waitForTimeout(300);
  problems.splice(before);
  return page;
}
/**
 * Cards that sit on top of each other with no gap: for every panel, KPI strip,
 * notice or toolbar, the nearest block above it that overlaps it horizontally
 * (and isn't its ancestor or descendant) must be at least 8px away.
 */
async function touchingBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // Blocks in the page flow (through loading wrappers and plain divs), plus every panel.
    const flow: HTMLElement[] = [];
    const walk = (parent: Element) => {
      for (const child of parent.children) {
        const wrapper =
          child.classList.contains('later') ||
          child.classList.contains('section-gap') ||
          (child.tagName === 'DIV' && child.classList.length === 0);
        if (wrapper) walk(child);
        else flow.push(child as HTMLElement);
      }
    };
    const content = document.querySelector('.content');
    if (content) walk(content);
    const blocks = [
      ...new Set([
        ...flow,
        ...document.querySelectorAll<HTMLElement>('.content .panel, .content .kpis, .modal .panel'),
      ]),
    ].filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
    const name = (el: HTMLElement) =>
      (el.querySelector('.panel-head h2, .panel-title, h1, h2, h3')?.textContent ?? '').trim() ||
      `.${[...el.classList].join('.')}`;
    const out: string[] = [];
    for (const el of blocks) {
      const box = el.getBoundingClientRect();
      let nearest: { el: HTMLElement; bottom: number } | null = null;
      for (const other of blocks) {
        if (other === el || other.contains(el) || el.contains(other)) continue;
        const o = other.getBoundingClientRect();
        const overlap = Math.min(box.right, o.right) - Math.max(box.left, o.left);
        if (overlap < 40 || o.bottom > box.top + 1) continue;
        if (!nearest || o.bottom > nearest.bottom) nearest = { el: other, bottom: o.bottom };
      }
      if (!nearest) continue;
      // Two blocks that start together are one row of a grid, not a stack.
      const gap = box.top - nearest.bottom;
      if (gap < 8)
        out.push(`"${name(el)}" is ${gap.toFixed(0)}px below "${name(nearest.el)}" (want ≥ 8px)`);
    }
    return [...new Set(out)];
  });
}

const actions: Record<string, (p: Page) => Promise<void>> = {
  'insight-saved': async (p) => {
    await p.getByRole('button', { name: 'Alerts' }).click();
    await p.waitForTimeout(800);
  },
  dashboard: async (p) => {
    await p.getByRole('button', { name: 'Subscribe' }).click();
    await p.waitForTimeout(700);
  },
  'insights-paths': async (p) => {
    await p.locator('.sankey .sankey-node:not(.other)').nth(1).click();
    await p.waitForTimeout(300);
  },
  'insights-funnel': async (p) => {
    await p.locator('.fold > summary').first().click();
    await p.waitForTimeout(300);
  },
  'insights-trends': async (p) => {
    await p.getByRole('button', { name: 'People' }).first().click();
    await p.waitForTimeout(700);
  },
  destination: async (p) => {
    await p.getByRole('button', { name: 'Send a test event' }).click();
    await p.waitForTimeout(700);
  },
  transformations: async (p) => {
    await p.getByRole('button', { name: 'Try it' }).click();
    await p.waitForTimeout(700);
  },
  'insights-correlation': async (p) => {
    await p.getByRole('button', { name: 'Find what drives conversion' }).click();
    await p.waitForTimeout(1200);
  },
  'insights-retention-hour': async (p) => {
    await p.locator('.retention .cell-button').first().click();
    await p.waitForTimeout(900);
  },
  'insights-trendline': async (p) => {
    await p.getByRole('button', { name: 'Add a note' }).click();
    await p.waitForTimeout(300);
  },
  imports: async (p) => {
    // A small PostHog export: two pageviews and a signup, one record without a time.
    const rows = [
      {
        uuid: 'ph-1',
        event: '$pageview',
        timestamp: new Date(now - 86_400_000).toISOString(),
        distinct_id: 'ph-user',
        properties: { $current_url: 'https://demo.test/pricing', $browser: 'Firefox' },
      },
      {
        uuid: 'ph-2',
        event: '$pageview',
        timestamp: new Date(now - 80_000_000).toISOString(),
        distinct_id: 'ph-user',
        properties: { $current_url: 'https://demo.test/' },
      },
      {
        uuid: 'ph-3',
        event: 'signed_up',
        timestamp: new Date(now - 79_000_000).toISOString(),
        distinct_id: 'ph-user',
        properties: { plan: 'pro' },
      },
      { uuid: 'ph-4', event: 'broken' },
    ];
    await p.locator('input[type=file]').setInputFiles({
      name: 'posthog-events.ndjson',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')),
    });
    await p.waitForTimeout(700);
    await shot(p, `${out}/imports-preview.png`);
    await p.getByRole('button', { name: /^Import \d/ }).click();
    await p.waitForTimeout(1200);
  },
  cohorts: async (p) => {
    await p
      .locator('.cohorts-table tr', { hasText: 'Healthy paying accounts' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await p.waitForTimeout(900);
  },
  'cohorts-members': async (p) => {
    await p
      .locator('.cohorts-table tr', { hasText: 'Beta testers' })
      .getByRole('button', { name: 'People' })
      .click();
    await p.waitForTimeout(700);
  },
  exports: async (p) => {
    await p.locator('table .link-button').first().click();
    await p.waitForTimeout(700);
  },
};
/** Assertions on what a page shows, run in every theme and width; each returns a problem or null. */
const checks: Record<string, (p: Page) => Promise<string | null>> = {
  // Countries with data are shaded: the stylesheet's grey once won over the shade.
  'insights-map': async (p) => {
    const fills = await p.evaluate(() => {
      const fill = (el: Element | null) => (el ? getComputedStyle(el).fill : null);
      return {
        shaded: fill(document.querySelector('.world-map .country.has-value')),
        plain: fill(document.querySelector('.world-map .country:not(.has-value)')),
      };
    });
    if (!fills.shaded) return 'no country on the map has a value';
    return fills.shaded === fills.plain
      ? `countries with values are not shaded (both ${fills.shaded})`
      : null;
  },
};
// A dashboard draws every tile, and none of them errors.
checks.dashboard = async (p) => {
  await p.waitForTimeout(800);
  const tiles = await p.locator('.dashboard-grid .tile').count();
  const errors = await p.locator('.dashboard-grid .tile .state.error').count();
  const charts = await p
    .locator('.dashboard-grid .tile svg.chart, .dashboard-grid .tile .tile-paths')
    .count();
  if (tiles < 5) return `only ${tiles} tiles`;
  if (errors) return `${errors} tiles show an error`;
  return charts >= 3 ? null : `only ${charts} tiles drew a chart`;
};
// The paths chart draws steps and the bands between them, and hovering a step traces its flow.
checks['insights-paths'] = async (p) => {
  const nodes = await p.locator('.sankey .sankey-node').count();
  const links = await p.locator('.sankey .sankey-link').count();
  const list = await p.locator('.sankey-list-row').count();
  if (list) return list > 3 ? null : `only ${list} steps in the narrow list`;
  if (nodes < 4 || links < 3) return `the paths chart has ${nodes} steps and ${links} links`;
  await p.locator('.sankey .sankey-node').first().hover();
  const lit = await p.locator('.sankey.tracing .sankey-link.lit').count();
  return lit ? null : 'hovering a step traces no links';
};
checks['insights-trends'] = async (p) => {
  // A setting hidden in the closed "More options" fold still shows as a chip.
  const chips = await p.locator('.fold:not([open]) .setting-chip').allTextContents();
  if (!chips.some((c) => /company/.test(c)))
    return `the closed fold shows no chip for counting by company (${chips.join(', ')})`;
  // The formula editor suggests what comes next, and checks as you type.
  const field = p.locator('.formula-row textarea.code-input').first();
  await field.click();
  await field.fill('B / ');
  await p.waitForTimeout(100);
  const hints = await p.locator('.formula-hints:not([hidden]) li').allTextContents();
  if (!hints.some((t) => t.startsWith('A')))
    return `no series suggested after "B / " (${hints.join(' | ')})`;
  await field.fill('B / D');
  const message = (await p.locator('.formula-row .code-message').first().textContent()) ?? '';
  if (!/D isn't a series/.test(message))
    return `no inline error for an unknown series (${message})`;
  await field.fill('B / A * 100');
  return null;
};
checks.flag = async (p) => {
  // A payload with a mistake is marked at its line, and saving says what's wrong.
  const editor = p.locator('.payload-fold[open] textarea.code-input').first();
  if (!(await editor.count())) return 'no open payload editor';
  await editor.fill('{\n  "cta": "Buy now"\n  "size": 2\n}');
  const status = await p.locator('.payload-fold[open] .json-status').first().textContent();
  const marked = await p.locator('.payload-fold[open] .code-error').count();
  if (!status?.includes('Line 3, column 3') || marked === 0)
    return `invalid JSON is not marked at its line (status: ${status}, squiggles: ${marked})`;
  await p.getByRole('button', { name: 'Save changes' }).click();
  await p.waitForTimeout(300);
  const error = (await p.locator('form .error, form [role=alert]').allTextContents()).join(' ');
  return /Payload for "control"/.test(error)
    ? null
    : `saving invalid JSON did not explain why (${error})`;
};
const MOBILE = new Set([
  'insights-map',
  'insights-pie',
  'insights-correlation',
  'empty-destinations',
  'empty-errors',
  'destination-pick',
  'experiment',
  'experiments-list',
  'person',
  'cohorts',
  'errors',
  'issue',
  'revenue',
  'groups',
  'group',
  'destinations',
  'destination-new',
  'settings',
  'insights-trends',
  'insights-funnel',
]);
for (const [theme, width, height, suffix] of [
  ['light', 1360, 900, ''],
  ['dark', 1360, 900, '-dark'],
  ['light', 390, 844, '-mobile'],
] as const) {
  const page = await session(theme, width, height);
  for (const [name, route] of routes) {
    if (suffix === '-mobile' && !MOBILE.has(name)) continue;
    if (only && !only.has(name)) continue;
    await page.goto(`${base}/app#/${route}`);
    await page.waitForTimeout(900);
    const text = await page
      .locator('.main')
      .first()
      .textContent()
      .then((t) => t ?? '')
      .catch(() => '');
    if (
      /Request failed|Something went wrong|is not a function|of undefined \(reading '(?!price)/.test(
        text.slice(0, 4000),
      )
    )
      problems.push(
        `${name}${suffix}: page text mentions an error: ${text.slice(0, 300).replace(/\n/g, ' | ')}`,
      );
    await shot(page, `${out}/${name}${suffix}.png`);
    for (const gap of await touchingBlocks(page)) problems.push(`${name}${suffix}: ${gap}`);
    const problem = await checks[name]?.(page).catch((e: Error) => `check failed: ${e.message}`);
    if (problem) problems.push(`${name}${suffix}: ${problem}`);
    const act = actions[name];
    if (act && suffix !== '-mobile') {
      await act(page).catch((e) => problems.push(`${name}${suffix}: action failed: ${e.message}`));
      await shot(page, `${out}/${name}${suffix}-after.png`);
      await page.keyboard.press('Escape');
    }
  }
  await page.context().close();
}
writeFileSync(`${out}/problems.json`, JSON.stringify(problems, null, 2));
console.log(JSON.stringify({ problems }, null, 2));
await browser.close();
await server.close();
echo.close();
