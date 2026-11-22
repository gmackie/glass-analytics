/**
 * Cohorts: saved groups of people, defined by what they are and what they did.
 *
 * A definition is groups of conditions: the person must match all (or any) of
 * the groups, and within a group all (or any) of its conditions. Conditions:
 *
 * | type                 | matches people who…                                              |
 * | -------------------- | ---------------------------------------------------------------- |
 * | property             | have a person (or event) property value in the look-back         |
 * | performed            | did an event at least / exactly / at most N times within a window |
 * | not_performed        | didn't do it within the window                                    |
 * | performed_regularly  | did it in at least K of the last N days, weeks or months          |
 * | first_performed      | did it for the first time ever within the window                  |
 * | stopped              | did it in the window before, but not in the latest one            |
 * | started              | did it in the latest window, but not in the one before            |
 * | sequence             | did one event and then another within a gap                       |
 * | cohort               | are (or aren't) in another saved cohort                           |
 *
 * Every condition compiles to a subquery of person ids (`pid`), so a cohort
 * works as a filter on any insight in both stores. Static cohorts (uploaded or
 * saved from a list of people) have explicit members instead; the service says
 * how to read them (a D1 table, or inlined ids in the lake).
 */

import { z } from 'zod/v4';
import type { Filter } from './filters.ts';
import { filterSchema } from './insights/schemas.ts';
import type { Dialect } from './sql/dialect.ts';
import { filtersSql } from './sql/filters.ts';
import { bucketExpr, resolvedEventsSql } from './sql/source.ts';
import { DAY_MS, parseDuration, parseTime } from './time.ts';

const duration = z
  .union([z.string(), z.number()])
  .describe('A length of time back from now, e.g. "30d", "2w", "6mo" (or seconds).');

const behaviour = {
  event: z.string().describe('Event name, or "*" for any event.'),
  filters: z.array(filterSchema).optional().describe('Conditions on that event.'),
};

export const cohortCondition = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('property'),
    property: z.string().describe('A person property ("person.plan"), event property or column.'),
    op: filterSchema.shape.op,
    value: filterSchema.shape.value,
    negate: z.boolean().optional().describe('People who do NOT match.'),
  }),
  z.object({
    type: z.literal('performed'),
    ...behaviour,
    count: z
      .object({
        op: z.enum(['gte', 'eq', 'lte']).describe('At least, exactly, or at most.'),
        value: z.number().int().min(0),
      })
      .optional()
      .describe('How many times. Default: at least once.'),
    within: duration.optional().describe('Window back from now. Default "30d".'),
  }),
  z.object({
    type: z.literal('not_performed'),
    ...behaviour,
    within: duration.optional().describe('Window back from now. Default "30d".'),
  }),
  z.object({
    type: z.literal('performed_regularly'),
    ...behaviour,
    period: z.enum(['day', 'week', 'month']),
    periods: z.number().int().min(1).max(52).describe('How many recent periods to look at.'),
    minPeriods: z.number().int().min(1).describe('In at least this many of them.'),
  }),
  z.object({
    type: z.literal('first_performed'),
    ...behaviour,
    within: duration
      .optional()
      .describe('Their first time ever was within this window. Default "30d".'),
  }),
  z.object({
    type: z.literal('stopped'),
    ...behaviour,
    within: duration.describe('The recent window they did NOT do it in, e.g. "14d".'),
    before: duration
      .optional()
      .describe('The window before it they DID do it in. Default the same length.'),
  }),
  z.object({
    type: z.literal('started'),
    ...behaviour,
    within: duration.describe('The recent window they did it in, e.g. "7d".'),
    before: duration
      .optional()
      .describe('The window before it they did NOT do it in. Default the same length.'),
  }),
  z.object({
    type: z.literal('sequence'),
    ...behaviour,
    followedBy: z.object(behaviour).describe('The event that must follow.'),
    gap: duration.optional().describe('At most this long between them. Default "1d".'),
    within: duration.optional().describe('Both within this window. Default "30d".'),
  }),
  z.object({
    type: z.literal('cohort'),
    key: z.string().describe('Another saved cohort.'),
    negate: z.boolean().optional().describe('People NOT in it.'),
  }),
]);

export type CohortCondition = z.infer<typeof cohortCondition>;

export const cohortGroup = z.object({
  match: z.enum(['all', 'any']).optional().describe('Match all conditions (default) or any.'),
  conditions: z.array(cohortCondition).min(1).max(20),
});

