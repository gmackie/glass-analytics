import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runTrafficBreakdown } from '../src/insights/traffic-breakdown.ts';
import { HOUR_MS } from '../src/time.ts';
import { context, createDb, insert } from './helpers.ts';

it('counts pageviews by wall-clock hour across DST and weights the fleet mean by visits', async () => {
  const db = createDb();
  // 01:00 occurs twice in New York on this date.
  const start = Date.parse('2026-11-01T05:00:00Z');
  const range = { from: start, to: start + 3 * HOUR_MS };
  const filtered = { startedMs: start - 10000, count: 2 };
  const base = {
    ts_ms: start,
    received_ms: start,
    session_id: 'shared',
    props: { $traffic_class: 'likely_human' },
  };
  insert(db, [
    { ...base, project: 'a', device: 'mobile' },
    { ...base, project: 'a', event: '$pageleave', ts_ms: start + 30000 },
    {
      ...base,
      project: 'a',
      session_id: 'single',
      ts_ms: start + HOUR_MS,
      device: 'watch',
      props: {},
    },
    { ...base, project: 'b', ts_ms: start + HOUR_MS, device: 'tablet' },
    { ...base, project: 'b', event: '$pageleave', ts_ms: start + HOUR_MS + 300000 },
    {
      ...base,
      project: 'b',
      session_id: 'short',
      ts_ms: start + 2 * HOUR_MS,
      received_ms: start - 20000,
    },
    {
      ...base,
      project: 'b',
      session_id: 'short',
      event: '$pageleave',
      ts_ms: start + 2 * HOUR_MS + 60000,
    },
    { ...base, project: 'a', session_id: 'leave-only', event: '$pageleave' },
    { ...base, project: 'a', session_id: 'single', event: 'click', ts_ms: start + 2 * HOUR_MS },
    { ...base, project: 'a', session_id: 'single', event: '$pageleave', ts_ms: range.to },
    { ...base, project: 'a', ts_ms: start - 1 },
    { ...base, project: 'elsewhere' },
  ]);
  const ctx = context(db);
  const fleet = await runTrafficBreakdown(range, ['a', 'b', 'quiet'], ctx, filtered);
  assert.equal(fleet.timezone, 'UTC');
  assert.equal(fleet.hourly.length, 24);
  assert.deepEqual(fleet.hourly.slice(5, 8), [1, 2, 1]);
  assert.deepEqual(
    fleet.weekdayHourly.map((day) => day.slice(5, 8)),
    [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [1, 2, 1],
    ],
  );
  assert.equal(
    fleet.hourly.reduce((n, v) => n + v, 0),
    4,
  );
  assert.deepEqual(fleet.devices, { desktop: 1, mobile: 1, tablet: 1, other: 1 });
  assert.deepEqual(fleet.visitors, {
    likelyHuman: 2,
    unclassified: 2,
    knownBot: 2,
    collectionStarted: new Date(filtered.startedMs).toISOString(),
  });
  assert.deepEqual(fleet.sessions, {
    count: 4,
    averageSeconds: 97.5,
    bands: [1, 1, 1, 1],
    sites: [
      { project: 'a', count: 2, averageSeconds: 15 },
      { project: 'b', count: 2, averageSeconds: 180 },
      { project: 'quiet', count: 0, averageSeconds: null },
    ],
  });
  const site = await runTrafficBreakdown(
    range,
    ['a'],
    { ...ctx, timezone: 'America/New_York' },
    filtered,
  );
  assert.equal(site.timezone, 'America/New_York');
  assert.equal(site.hourly[1], 2);
  assert.equal(site.weekdayHourly[6]?.[1], 2);
  assert.equal(
    site.weekdayHourly.flat().reduce((n, v) => n + v, 0),
    2,
  );
  assert.equal(site.sessions.averageSeconds, 15);
  // A site with double the sessions gets double the weight.
  insert(db, [
    { ...base, project: 'b', session_id: 'more' },
    { ...base, project: 'b', session_id: 'another' },
  ]);
  const weighted = await runTrafficBreakdown(range, ['a', 'b'], ctx, filtered);
  assert.equal(weighted.sessions.averageSeconds, 65);
  assert.equal(weighted.sessions.sites[0]?.project, 'b');

  const before = ctx.queries.length;
  const empty = await runTrafficBreakdown(range, [], ctx, { startedMs: range.to, count: 0 });
  assert.equal(ctx.queries.length, before);
  assert.equal(empty.visitors.knownBot, null);
  assert.equal(empty.sessions.averageSeconds, null);
  assert.ok(empty.hourly.every((n) => n === 0));
  assert.deepEqual(
    empty.weekdayHourly.map((day) => day.length),
    [24, 24, 24, 24, 24, 24, 24],
  );
  assert.ok(empty.weekdayHourly.flat().every((n) => n === 0));
});

it('places a timestamp just before the Unix epoch in the last wall-clock hour', async () => {
  const db = createDb();
  insert(db, [{ ts_ms: -1, session_id: '' }]);
  const r = await runTrafficBreakdown({ from: -HOUR_MS, to: 0 }, ['p'], context(db), {
    startedMs: 1,
    count: 0,
  });
  assert.equal(r.hourly[23], 1);
  assert.equal(r.weekdayHourly[2]?.[23], 1);
  assert.deepEqual(r.sessions.sites, [{ project: 'p', count: 0, averageSeconds: null }]);
});
