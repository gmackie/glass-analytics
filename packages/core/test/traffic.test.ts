import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runTraffic } from '../src/insights/traffic.ts';
import { context, createDb, insert, NOW } from './helpers.ts';

it('ranks all pageviews before paging and drills from shared paths to sites to referrers', async () => {
  const db = createDb();
  const path = "/#/person's/:id";
  insert(db, [
    ...['a', 'b'].flatMap((project) =>
      [1, 2, 3].map(() => ({ project, path, distinct_id: 'repeat' })),
    ),
    ...[1, 2, 3, 4].map((i) => ({ project: 'a', path: '/docs', distinct_id: String(i) })),
    { project: 'a', path, referrer_host: 'search.test' },
    { project: 'a', path: '', distinct_id: 'unknown' },
    { project: 'a', path: '/early', ts_ms: NOW - 7 * 86400000 },
    { project: 'a', path: '/excluded', ts_ms: NOW },
    { project: 'a', path, daysAgo: 8 },
    { project: 'a', path, event: 'click' },
    { project: 'other', path },
  ]);
  const ctx = context(db);
  const spec = { from: '-7d', limit: 1, offset: 0 };
  const fleet = await runTraffic(spec, ['a', 'b', 'quiet'], ctx);
  assert.equal(fleet.pageviews, 13);
  assert.equal(
    fleet.series.reduce((a, n) => a + n, 0),
    13,
  );
  assert.ok(fleet.series.includes(0));
  assert.deepEqual(fleet.ranking, [{ value: path, pageviews: 7 }]);
  assert.equal(fleet.hasMore, true);
  const next = await runTraffic({ ...spec, offset: 1 }, ['a', 'b'], ctx);
  assert.deepEqual(next.ranking, [{ value: '/docs', pageviews: 4 }]);
  assert.equal(next.pageviews, 13);
  const detail = await runTraffic({ ...spec, path, limit: 10 }, ['a', 'b', 'quiet'], ctx);
  assert.deepEqual(detail.ranking, [
    { value: 'a', pageviews: 4 },
    { value: 'b', pageviews: 3 },
  ]);
  assert.equal(detail.dimension, 'project');
  assert.equal(detail.pageviews, 7);
  assert.equal(detail.hasMore, false);
  const site = await runTraffic({ ...spec, limit: 10 }, 'a', ctx);
  assert.deepEqual(
    site.ranking.map((r) => r.value),
    [path, '/docs', '/early'],
  );
  const refs = await runTraffic({ ...spec, path, limit: 10 }, 'a', ctx);
  assert.equal(refs.pageviews, 4);
  assert.equal(refs.dimension, 'referrer_host');
  assert.deepEqual(refs.ranking, [
    { value: '', pageviews: 3 },
    { value: 'search.test', pageviews: 1 },
  ]);
  const missing = await runTraffic({ ...spec, path: '/missing' }, 'a', ctx);
  assert.equal(missing.pageviews, 0);
  assert.deepEqual(missing.ranking, []);
  const before = ctx.queries.length;
  const empty = await runTraffic(spec, [], ctx);
  assert.equal(ctx.queries.length, before);
  assert.ok(empty.series.every((n) => n === 0));
});
