import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectionFrom,
  fetchPaths,
  fetchReport,
  fetchSites,
  pastedConnection,
  pathsSchema,
  verifyConnection,
} from '../apps/expo/src/data.ts';
import { paneLayout, visiblePanes } from '../apps/expo/src/layout.ts';
import { dashboardPalette } from '../apps/expo/src/palette.ts';
import { sankeyLayout, touchHeight } from '../apps/expo/src/sankey.ts';
import { TEST_ASSETS, wire } from '../packages/worker/test/harness.ts';
import { startDevServer } from '../packages/worker/test/server.ts';

test('the native light and dark colors match the dashboard tokens', () => {
  const css = readFileSync(
    new URL('../packages/dashboard/src/styles.css', import.meta.url),
    'utf8',
  );
  const tokens = new Map(
    Array.from(
      css.matchAll(/--([\w-]+):\s*light-dark\(\s*(#[\da-f]+),\s*(#[\da-f]+)\s*\)/gi),
      ([, name, light, dark]) => [name, { light, dark }] as const,
    ),
  );
  for (const [name, pair] of Object.entries(dashboardPalette)) {
    const token = name.replace(/[A-Z0-9]/g, (part) => `-${part.toLowerCase()}`);
    assert.deepEqual(pair, tokens.get(token), `--${token}`);
  }
});

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
  assert.deepEqual(week.breakdowns.pages, [{ value: '/pricing', visitors: 1, count: 1 }]);
  assert.equal((await fetchReport(connection, 'demo', 30)).totals.visitors, 2);
  await assert.rejects(verifyConnection({ ...connection, key: 'wrong' }), /rejected the key/);
  await assert.rejects(
    verifyConnection({ ...connection, url: server.demoUrl }),
    /Dataflare API response|HTTP 404/,
  );
});

test('mobile paths use the selected site and range, count drop-offs, and can include events', async (t) => {
  const server = await startDevServer({ port: 0, demoPort: 0, memory: true, assets: TEST_ASSETS });
  t.after(() => server.close());
  const connection = { url: server.glassUrl, key: 'dev-read-key' };
  const empty = await fetchPaths(connection, 'demo', 7, false);
  assert.deepEqual([empty.total, empty.nodes, empty.links, empty.topPaths], [0, [], [], []]);
  const now = Date.now();
  function visit(who: string, offset: number, path: string, event = '$pageview') {
    return wire(event, {
      distinct_id: who,
      session_id: who,
      ts: now - 60_000 + offset,
      url: 'https://example.org' + path,
    });
  }
  const capture = await fetch(server.glassUrl + '/e', {
    method: 'POST',
    body: JSON.stringify({
      project: 'demo',
      events: [
        visit('alice', 0, '/'),
        visit('alice', 10_000, '/pricing'),
        visit('alice', 20_000, '/pricing', 'signup'),
        visit('bob', 0, '/'),
        visit('bob', 10_000, '/pricing'),
        visit('chris', 0, '/'),
        visit('earlier', -20 * 86_400_000, '/older'),
      ],
    }),
  });
  assert.ok(capture.ok);
  const created = await fetch(server.glassUrl + '/api/projects', {
    method: 'POST',
    headers: { Authorization: 'Bearer dev-admin-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'other', name: 'Other site' }),
  });
  assert.equal(created.status, 201);
  assert.ok(
    (
      await fetch(server.glassUrl + '/e', {
        method: 'POST',
        body: JSON.stringify({
          project: 'other',
          events: [visit('visitor', 0, '/private-to-other')],
        }),
      })
    ).ok,
  );
  const other = await fetchPaths(connection, 'other', 7, false);
  assert.deepEqual(other.topPaths, [{ items: ['/private-to-other'], count: 1 }]);
  const pages = await fetchPaths(connection, 'demo', 7, false);
  assert.equal(pages.total, 3);
  assert.deepEqual(pages.links, [
    { source: '1:/', target: '2:/pricing', count: 2, avgSeconds: 10 },
  ]);
  assert.equal(pages.nodes.find((node) => node.id === '1:/')?.dropOff, 1);
  assert.deepEqual(pages.topPaths[0], { items: ['/', '/pricing'], count: 2 });
  const withEvents = await fetchPaths(connection, 'demo', 7, true);
  assert.equal(withEvents.nodes.find((node) => node.id === '3:signup')?.count, 1);
  assert.equal((await fetchPaths(connection, 'demo', 30, false)).total, 4);
  await assert.rejects(
    fetchPaths({ ...connection, key: 'unrelated' }, 'demo', 7, false),
    /rejected the key/,
  );
  const report = await fetchReport(connection, 'demo', 7);
  assert.equal(report.totals.pageviews, 5);
  assert.equal(
    report.timeseries.pageviews?.reduce((sum, n) => sum + n, 0),
    5,
  );
  assert.equal(report.totals.viewsPerSession, 5 / 3);
  assert.ok(report.breakdowns.entry_pages?.some((row) => row.value === '/'));
});

test('Sankey bands share a scale, stay within their steps and leave room for touch labels at both Duo widths', () => {
  const file = new URL('../apps/expo/assets/demo-paths.json', import.meta.url);
  const samples = JSON.parse(readFileSync(file, 'utf8'));
  for (const days of [7, 30, 90]) {
    const pages = pathsSchema.parse(samples[days].pages);
    const events = pathsSchema.parse(samples[days].events);
    assert.ok(pages.total > 0 && pages.links.length && pages.topPaths.length);
    assert.ok(events.nodes.some((n) => !n.other && !n.label.startsWith('/')));
    for (const viewport of [320, 820]) {
      const flow = sankeyLayout(pages, viewport);
      assert.ok(flow.width >= viewport);
      assert.equal(flow.bands.length, pages.links.length);
      for (const band of flow.bands) assert.equal(band.width, band.link.count * flow.scale);
      for (const box of flow.nodes) {
        assert.ok(box.outgoing <= box.y + box.height + 1e-7);
        assert.ok(box.incoming <= box.y + box.height + 1e-7);
        assert.ok(box.labelY >= 0 && box.labelY + touchHeight <= flow.height);
        const i = flow.nodes.indexOf(box);
        const next = flow.nodes[i + 1];
        if (next?.node.column === box.node.column)
          assert.ok(next.labelY >= box.labelY + touchHeight);
      }
    }
  }
  assert.ok(samples[90].pages.total > samples[7].pages.total);
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
