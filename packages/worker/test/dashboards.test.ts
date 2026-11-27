/**
 * Dashboards, scheduled reports and alerts end to end: a dashboard from a template, tiles and
 * filters, a report to Slack with signed chart images, an emailed report with inline charts
 * and an unsubscribe link, the cron sending what's due, and alerts firing and resolving.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { runMaintenance } from '../src/cron.ts';
import { ensureStarterDashboards } from '../src/dashboards.ts';
import { clearDestinationCache, configureDeliveries } from '../src/destinations.ts';
import type { EmailSender } from '../src/env.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

const DAY = 86_400_000;
let t: TestApp;
let posted: { url: string; body: string }[] = [];
let mails: Parameters<EmailSender['send']>[0][] = [];

const fakeEmail: EmailSender = {
  async send(m) {
    mails.push(m);
    return { messageId: `m-${mails.length}` };
  },
};

async function setup(env: Parameters<typeof testApp>[0] = {}) {
  clearGroupTypeCache();
  clearDestinationCache();
  posted = [];
  mails = [];
  configureDeliveries({
    fetch: async (input, init) => {
      posted.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('ok');
    },
  });
  t = testApp(env);
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
  const now = Date.now();
  const events = [];
  for (let d = 1; d <= 6; d++)
    for (let p = 0; p < d; p++)
      events.push(
        wire('$pageview', {
          distinct_id: `u${p}`,
          session_id: `s${d}-${p}`,
          ts: now - d * DAY,
          url: 'https://acme.com/',
        }),
        ...(p === 0
          ? [
              wire('signup_completed', {
                distinct_id: `u${p}`,
                session_id: `s${d}-${p}`,
                ts: now - d * DAY + 1000,
              }),
            ]
          : []),
        ...(p === 1
          ? [
              wire('order_paid', {
                distinct_id: `u${p}`,
                session_id: `s${d}-${p}`,
                ts: now - d * DAY + 2000,
              }),
            ]
          : []),
      );
  await t.ingest(events);
}

const slack = async () =>
  (
    await t.json<{ destination: { id: string } }>('POST', '/api/destinations', {
      body: {
        project: 'acme',
        template: 'slack',
        events: ['dataflare_test'],
        inputs: { url: 'https://hooks.slack.com/x' },
      },
    })
  ).destination.id;

type Tile = {
  id: string;
  kind: string;
  width: number;
  runSpec?: Record<string, unknown>;
  insight?: { key: string } | null;
};

describe('dashboards', () => {
  beforeEach(() => setup());

  it('initializes existing and new projects once and keeps edited or deleted boards as the owner left them', async () => {
    const list = async (project: string) =>
      (
        await t.json<{ dashboards: { id: string; name: string; tiles: number }[] }>(
          'GET',
          `/api/dashboards?project=${project}`,
          { key: READ },
        )
      ).dashboards;
    const original = await list('acme');
    assert.deepEqual(
      original.map((d) => [d.name, d.tiles]),
      [
        ['Acquisition', 3],
        ['Engagement', 4],
        ['Website overview', 5],
      ],
    );
    const [acquisition, engagement, website] = original;
    await t.json('PUT', `/api/dashboards/${acquisition!.id}`, {
      body: { project: 'acme', name: 'Our sources' },
    });
    await t.json('DELETE', `/api/dashboards/${engagement!.id}?project=acme`);
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    assert.deepEqual(
      (await list('acme')).map((d) => [d.id, d.name, d.tiles]),
      [
        [acquisition!.id, 'Our sources', 3],
        [website!.id, 'Website overview', 5],
      ],
    );

    // An install upgraded with existing projects may have boards and customized analyses already.
    t.db.sqlite.exec("INSERT INTO projects (id,name,created_at) VALUES ('legacy','Legacy',1)");
    const custom = await t.json<{ id: string }>('POST', '/api/dashboards', {
      body: { project: 'legacy', name: 'Executive metrics' },
    });
    const [a, b] = await Promise.all([list('legacy'), list('legacy')]);
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.map((d) => [d.name, d.tiles]),
      [
        ['Acquisition', 3],
        ['Engagement', 4],
        ['Executive metrics', 0],
        ['Website overview', 5],
      ],
    );
    assert.equal(a[2]!.id, custom.id);
    const detail = await t.json<{ tiles: Tile[] }>(
      'GET',
      `/api/dashboards/${a[0]!.id}?project=legacy`,
      { key: READ },
    );
    assert.ok(detail.tiles.every((tile) => tile.insight?.key));
  });

  it('runs the starter analyses as a reader and keeps a deleted analysis out of the board', async () => {
    const { dashboards } = await t.json<{ dashboards: { id: string; name: string }[] }>(
      'GET',
      '/api/dashboards?project=acme',
    );
    const board = '/api/dashboards/' + dashboards.find((d) => d.name === 'Website overview')!.id;
    const read = () =>
      t.json<{ tiles: Tile[]; results: { title: string; note?: string }[] }>(
        'GET',
        board + '?project=acme&results=true',
        { key: READ },
      );
    const ready = await read();
    assert.equal(ready.results.length, 5);
    assert.ok(ready.results.some((r) => r.title === 'Pageviews'));
    const key = ready.tiles[0]!.insight!.key;
    await t.json('DELETE', '/api/insights/' + key + '?project=acme');
    const edited = await read();
    assert.equal(edited.tiles[0]!.insight, null);
    const missing = await t.call('POST', board + '/tiles', {
      body: { project: 'acme', kind: 'insight', insightKey: key },
    });
    assert.equal(missing.status, 404);
  });

  it('adopts pre-upgrade starter boards and retries an interrupted setup without partial tiles', async () => {
    const db = t.db.sqlite;
    db.exec("INSERT INTO projects (id,name,created_at) VALUES ('old','Old',1),('retry','Retry',1)");
    const old = await t.json<{ id: string }>('POST', '/api/dashboards/from-template', {
      body: { project: 'old', template: 'website' },
    });
    db.exec(
      readFileSync(new URL('../migrations/0020_dashboard_setup.sql', import.meta.url), 'utf8'),
    );
    const existing = await t.json<{ id: string }>('POST', '/api/dashboards', {
      body: { project: 'old', name: 'Acquisition' },
    });
    db.exec(
      readFileSync(
        new URL('../migrations/0022_dashboard_template_setup.sql', import.meta.url),
        'utf8',
      ),
    );
    await ensureStarterDashboards(t.db, 'old');
    assert.deepEqual(
      db
        .prepare(
          "SELECT id FROM dashboards WHERE project='old' AND name IN ('Website overview','Acquisition') ORDER BY name",
        )
        .all()
        .map((r) => r.id),
      [existing.id, old.id],
    );

    db.exec(
      `CREATE TRIGGER fail_tile BEFORE INSERT ON dashboard_tiles
       WHEN NEW.project = 'retry' AND NEW.position = 1 AND NEW.dashboard IN
         (SELECT id FROM dashboards WHERE project = NEW.project AND name = 'Acquisition')
       BEGIN SELECT RAISE(ABORT, 'tile failed'); END`,
    );
    await assert.rejects(ensureStarterDashboards(t.db, 'retry'), /tile failed/);
    for (const [table, size] of [
      ['dashboards', 1],
      ['insights', 5],
      ['dashboard_tiles', 5],
      ['dashboard_setup', 1],
      ['dashboard_template_setup', 0],
    ]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project = 'retry'`).get()!.n,
        size,
      );
    }
    db.exec('DROP TRIGGER fail_tile');
    await ensureStarterDashboards(t.db, 'retry');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM dashboard_tiles WHERE project='retry'").get()!.n,
      12,
    );
  });

  it('starts from a template with the project’s own events', async () => {
    const templates = await t.json<{ events: { signup?: string; purchase?: string } }>(
      'GET',
      '/api/dashboards/templates?project=acme',
    );
    assert.deepEqual(templates.events, { signup: 'signup_completed', purchase: 'order_paid' });
    const made = await t.json<{ id: string }>('POST', '/api/dashboards/from-template', {
      body: { project: 'acme', template: 'product' },
    });
    const d = await t.json<{ name: string; tiles: Tile[] }>(
      'GET',
      `/api/dashboards/${made.id}?project=acme`,
    );
    assert.equal(d.name, 'Product health');
    assert.equal(d.tiles.length, 5);
    assert.ok(d.tiles.every((x) => x.insight?.key));
    // The analyses were saved, each under its own key.
    const insights = await t.json<{ insights: { key: string }[] }>(
      'GET',
      '/api/insights?project=acme',
    );
    for (const tile of d.tiles)
      assert.ok(insights.insights.some((i) => i.key === tile.insight!.key));
    // A second copy doesn't overwrite the first one's analyses.
    const again = await t.json<{ id: string }>('POST', '/api/dashboards/from-template', {
      body: { project: 'acme', template: 'product' },
    });
    const d2 = await t.json<{ tiles: Tile[] }>('GET', `/api/dashboards/${again.id}?project=acme`);
    assert.notEqual(d2.tiles[0]!.insight!.key, d.tiles[0]!.insight!.key);
    const revenue = await t.call('POST', '/api/dashboards/from-template', {
      body: { project: 'acme', template: 'revenue', events: { purchase: '' } },
    });
    assert.equal(revenue.status, 201);
  });

  it('adds, resizes, reorders and removes tiles; filters apply unless a tile ignores them', async () => {
    const { id } = await t.json<{ id: string }>('POST', '/api/dashboards', {
      body: { project: 'acme', name: 'Mine' },
    });
    const a = await t.json<{ tile: Tile }>('POST', `/api/dashboards/${id}/tiles`, {
      body: {
        project: 'acme',
        insight: { name: 'Visits', kind: 'trends', spec: { series: [{ event: '$pageview' }] } },
      },
    });
    const b = await t.json<{ tile: Tile }>('POST', `/api/dashboards/${id}/tiles`, {
      body: { project: 'acme', text: '## Notes', width: 12 },
    });
    await t.json('PUT', `/api/dashboards/${id}/tiles/${a.tile.id}`, {
      body: { project: 'acme', width: 12, height: 2, ignoreFilters: true },
    });
    await t.json('PUT', `/api/dashboards/${id}/order`, {
      body: { project: 'acme', tiles: [b.tile.id, a.tile.id] },
    });
    await t.json('PUT', `/api/dashboards/${id}`, {
      body: {
        project: 'acme',
        name: 'Mine',
        filters: { from: '-3d', filters: [{ property: 'browser', value: 'Chrome' }] },
      },
    });
    let d = await t.json<{ tiles: Tile[]; filters: { from: string } }>(
      'GET',
      `/api/dashboards/${id}?project=acme`,
    );
    assert.deepEqual(
      d.tiles.map((x) => x.kind),
      ['text', 'insight'],
    );
    assert.equal(d.tiles[1]!.width, 12);
    // Ignores the dashboard filters: runs as saved.
    assert.equal(d.tiles[1]!.runSpec!.from, undefined);
    await t.json('PUT', `/api/dashboards/${id}/tiles/${a.tile.id}`, {
      body: { project: 'acme', ignoreFilters: false },
    });
    d = await t.json('GET', `/api/dashboards/${id}?project=acme`);
    assert.equal(d.tiles[1]!.runSpec!.from, '-3d');
    assert.deepEqual(d.tiles[1]!.runSpec!.filters, [{ property: 'browser', value: 'Chrome' }]);
    const results = await t.json<{ results: { title: string; value: string }[] }>(
      'GET',
      `/api/dashboards/${id}?project=acme&results=true`,
    );
    assert.equal(results.results[0]!.title, 'Visits');
    await t.json('DELETE', `/api/dashboards/${id}/tiles/${b.tile.id}?project=acme`);
    const copy = await t.json<{ id: string }>('POST', `/api/dashboards/${id}/duplicate`, {
      body: { project: 'acme', name: 'Copy' },
    });
    assert.equal(
      (await t.json<{ tiles: Tile[] }>('GET', `/api/dashboards/${copy.id}?project=acme`)).tiles
        .length,
      1,
    );
    // The read key reads but doesn't change.
    assert.equal((await t.call('GET', `/api/dashboards?project=acme`, { key: READ })).status, 200);
    assert.equal(
      (await t.call('POST', '/api/dashboards', { key: READ, body: { project: 'acme', name: 'x' } }))
        .status,
      403,
    );
    await t.json('DELETE', `/api/dashboards/${id}?project=acme`);
    assert.equal((await t.call('GET', `/api/dashboards/${id}?project=acme`)).status, 404);
    // Its analysis is still there.
    assert.equal(
      (await t.call('GET', `/api/insights/${a.tile.insight?.key ?? 'visits'}?project=acme`)).status,
      200,
    );
  });
});

describe('scheduled reports', () => {
  it('sends a dashboard to Slack with signed chart images, and the cron sends what is due', async () => {
    await setup();
    const dest = await slack();
    const { id: board } = await t.json<{ id: string }>('POST', '/api/dashboards/from-template', {
      body: { project: 'acme', template: 'product' },
    });
    const sub = await t.json<{ id: string; nextRun: string; when: string }>(
      'POST',
      '/api/subscriptions',
      {
        body: {
          project: 'acme',
          target: 'dashboard',
          targetId: board,
          channels: { destinations: [dest] },
          schedule: { frequency: 'weekly', weekday: 'mon', time: '09:00' },
          message: 'Morning!',
        },
      },
    );
    assert.equal(sub.when, 'Every Monday at 09:00');
    assert.equal(new Date(sub.nextRun).getUTCDay(), 1);
    const sent = await t.json<{ status: string }>('POST', `/api/subscriptions/${sub.id}/send`, {
      body: { project: 'acme' },
    });
    assert.equal(sent.status, 'sent');
    const message = JSON.parse(posted.at(-1)!.body) as {
      blocks: { type: string; image_url?: string; text?: { text: string } }[];
    };
    assert.equal(message.blocks[0]!.type, 'header');
    assert.match(message.blocks[1]!.text!.text, /Morning! · Every Monday at 09:00/);
    const images = message.blocks.filter((b) => b.type === 'image').map((b) => b.image_url!);
    assert.ok(images.length >= 3, `${images.length} images`);
    // The image link works, and only as signed.
    const path = new URL(images[0]!).pathname + new URL(images[0]!).search;
    const png = await t.call('GET', path, { key: null });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('Content-Type'), 'image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    assert.deepEqual([...bytes.subarray(1, 4)], [80, 78, 71]);
    assert.equal(
      (await t.call('GET', path.replace(/s=[^&]+/, 's=forged'), { key: null })).status,
      403,
    );

    // Due now: the cron starts it and sends it.
    await t.db
      .prepare('UPDATE subscriptions SET next_run_at = ?')
      .bind(Date.now() - 1000)
      .run();
    const before = posted.length;
    const store = new D1Store(t.env.DB);
    const result = await runMaintenance(t.env, store, Date.now(), { hourly: false });
    assert.ok(Number(result.tasks.reports) > 0, JSON.stringify(result.tasks));
    assert.equal(posted.length, before + 1);
    const list = await t.json<{ subscriptions: { lastStatus: string; nextRun: string }[] }>(
      'GET',
      `/api/subscriptions?project=acme&dashboard=${board}`,
    );
    assert.equal(list.subscriptions[0]!.lastStatus, 'sent');
    assert.ok(Date.parse(list.subscriptions[0]!.nextRun) > Date.now());
  });

  it('emails reports with inline charts, and an address can unsubscribe', async () => {
    await setup({ EMAIL: fakeEmail, GLASS_EMAIL_FROM: 'reports@acme.com' });
    const caps = await t.json<{ email: boolean; emailFrom: string }>(
      'GET',
      '/api/capabilities?project=acme',
    );
    assert.deepEqual([caps.email, caps.emailFrom], [true, 'reports@acme.com']);
    await t.json('POST', '/api/insights', {
      body: {
        project: 'acme',
        name: 'Visits',
        kind: 'trends',
        spec: { series: [{ event: '$pageview' }] },
      },
    });
    const sub = await t.json<{ id: string }>('POST', '/api/subscriptions', {
      body: {
        project: 'acme',
        target: 'insight',
        targetId: 'visits',
        channels: { emails: ['ann@acme.com', 'bob@acme.com'] },
        schedule: { frequency: 'daily' },
      },
    });
    await t.json('POST', `/api/subscriptions/${sub.id}/send`, { body: { project: 'acme' } });
    assert.equal(mails.length, 2);
    const mail = mails[0]!;
    assert.equal(mail.from, 'reports@acme.com');
    assert.deepEqual(mail.to, ['ann@acme.com']);
    assert.match(mail.html!, /cid:chart-0@dataflare/);
    assert.equal(mail.attachments![0]!.disposition, 'inline');
    const link = /Unsubscribe: (\S+)/.exec(mail.text!)![1]!;
    const page = await t.call('GET', new URL(link).pathname + new URL(link).search, { key: null });
    assert.match(await page.text(), /ann@acme.com won/);
    const after = await t.json<{
      subscriptions: { channels: { emails: string[] }; enabled: boolean }[];
    }>('GET', '/api/subscriptions?project=acme');
    assert.deepEqual(after.subscriptions[0]!.channels.emails, ['bob@acme.com']);
    assert.equal(
      (await t.call('GET', `${new URL(link).pathname}?email=bob%40acme.com&s=x`, { key: null }))
        .status,
      403,
    );
  });

  it('refuses email when it is not set up, and reports that fail say why', async () => {
    await setup();
    await t.json('POST', '/api/insights', {
      body: {
        project: 'acme',
        name: 'Visits',
        kind: 'trends',
        spec: { series: [{ event: '$pageview' }] },
      },
    });
    const res = await t.call('POST', '/api/subscriptions', {
      body: {
        project: 'acme',
        target: 'insight',
        targetId: 'visits',
        channels: { emails: ['a@acme.com'] },
        schedule: { frequency: 'daily' },
      },
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /dataflare email enable/);
    const missing = await t.call('POST', '/api/subscriptions', {
      body: {
        project: 'acme',
        target: 'dashboard',
        targetId: 'nope',
        channels: { destinations: ['x'] },
        schedule: { frequency: 'daily' },
      },
    });
    assert.equal(missing.status, 404);
    const sub = await t.json<{ id: string }>('POST', '/api/subscriptions', {
      body: {
        project: 'acme',
        target: 'insight',
        targetId: 'visits',
        channels: { destinations: ['gone'] },
        schedule: { frequency: 'daily' },
      },
    });
    const sent = await t.json<{ status: string; error: string }>(
      'POST',
      `/api/subscriptions/${sub.id}/send`,
      { body: { project: 'acme' } },
    );
    assert.equal(sent.status, 'failed');
    assert.match(sent.error, /gone/);
  });
});

describe('alerts', () => {
  beforeEach(() => setup());

  it('fires once when the line is crossed, resolves, and keeps a history', async () => {
    const dest = await slack();
    await t.json('POST', '/api/insights', {
      body: {
        project: 'acme',
        name: 'Daily visits',
        kind: 'trends',
        spec: { series: [{ event: '$pageview' }], interval: 'day', from: '-7d' },
      },
    });
    const alert = await t.json<{ id: string }>('POST', '/api/alerts', {
      body: {
        project: 'acme',
        name: 'Busy day',
        insightKey: 'daily-visits',
        condition: { type: 'value', above: 0 },
        schedule: { frequency: 'hourly' },
        channels: { destinations: [dest] },
      },
    });
    const first = await t.json<{ state: string; notified: string | null }>(
      'POST',
      `/api/alerts/${alert.id}/check`,
      { body: { project: 'acme' } },
    );
    assert.deepEqual([first.state, first.notified], ['firing', 'firing']);
    assert.match(JSON.parse(posted.at(-1)!.body).blocks[0].text.text, /Busy day/);
    const second = await t.json<{ notified: string | null }>(
      'POST',
      `/api/alerts/${alert.id}/check`,
      { body: { project: 'acme' } },
    );
    assert.equal(second.notified, null);
    await t.json('PUT', `/api/alerts/${alert.id}`, {
      body: {
        project: 'acme',
        name: 'Busy day',
        insightKey: 'daily-visits',
        condition: { type: 'value', above: 1_000_000 },
        schedule: { frequency: 'hourly' },
        channels: { destinations: [dest] },
      },
    });
    const third = await t.json<{ state: string; notified: string | null }>(
      'POST',
      `/api/alerts/${alert.id}/check`,
      { body: { project: 'acme' } },
    );
    assert.deepEqual([third.state, third.notified], ['ok', 'resolved']);
    assert.match(JSON.parse(posted.at(-1)!.body).blocks[0].text.text, /Resolved/);
    const got = await t.json<{ history: { fired: boolean }[] }>(
      'GET',
      `/api/alerts/${alert.id}?project=acme`,
    );
    assert.deepEqual(
      got.history.map((h) => h.fired),
      [true, true, false],
    );
  });

  it('only watches trends and funnels, disables itself when the analysis goes, and skips quiet hours', async () => {
    const dest = await slack();
    await t.json('POST', '/api/insights', {
      body: { project: 'acme', name: 'Ways', kind: 'paths', spec: { steps: 3 } },
    });
    const paths = await t.call('POST', '/api/alerts', {
      body: {
        project: 'acme',
        name: 'x',
        insightKey: 'ways',
        condition: { type: 'value', above: 1 },
        schedule: { frequency: 'hourly' },
        channels: { destinations: [dest] },
      },
    });
    assert.equal(paths.status, 400);
    await t.json('POST', '/api/insights', {
      body: {
        project: 'acme',
        name: 'Visits',
        kind: 'trends',
        spec: { series: [{ event: '$pageview' }] },
      },
    });
    const quiet = await t.json<{ id: string }>('POST', '/api/alerts', {
      body: {
        project: 'acme',
        name: 'Quiet',
        insightKey: 'visits',
        condition: { type: 'value', above: 0 },
        schedule: { frequency: 'hourly' },
        quiet: [{ from: '00:00', to: '23:59' }],
        channels: { destinations: [dest] },
      },
    });
    await t.db
      .prepare('UPDATE alerts SET next_check_at = ?')
      .bind(Date.now() - 1000)
      .run();
    const result = await runMaintenance(t.env, new D1Store(t.env.DB), Date.now(), {
      hourly: false,
    });
    assert.equal(result.tasks.alerts, 0);
    await t.json('DELETE', '/api/insights/visits?project=acme');
    const gone = await t.json<{ state: string }>('POST', `/api/alerts/${quiet.id}/check`, {
      body: { project: 'acme' },
    });
    assert.equal(gone.state, 'disabled');
    const list = await t.json<{ alerts: { enabled: boolean }[] }>(
      'GET',
      '/api/alerts?project=acme',
    );
    assert.equal(list.alerts[0]!.enabled, false);
  });
});
