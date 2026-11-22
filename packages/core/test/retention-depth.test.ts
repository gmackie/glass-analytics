/**
 * Retention at PostHog depth: recurring cohorts, on-or-after (cumulative)
 * retention, breakdowns, hourly periods, any event, simple means, group
 * aggregation and drill-down into a cell.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileRetentionActors, runRetention } from '../src/insights/retention.ts';
import { retentionSpec } from '../src/insights/schemas.ts';
import { context, createDb, DAY, insert, NOW, type TestEvent } from './helpers.ts';

const spec = (s: Record<string, unknown>) =>
  retentionSpec.parse({
    cohortEvent: { event: 'signup' },
    returnEvent: { event: 'visit' },
    period: 'day',
    periods: 4,
    from: '-10d',
    ...s,
  });
// Day starts, as retention cohort starts are.
const dayStart = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / DAY) * DAY;
const ev = (
  distinct: string,
  event: string,
  daysAgo: number,
  extra: Partial<TestEvent> = {},
): TestEvent => ({
  distinct_id: distinct,
  event,
  ts_ms: dayStart(daysAgo) + 3_600_000,
  ...extra,
});

function db() {
  const d = createDb();
  insert(d, [
    // a signs up 8 days ago (Chrome), comes back on days +1 and +3.
    ev('a', 'signup', 8, { browser: 'Chrome' }),
    ev('a', 'visit', 7),
    ev('a', 'visit', 5),
    // b signs up 8 days ago (Safari), comes back on day +2 only.
    ev('b', 'signup', 8, { browser: 'Safari' }),
    ev('b', 'visit', 6),
    // a signs up again 6 days ago (a second "cohort event"), b again 5 days ago.
    ev('a', 'signup', 6, { browser: 'Chrome' }),
    ev('b', 'signup', 5, { browser: 'Safari' }),
  ]);
  return d;
}

const row = (r: Awaited<ReturnType<typeof runRetention>>, daysAgo: number) =>
  r.cohorts.find((c) => c.start === dayStart(daysAgo));

describe('retention modes', () => {
  it('first-time cohorts count each person once', async () => {
    const res = await runRetention(spec({}), context(db()));
    assert.equal(res.cohorts.length, 1);
    assert.deepEqual(row(res, 8)!.counts, [2, 1, 1, 1, 0]);
  });

  it('recurring cohorts count people in every period they did it', async () => {
    const res = await runRetention(spec({ retentionType: 'recurring' }), context(db()));
    assert.equal(res.retentionType, 'recurring');
    assert.deepEqual(
      res.cohorts.map((c) => [c.start, c.size]),
      [
        [dayStart(8), 2],
        [dayStart(6), 1],
        [dayStart(5), 1],
      ],
    );
    // a's second cohort (6 days ago): a visited again 5 days ago, in period 1.
    assert.deepEqual(row(res, 6)!.counts.slice(0, 2), [1, 1]);
  });

  it('on-or-after retention counts later returns too', async () => {
    const res = await runRetention(spec({ cumulative: true }), context(db()));
    // Period 1 or later: a (back at +1 and +3) and b (back at +2) — both.
    assert.deepEqual(row(res, 8)!.counts, [2, 2, 2, 1, 0]);
    assert.equal(res.cumulative, true);
  });

  it('breaks the table down by a property of the cohort event', async () => {
    const res = await runRetention(spec({ breakdown: 'browser' }), context(db()));
    const byValue = Object.fromEntries(res.breakdowns!.map((b) => [b.value, b.cohorts[0]!.counts]));
    assert.deepEqual(byValue, { Chrome: [1, 1, 0, 1, 0], Safari: [1, 0, 1, 0, 0] });
  });

  it('accepts any event, hourly periods and simple means', async () => {
    const d = createDb();
    const h = 3_600_000;
    const base = Math.floor((NOW - 5 * h) / h) * h;
    insert(d, [
      { distinct_id: 'a', event: 'x', ts_ms: base },
      { distinct_id: 'a', event: 'y', ts_ms: base + h },
      { distinct_id: 'b', event: 'x', ts_ms: base + h },
    ]);
    const res = await runRetention(
      retentionSpec.parse({
        cohortEvent: { event: '*' },
        returnEvent: { event: '*' },
        period: 'hour',
        periods: 2,
        from: '-6h',
        meanMethod: 'simple',
      }),
      context(d),
    );
    assert.deepEqual(
      res.cohorts.map((c) => c.counts),
      [
        [1, 1, 0],
        [1, 0, 0],
      ],
    );
    // Simple mean of period-1 rates over cohorts old enough: (100% + 0%) / 2.
    assert.equal(res.average[1], 0.5);
  });

  it('aggregates by group', async () => {
    const d = createDb();
    insert(d, [
      ev('u1', 'signup', 8, { props: { $groups: { company: 'acme' } } }),
      ev('u2', 'visit', 7, { props: { $groups: { company: 'acme' } } }),
      ev('u3', 'signup', 8, { props: { $groups: { company: 'globex' } } }),
    ]);
    const res = await runRetention(spec({ aggregateBy: 'company' }), context(d));
    // acme came back the next day through another member; globex didn't.
    assert.deepEqual(row(res, 8)!.counts.slice(0, 2), [2, 1]);
  });
});

describe('retention drill-down', () => {
  it('lists the people in a cell', async () => {
    const d = db();
    const ctx = context(d);
    const s = spec({});
    const page = { limit: 10, offset: 0 };
    const all = await ctx.execute(
      compileRetentionActors(s, ctx, { cohort: dayStart(8), period: 0 }, page),
    );
    const day2 = await ctx.execute(
      compileRetentionActors(s, ctx, { cohort: dayStart(8), period: 2 }, page),
    );
    assert.deepEqual(
      all.map((r) => r.actor),
      ['a', 'b'],
    );
    assert.deepEqual(
      day2.map((r) => r.actor),
      ['b'],
    );
    const cumulative = await ctx.execute(
      compileRetentionActors(
        spec({ cumulative: true }),
        ctx,
        { cohort: dayStart(8), period: 2 },
        page,
      ),
    );
    assert.deepEqual(
      cumulative.map((r) => r.actor),
      ['a', 'b'],
    );
  });
});