export const cohortDefinitionV2 = z
  .object({
    match: z.enum(['all', 'any']).optional().describe('Match all groups (default) or any.'),
    groups: z.array(cohortGroup).min(1).max(10),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'How far back people are considered at all (and property conditions look). Default "-90d".',
      ),
  })
  .describe('Groups of conditions; see docs/queries.md#cohorts.');

export type CohortDefinition = z.infer<typeof cohortDefinitionV2>;

/** A version-1 definition: filters on events in a look-back, optionally on one event. */
export interface LegacyCohortDefinition {
  filters?: Filter[];
  didEvent?: string;
  from?: string | number;
}

/** Read any stored definition as version 2. */
export function normaliseCohort(raw: unknown, now = Date.now()): CohortDefinition {
  const v2 = cohortDefinitionV2.safeParse(raw);
  if (v2.success) return v2.data;
  // Version 1 meant: people with an event (of `didEvent`, if set) in the look-back that matches
  // every filter. That is one "performed" condition with those filters on the same event.
  const old = (raw ?? {}) as LegacyCohortDefinition;
  const from = old.from ?? '-90d';
  return {
    match: 'all',
    groups: [
      {
        match: 'all',
        conditions: [
          {
            type: 'performed',
            event: old.didEvent || '*',
            ...(old.filters?.length ? { filters: old.filters } : {}),
            within: lookbackSeconds(from, now),
          },
        ],
      },
    ],
    from,
  };
}

/** A v1 look-back ("-90d", an ISO date) as seconds back from now, for the equivalent condition. */
function lookbackSeconds(from: string | number | undefined, now = Date.now()): number {
  const start = parseTime(from ?? '-90d', now);
  return Math.max(1, Math.round((now - start) / 1000));
}

export interface CohortContext {
  dialect: Dialect;
  project: string;
  now: number;
  /** Another saved cohort's definition, or "static" for a cohort with explicit members. */
  lookup(key: string): CohortDefinition | 'static' | undefined;
  /** SQL selecting `pid` for a static cohort's members. */
  staticMembers(key: string): string;
}

type ConditionOf<K extends CohortCondition['type']> = Extract<CohortCondition, { type: K }>;

/** One condition as SQL selecting `pid`; `negate` means "not in" it. */
interface Part {
  sql: string;
  negate: boolean;
}

/** What compiling one definition needs: the context, the time windows seen, the reference chain. */
interface Compiler {
  d: Dialect;
  ctx: CohortContext;
  now: number;
  universeFrom: number;
  windows: number[];
  stack: string[];
}

function eventsSql(
  k: Compiler,
  from: number,
  to: number,
  b: { event: string; filters?: Filter[] },
): string {
  return resolvedEventsSql(k.d, {
    project: k.ctx.project,
    from,
    to,
    events: b.event === '*' ? undefined : [b.event],
    filters: b.filters as Filter[] | undefined,
  });
}

/** The start of a look-back window, recorded so the universe covers it. */
function lookback(k: Compiler, within: string | number | undefined): number {
  const from = k.now - parseDuration(within ?? '30d');
  k.windows.push(from);
  return from;
}

const until = (k: Compiler) => k.now + 60_000;

function propertyPart(c: ConditionOf<'property'>, k: Compiler): Part {
  const filter = { property: c.property, op: c.op, value: c.value } as Filter;
  const people = resolvedEventsSql(k.d, {
    project: k.ctx.project,
    from: k.universeFrom,
    to: until(k),
  });
  return {
    sql: `SELECT DISTINCT cp.pid FROM (${people}) cp WHERE ${filtersSql([filter], k.d, 'cp')}`,
    negate: Boolean(c.negate),
  };
}

const COUNT_SYMBOL = { gte: '>=', eq: '=', lte: '<=' } as const;

function performedPart(c: ConditionOf<'performed'>, k: Compiler): Part {
  const from = lookback(k, c.within);
  const count = c.count ?? { op: 'gte' as const, value: 1 };
  if (count.op === 'gte' && count.value <= 0)
    return {
      sql: `SELECT DISTINCT pe.pid FROM (${eventsSql(k, k.universeFrom, until(k), { event: '*' })}) pe`,
      negate: false,
    };
  const counted = `SELECT pe.pid FROM (${eventsSql(k, from, until(k), c)}) pe GROUP BY pe.pid HAVING COUNT(*)`;
  // "At most N" (or exactly 0) includes people who never did it: everyone but those who did more.
  const atMost =
    (count.op === 'lte' && count.value >= 0) || (count.op === 'eq' && count.value === 0);
  if (atMost)
    return { sql: `${counted} > ${k.d.num(count.op === 'eq' ? 0 : count.value)}`, negate: true };
  return { sql: `${counted} ${COUNT_SYMBOL[count.op]} ${k.d.num(count.value)}`, negate: false };
}

