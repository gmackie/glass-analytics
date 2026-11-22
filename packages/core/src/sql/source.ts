/**
 * Building blocks shared by all insight compilers.
 */

import { COHORT_PROPERTY, type CohortMembers, type Filter, SESSION_PREFIX } from '../filters.ts';
import {
  DAY_MS,
  fixedZone,
  HOUR_MS,
  type Interval,
  localThreshold,
  MINUTE_MS,
  WEEK_MS,
  type Zone,
} from '../time.ts';
import { assertSafeKey, type Dialect } from './dialect.ts';
import { filtersSql } from './filters.ts';

/**
 * What a query counts: people (the default), sessions, or groups of a type
 * (`{ group: "company" }`, from `glass.group("company", id)`). Compilers count
 * the `actor` column that `eventsCte` adds, so every insight can aggregate by any
 * of them.
 */
export type Aggregation = 'person' | 'session' | { group: string };

/** Parse a spec's `aggregateBy` ("person", "session" or a group type). */
export function parseAggregation(value: string | null | undefined): Aggregation {
  if (!value || value === 'person' || value === 'persons' || value === 'users') return 'person';
  if (value === 'session' || value === 'sessions') return 'session';
  const type = value.startsWith('group.') ? value.slice(6) : value;
  assertSafeKey(type);
  return { group: type };
}

/** Human noun for summaries: "people", "sessions", "companies". */
export function actorNoun(a: Aggregation, n = 2): string {
  if (a === 'person') return n === 1 ? 'person' : 'people';
  if (a === 'session') return n === 1 ? 'session' : 'sessions';
  return n === 1 ? a.group : `${a.group} groups`;
}

export interface SourceOptions {
  project: string;
  /** Inclusive, epoch ms. */
  from: number;
  /** Exclusive, epoch ms. */
  to: number;
  /** Restrict to these event names (pushes the filter down for cheaper scans). */
  events?: readonly string[];
  filters?: readonly Filter[];
  /** What the `actor` column holds. Defaults to the person. */
  aggregation?: Aggregation;
  /** CTE name. Default "ev". */
  name?: string;
}

/**
 * The `ev` CTE every query starts from: events in range for one project, plus a
 * resolved `pid` (person id).
 *
 * Identity resolution happens here, at query time, so it is correct in both
 * stores without rewriting old rows:
 *
 * - events that carry a `user_id` belong to that user;
 * - anonymous events belong to whichever user their `distinct_id` was later
 *   linked to by `identify()` (the `identities` table), or else to the device.
 *
 * This is what makes a funnel like "visited pricing → signed up → purchased"
 * connect the anonymous pricing visit to the person who later signed up.
 */
export function eventsCte(d: Dialect, o: SourceOptions): string {
  // Cohort filters test the resolved person id, which only exists after the identity join.
  const cohort = (o.filters ?? []).filter((f) => f.property === COHORT_PROPERTY);
  const rows = resolvedEvents(d, {
    ...o,
    filters: (o.filters ?? []).filter((f) => f.property !== COHORT_PROPERTY),
  });
  const name = o.name ?? 'ev';
  if (cohort.length === 0) return `${name} AS (\n  ${rows}\n)`;
  return `${name} AS (\n  SELECT * FROM (\n  ${rows}\n  ) ev_all\n  WHERE ${filtersSql(cohort, d)}\n)`;
}

/** Distinct person ids in a cohort, as a subquery for `pid IN (…)`. */
export function cohortMembersSql(d: Dialect, c: CohortMembers): string {
  if (c.sql) return c.sql;
  const filters = c.filters.filter((f) => f.property !== COHORT_PROPERTY);
  return `SELECT DISTINCT cm.pid FROM (${resolvedEvents(d, { project: c.project, from: c.from, to: c.to, events: c.events, filters })}) cm`;
}

/** Events in range with their resolved person (`pid`) and `actor`, as a plain SELECT (no CTE). */
export function resolvedEventsSql(d: Dialect, o: SourceOptions): string {
  const filters = (o.filters ?? []).filter((f) => f.property !== COHORT_PROPERTY);
  const cohort = (o.filters ?? []).filter((f) => f.property === COHORT_PROPERTY);
  const rows = resolvedEvents(d, { ...o, filters });
  if (cohort.length === 0) return rows;
  return `SELECT * FROM (${rows}) ev_all WHERE ${filtersSql(cohort, d)}`;
}

