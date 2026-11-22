/**
 * Date ranges, intervals and time zones.
 *
 * Agents (and humans) mostly think in relative terms — "last 30 days" — so every
 * query accepts relative expressions as well as ISO dates. Buckets are UTC by
 * default, shifted by a fixed `utcOffsetMinutes`, or follow an IANA time zone
 * (`timezone: "Europe/London"`) including its daylight-saving changes.
 */

export type Interval = 'minute' | 'hour' | 'day' | 'week' | 'month';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Milliseconds per interval. Months are variable and handled separately. */
export const INTERVAL_MS: Record<Exclude<Interval, 'month'>, number> = {
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
};

const RELATIVE = /^-?(\d+)\s*(m|min|h|d|w|mo|y)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
};

/**
 * Parse a point in time.
 *
 * Accepts: `now`, `today` (UTC midnight), `yesterday`, relative offsets
 * (`-30d`, `7d`, `-12h`, `-2w`, `-3mo`, `-1y`), ISO dates or epoch milliseconds.
 * Relative offsets always point into the past.
 */
export function parseTime(input: string | number, now: number = Date.now()): number {
  if (typeof input === 'number') return input;
  const value = input.trim().toLowerCase();
  if (value === 'now') return now;
  if (value === 'today') return startOfDay(now);
  if (value === 'yesterday') return startOfDay(now) - DAY_MS;
  const rel = RELATIVE.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (unit === 'mo') return addMonths(now, -n);
    if (unit === 'y') return addMonths(now, -12 * n);
    return now - n * UNIT_MS[unit]!;
  }
  if (/^\d{10,}$/.test(value)) return Number(value);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new RangeError(
      `Cannot parse time "${input}". Use an ISO date (2026-10-01), "now", "today" or a relative offset like "-30d".`,
    );
  }
  return parsed;
}

export interface TimeRange {
  /** Inclusive start, ms. */
  from: number;
  /** Exclusive end, ms. */
  to: number;
}

/** Resolve `from`/`to` expressions into an absolute range. Defaults to the last 30 days. */
export function resolveRange(
  from: string | number | undefined,
  to: string | number | undefined,
  now: number = Date.now(),
): TimeRange {
  const range = {
    from: parseTime(from ?? '-30d', now),
    to: parseTime(to ?? 'now', now),
  };
  if (range.to <= range.from) {
    throw new RangeError(
      `Empty time range: "from" (${iso(range.from)}) must be before "to" (${iso(range.to)}).`,
    );
  }
  return range;
}

export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Add calendar months, clamping the day (31 Oct - 1 month = 30 Sep, not 1 Oct). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target.getTime();
}

// ── Time zones ──────────────────────────────────────────────────────────────

/**
 * A time zone as the compilers use it: the UTC offset in force from each
 * instant on. A fixed offset is one segment; an IANA zone has one segment per
 * daylight-saving change in the window a query needs. SQL turns the segments
 * into a short `CASE`, so bucketing stays integer arithmetic on every engine.
 */
export interface Zone {
  /** IANA name ("Europe/London"), "UTC", or a fixed offset such as "UTC+60m". */
  name: string;
  /** Ascending by `start` (UTC ms). The first segment starts at -Infinity. */
  segments: { start: number; offsetMs: number }[];
}

export const UTC_ZONE: Zone = { name: 'UTC', segments: [{ start: -Infinity, offsetMs: 0 }] };

export function fixedZone(offsetMinutes: number): Zone {
  if (!offsetMinutes) return UTC_ZONE;
  return {
    name: `UTC${offsetMinutes > 0 ? '+' : ''}${offsetMinutes}m`,
    segments: [{ start: -Infinity, offsetMs: offsetMinutes * MINUTE_MS }],
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the runtime knows this IANA time zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The UTC offset (ms) of an IANA time zone at an instant. */
export function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return local - Math.floor(utcMs / 1000) * 1000;
}

const yearSegments = new Map<string, { start: number; offsetMs: number }[]>();

/** Offset changes of a zone during one UTC year, found by daily steps and a binary search. */
function transitionsInYear(timeZone: string, year: number): { start: number; offsetMs: number }[] {
  const key = `${timeZone}:${year}`;
  const hit = yearSegments.get(key);
  if (hit) return hit;
  const out: { start: number; offsetMs: number }[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1);
  let off = tzOffsetMs(timeZone, t);
  while (t < end) {
    const next = Math.min(end, t + DAY_MS);
    const nextOff = tzOffsetMs(timeZone, next);
    if (nextOff !== off) {
      // The change happens in (t, next]: narrow it to the minute.
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.max(MINUTE_MS, Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS);
        if (tzOffsetMs(timeZone, mid) === off) lo = mid;
        else hi = mid;
      }
      out.push({ start: hi, offsetMs: nextOff });
      off = nextOff;
    }
    t = next;
  }
  yearSegments.set(key, out);
  return out;
}

/**
 * The zone a query buckets in. An IANA `timezone` wins over a fixed
 * `utcOffsetMinutes`; neither means UTC. `window` is the span of timestamps the
 * query reads (with margin), which bounds how many offset changes are included.
 */
