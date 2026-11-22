/**
 * Property references and filters.
 *
 * One filter language is used everywhere: query filters, breakdowns, and
 * feature-flag targeting. A property is written as a short string:
 *
 * | Written as         | Resolves to                                        |
 * | ------------------ | -------------------------------------------------- |
 * | `browser`, `path`… | a built-in column (see FILTERABLE_COLUMNS)          |
 * | `plan`, `props.plan` | the event property `plan`                        |
 * | `person.plan`      | the person property `plan` at the time of the event |
 * | `props.address.city` | a nested event property                          |
 * | `group.company`    | the event's group key of type `company`             |
 * | `group.company.plan` | that group's `plan` property at the time of the event |
 * | `cohort`           | membership of a saved cohort (value: cohort key)    |
 *
 * `cohort` filters use `eq`/`in` ("in any of these cohorts") or `neq`/`not_in`.
 * The server resolves each key to its saved definition before compiling, so
 * core never reads the cohorts table. An event property literally named
 * "cohort" is still reachable as `props.cohort`.
 */

import { FILTERABLE_COLUMNS } from './events.ts';

export type PropertyRef =
  | { kind: 'column'; column: string }
  | { kind: 'event'; path: string[] }
  | { kind: 'person'; path: string[] }
  /** `group.<type>` (path empty: the group key) or `group.<type>.<prop>`. */
  | { kind: 'group'; type: string; path: string[] }
  /** `flag.<key>`: the value of another feature flag (on events: the flags they carried). */
  | { kind: 'flag'; key: string };

/** Prefix for group references: `group.company` (the key) or `group.company.plan`. */
export const GROUP_PREFIX = 'group.';

/** Prefix for flag references: `flag.new-checkout` is that flag's value. */
export const FLAG_PREFIX = 'flag.';

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_not_set',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];
export type FilterValue = string | number | boolean | (string | number)[];

export interface Filter {
  property: string;
  /** Defaults to `eq`. */
  op?: FilterOp;
  value?: FilterValue;
  /** Resolved definitions for a `cohort` filter, keyed by cohort key. Set by the server, never by callers. */
  cohorts?: Record<string, CohortMembers>;
}

/** Pseudo-property that filters on saved-cohort membership. */
export const COHORT_PROPERTY = 'cohort';

/**
 * Prefix for session-level filters: `session.utm_source = google` keeps every
 * event of sessions with a pageview where utm_source is google. Sources (UTM
 * tags, referrer) are only on the landing pageview, so an event-level filter
 * would drop the rest of the visit, including its conversions.
 */
export const SESSION_PREFIX = 'session.';

/** Who is in a cohort: people with a matching event in [from, to). */
export interface CohortMembers {
  project: string;
  from: number;
  to: number;
  /** Only people who did one of these events. */
  events?: string[];
  filters: Filter[];
  /**
   * The membership as SQL selecting `pid` (compiled from a cohort definition, see cohorts.ts).
   * When set, it is used instead of `events`/`filters`.
   */
  sql?: string;
}

export function parseProperty(input: string): PropertyRef {
  const raw = input.trim();
  if (!raw) throw new TypeError('Property name cannot be empty');
  if (raw.startsWith('person.')) return { kind: 'person', path: splitPath(raw.slice(7)) };
  if (raw.startsWith(FLAG_PREFIX) && raw.length > FLAG_PREFIX.length) {
    return { kind: 'flag', key: raw.slice(FLAG_PREFIX.length) };
  }
  if (raw.startsWith(GROUP_PREFIX)) {
    const [type, ...path] = splitPath(raw.slice(GROUP_PREFIX.length));
    return { kind: 'group', type: type!, path };
  }
  if (raw.startsWith('props.')) return { kind: 'event', path: splitPath(raw.slice(6)) };
  if (FILTERABLE_COLUMNS.has(raw)) return { kind: 'column', column: raw };
  return { kind: 'event', path: splitPath(raw) };
}

function splitPath(path: string): string[] {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new TypeError(`Invalid property path "${path}"`);
  return parts;
}

/** Context a feature flag is evaluated against. */
export interface EvaluationContext {
  distinct_id: string;
  user_id?: string | null;
  person?: Record<string, unknown>;
  /** Group type → key, as sent with `glass.group()`. */
  groups?: Record<string, string>;
  /** Group type → that group's properties. */
  groupProps?: Record<string, Record<string, unknown>>;
  /** Saved cohorts the person belongs to (keys), for cohort conditions. */
  cohorts?: readonly string[];
  /** Values of flags already evaluated, for `flag.<key>` conditions. */
  flags?: Record<string, string>;
  country?: string;
  device?: string;
  browser?: string;
  os?: string;
  url?: string;
  path?: string;
  host?: string;
  [column: string]: unknown;
}