function notPerformedPart(c: ConditionOf<'not_performed'>, k: Compiler): Part {
  const from = lookback(k, c.within);
  return {
    sql: `SELECT DISTINCT pe.pid FROM (${eventsSql(k, from, until(k), c)}) pe`,
    negate: true,
  };
}

const PERIOD_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS } as const;

function regularlyPart(c: ConditionOf<'performed_regularly'>, k: Compiler): Part {
  if (c.minPeriods > c.periods) throw new RangeError('minPeriods cannot be more than periods.');
  const from = k.now - c.periods * PERIOD_MS[c.period];
  k.windows.push(from);
  const periods = `SELECT DISTINCT pe.pid, ${bucketExpr(k.d, 'pe.ts_ms', c.period)} AS b FROM (${eventsSql(k, from, until(k), c)}) pe`;
  return {
    sql: `SELECT pr.pid FROM (${periods}) pr GROUP BY pr.pid HAVING COUNT(*) >= ${k.d.num(c.minPeriods)}`,
    negate: false,
  };
}

function firstPerformedPart(c: ConditionOf<'first_performed'>, k: Compiler): Part {
  const from = lookback(k, c.within);
  // First ever: all history, not just the window.
  return {
    sql: `SELECT pe.pid FROM (${eventsSql(k, 0, until(k), c)}) pe GROUP BY pe.pid HAVING MIN(pe.ts_ms) >= ${k.d.num(from)}`,
    negate: false,
  };
}

function changedPart(c: ConditionOf<'stopped' | 'started'>, k: Compiler): Part {
  const split = k.now - parseDuration(c.within);
  const start = split - parseDuration(c.before ?? c.within);
  k.windows.push(start);
  const before = `SELECT DISTINCT pe.pid FROM (${eventsSql(k, start, split, c)}) pe`;
  const after = `SELECT DISTINCT pe.pid FROM (${eventsSql(k, split, until(k), c)}) pe`;
  const [did, didNot] = c.type === 'stopped' ? [before, after] : [after, before];
  return { sql: `SELECT dn.pid FROM (${did}) dn WHERE dn.pid NOT IN (${didNot})`, negate: false };
}

function sequencePart(c: ConditionOf<'sequence'>, k: Compiler): Part {
  const from = lookback(k, c.within);
  const gap = parseDuration(c.gap ?? '1d');
  return {
    sql: `SELECT DISTINCT sa.pid FROM (${eventsSql(k, from, until(k), c)}) sa JOIN (${eventsSql(k, from, until(k), c.followedBy)}) sb
  ON sb.pid = sa.pid AND sb.ts_ms > sa.ts_ms AND sb.ts_ms <= sa.ts_ms + ${k.d.num(gap)}`,
    negate: false,
  };
}

function cohortPart(c: ConditionOf<'cohort'>, k: Compiler): Part {
  if (k.stack.includes(c.key))
    throw new TypeError(
      `Cohorts refer to each other in a loop: ${[...k.stack, c.key].join(' → ')}.`,
    );
  const other = k.ctx.lookup(c.key);
  if (other === undefined) throw new TypeError(`No cohort "${c.key}" to refer to.`);
  const sql =
    other === 'static'
      ? k.ctx.staticMembers(c.key)
      : compileCohort(other, k.ctx, [...k.stack, c.key]);
  return { sql, negate: Boolean(c.negate) };
}

const PARTS: { [K in CohortCondition['type']]: (c: ConditionOf<K>, k: Compiler) => Part } = {
  property: propertyPart,
  performed: performedPart,
  not_performed: notPerformedPart,
  performed_regularly: regularlyPart,
  first_performed: firstPerformedPart,
  stopped: changedPart,
  started: changedPart,
  sequence: sequencePart,
  cohort: cohortPart,
};

function conditionSql(c: CohortCondition, k: Compiler): string {
  const { sql, negate } = (PARTS[c.type] as (c: CohortCondition, k: Compiler) => Part)(c, k);
  return `u.pid ${negate ? 'NOT IN' : 'IN'} (${sql})`;
}

