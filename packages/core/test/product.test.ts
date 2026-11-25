import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runProduct } from '../src/insights/product.ts';
import { context, createDb, insert, link } from './helpers.ts';

it('ranks marked actions using resolved people and project-local dates', async () => {
  const db = createDb();
  const from = Date.parse('2026-10-10T03:59Z');
  const to = from + 60000 * 3;
  link(db, 'phone', 'alice');
  link(db, 'tablet', 'alice');
  link(db, 'phone', 'bob', 'elsewhere');
  insert(db, [
    { event: 'play', distinct_id: 'phone', ts_ms: from },
    { event: 'play', distinct_id: 'tablet', ts_ms: from + 60000 },
    { event: 'play', distinct_id: 'bob', ts_ms: from + 60000 },
    { event: 'play', distinct_id: 'bob', ts_ms: from + 90000 },
    { distinct_id: 'viewer', ts_ms: from },
    { event: 'probe', distinct_id: 'monitor', ts_ms: from },
    { event: 'play', distinct_id: 'late', ts_ms: to },
    { event: 'play', project: 'elsewhere', ts_ms: from },
  ]);
  const ctx = { ...context(db), timezone: 'America/New_York' };
  const marks = ['idle', 'play', '$pageview'].map((event) => ({ event, role: 'important' }));
  const report = await runProduct({ from, to }, marks, ctx);
  assert.equal(report.audience, 3);
  assert.deepEqual(report.actions, [
    {
      event: 'play',
      role: 'important',
      volume: 4,
      adopters: 2,
      repeaters: 1,
      adoptionShare: 2 / 3,
      repeatShare: 0.5,
    },
    {
      event: 'idle',
      role: 'important',
      volume: 0,
      adopters: 0,
      repeaters: 0,
      adoptionShare: 0,
      repeatShare: null,
    },
  ]);
  const empty = await runProduct({ from: 0, to: 1 }, marks, ctx);
  assert.equal(empty.actions[0]?.adoptionShare, null);
  assert.deepEqual((await runProduct({ from, to }, [], ctx)).actions, []);
});
