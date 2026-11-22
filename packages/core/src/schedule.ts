/**
 * When scheduled reports and alert checks run: hourly, daily, weekly or monthly (by date, the
 * last day, or an ordinal such as "the first Monday"), every N of those, at a wall-clock time
 * in a time zone. Times follow daylight saving: "09:00 Europe/London" is 09:00 in both summer
 * and winter. Quiet hours and weekends can be skipped.
 */

import { z } from 'zod/v4';
import { DAY_MS, isValidTimeZone, localToUtc, offsetAt, zoneFor } from './time.ts';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour "HH:MM", e.g. "09:00".');

export const scheduleSchema = z
  .object({
    frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
    every: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Every N hours, days, weeks or months. Default 1.'),
    time: clock.optional().describe('Local time for daily, weekly and monthly. Default "09:00".'),
    minute: z
      .number()
      .int()
      .min(0)
      .max(59)
      .optional()
      .describe('Hourly: minute past the hour. Default 0.'),
    weekday: z.enum(WEEKDAYS).optional().describe('Weekly: the day. Default "mon".'),
    monthDay: z
      .union([z.number().int().min(1).max(31), z.literal('last')])
      .optional()
      .describe('Monthly: day of the month (clamped to short months) or "last". Default 1.'),
    ordinal: z
      .object({
        nth: z.union([z.number().int().min(1).max(4), z.literal('last')]),
        weekday: z.enum(WEEKDAYS),
      })
      .optional()
      .describe(
        'Monthly, instead of monthDay: e.g. { nth: 1, weekday: "mon" } or { nth: "last", weekday: "fri" }.',
      ),
    timezone: z
      .string()
      .optional()
      .refine((tz) => tz === undefined || isValidTimeZone(tz), 'Unknown time zone.')
      .describe('IANA time zone. Default: the project time zone, else UTC.'),
  })
  .describe('When something runs.');

export type Schedule = z.infer<typeof scheduleSchema>;

export const quietHoursSchema = z
  .array(z.object({ from: clock, to: clock }))
  .max(5)
  .describe(
    'Local times not to send in, e.g. [{ "from": "22:00", "to": "07:00" }] (may wrap midnight).',
  );