function lookup(ctx: EvaluationContext, ref: PropertyRef): unknown {
  if (ref.kind === 'column') return ctx[ref.column];
  if (ref.kind === 'flag') return ctx.flags?.[ref.key];
  if (ref.kind === 'group') {
    if (ref.path.length === 0) return ctx.groups?.[ref.type];
    let value: unknown = ctx.groupProps?.[ref.type];
    for (const key of ref.path) {
      if (value === null || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  // Flags have no event properties; `plan` and `person.plan` both mean the person property.
  let value: unknown = ctx.person;
  for (const key of ref.path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const asText = (v: unknown): string | null =>
  v === undefined || v === null || v === ''
    ? null
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);

/** Evaluate a filter in JavaScript. Mirrors the SQL semantics in `sql/filters.ts`. */
export function matchFilter(filter: Filter, ctx: EvaluationContext): boolean {
  const op = filter.op ?? 'eq';
  if (filter.property === COHORT_PROPERTY) {
    const member = toList(filter.value).some((key) => ctx.cohorts?.includes(key) ?? false);
    return op === 'neq' || op === 'not_in' ? !member : member;
  }
  return compare(op, lookup(ctx, parseProperty(filter.property)), filter.value);
}

/** An event as stream processing sees it (destinations, transformations): JSON already parsed. */
export interface EventLike {
  props: Record<string, unknown>;
  person: Record<string, unknown>;
  flags?: Record<string, string>;
  [column: string]: unknown;
}

function walk(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const key of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/**
 * Evaluate a filter against one event, with query semantics: `plan` is the event property,
 * `person.plan` the person property, `group.company.plan` the group snapshot. Mirrors
 * `sql/filters.ts` so a destination or transformation matches what a query would.
 * Cohort filters can't be evaluated per event here and never match.
 */
export function matchEventFilter(filter: Filter, ev: EventLike): boolean {
  if (filter.property === COHORT_PROPERTY) return false;
  const ref = parseProperty(filter.property);
  const actual = READ[ref.kind](ref as never, ev);
  return compare(
    filter.op ?? 'eq',
    actual === '' && ref.kind === 'column' ? undefined : actual,
    filter.value,
  );
}

type RefOf<K extends PropertyRef['kind']> = Extract<PropertyRef, { kind: K }>;

/** Where each kind of property lives on an event. */
const READ: { [K in PropertyRef['kind']]: (ref: RefOf<K>, ev: EventLike) => unknown } = {
  column: (ref, ev) => ev[ref.column],
  event: (ref, ev) => walk(ev.props, ref.path),
  person: (ref, ev) => walk(ev.person, ref.path),
  flag: (ref, ev) => ev.flags?.[ref.key],
  group: (ref, ev) =>
    ref.path.length === 0
      ? walk(ev.props, ['$groups', ref.type])
      : walk(ev.props, ['$group_props', ref.type, ...ref.path]),
};

const contains = (text: string | null, value: FilterValue | undefined) =>
  text?.toLowerCase().includes(String(value ?? '').toLowerCase()) ?? false;

function compareNumbers(
  op: 'gt' | 'gte' | 'lt' | 'lte',
  actual: unknown,
  value: FilterValue | undefined,
): boolean {
  const a = typeof actual === 'number' ? actual : Number.NaN;
  const b = Number(value);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  return op === 'lt' ? a < b : a <= b;
}

/** Text operators, given the actual value as text (null when unset) and the filter's value. */
const TEXT_OPS: Record<
  Exclude<FilterOp, 'gt' | 'gte' | 'lt' | 'lte'>,
  (text: string | null, value: FilterValue | undefined) => boolean
> = {
  is_set: (text) => text !== null,
  is_not_set: (text) => text === null,
  eq: (text, value) => text !== null && text === asText(value),
  neq: (text, value) => text === null || text !== asText(value),
  contains: (text, value) => contains(text, value),
  not_contains: (text, value) => text === null || !contains(text, value),
  in: (text, value) => text !== null && toList(value).includes(text),
  not_in: (text, value) => text === null || !toList(value).includes(text),
};

function compare(op: FilterOp, actual: unknown, value: FilterValue | undefined): boolean {
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte')
    return compareNumbers(op, actual, value);
  return TEXT_OPS[op](asText(actual), value);
}

export function toList(value: FilterValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}