export function zoneFor(
  timezone: string | null | undefined,
  utcOffsetMinutes: number | null | undefined,
  window: TimeRange,
): Zone {
  if (timezone && timezone !== 'UTC' && timezone !== 'Etc/UTC') {
    if (!isValidTimeZone(timezone)) {
      throw new RangeError(
        `Unknown time zone "${timezone}". Use an IANA name such as "Europe/London" or "America/New_York".`,
      );
    }
    const from = Math.max(window.from - 2 * DAY_MS, Date.UTC(1971, 0, 1));
    const to = window.to + 2 * DAY_MS;
    const first = new Date(from).getUTCFullYear();
    const last = new Date(to).getUTCFullYear();
    const segments = [{ start: -Infinity, offsetMs: tzOffsetMs(timezone, from) }];
    for (let y = first; y <= last; y++) {
      for (const change of transitionsInYear(timezone, y)) {
        if (change.start > from && change.start <= to) segments.push(change);
      }
    }
    return { name: timezone, segments };
  }
  return fixedZone(utcOffsetMinutes ?? 0);
}

function asZone(zone: Zone | number | undefined): Zone {
  return typeof zone === 'object' ? zone : fixedZone(zone ?? 0);
}

/** The offset in force at a UTC instant. */
export function offsetAt(zone: Zone, utcMs: number): number {
  let off = zone.segments[0]!.offsetMs;
  for (const s of zone.segments) {
    if (s.start <= utcMs) off = s.offsetMs;
    else break;
  }
  return off;
}

/**
 * The UTC instant of a local wall-clock time. A local time skipped by a
 * spring-forward change is read with the old offset (so a skipped midnight maps
 * to the instant of the change), and a time repeated by a fall-back change maps
 * to its first occurrence. Both are what a bucket start needs.
 */
export function localToUtc(zone: Zone, localMs: number): number {
  const s = zone.segments;
  let off = s[0]!.offsetMs;
  for (let i = 1; i < s.length; i++) {
    if (localMs >= localThreshold(s[i - 1]!.offsetMs, s[i]!)) off = s[i]!.offsetMs;
    else break;
  }
  return localMs - off;
}

/** The local time from which a segment's offset applies: after a gap ends, or after a repeat ends. */
export function localThreshold(
  previousOffsetMs: number,
  segment: { start: number; offsetMs: number },
): number {
  return segment.start + Math.max(previousOffsetMs, segment.offsetMs);
}

/** Start of the local bucket containing a local wall-clock time (both as "UTC" ms). */
function localBucket(local: number, interval: Interval): number {
  if (interval === 'month') {
    const d = new Date(local);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (interval === 'week') {
    const day = Math.floor(local / DAY_MS);
    // 1970-01-01 was a Thursday; (day + 3) % 7 === 0 on Mondays.
    return (day - ((day + 3) % 7)) * DAY_MS;
  }
  return Math.floor(local / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
}

/** Start of the bucket containing `ms`, in a zone (or a fixed offset in minutes). Weeks start on Monday. */
export function bucketStart(ms: number, interval: Interval, zone?: Zone | number): number {
  const z = asZone(zone);
  const off = offsetAt(z, ms);
  // Minutes and hours never straddle an offset change (they happen on the hour), so they use
  // the event's own offset; longer buckets start at local midnight.
  if (interval === 'minute' || interval === 'hour') {
    return localBucket(ms + off, interval) - off;
  }
  return localToUtc(z, localBucket(ms + off, interval));
}

/** Every bucket start from `from` (bucketed) up to `to` (exclusive). Used to fill gaps in time series. */
export function bucketsBetween(
  range: TimeRange,
  interval: Interval,
  zone?: Zone | number,
  max = 2000,
): number[] {
  const z = asZone(zone);
  const out: number[] = [];
  let cursor = bucketStart(range.from, interval, z);
  while (cursor < range.to && out.length < max) {
    out.push(cursor);
    if (interval === 'minute' || interval === 'hour') {
      cursor += INTERVAL_MS[interval];
      continue;
    }
    const local = cursor + offsetAt(z, cursor);
    const nextLocal = interval === 'month' ? addMonths(local, 1) : local + INTERVAL_MS[interval];
    cursor = localToUtc(z, localBucket(nextLocal, interval));
  }
  return out;
}

/** Parse a duration such as `7d`, `24h`, `30m`, `2mo` or a number of seconds into milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input * 1000;
  const m = /^(\d+)\s*(s|m|min|h|d|w|mo)$/i.exec(input.trim());
  if (!m)
    throw new RangeError(
      `Cannot parse duration "${input}". Use e.g. "30m", "24h", "7d" or seconds.`,
    );
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  // A month is 30 days here: durations are lengths (windows, look-backs), not calendar dates.
  const ms = unit === 's' ? 1000 : unit === 'mo' ? 30 * DAY_MS : UNIT_MS[unit]!;
  return n * ms;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
