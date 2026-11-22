/**
 * Schedules: wall-clock times across daylight saving, every-N, weekly fortnights, monthly by
 * date (clamped), the last day and ordinals, quiet hours across midnight, and the words.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeSchedule,
  inQuietHours,
  isWeekend,
  nextRun,
  type Schedule,
  scheduleSchema,
} from '../src/schedule.ts';

const at = (iso: string) => Date.parse(iso);
const next = (s: Schedule, after: string, tz?: string) =>
  new Date(nextRun(scheduleSchema.parse(s), at(after), tz)).toISOString();

describe('nextRun', () => {
  it('keeps 09:00 local through both clock changes', () => {
    const s: Schedule = { frequency: 'daily', time: '09:00', timezone: 'Europe/London' };
    // GMT before 29 March 2026, BST after, GMT again after 25 October.
    assert.equal(next(s, '2026-03-28T10:00:00Z'), '2026-03-29T08:00:00.000Z');
    assert.equal(next(s, '2026-03-27T10:00:00Z'), '2026-03-28T09:00:00.000Z');
    assert.equal(next(s, '2026-10-24T10:00:00Z'), '2026-10-25T09:00:00.000Z');
    assert.equal(next(s, '2026-10-24T07:00:00Z'), '2026-10-24T08:00:00.000Z');
  });

  it('runs a time skipped by spring-forward at the change, and a repeated time once', () => {
    const s: Schedule = { frequency: 'daily', time: '01:30', timezone: 'Europe/London' };
    // 01:30 on 29 March doesn't exist locally: it runs an hour on, at 02:30 BST.
    assert.equal(next(s, '2026-03-28T23:00:00Z'), '2026-03-29T01:30:00.000Z');
    // 01:30 on 25 October happens twice: the first one.
    assert.equal(next(s, '2026-10-24T23:00:00Z'), '2026-10-25T00:30:00.000Z');
  });

  it('uses the fallback zone, then UTC', () => {
    assert.equal(
      next({ frequency: 'daily', time: '09:00' }, '2026-07-01T00:00:00Z', 'America/New_York'),
      '2026-07-01T13:00:00.000Z',
    );
    assert.equal(next({ frequency: 'daily' }, '2026-07-01T00:00:00Z'), '2026-07-01T09:00:00.000Z');
  });

  it('hourly, at a minute, every N hours', () => {
    assert.equal(
      next({ frequency: 'hourly', minute: 15 }, '2026-07-01T10:20:00Z'),
      '2026-07-01T11:15:00.000Z',
    );
    assert.equal(
      next({ frequency: 'hourly', every: 6 }, '2026-07-01T10:20:00Z'),
      '2026-07-01T12:00:00.000Z',
    );
    // Strictly after: a run due now is the next one.
    assert.equal(next({ frequency: 'hourly' }, '2026-07-01T11:00:00Z'), '2026-07-01T12:00:00.000Z');
  });

  it('weekly on a day, and every 2 weeks on a stable fortnight', () => {
    assert.equal(
      next({ frequency: 'weekly', weekday: 'mon' }, '2026-11-19T12:00:00Z'),
      '2026-11-23T09:00:00.000Z',
    );
    const a = next({ frequency: 'weekly', weekday: 'fri', every: 2 }, '2026-11-19T12:00:00Z');
    const b = next({ frequency: 'weekly', weekday: 'fri', every: 2 }, a);
    assert.equal(Date.parse(b) - Date.parse(a), 14 * 86_400_000);
  });

  it('monthly by date (clamped), the last day, and ordinals', () => {
    assert.equal(
      next({ frequency: 'monthly', monthDay: 31 }, '2026-02-01T00:00:00Z'),
      '2026-02-28T09:00:00.000Z',
    );
    assert.equal(
      next({ frequency: 'monthly', monthDay: 'last' }, '2026-04-01T00:00:00Z'),
      '2026-04-30T09:00:00.000Z',
    );
    // The first Monday of December 2026 is the 7th; the last Friday of November is the 27th.
    assert.equal(
      next({ frequency: 'monthly', ordinal: { nth: 1, weekday: 'mon' } }, '2026-11-20T00:00:00Z'),
      '2026-12-07T09:00:00.000Z',
    );
    assert.equal(
      next(
        { frequency: 'monthly', ordinal: { nth: 'last', weekday: 'fri' } },
        '2026-11-20T00:00:00Z',
      ),
      '2026-11-27T09:00:00.000Z',
    );
    // Every 3 months: only months whose index is a multiple of 3 (Jan, Apr, Jul, Oct).
    assert.equal(
      next({ frequency: 'monthly', every: 3 }, '2026-11-20T00:00:00Z'),
      '2027-01-01T09:00:00.000Z',
    );
  });

  it('rejects bad times and zones', () => {
    assert.throws(() => scheduleSchema.parse({ frequency: 'daily', time: '9am' }));
    assert.throws(() => scheduleSchema.parse({ frequency: 'daily', timezone: 'Mars/Olympus' }));
  });
});

describe('quiet hours and weekends', () => {
  it('wrap midnight, in local time', () => {
    const quiet = [{ from: '22:00', to: '07:00' }];
    assert.equal(inQuietHours(quiet, at('2026-07-01T22:30:00Z'), 'Europe/London'), true);
    assert.equal(inQuietHours(quiet, at('2026-07-01T05:30:00Z'), 'Europe/London'), true);
    assert.equal(inQuietHours(quiet, at('2026-07-01T06:30:00Z'), 'Europe/London'), false);
    assert.equal(inQuietHours([{ from: '12:00', to: '13:00' }], at('2026-07-01T12:30:00Z')), true);
    assert.equal(inQuietHours(undefined, at('2026-07-01T12:30:00Z')), false);
  });

  it('weekends are local too', () => {
    // 23:30 UTC on Friday is already Saturday in Tokyo.
    assert.equal(isWeekend(at('2026-11-20T23:30:00Z'), 'Asia/Tokyo'), true);
    assert.equal(isWeekend(at('2026-11-20T23:30:00Z'), 'UTC'), false);
  });
});

describe('describeSchedule', () => {
  it('reads like a sentence', () => {
    assert.equal(
      describeSchedule({ frequency: 'weekly', weekday: 'mon' }),
      'Every Monday at 09:00',
    );
    assert.equal(
      describeSchedule({ frequency: 'hourly', every: 2, minute: 5 }),
      'Every 2 hours at :05',
    );
    assert.equal(
      describeSchedule({
        frequency: 'monthly',
        ordinal: { nth: 1, weekday: 'mon' },
        time: '08:30',
      }),
      'Monthly on the first Monday at 08:30',
    );
    assert.equal(
      describeSchedule({ frequency: 'monthly', monthDay: 22 }),
      'Monthly on the 22nd at 09:00',
    );
    assert.equal(describeSchedule({ frequency: 'daily', every: 2 }), 'Every 2 days at 09:00');
  });
});