/** Membership as SQL selecting `pid`. Throws on unknown or circular references. */
export function compileCohort(
  def: CohortDefinition,
  ctx: CohortContext,
  stack: string[] = [],
): string {
  const universeFrom = parseTime(def.from ?? '-90d', ctx.now);
  const k: Compiler = {
    d: ctx.dialect,
    ctx,
    now: ctx.now,
    universeFrom,
    windows: [universeFrom],
    stack,
  };
  const groups = def.groups.map(
    (g) =>
      `(${g.conditions.map((c) => conditionSql(c, k)).join(g.match === 'any' ? ' OR ' : ' AND ')})`,
  );
  // Everyone seen in the longest window any condition looks at: "did not" needs someone to not do it.
  const universe = `SELECT DISTINCT ue.pid FROM (${resolvedEventsSql(k.d, { project: ctx.project, from: Math.min(...k.windows), to: until(k) })}) ue`;
  return `SELECT u.pid FROM (${universe}) u WHERE ${groups.join(def.match === 'any' ? ' OR ' : ' AND ')}`;
}

/** Keys of the other cohorts a definition refers to (for listings and cycle checks). */
export function cohortReferences(def: CohortDefinition): string[] {
  return def.groups.flatMap((g) =>
    g.conditions.flatMap((c) => (c.type === 'cohort' ? [c.key] : [])),
  );
}

/** A one-line description of a definition, for summaries. */
const OP_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  contains: 'contains',
  not_contains: "doesn't contain",
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_set: 'is set',
  is_not_set: 'is not set',
};

const UNIT_WORDS: Record<string, string> = {
  s: 'second',
  m: 'minute',
  min: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  mo: 'month',
};

/** "30d" → "30 days", "1w" → "1 week"; anything else as given (seconds as "N seconds"). */
export function durationWords(input: string | number): string {
  if (typeof input === 'number') return `${input} second${input === 1 ? '' : 's'}`;
  const m = /^(\d+)\s*(s|m|min|h|d|w|mo)$/i.exec(input.trim());
  if (!m) return input;
  const n = Number(m[1]);
  return `${n} ${UNIT_WORDS[m[2]!.toLowerCase()]}${n === 1 ? '' : 's'}`;
}

const COUNT_WORDS = { gte: 'at least', eq: 'exactly', lte: 'at most' } as const;

const quoted = (v: unknown) =>
  v === undefined
    ? ''
    : ` ${Array.isArray(v) ? v.map((x) => JSON.stringify(x)).join(', ') : JSON.stringify(v)}`;

const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`;
const lastWindow = (within: string | number | undefined) =>
  `in the last ${durationWords(within ?? '30d')}`;

function describeProperty(c: ConditionOf<'property'>): string {
  const op = c.op ?? 'eq';
  const value = op === 'is_set' || op === 'is_not_set' ? '' : quoted(c.value);
  return `${c.negate ? 'not: ' : ''}${c.property} ${OP_WORDS[op] ?? op}${value}`;
}

function describePerformed(c: ConditionOf<'performed'>): string {
  const count = c.count ? ` ${COUNT_WORDS[c.count.op]} ${times(c.count.value)}` : '';
  return `did ${c.event}${count} ${lastWindow(c.within)}`;
}

const DESCRIBE: {
  [K in CohortCondition['type']]: (c: ConditionOf<K>, names?: Map<string, string>) => string;
} = {
  property: describeProperty,
  performed: describePerformed,
  not_performed: (c) => `didn't do ${c.event} ${lastWindow(c.within)}`,
  performed_regularly: (c) =>
    `did ${c.event} in at least ${c.minPeriods} of the last ${c.periods} ${c.period}s`,
  first_performed: (c) => `first did ${c.event} ${lastWindow(c.within)}`,
  stopped: (c) => `stopped doing ${c.event} (none in the last ${durationWords(c.within)})`,
  started: (c) => `started doing ${c.event} (in the last ${durationWords(c.within)})`,
  sequence: (c) =>
    `did ${c.event} then ${c.followedBy.event} within ${durationWords(c.gap ?? '1d')}`,
  cohort: (c, names) => {
    const name = names?.get(c.key);
    return `${c.negate ? 'not in' : 'in'} cohort ${name ? `"${name}"` : c.key}`;
  },
};

/**
 * A definition in plain words, e.g. "did report at least 3 times in the last 7 days".
 * `names` turns referenced cohort keys into their names.
 */
export function describeCohort(def: CohortDefinition, names?: Map<string, string>): string {
  const one = (c: CohortCondition) =>
    (DESCRIBE[c.type] as (c: CohortCondition, names?: Map<string, string>) => string)(c, names);
  return def.groups
    .map((g) => g.conditions.map(one).join(g.match === 'any' ? ' or ' : ' and '))
    .map((s) => (def.groups.length > 1 ? `(${s})` : s))
    .join(def.match === 'any' ? ' or ' : ' and ');
}
