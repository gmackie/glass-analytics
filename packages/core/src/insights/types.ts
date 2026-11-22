import type { Dialect } from '../sql/dialect.ts';
import { type TimeRange, type Zone, zoneFor } from '../time.ts';

export type Row = Record<string, unknown>;

/** Everything an insight needs to run: where to send SQL, and how to write it. */
export interface QueryContext {
  dialect: Dialect;
  /** Execute one read-only SQL statement and return rows as plain objects. */
  execute(sql: string): Promise<Row[]>;
  /** Project the query is scoped to. */
  project: string;
  /** Override "now" (tests, reproducible reports). */
  now?: number;
  /** The project's IANA time zone, used when a spec names neither `timezone` nor `utcOffsetMinutes`. */
  timezone?: string;
  /** The project's path cleaning rules (paths insights apply them unless told not to). */
  pathCleaning?: { match: string; alias: string }[];
}

/**
 * The zone a spec buckets in: its own `timezone`, else its `utcOffsetMinutes`,
 * else the project's time zone, else UTC. `window` is the span of timestamps read.
 */
export function zoneOf(
  spec: { timezone?: string; utcOffsetMinutes?: number },
  ctx: Pick<QueryContext, 'timezone'>,
  window: TimeRange,
): Zone {
  if (spec.timezone) return zoneFor(spec.timezone, undefined, window);
  if (spec.utcOffsetMinutes !== undefined) return zoneFor(undefined, spec.utcOffsetMinutes, window);
  return zoneFor(ctx.timezone, undefined, window);
}

/** Fields every insight result carries, so agents can always show their working. */
export interface ResultBase {
  kind: string;
  /** A short natural-language summary of the result. */
  summary: string;
  /** The SQL that produced the result, in execution order. */
  sql: string[];
  range: { from: string; to: string };
}

/** Format a number for summaries: 1234 → "1,234", 0.1234 → "12.3%". */
export function fmt(n: number, kind: 'count' | 'percent' | 'decimal' = 'count'): string {
  if (!Number.isFinite(n)) return '–';
  if (kind === 'percent') return `${(n * 100).toFixed(1)}%`;
  if (kind === 'decimal') return n.toFixed(2);
  return Math.round(n).toLocaleString('en-US');
}