/** A local calendar day, as Y-M-D in the zone, with its weekday and position. */
interface LocalDay {
  y: number;
  m: number;
  d: number;
  weekday: number;
  /** Days since 1970-01-01 (local). */
  index: number;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function localDay(index: number): LocalDay {
  const at = new Date(index * DAY_MS);
  return {
    y: at.getUTCFullYear(),
    m: at.getUTCMonth(),
    d: at.getUTCDate(),
    weekday: at.getUTCDay(),
    index,
  };
}

/** Whether day `day` is the schedule's day of the month. */
function monthlyMatch(s: Schedule, day: LocalDay): boolean {
  const length = daysInMonth(day.y, day.m);
  if (s.ordinal) {
    if (day.weekday !== WEEKDAYS.indexOf(s.ordinal.weekday)) return false;
    return s.ordinal.nth === 'last' ? day.d + 7 > length : Math.ceil(day.d / 7) === s.ordinal.nth;
  }
  const want = s.monthDay ?? 1;
  return day.d === (want === 'last' ? length : Math.min(want, length));
}

/** Whether a local day runs (hourly runs every day). */
function dayMatches(s: Schedule, day: LocalDay): boolean {
  const every = s.every ?? 1;
  switch (s.frequency) {
    case 'hourly':
      return true;
    case 'daily':
      return day.index % every === 0;
    case 'weekly':
      // Weeks counted from a Monday, so "every 2 weeks" is a stable fortnight.
      return (
        day.weekday === WEEKDAYS.indexOf(s.weekday ?? 'mon') &&
        Math.floor((day.index - 4) / 7) % every === 0
      );
    case 'monthly':
      return (day.y * 12 + day.m) % every === 0 && monthlyMatch(s, day);
  }
}

/** Local minutes past midnight a matching day runs at. */
function runMinutes(s: Schedule): number[] {
  if (s.frequency !== 'hourly') return [minutesOf(s.time ?? '09:00')];
  const every = s.every ?? 1;
  const out: number[] = [];
  for (let h = 0; h < 24; h += every) out.push(h * 60 + (s.minute ?? 0));
  return out;
}

/**
 * The first run strictly after `after` (epoch ms). `timezone` is the fallback when the
 * schedule names none. Looks up to 13 months ahead.
 */
export function nextRun(s: Schedule, after: number, timezone = 'UTC'): number {
  const tz = s.timezone ?? timezone;
  const horizon = 400 * DAY_MS;
  const zone = zoneFor(tz, undefined, { from: after - 2 * DAY_MS, to: after + horizon });
  const first = Math.floor((after + offsetAt(zone, after)) / DAY_MS) - 1;
  const minutes = runMinutes(s);
  for (let i = first; i < first + 400; i++) {
    const day = localDay(i);
    if (!dayMatches(s, day)) continue;
    for (const m of minutes) {
      const at = localToUtc(zone, i * DAY_MS + m * 60_000);
      if (at > after) return at;
    }
  }
  throw new RangeError('This schedule never runs in the next 13 months.');
}

/** Whether an instant falls in one of the quiet windows (local time; windows may wrap midnight). */
export function inQuietHours(
  quiet: { from: string; to: string }[] | undefined,
  at: number,
  timezone = 'UTC',
): boolean {
  if (!quiet?.length) return false;
  const zone = zoneFor(timezone, undefined, { from: at - DAY_MS, to: at + DAY_MS });
  const local = at + offsetAt(zone, at);
  const minute = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
  return quiet.some(({ from, to }) => {
    const a = minutesOf(from);
    const b = minutesOf(to);
    return a <= b ? minute >= a && minute < b : minute >= a || minute < b;
  });
}

/** Saturday or Sunday, locally. */
export function isWeekend(at: number, timezone = 'UTC'): boolean {
  const zone = zoneFor(timezone, undefined, { from: at - DAY_MS, to: at + DAY_MS });
  const weekday = new Date(at + offsetAt(zone, at)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

const ORDINALS: Record<string, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  last: 'last',
};

function monthlyWords(s: Schedule): string {
  if (s.ordinal)
    return `on the ${ORDINALS[String(s.ordinal.nth)]} ${WEEKDAY_NAMES[s.ordinal.weekday]}`;
  const d = s.monthDay ?? 1;
  if (d === 'last') return 'on the last day';
  const suffix =
    d % 10 === 1 && d !== 11
      ? 'st'
      : d % 10 === 2 && d !== 12
        ? 'nd'
        : d % 10 === 3 && d !== 13
          ? 'rd'
          : 'th';
  return `on the ${d}${suffix}`;
}

/** "Every Monday at 09:00", "Every 2 hours at :15", "Monthly on the first Monday at 08:30". */
export function describeSchedule(s: Schedule): string {
  const every = s.every ?? 1;
  const at = `at ${s.time ?? '09:00'}`;
  const unit = (one: string) => (every === 1 ? one : `every ${every} ${one}s`);
  switch (s.frequency) {
    case 'hourly':
      return `${every === 1 ? 'Every hour' : `Every ${every} hours`} at :${String(s.minute ?? 0).padStart(2, '0')}`;
    case 'daily':
      return `${every === 1 ? 'Every day' : `Every ${every} days`} ${at}`;
    case 'weekly':
      return `${every === 1 ? 'Every' : `Every ${every} weeks on`} ${WEEKDAY_NAMES[s.weekday ?? 'mon']} ${at}`;
    case 'monthly':
      return `${every === 1 ? 'Monthly' : `${unit('month').replace(/^e/, 'E')}`} ${monthlyWords(s)} ${at}`;
  }
}
