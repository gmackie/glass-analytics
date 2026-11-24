/**
 * End to end: a real browser browses the demo site with the real SDK, the real
 * Worker ingests it (on Node, via the dev server), and we check the results
 * through the API and the dashboard.
 *
 * Run with `pnpm test:e2e` (builds first). Screenshots go to test-results/.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { sha256Hex } from '../packages/core/src/hash.ts';
import { wire } from '../packages/worker/test/harness.ts';
import { type DevServer, startDevServer } from '../packages/worker/test/server.ts';
import { assertRendersFrames } from './render-check.ts';

// Headless Chromium says "HeadlessChrome", which Dataflare filters as a bot; look like a real browser.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SHOTS = new URL('../test-results/', import.meta.url).pathname;

let server: DevServer;
let browser: Browser;
let context: BrowserContext;

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${server.glassUrl}${path}`, {
    method,
    headers: { Authorization: 'Bearer dev-admin-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data as T;
}

async function eventually<T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() - start < timeoutMs);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 500)}`);
}

describe('Dataflare end to end', { timeout: 120_000 }, () => {
  before(async () => {
    mkdirSync(SHOTS, { recursive: true });
    server = await startDevServer({ port: 0, demoPort: 0, memory: true });
    // Set the UA for the whole browser: context overrides don't apply to sendBeacon requests.
    browser = await chromium.launch({ args: [`--user-agent=${UA}`] });
    context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 860 } });
    // Every click below waits for animation frames: stop here, with the fix, if there are none.
    const probe = await context.newPage();
    await assertRendersFrames(probe);
    await probe.close();
    // A 50/50 flag on the home page call to action.
    await api('PUT', '/api/flags/new-cta', {
      project: 'demo',
      rollout: 100,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'test', weight: 50 },
      ],
    });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  it('captures a real browsing session', async () => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${server.demoUrl}/?utm_source=e2e&utm_campaign=launch`);
    await page.waitForFunction(
      () => (window as unknown as { glass?: { flags(): object } }).glass?.flags !== undefined,
    );
    await page.waitForTimeout(500); // flags load, exposure is logged
    await page.click('#cta a');
    await page.waitForURL('**/pricing');
    await page.click('text=Choose Team');
    await page.waitForURL('**/signup?plan=team');
    await page.fill('#email', 'ada@example.com');
    await page.click('button[type=submit]');
    await page.waitForURL('**/app');
    await page.waitForTimeout(300);
    await page.click('#pay');
    await page.click('#pay');
    await page.click('#pay');
    await page.waitForTimeout(300);
    // Leave the way a visitor does: pagehide sends the last events and replay chunk.
    // (Closing the tab outright can tear the page down before its handlers run.)
    await page.goto('about:blank');
    await page.close();
    assert.ok(
      errors.some((e) => e.includes('number')),
      'the demo button throws, as designed',
    );

    const events = await eventually(
      () => api<{ events: { event: string; count: number }[] }>('GET', '/api/events?project=demo'),
      (r) =>
        ['signup_completed', 'plan_selected', '$exception', '$pageview'].every((name) =>
          r.events.some((e) => e.event === name),
        ),
      'events',
    );
    const count = (name: string) => events.events.find((e) => e.event === name)?.count ?? 0;
    assert.equal(count('$pageview'), 4);
    assert.equal(count('signup_completed'), 1);
    assert.ok(count('$exception') >= 1);
  });

  it('answers questions about it through the API', async () => {
    const web = await api<{
      totals: { visitors: number; pageviews: number; sessions: number };
      breakdowns: { utm_source: { value: string }[] };
    }>('POST', '/api/query', { kind: 'web', project: 'demo', from: '-1h' });
    assert.equal(web.totals.visitors, 1);
    assert.equal(web.totals.pageviews, 4);
    assert.equal(web.totals.sessions, 1);
    assert.equal(web.breakdowns.utm_source[0]!.value, 'e2e');

    const funnel = await api<{ steps: { count: number }[] }>('POST', '/api/query', {
      kind: 'funnel',
      project: 'demo',
      from: '-1h',
      steps: [
        { event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] },
        { event: 'plan_selected', filters: [{ property: 'plan', value: 'team' }] },
        { event: 'signup_completed' },
      ],
    });
    assert.deepEqual(
      funnel.steps.map((s) => s.count),
      [1, 1, 1],
    );

    const person = await api<{
      identified: boolean;
      properties: { plan: string };
      recentEvents: unknown[];
    }>('GET', '/api/persons/user-ada?project=demo');
    assert.equal(person.identified, true);
    assert.equal(person.properties.plan, 'team');
    assert.ok(person.recentEvents.length >= 6, 'events before signup are attributed to the person');

    const sql = await api<{ rows: { n: number }[] }>('POST', '/api/sql', {
      project: 'demo',
      query: "SELECT COUNT(*) AS n FROM events WHERE event = '$exposure'",
    });
    assert.ok(sql.rows[0]!.n >= 1, 'reading the flag recorded an exposure');
  });

  it('records the session and summarises it as text', async () => {
    const list = await eventually(
      () =>
        api<{ replays: { session: string; errors: number; clicks: number }[] }>(
          'GET',
          '/api/replays?project=demo',
        ),
      (r) => r.replays.length > 0 && r.replays[0]!.errors > 0,
      'replay with errors',
    );
    const session = list.replays[0]!.session;
    const recording = await eventually(
      () =>
        api<{ events: { type: number }[] }>('GET', `/api/replays/${session}/events?project=demo`),
      (r) => r.events.filter((e) => e.type === 4).length >= 4,
      'one recorded page per page load',
    );
    assert.ok(recording.events.length > 10);
    const summary = await eventually(
      () =>
        api<{
          transcript: string;
          stats: {
            clicks: number;
            errors: number;
            pages: number;
            failedRequests: number;
            consoleErrors: number;
          };
        }>('GET', `/api/replays/${session}/summary?project=demo`),
      (r) => r.stats.failedRequests > 0 && r.stats.consoleErrors > 0,
      'the failed billing request and its console error',
    );
    assert.match(summary.transcript, /Viewed \/pricing/);
    // Every click is labelled from the page it happened on, including the ones that navigate away,
    // and including the call to action the flag rewrites after load (rrweb records it as a mutation).
    const clicks = summary.transcript
      .split('\n')
      .map((l) => l.slice(6).replace(/ · .*$/, ''))
      .filter((l) => /^(Rage-)?[Cc]licked /.test(l));
    assert.match(clicks[0] ?? '', /^Clicked "(See pricing|Start your free trial)" \(link\)$/); // the new-cta flag picks the text
    assert.deepEqual(clicks.slice(1), [
      'Clicked "Choose Team" (button)',
      'Clicked "Create account" (button)',
      'Rage-clicked "Upgrade now" (button) ×3',
    ]);
    assert.match(
      summary.transcript,
      /Rage-clicked "Upgrade now" \(button\) ×3 · #pay \[.*an error followed\]/,
    );
    assert.match(summary.transcript, /ERROR TypeError/);
    assert.match(summary.transcript, /Request failed: POST http:\/\/[^ ]+\/api\/billing → 404/);
    assert.doesNotMatch(summary.transcript, /plan=pro/, 'query strings are not recorded');
    assert.match(summary.transcript, /Console error: Billing request failed: 404/);
    assert.match(summary.transcript, /Event signup_completed \(plan="team"\)/);

    const shot = await api<{ screen: string }>(
      'GET',
      `/api/replays/${session}/snapshot?project=demo&at=00:00`,
    );
    assert.match(shot.screen, /# Inkwell/);
    const found = await api<{ replays: { session: string }[] }>(
      'GET',
      '/api/replays?project=demo&has=rage_clicks,failed_requests&url=/app',
    );
    assert.deepEqual(
      found.replays.map((r) => r.session),
      [session],
    );
  });

  it('shows it in the dashboard', async () => {
    const page = await context.newPage();
    await page.goto(`${server.glassUrl}/app`);
    await page.fill('input[type=password]', 'dev-admin-key');
    await page.click('text=Open dashboard');
    await page.waitForSelector('.kpis');
    const visitors = await page.textContent('.kpi:first-child dd');
    assert.match(visitors ?? '', /^1/);
    await page.screenshot({ path: `${SHOTS}dashboard-web.png`, fullPage: true });

    await page.keyboard.press('s'); // Show SQL
    await page.waitForSelector('.sql-pane', { state: 'visible' });
    await page.screenshot({ path: `${SHOTS}dashboard-web-sql.png` });
    await page.keyboard.press('s');

    await page.goto(
      `${server.glassUrl}/app#/insights/funnel?project=demo&from=-1h&spec=${encodeURIComponent(JSON.stringify({ steps: [{ event: '$pageview' }, { event: 'plan_selected' }, { event: 'signup_completed' }], window: '1d' }))}`,
    );
    await page.waitForSelector('.funnel');
    await page.screenshot({ path: `${SHOTS}dashboard-funnel.png`, fullPage: true });

    await page.goto(`${server.glassUrl}/app#/replays?project=demo`);
    await page.click('table a.replay-link >> nth=0');
    await page.waitForSelector('.activity-item');
    await page.waitForSelector('.scrub-markers .marker.error');
    assert.match((await page.textContent('.activity-list')) ?? '', /Upgrade now/);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}dashboard-replay.png`, fullPage: true });

    await page.goto(`${server.glassUrl}/app#/flags?project=demo`);
    await page.waitForSelector('text=new-cta');
    await page.goto(`${server.glassUrl}/app#/events?project=demo`);
    await page.waitForSelector('text=signup_completed');
    await page.screenshot({ path: `${SHOTS}dashboard-events.png`, fullPage: true });
    await page.close();
  });

  it('signs in from a #key= link and wipes the key from the URL', async () => {
    const fresh = await browser.newContext({ userAgent: UA });
    const page = await fresh.newPage();
    await page.goto(`${server.glassUrl}/app#key=dev-admin-key`);
    await page.waitForSelector('.kpis');
    assert.doesNotMatch(page.url(), /dev-admin-key/);
    assert.equal(await page.evaluate(() => localStorage.getItem('glass:key')), 'dev-admin-key');
    await fresh.close();
  });

  it('opens and renews an Access dashboard deep link without storing or sending a key', async (t) => {
    const identity = { aud: 'observe', getIdentity: async () => ({ email: 'owner@example.test' }) };
    const observe = await startDevServer({
      port: 0,
      demoPort: 0,
      memory: true,
      access: () => identity,
    });
    t.after(() => observe.close());
    observe.env.GLASS_ACCESS_AUD = identity.aud;
    observe.env.GLASS_ACCESS_ADMIN_EMAIL_SHA256 = await sha256Hex('owner@example.test');
    const fresh = await browser.newContext({ userAgent: UA });
    t.after(() => fresh.close());
    const page = await fresh.newPage();
    const requests: { path: string; bearer?: string }[] = [];
    page.on('request', (req) =>
      requests.push({ path: new URL(req.url()).pathname, bearer: req.headers().authorization }),
    );
    const base = observe.glassUrl + '/_glass/app';
    await page.goto(base + '#/settings?from=-7d');
    const signOut = page.getByRole('link', { name: 'Sign out of Cloudflare Access' });
    await signOut.waitFor();
    assert.equal(await signOut.getAttribute('href'), '/cdn-cgi/access/logout');
    assert.match(page.url(), /#\/settings\?from=-7d&project=demo$/);
    assert.equal(await page.getByLabel('API key', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('glass:key')), null);
    await page.evaluate(() => localStorage.setItem('glass:key', 'old-installed-key'));
    await page.reload();
    await signOut.waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('glass:key')), null);
    await page.keyboard.press('/');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await page.keyboard.press('Escape');
    const created = await page.evaluate(async () => {
      const response = await fetch('/_glass/app/api/cohorts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'demo',
          key: 'qa',
          name: 'QA',
          static: true,
          ids: ['tester'],
        }),
      });
      return response.status;
    });
    assert.equal(created, 201);
    await page.goto(base + '#/users?project=demo&tab=cohorts');
    await page.getByRole('button', { name: 'People', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    assert.equal((await download).suggestedFilename(), 'cohort-qa.csv');
    await page.getByRole('button', { name: 'Done' }).click();
    // Access intercepts the next API fetch with a redirect to its login page.
    await page.route(
      '**/app/api/flags?**',
      (route) => route.fulfill({ status: 302, headers: { Location: '/cdn-cgi/access/login' } }),
      { times: 1 },
    );
    await page.goto(base + '#/flags?project=demo&from=-7d');
    await page.getByRole('button', { name: 'Sign in with Cloudflare Access' }).click();
    await page.locator('.shell.page-flags').waitFor();
    assert.match(page.url(), /#\/flags\?project=demo&from=-7d$/);
    assert.ok(requests.some((r) => r.path === '/_glass/app/api/projects'));
    assert.ok(requests.some((r) => r.path === '/_glass/app/api/cohorts/qa/members'));
    assert.ok(requests.every((r) => !r.bearer && !r.path.startsWith('/_glass/api')));
    await page.goto(base + '#key=obsolete-key');
    await page.waitForURL((url) => !url.hash.includes('obsolete-key'));
    assert.doesNotMatch(page.url(), /obsolete-key/);
    assert.equal(await page.evaluate(() => localStorage.getItem('glass:key')), null);
  });

  it('records a short visit to a page bigger than a beacon', async () => {
    // Most real pages' DOM snapshots are bigger than the 64 KB a page can send as it closes.
    const visitor = await browser.newContext({ userAgent: UA });
    const page = await visitor.newPage();
    await page.goto(`${server.demoUrl}/changelog`);
    await page.waitForTimeout(300);
    await page.goto('about:blank');
    await visitor.close();

    const list = await eventually(
      () =>
        api<{ replays: { session: string; url: string }[] }>('GET', '/api/replays?project=demo'),
      (r) => r.replays.some((x) => x.url.endsWith('/changelog')),
      'a replay of the changelog page',
    );
    const session = list.replays.find((x) => x.url.endsWith('/changelog'))!.session;
    const { events } = await api<{ events: { type: number }[] }>(
      'GET',
      `/api/replays/${session}/events?project=demo`,
    );
    const snapshot = events.find((e) => e.type === 2);
    assert.ok(
      snapshot && JSON.stringify(snapshot).length > 64_000,
      'the full snapshot, bigger than a beacon, was stored',
    );
  });
  it('records cookieless visits without storing anything', async () => {
    const visitor = await browser.newContext({ userAgent: UA });
    const page = await visitor.newPage();
    // The pricing page, with Dataflare loaded the way a site without consent loads it.
    await page.addInitScript(() => {
      new MutationObserver((_, observer) => {
        const tag = document.querySelector<HTMLScriptElement>('script[src$="/s.js"]');
        if (!tag) return;
        tag.dataset.persistence = 'cookieless';
        tag.dataset.replayCookieless = 'true';
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${server.demoUrl}/pricing`);
    await page.waitForTimeout(500);
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('glass')),
    );
    assert.deepEqual(stored, [], 'nothing is stored on the device');
    await page.goto('about:blank');
    await visitor.close();

    const list = await eventually(
      () =>
        api<{ replays: { session: string; url: string }[] }>('GET', '/api/replays?project=demo'),
      (r) => r.replays.some((x) => x.url.endsWith('/pricing') && x.session.startsWith('cs_')),
      'a cookieless replay of the pricing page',
    );
    const replay = list.replays.find((x) => x.session.startsWith('cs_'))!;
    const sql = await api<{ rows: { n: number }[] }>('POST', '/api/sql', {
      project: 'demo',
      query: `SELECT COUNT(*) AS n FROM events WHERE event = '$pageview' AND session_id = '${replay.session}'`,
    });
    assert.ok(sql.rows[0]!.n >= 1, "the replay joins the visit's events");
  });
  it('drills from fleet pageviews into one path and site while retaining the date range', async () => {
    await api('POST', '/api/projects', { id: 'quiet-site' });
    await api('POST', '/api/projects', { id: 'help-center' });
    const paths = [
      '/pricing',
      '/guides',
      '/releases',
      '/integrations',
      '/about',
      '/status',
      '/support',
      '/docs',
      '/roadmap',
      '/customers',
      '/features',
    ];
    for (const project of ['demo', 'help-center']) {
      const events = paths.flatMap((path, i) =>
        Array.from({ length: paths.length - i }, (_, j) =>
          wire('$pageview', {
            url: `https://example.test${path}`,
            distinct_id: `reader-${j}`,
            referrer: 'https://search.example/',
            ts: Date.now() - (1 + ((i + j) % 6)) * 86400000,
          }),
        ),
      );
      await api('POST', '/api/import', { project, events });
    }
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${server.glassUrl}/app#/sites?from=-7d`);
    await page.locator('.sites-table a', { hasText: 'quiet-site' }).waitFor();
    const total = await api<{ pageviews: number }>('GET', '/api/traffic?from=-7d');
    assert.equal(
      await page.locator('.traffic-total').innerText(),
      total.pageviews.toLocaleString(),
    );
    await page.screenshot({ path: SHOTS + 'dashboard-traffic.png', animations: 'disabled' });
    await page.getByRole('link', { name: 'Next', exact: true }).click();
    await page.locator('.traffic-ranking td').filter({ hasText: /^11$/ }).first().waitFor();
    await page.getByRole('link', { name: 'Previous', exact: true }).click();
    await page
      .locator('.traffic-ranking')
      .getByRole('link', { name: '/pricing', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Contributing sites' }).waitFor();
    await page.locator('.traffic-ranking').getByRole('link', { name: 'demo', exact: true }).click();
    await page.getByRole('heading', { name: 'Referrers' }).waitFor();
    const getParams = () => new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    assert.equal(getParams().get('from'), '-7d');
    assert.equal(getParams().get('path'), '/pricing');
    assert.equal(getParams().get('project'), 'demo');
    const sessions = page.getByRole('link', { name: 'Explore sessions' });
    assert.match((await sessions.getAttribute('href'))!, /reports\/segment/);
    await page.reload();
    await page.getByRole('heading', { name: 'Referrers' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('.topbar .project-switch').click();
    await page.getByRole('option', { name: 'quiet-site' }).click();
    await page.getByText('No referrer data in this period.').waitFor();
    assert.equal(await page.locator('.traffic-total').innerText(), '0');
    assert.equal(getParams().get('path'), '/pricing');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole('link', { name: 'Site dashboards' }).click();
    await page.getByText('Website overview', { exact: true }).first().waitFor();
    await page.locator('.dashboard-card').filter({ hasText: 'Website overview' }).click();
    await page.getByRole('heading', { name: 'Website overview' }).waitFor();
    await page.goBack();
    await page.getByRole('link', { name: 'Pageview rankings' }).click();
    await page.getByRole('heading', { name: 'Most viewed paths' }).waitFor();
    assert.equal(getParams().get('project'), 'quiet-site');
    await page.locator('.page-actions').getByRole('link', { name: 'All sites' }).click();
    await page.locator('.sites-table').waitFor();
    assert.equal(getParams().get('project'), null);
    await page.locator('.traffic-total').waitFor();
    await page.screenshot({ path: SHOTS + 'dashboard-traffic-mobile.png', animations: 'disabled' });
    await page.close();
  });
});
