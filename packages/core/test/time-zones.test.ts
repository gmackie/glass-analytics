import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { runTrends } from '../src/insights/trends.ts';
import { sqlite } from '../src/sql/dialect.ts';
import { bucketExpr } from '../src/sql/source.ts';
import {
  bucketStart,
  bucketsBetween,
  localToUtc,
  offsetAt,
  tzOffsetMs,
  zoneFor,
} from '../src/time.ts';
import { context, createDb, insert } from './helpers.ts';

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MARCH = { from: Date.UTC(2026, 2, 20), to: Date.UTC(2026, 3, 5) };
const OCTOBER = { from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 10, 5) };

describe('time zones', () => {
  it('reads offsets from Intl', () => {
    assert.equal(tzOffsetMs('Europe/London', Date.UTC(2026, 2, 28, 12)), 0);
    assert.equal(tzOffsetMs('Europe/London', Date.UTC(2026, 2, 30, 12)), H);
    assert.equal(tzOffsetMs('America/New_York', Date.UTC(2026, 0, 15)), -5 * H);
    assert.equal(tzOffsetMs('Asia/Kolkata', Date.UTC(2026, 0, 15)), 5.5 * H);
  });

  it('finds the exact minute of a daylight-saving change', () => {
    const zone = zoneFor('Europe/London', undefined, MARCH);
    assert.equal(zone.segments.length, 2);
    assert.equal(iso(zone.segments[1]!.start), '2026-03-29T01:00:00.000Z');
    assert.equal(offsetAt(zone, Date.UTC(2026, 2, 29, 0, 59)), 0);
    assert.equal(offsetAt(zone, Date.UTC(2026, 2, 29, 1, 0)), H);
  });

  it('starts days at local midnight on both sides of a change', () => {
    const zone = zoneFor('Europe/London', undefined, MARCH);
    // 29 March: midnight is still GMT; the day after, midnight is BST (23:00 UTC the evening before).
    assert.equal(
      iso(bucketStart(Date.UTC(2026, 2, 29, 12), 'day', zone)),
      '2026-03-29T00:00:00.000Z',
    );
    assert.equal(
      iso(bucketStart(Date.UTC(2026, 2, 30, 12), 'day', zone)),
      '2026-03-29T23:00:00.000Z',
    );
    // Just after midnight BST on the 30th is still the 30th.
    assert.equal(
      iso(bucketStart(Date.UTC(2026, 2, 29, 23, 30), 'day', zone)),
      '2026-03-29T23:00:00.000Z',
    );
  });

  it('lists 23- and 25-hour days around the changes', () => {
    const spring = zoneFor('Europe/London', undefined, MARCH);
    const days = bucketsBetween(
      { from: Date.UTC(2026, 2, 28, 12), to: Date.UTC(2026, 2, 31) },
      'day',
      spring,
    ).map(iso);
    assert.deepEqual(days, [
      '2026-03-28T00:00:00.000Z',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T23:00:00.000Z',
      '2026-03-30T23:00:00.000Z',
    ]);
    const autumn = zoneFor('Europe/London', undefined, OCTOBER);
    const fall = bucketsBetween(
      { from: Date.UTC(2026, 9, 24, 12), to: Date.UTC(2026, 9, 27) },
      'day',
      autumn,
    ).map(iso);
    assert.deepEqual(fall, [
      '2026-10-23T23:00:00.000Z',
      '2026-10-24T23:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ]);
  });

  it('maps skipped and repeated local times to a single instant', () => {
    const spring = zoneFor('Europe/London', undefined, MARCH);
    // 01:30 on 29 March doesn't exist locally: it is read with the old offset (GMT).
    assert.equal(iso(localToUtc(spring, Date.UTC(2026, 2, 29, 1, 30))), '2026-03-29T01:30:00.000Z');
    const autumn = zoneFor('Europe/London', undefined, OCTOBER);
    // 01:30 on 25 October happens twice locally; the first is 00:30 UTC.
    assert.equal(iso(localToUtc(autumn, Date.UTC(2026, 9, 25, 1, 30))), '2026-10-25T00:30:00.000Z');
  });

  it('buckets identically in SQL and in JavaScript', () => {
    const db = new DatabaseSync(':memory:');
    const zones = [
      ['Europe/London', MARCH],
      ['Europe/London', OCTOBER],
      ['America/New_York', { from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 20) }],
      ['America/New_York', { from: Date.UTC(2026, 9, 25), to: Date.UTC(2026, 10, 10) }],
      ['Asia/Kolkata', MARCH],
      ['Australia/Lord_Howe', { from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 3, 10) }],
      ['Pacific/Auckland', { from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 4, 10) }],
      // Chile changes at local midnight, so a day can start at 01:00 or happen twice.
      ['America/Santiago', { from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 3, 10) }],
      ['America/Santiago', { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 15) }],
    ] as const;
    for (const [name, range] of zones) {
      const zone = zoneFor(name, undefined, range);
      for (const interval of ['minute', 'hour', 'day', 'week', 'month'] as const) {
        const expr = bucketExpr(sqlite, 't', interval, zone);
        const stmt = db.prepare(`SELECT ${expr} AS b FROM (SELECT CAST(? AS INTEGER) AS t)`);
        for (let ts = range.from; ts < range.to; ts += 37 * 60_000 + 13_000) {
          const sql = Number((stmt.get(ts) as { b: number }).b);
          assert.equal(
            sql,
            bucketStart(ts, interval, zone),
            `${name} ${interval} at ${iso(ts)}: SQL ${iso(sql)}`,
          );
        }
      }
    }
  });

  it('rejects unknown zones with a hint', () => {
    assert.throws(() => zoneFor('Mars/Olympus', undefined, MARCH), /IANA name/);
  });

  it('runs trends by local day across a change', async () => {
    const db = createDb();
    // Two events on the evening of 29 March BST (one before, one after 23:00 UTC).
    insert(db, [
      { event: 'x', ts_ms: Date.UTC(2026, 2, 29, 22, 30) }, // 23:30 BST on the 29th
      { event: 'x', ts_ms: Date.UTC(2026, 2, 29, 23, 30) }, // 00:30 BST on the 30th
    ]);
    const ctx = context(db);
    const res = await runTrends(
      {
        series: [{ event: 'x' }],
        interval: 'day',
        from: '2026-03-28',
        to: '2026-03-31',
        timezone: 'Europe/London',
      },
      { ...ctx, now: Date.UTC(2026, 3, 1) },
    );
    const byDay = Object.fromEntries(res.buckets.map((b, i) => [iso(b), res.series[0]!.values[i]]));
    assert.equal(byDay['2026-03-29T00:00:00.000Z'], 1);
    assert.equal(byDay['2026-03-29T23:00:00.000Z'], 1);
    // The project time zone applies when the spec names none.
    const fallback = await runTrends(
      { series: [{ event: 'x' }], interval: 'day', from: '2026-03-28', to: '2026-03-31' },
      { ...ctx, now: Date.UTC(2026, 3, 1), timezone: 'Europe/London' },
    );
    assert.deepEqual(fallback.buckets, res.buckets);
  });
});
