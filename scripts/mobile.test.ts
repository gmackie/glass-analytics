import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectionFrom,
  fetchReport,
  fetchSites,
  pastedConnection,
  verifyConnection,
} from '../apps/expo/src/data.ts';
import { paneLayout, visiblePanes } from '../apps/expo/src/layout.ts';
import { TEST_ASSETS, wire } from '../packages/worker/test/harness.ts';
import { startDevServer } from '../packages/worker/test/server.ts';

test('the mobile read key lists sites and reads the selected period under a mounted Worker', async (t) => {
  const server = await startDevServer({ port: 0, demoPort: 0, memory: true, assets: TEST_ASSETS });
  t.after(() => server.close());
  const host = `${server.glassUrl}/_glass`;
  const cli = fileURLToPath(new URL('../packages/cli/src/index.ts', import.meta.url));
  const copied = execFileSync(process.execPath, [cli, 'key', '--read', '--json'], {
    env: { GLASS_HOST: host, GLASS_READ_KEY: 'dev-read-key' },
    encoding: 'utf8',
  });
  const connection = pastedConnection(copied);
  assert.deepEqual(connection, { url: host, key: 'dev-read-key' });
  assert.ok(connection);
  await verifyConnection(connection);
  const empty = await fetchReport(connection, 'demo', 7);
  assert.equal(empty.totals.visitors, 0);
  assert.deepEqual(empty.breakdowns.pages, []);
  const capture = await fetch(`${server.glassUrl}/e`, {
    method: 'POST',
    body: JSON.stringify({
      project: 'demo',
      events: [
        wire('$pageview', { url: 'https://example.org/pricing' }),
        wire('$pageview', {
          url: 'https://example.org/docs',
          distinct_id: 'older',
          ts: Date.now() - 12 * 86400000,
        }),
      ],
    }),
  });
  assert.ok(capture.ok);
  const rows = await fetchSites(connection, 7);
  assert.deepEqual(rows, [{ project: 'demo', visitors: 1, pageviews: 1 }]);
  const week = await fetchReport(connection, 'demo', 7);
  assert.equal(week.totals.visitors, 1);
  assert.deepEqual(week.breakdowns.pages, [{ value: '/pricing', count: 1 }]);
  assert.equal((await fetchReport(connection, 'demo', 30)).totals.visitors, 2);
  await assert.rejects(verifyConnection({ ...connection, key: 'wrong' }), /rejected the key/);
  await assert.rejects(
    verifyConnection({ ...connection, url: server.demoUrl }),
    /Dataflare API response|HTTP 404/,
  );
});

test('the connection form keeps the Worker mount and rejects unsafe or incomplete addresses', () => {
  assert.deepEqual(connectionFrom(' https://example.org/_glass/api/ ', ' abc '), {
    url: 'https://example.org/_glass',
    key: 'abc',
  });
  for (const url of [
    'example.org',
    'http://example.org',
    'https://user:pass@example.org',
    'https://example.org/?key=value',
  ])
    assert.throws(() => connectionFrom(url, 'key'));
  assert.throws(() => connectionFrom('https://example.org', ' '), /read key/);
  assert.equal(connectionFrom('http://127.0.0.1:8787', 'test').url, 'http://127.0.0.1:8787');
  assert.equal(
    connectionFrom('https://example.org/_glass/app/#/reports', 'key').url,
    'https://example.org/_glass',
  );
});

test('pasting connection details validates the host and key before replacing either field', () => {
  assert.equal(pastedConnection('plain-read-key'), null);
  assert.equal(pastedConnection(''), null);
  for (const invalid of ['{"host":', '{"host":"https://example.org"}', '{"key":123}']) {
    assert.throws(() => pastedConnection(invalid), /full output/);
  }
  assert.throws(() => pastedConnection('{"host":"http://example.org","key":"secret"}'), /HTTPS/);
  assert.throws(() => pastedConnection('{"host":"https://example.org","key":""}'), /read key/);
});

test('resizing fits one or two panes and moves content outside a partial fold in either direction', () => {
  assert.equal(paneLayout(466, 678, null), null);
  assert.deepEqual(paneLayout(951, 669, null), { axis: 'row', first: 310, gap: 1 });
  const vertical = { x: 455, y: 0, width: 41, height: 669 };
  assert.deepEqual(paneLayout(951, 669, vertical), { axis: 'row', first: 455, gap: 41 });
  assert.deepEqual(paneLayout(669, 951, { x: 0, y: 452, width: 669, height: 47 }), {
    axis: 'column',
    first: 452,
    gap: 47,
  });
  assert.equal(paneLayout(430, 670, vertical), null);
});

test('compact navigation remembers the selected pane across an expanded layout', () => {
  assert.equal(visiblePanes(false, 2, 'auto'), 'sites');
  assert.equal(visiblePanes(false, 1, 'auto'), 'report');
  assert.equal(visiblePanes(true, 2, 'report'), 'both');
  assert.equal(visiblePanes(false, 2, 'report'), 'report');
  assert.equal(visiblePanes(false, 1, 'sites'), 'sites');
  assert.equal(visiblePanes(true, 0, 'report'), 'sites');
});
