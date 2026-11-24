import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TrafficBreakdown } from '@dataflare/core/insights/traffic-breakdown';
import { DAY_MS } from '@dataflare/core/time';
import { runMaintenance } from '../src/cron.ts';
import { D1Store } from '../src/stores/d1.ts';
import { testApp, wire } from './harness.ts';

it('measures public pageviews at ingest and keeps filtered bots out of ordinary analytics', async () => {
  const t = testApp({ GLASS_RETENTION_DAYS: '30' });
  await t.json('POST', '/api/projects', {
    body: { id: 'acme', allowed_origins: ['https://acme.test'] },
  });
  await t.json('POST', '/api/projects', { body: { id: 'quiet' } });
  const ts = Date.now() - 5000;
  const event = wire('$pageview', {
    ts,
    id: 'opaque-view',
    url: 'https://acme.test/private',
    distinct_id: 'private-visitor',
  });
  const bot = { headers: { 'User-Agent': 'ExampleBot' } };
  const batch = [event, wire('$click'), { ...event, id: 5 }];
  const send = (project: string, headers: Record<string, string>) =>
    t.call('POST', '/e', { key: null, headers, body: { project, events: batch } });
  assert.equal(
    (await send('acme', { ...bot.headers, Origin: 'https://unlisted.test' })).status,
    403,
  );
  assert.equal((await send('unknown', bot.headers)).status, 404);
  assert.equal((await send('acme', bot.headers)).status, 204);
  assert.equal((await send('acme', bot.headers)).status, 204);
  assert.equal((await t.ingest([wire('$click')], bot)).status, 204);
  const receipts = t.db.sqlite.prepare('SELECT * FROM filtered_pageviews').all();
  assert.equal(receipts.length, 1);
  assert.deepEqual(Object.keys(receipts[0]!).sort(), ['event_hash', 'project', 'ts_ms']);
  assert.match(String(receipts[0]!.event_hash), /^[0-9a-f]{64}$/);
  assert.equal(receipts[0]!.ts_ms, ts);
  assert.equal(t.db.sqlite.prepare('SELECT * FROM events').all().length, 0);
  const spoofed = { $traffic_class: 'likely_human' };
  await t.ingest([wire('$pageview')]);
  await t.ingest([wire('$pageview', { props: spoofed })], { headers: { 'User-Agent': '' } });
  await t.ingest([wire('$pageview', { props: spoofed })], {
    headers: { 'User-Agent': 'custom-client' },
  });
  await t.json('POST', '/api/import', {
    body: { project: 'acme', events: [wire('$pageview', { props: spoofed })] },
  });
  const get = (q: string) => t.json<TrafficBreakdown>('GET', '/api/traffic/breakdown?' + q);
  const r = await get('from=-7d');
  assert.equal(r.visitors.knownBot, 1);
  assert.equal(r.visitors.likelyHuman, 1);
  assert.equal(r.visitors.unclassified, 3);
  assert.equal(
    r.hourly.reduce((a, n) => a + n, 0),
    4,
  );
  assert.equal(r.sessions.count, 1);
  const quiet = await get('project=quiet');
  assert.equal(quiet.visitors.knownBot, 0);
  assert.equal(quiet.sessions.averageSeconds, null);
  assert.equal((await get('from=-3d&to=-2d')).visitors.knownBot, null);
  assert.equal((await get(`from=${ts}&to=${ts + 1}`)).visitors.knownBot, 1);
  assert.equal((await get(`from=${ts - 1}&to=${ts}`)).visitors.knownBot, null);
  assert.equal((await t.call('GET', '/api/traffic/breakdown?project=unknown')).status, 404);
  assert.equal((await t.call('GET', '/api/traffic/breakdown', { key: null })).status, 401);
  await runMaintenance(t.env, new D1Store(t.db), Date.now() + 31 * DAY_MS);
  assert.equal(t.db.sqlite.prepare('SELECT * FROM filtered_pageviews').all().length, 0);
});