function resolvedEvents(d: Dialect, o: SourceOptions): string {
  const where = [
    `e.project = ${d.str(o.project)}`,
    `e.ts_ms >= ${d.num(Math.floor(o.from))}`,
    `e.ts_ms < ${d.num(Math.ceil(o.to))}`,
  ];
  if (o.events && o.events.length > 0 && !o.events.includes('*')) {
    const unique = [...new Set(o.events)];
    where.push(`e.event IN (${unique.map((n) => d.str(n)).join(', ')})`);
  }
  const sessionFilters = (o.filters ?? []).filter((f) => f.property.startsWith(SESSION_PREFIX));
  const eventFilters = (o.filters ?? []).filter((f) => !f.property.startsWith(SESSION_PREFIX));
  if (eventFilters.length > 0) where.push(filtersSql(eventFilters, d, 'e'));
  if (sessionFilters.length > 0) {
    // Sessions with a pageview matching the conditions. A session's landing can precede the range by a little.
    const inner = sessionFilters.map((f) => ({
      ...f,
      property: f.property.slice(SESSION_PREFIX.length),
    }));
    where.push(`e.session_id IN (
      SELECT sf.session_id FROM ${d.table('events')} sf
      WHERE sf.project = ${d.str(o.project)}
        AND sf.ts_ms >= ${d.num(Math.floor(o.from) - 86_400_000)}
        AND sf.ts_ms < ${d.num(Math.ceil(o.to))}
        AND sf.event = '$pageview'
        AND ${filtersSql(inner, d, 'sf')}
    )`);
  }
  const pid = `CASE WHEN e.user_id IS NOT NULL AND e.user_id <> '' THEN e.user_id ELSE COALESCE(i.person_id, e.person_id) END`;
  const aggregation = o.aggregation ?? 'person';
  const actor =
    aggregation === 'person'
      ? pid
      : aggregation === 'session'
        ? 'e.session_id'
        : d.jsonText('e.props', ['$groups', aggregation.group]);
  // Events outside any session or group don't count when aggregating by them.
  if (aggregation !== 'person') where.push(`${actor} IS NOT NULL AND ${actor} <> ''`);
  return `SELECT e.*,
    ${pid} AS pid,
    ${actor} AS actor
  FROM ${d.table('events')} e
  LEFT JOIN (
    SELECT distinct_id, MIN(person_id) AS person_id
    FROM ${d.table('identities')}
    WHERE project = ${d.str(o.project)}
    GROUP BY distinct_id
  ) i ON i.distinct_id = e.distinct_id
  WHERE ${where.join('\n    AND ')}`;
}

/** The UTC offset (ms) in force at `tsMs`, as SQL: a literal, or a CASE over the zone's changes. */
export function offsetSql(d: Dialect, tsMs: string, zone: Zone): string {
  const s = zone.segments;
  if (s.length === 1) return d.num(s[0]!.offsetMs);
  const branches = s
    .slice(1)
    .map((seg, i) => `WHEN ${tsMs} < ${d.num(seg.start)} THEN ${d.num(s[i]!.offsetMs)}`);
  return `(CASE ${branches.join(' ')} ELSE ${d.num(s.at(-1)!.offsetMs)} END)`;
}

/** The offset to subtract from a local wall-clock time to get UTC (see `localToUtc` in time.ts). */
function localOffsetSql(d: Dialect, localMs: string, zone: Zone): string {
  const s = zone.segments;
  if (s.length === 1) return d.num(s[0]!.offsetMs);
  const branches = s
    .slice(1)
    .map(
      (seg, i) =>
        `WHEN ${localMs} < ${d.num(localThreshold(s[i]!.offsetMs, seg))} THEN ${d.num(s[i]!.offsetMs)}`,
    );
  return `(CASE ${branches.join(' ')} ELSE ${d.num(s.at(-1)!.offsetMs)} END)`;
}

/** `tsMs` as local wall-clock milliseconds in the zone. */
export function localTimeSql(d: Dialect, tsMs: string, zone: Zone): string {
  const s = zone.segments;
  if (s.length === 1 && s[0]!.offsetMs === 0) return tsMs;
  return `(${tsMs} + ${offsetSql(d, tsMs, zone)})`;
}

/**
 * Start of the bucket containing `tsMs`, as epoch ms, computed in SQL.
 * Minutes, hours, days and weeks are integer arithmetic (identical in every
 * engine); months need calendar logic, delegated to the dialect. In a zone with
 * daylight saving, days start at local midnight on both sides of a change,
 * matching `bucketStart()` in time.ts exactly.
 */
export function bucketExpr(
  d: Dialect,
  tsMs: string,
  interval: Interval,
  zone: Zone | number = 0,
): string {
  const z = typeof zone === 'number' ? fixedZone(zone) : zone;
  const utc = z.segments.length === 1 && z.segments[0]!.offsetMs === 0;
  const local = localTimeSql(d, tsMs, z);
  if (interval === 'minute' || interval === 'hour') {
    const unit = interval === 'minute' ? MINUTE_MS : HOUR_MS;
    if (utc) return `((${tsMs} / ${unit}) * ${unit})`;
    return `(((${local}) / ${unit}) * ${unit} - ${offsetSql(d, tsMs, z)})`;
  }
  let start: string;
  switch (interval) {
    case 'day':
      start = `((${local} / ${DAY_MS}) * ${DAY_MS})`;
      break;
    case 'week': {
      // Weeks start on Monday. Day 0 (1970-01-01) was a Thursday, so (day + 3) % 7 is 0 on Mondays.
      const day = `(${local} / ${DAY_MS})`;
      start = `((${day} - ((${day} + 3) % 7)) * ${DAY_MS})`;
      break;
    }
    case 'month':
      start = d.monthStartMs(local);
      break;
  }
  if (utc) return start;
  return `(${start} - ${localOffsetSql(d, start, z)})`;
}

/** Length of a fixed interval in ms (weeks and below). */
export function fixedIntervalMs(interval: Exclude<Interval, 'month'>): number {
  return interval === 'minute'
    ? MINUTE_MS
    : interval === 'hour'
      ? HOUR_MS
      : interval === 'day'
        ? DAY_MS
        : WEEK_MS;
}

/** Normalise numeric cells: engines may return integers as strings or bigints. */
export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
