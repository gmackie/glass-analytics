/**
 * Paths: the journeys people take, as a chain of steps (pages, events, or both).
 *
 * Each actor (a person's first path in the range, or every session) gets one chain:
 *
 * - step 1 is where the path starts: the first time they did `start`, the first thing they
 *   did at all, or, around a funnel step, the first thing at or after it;
 * - step k+1 is the first step after step k (a different one when repeats collapse), inside
 *   the boundary: the same session, or a window from step 1;
 * - with only `end` (or a funnel's "before"), the chain runs backwards from it instead.
 *
 * There are no window functions: each step is `MIN(ts)` after the previous one, joined back to
 * read what it was, so the same SQL runs on SQLite (D1) and DataFusion (the lake). One query
 * counts the links between neighbouring steps (and drop-offs); another the most common whole
 * paths. Grouping the rare steps into "Other" and the people-per-link filters happen here.
 */

import type { Filter } from '../filters.ts';
import type { Dialect } from '../sql/dialect.ts';
import { type Aggregation, eventsCte, num, parseAggregation, text } from '../sql/source.ts';
import { parseDuration, resolveRange, type TimeRange } from '../time.ts';
import { funnelChain } from './funnel.ts';
import type { PathCleaningRule, PathsSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, type Row } from './types.ts';

export interface PathNode {
  /** `${column}:${label}`, unique in the result. */
  id: string;
  /** Column, 1 = the first step shown. */
  column: number;
  label: string;
  count: number;
  /** How many stopped here (the path ended inside the boundary). Not counted in the last column. */
  dropOff: number;
  /** The rare steps of this column, grouped. */
  other?: boolean;
}

export interface PathLink {
  source: string;
  target: string;
  count: number;
  /** Mean time from source to target. */
  avgSeconds: number | null;
}

export interface PathsResult extends ResultBase {
  kind: 'paths';
  /** "forward" from a start, or "backward" to an end (the end is then the last column). */
  direction: 'forward' | 'backward';
  steps: number;
  /** How many paths: people (or sessions) who have a first step. */
  total: number;
  nodes: PathNode[];
  links: PathLink[];
  /** The most common whole paths, at most 50. */
  topPaths: { items: string[]; count: number }[];
}

/** Dataflare's own events, which are never steps. */
const BOOKKEEPING = [
  '$pageleave',
  '$web_vitals',
  '$exposure',
  '$identify',
  '$set',
  '$groupidentify',
  '$click',
];

const OTHER = 'Other';
const SESSION_SPAN_MS = 86_400_000;

type Spec = PathsSpec;
type Direction = 'forward' | 'backward';

/** Everything the chain needs, worked out once. */
interface Plan {
  spec: Spec;
  d: Dialect;
  n: number;
  direction: Direction;
  aggregation: Aggregation;
  range: TimeRange;
  /** The window from step 1, in ms, or null for "the same session". */
  windowMs: number | null;
  collapse: boolean;
  cleaning: PathCleaningRule[];
}

function validateFunnel(f: NonNullable<Spec['funnel']>): void {
  if ((f.spec.order ?? 'ordered') === 'unordered')
    throw new TypeError('Paths from a funnel need an ordered or strict funnel.');
  const steps = f.spec.steps.length;
  if (f.step > steps)
    throw new RangeError(`The funnel has ${steps} steps; step ${f.step} is past the last.`);
  if (f.mode === 'between' && f.step >= steps)
    throw new RangeError('"between" needs a step before the last one.');
  if (f.mode === 'dropoff' && f.step < 2)
    throw new RangeError('No one drops off before the first step; use step 2 or later.');
}

function validate(spec: Spec): void {
  if (spec.funnel && (spec.start || spec.end))
    throw new TypeError('Paths come from a funnel step, or from start/end points, not both.');
  if (spec.funnel) validateFunnel(spec.funnel);
  const pages = spec.include?.pages ?? true;
  if (!pages && !spec.include?.events) throw new TypeError('Include pages, events, or both.');
}

function directionOf(spec: Spec): Direction {
  if (spec.funnel) return spec.funnel.mode === 'before' ? 'backward' : 'forward';
  return spec.end && !spec.start ? 'backward' : 'forward';
}

function planOf(spec: Spec, ctx: QueryContext): Plan {
  validate(spec);
  const boundary = spec.boundary ?? 'session';
  const own = spec.cleaning ?? [];
  const project = spec.projectCleaning === false ? [] : (ctx.pathCleaning ?? []);
  return {
    spec,
    d: ctx.dialect,
    n: spec.steps ?? 5,
    direction: directionOf(spec),
    aggregation: parseAggregation(spec.aggregateBy),
    range: resolveRange(spec.from, spec.to, ctx.now),
    windowMs: boundary === 'session' ? null : boundary.minutes * 60_000,
    collapse: spec.collapseRepeats ?? true,
    cleaning: [...own, ...project],
  };
}

// ── Steps: what each event is called ──────────────────────────────────────

/** The page path, with the cleaning rules applied (the first match wins). */
function cleanedPath(p: Plan): string {
  if (!p.cleaning.length) return 'path';
  const whens = p.cleaning.map(
    (r) => `WHEN ${p.d.globMatch('path', r.match)} THEN ${p.d.str(r.alias)}`,
  );
  return `(CASE ${whens.join(' ')} ELSE path END)`;
}

function rawItem(p: Plan): string {
  const base = `(CASE WHEN event = '$pageview' THEN ${cleanedPath(p)} ELSE event END)`;
  const key = p.spec.itemProperty;
  if (!key) return base;
  const value = p.d.jsonText('props', [key.replace(/^props\./, '')]);
  return `COALESCE(NULLIF(${value}, ''), ${base})`;
}

/** Steps matching a wildcard group show as the group. */
function groupedItem(p: Plan, item: string): string {
  const groups = p.spec.groups ?? [];
  if (!groups.length) return item;
  const whens = groups.map((g) => `WHEN ${p.d.globMatch(item, g)} THEN ${p.d.str(g)}`);
  return `(CASE ${whens.join(' ')} ELSE ${item} END)`;
}

/** Which events are steps at all. */
function includeSql(p: Plan): string {
  const { d } = p;
  const pages = p.spec.include?.pages ?? true;
  const events = p.spec.include?.events ?? false;
  const parts: string[] = [];
  if (pages) parts.push(`event = '$pageview'`);
  if (Array.isArray(events)) parts.push(`event IN (${events.map((e) => d.str(e)).join(', ')})`);
  else if (events)
    parts.push(
      `(event <> '$pageview' AND event NOT IN (${BOOKKEEPING.map((e) => d.str(e)).join(', ')}))`,
    );
  return `(${parts.join(' OR ')})`;
}

/** How far before and after the range events are read: a path may run past its edges. */
function readRange(p: Plan): TimeRange {
  const span = p.windowMs ?? SESSION_SPAN_MS;
  return {
    from: p.direction === 'backward' ? p.range.from - span : p.range.from,
    to: p.range.to + span,
  };
}

/** `pe`: every step event with its name (`item`), time, session and actor. */
function stepEventsCtes(p: Plan, ctx: QueryContext): string[] {
  const { d } = p;
  const read = readRange(p);
  const ev = eventsCte(d, {
    project: ctx.project,
    from: read.from,
    to: read.to,
    filters: (p.spec.filters as Filter[] | undefined) ?? [],
    aggregation: p.aggregation,
    name: 'pev',
  });
  const item = groupedItem(p, rawItem(p));
  const excluded = (p.spec.exclude ?? []).map((x) => d.globMatch('item', x));
  const where = excluded.length ? `WHERE NOT (${excluded.join(' OR ')})` : '';
  return [
    ev,
    `pe AS (SELECT * FROM (SELECT actor, ts_ms, session_id, ${item} AS item FROM pev WHERE ${includeSql(p)}) pi ${where})`,
  ];
}

// ── Step 1 ────────────────────────────────────────────────────────────────

function pointSql(p: Plan, point: NonNullable<Spec['start']>, alias = 'e'): string {
  const typed =
    (point.type ?? 'page') === 'page' ? `${alias}.item LIKE '/%'` : `${alias}.item NOT LIKE '/%'`;
  return `(${p.d.globMatch(`${alias}.item`, point.value)} AND ${typed})`;
}

/** The moment each path is anchored: `a0 (actor, t0, lim)`. */
function anchorCtes(p: Plan, ctx: QueryContext): string[] {
  const { d, spec } = p;
  const inRange = `e.ts_ms >= ${d.num(p.range.from)} AND e.ts_ms < ${d.num(p.range.to)}`;
  if (spec.funnel) return funnelAnchorCtes(p, ctx);
  const point = p.direction === 'backward' ? spec.end : spec.start;
  const cond = point ? `AND ${pointSql(p, point)}` : '';
  return [
    `a0 AS (SELECT e.actor, MIN(e.ts_ms) AS t0, CAST(NULL AS BIGINT) AS lim FROM pe e WHERE ${inRange} ${cond} GROUP BY e.actor)`,
  ];
}

/** Around a funnel step: the step's time (and, for "between", the next one's). */
function funnelAnchorCtes(p: Plan, ctx: QueryContext): string[] {
  const f = p.spec.funnel!;
  const funnel = { ...f.spec, from: p.spec.from, to: p.spec.to };
  const windowMs = parseDuration(funnel.window ?? '7d');
  const chain = funnelChain(funnel, ctx, p.range, windowMs, {
    bd: `''`,
    extra: [],
    aggregation: p.aggregation,
  });
  const k = f.step;
  const anchors: Record<string, string> = {
    after: `SELECT actor, t${k} AS t0, CAST(NULL AS BIGINT) AS lim FROM f WHERE t${k} IS NOT NULL`,
    before: `SELECT actor, t${k} AS t0, CAST(NULL AS BIGINT) AS lim FROM f WHERE t${k} IS NOT NULL`,
    between: `SELECT actor, t${k} AS t0, t${k + 1} AS lim FROM f WHERE t${k + 1} IS NOT NULL`,
    dropoff: `SELECT actor, t${k - 1} AS t0, CAST(NULL AS BIGINT) AS lim FROM f WHERE t${k - 1} IS NOT NULL AND t${k} IS NULL`,
  };
  return [chain.replace(/^WITH /, '').trimEnd(), `a0 AS (${anchors[f.mode]})`];
}

/** The first step: the first step event at (or, backwards, at or before) the anchor. */
function firstStepCtes(p: Plan): string[] {
  const { d } = p;
  const forward = p.direction === 'forward';
  const cmp = forward ? 'e.ts_ms >= a.t0' : 'e.ts_ms <= a.t0';
  const lim = forward ? ' AND (a.lim IS NULL OR e.ts_ms < a.lim)' : '';
  const span = p.windowMs ?? SESSION_SPAN_MS;
  const near = forward ? `e.ts_ms <= a.t0 + ${d.num(span)}` : `e.ts_ms >= a.t0 - ${d.num(span)}`;
  return [
    `pn1 AS (SELECT a.actor, ${forward ? 'MIN' : 'MAX'}(e.ts_ms) AS ts FROM a0 a JOIN pe e ON e.actor = a.actor AND ${cmp} AND ${near}${lim} GROUP BY a.actor)`,
    `ps1 AS (
  SELECT n.actor, n.ts, MIN(e.item) AS item, MIN(e.session_id) AS sid, n.ts AS t0, MIN(a.lim) AS lim
  FROM pn1 n JOIN a0 a ON a.actor = n.actor JOIN pe e ON e.actor = n.actor AND e.ts_ms = n.ts
  GROUP BY n.actor, n.ts
)`,
  ];
}

// ── Steps 2…n ─────────────────────────────────────────────────────────────

/** What keeps step k inside the path: order, repeats, boundary, the "between" limit, the end. */
function stepConditions(p: Plan): string[] {
  const { d, spec } = p;
  const forward = p.direction === 'forward';
  const out = [forward ? 'e.ts_ms > p.ts' : 'e.ts_ms < p.ts'];
  if (p.collapse) out.push('e.item <> p.item');
  if (p.windowMs === null) out.push('e.session_id = p.sid');
  else
    out.push(
      forward ? `e.ts_ms <= p.t0 + ${d.num(p.windowMs)}` : `e.ts_ms >= p.t0 - ${d.num(p.windowMs)}`,
    );
  if (forward) out.push('(p.lim IS NULL OR e.ts_ms < p.lim)');
  // From start to end: a path stops at the end.
  if (spec.start && spec.end) out.push(`NOT ${pointSql(p, spec.end, 'p')}`);
  return out;
}

function stepCtes(p: Plan, k: number): string[] {
  const agg = p.direction === 'forward' ? 'MIN' : 'MAX';
  const repeat = p.collapse ? ' AND e.item <> p.item' : '';
  return [
    `pn${k} AS (SELECT p.actor, ${agg}(e.ts_ms) AS ts FROM ps${k - 1} p JOIN pe e ON e.actor = p.actor AND ${stepConditions(p).join(' AND ')} GROUP BY p.actor)`,
    `ps${k} AS (
  SELECT n.actor, n.ts, MIN(e.item) AS item, p.sid, p.t0, p.lim
  FROM pn${k} n JOIN ps${k - 1} p ON p.actor = n.actor JOIN pe e ON e.actor = n.actor AND e.ts_ms = n.ts${repeat}
  GROUP BY n.actor, n.ts, p.sid, p.t0, p.lim
)`,
  ];
}

const cols = <T = string>(n: number, f: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i + 1));

/** `pc`: one row per path, `i1…in` (steps, NULL past its end) and `t1…tn` (times). */
function chainCte(p: Plan): string {
  const { n, spec } = p;
  const select = cols(n, (i) => `ps${i}.item AS i${i}, ps${i}.ts AS t${i}`).join(', ');
  const joins = cols(n - 1, (i) => `LEFT JOIN ps${i + 1} ON ps${i + 1}.actor = ps1.actor`).join(
    ' ',
  );
  // From start to end: only paths that got there.
  const reached =
    spec.start && spec.end
      ? `WHERE ${cols(n, (i) => pointSql(p, spec.end!, `ps${i}`)).join(' OR ')}`
      : '';
  return `pc AS (SELECT ps1.actor, ${select} FROM ps1 ${joins} ${reached})`;
}

/** The CTE chain ending in `pc`. */
function pathsChain(p: Plan, ctx: QueryContext): string {
  const ctes = [
    ...stepEventsCtes(p, ctx),
    ...anchorCtes(p, ctx),
    ...firstStepCtes(p),
    ...cols(p.n - 1, (i) => stepCtes(p, i + 1)).flat(),
    chainCte(p),
  ];
  return `WITH ${ctes.join(',\n')}\n`;
}

/** Links between step k and k+1 (k = 1…n-1); a NULL target is a drop-off. */
function linksSql(p: Plan, ctx: QueryContext): string {
  const { d, n } = p;
  const whens = (f: (k: number) => string) =>
    cols(n - 1, (k) => `WHEN ${k} THEN ${f(k)}`).join(' ');
  const ks = cols(n - 1, (k) => `(${k})`).join(', ');
  return `${pathsChain(p, ctx)}SELECT * FROM (
SELECT v.column1 AS k,
  CASE v.column1 ${whens((k) => `pc.i${k}`)} END AS src,
  CASE v.column1 ${whens((k) => `pc.i${k + 1}`)} END AS dst,
  COUNT(*) AS n,
  AVG(CASE v.column1 ${whens((k) => `ABS(pc.t${k + 1} - pc.t${k})`)} END) AS dt
FROM pc CROSS JOIN (VALUES ${ks}) v
WHERE (CASE v.column1 ${whens((k) => `pc.i${k}`)} END) IS NOT NULL
GROUP BY 1, 2, 3
) l
ORDER BY l.n DESC, l.k, l.src, COALESCE(l.dst, '')
LIMIT ${d.num(5000)}`;
}

function topPathsSql(p: Plan, ctx: QueryContext): string {
  const is = cols(p.n, (i) => `pc.i${i}`).join(', ');
  // NULLs sort first in SQLite and last in DataFusion: COALESCE keeps ties in one order.
  const order = cols(p.n, (i) => `COALESCE(pc.i${i}, '')`).join(', ');
  return `${pathsChain(p, ctx)}SELECT ${is}, COUNT(*) AS n FROM pc GROUP BY ${is} ORDER BY n DESC, ${order} LIMIT 50`;
}

export function compilePaths(spec: Spec, ctx: QueryContext): { links: string; topPaths: string } {
  const p = planOf(spec, ctx);
  return { links: linksSql(p, ctx), topPaths: topPathsSql(p, ctx) };
}

// ── Shaping ───────────────────────────────────────────────────────────────

interface RawLink {
  /** Chain position of the source (1 = step 1, which is the last column when backward). */
  k: number;
  src: string;
  dst: string | null;
  n: number;
  dt: number | null;
}

/** The column a chain position is drawn in: backward chains end in the last column. */
const columnOf = (p: Pick<Plan, 'n' | 'direction'>, k: number) =>
  p.direction === 'forward' ? k : p.n + 1 - k;

function rawLinks(rows: Row[]): RawLink[] {
  return rows.map((r) => ({
    k: num(r.k),
    src: text(r.src),
    dst: r.dst === null || r.dst === undefined ? null : text(r.dst),
    n: num(r.n),
    dt: r.dt === null || r.dt === undefined ? null : num(r.dt),
  }));
}

/** How many paths reach each step at each position: what leaves it, or (last) what arrives. */
function positionCounts(links: RawLink[], n: number): Map<string, number>[] {
  const counts = Array.from({ length: n + 1 }, () => new Map<string, number>());
  const add = (k: number, label: string, v: number) =>
    counts[k]!.set(label, (counts[k]!.get(label) ?? 0) + v);
  for (const l of links) {
    add(l.k, l.src, l.n);
    if (l.k === n - 1 && l.dst !== null) add(n, l.dst, l.n);
  }
  return counts;
}

/** Each position's top `perStep` labels; the rest become "Other". */
function keptLabels(counts: Map<string, number>[], perStep: number): Set<string>[] {
  return counts.map(
    (m) =>
      new Set(
        [...m.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, perStep)
          .map(([l]) => l),
      ),
  );
}

interface Grouped {
  nodes: Map<string, PathNode>;
  links: Map<string, PathLink & { seconds: number }>;
}

function nodeAt(g: Grouped, column: number, label: string, other: boolean): PathNode {
  const id = `${column}:${label}`;
  let node = g.nodes.get(id);
  if (!node) {
    node = { id, column, label, count: 0, dropOff: 0, ...(other ? { other: true } : {}) };
    g.nodes.set(id, node);
  }
  return node;
}

function addLink(g: Grouped, source: PathNode, target: PathNode, l: RawLink): void {
  const key = `${source.id}>${target.id}`;
  const link = g.links.get(key) ?? {
    source: source.id,
    target: target.id,
    count: 0,
    avgSeconds: null,
    seconds: 0,
  };
  link.count += l.n;
  link.seconds += ((l.dt ?? 0) / 1000) * l.n;
  g.links.set(key, link);
}

/** Group rare labels into "Other" and turn chain positions into columns. */
function groupLinks(p: Plan, raw: RawLink[]): Grouped {
  const counts = positionCounts(raw, p.n);
  const kept = keptLabels(counts, p.spec.perStep ?? 8);
  const g: Grouped = { nodes: new Map(), links: new Map() };
  const node = (k: number, label: string) => {
    const keep = kept[k]!.has(label);
    return nodeAt(g, columnOf(p, k), keep ? label : OTHER, !keep);
  };
  for (const [k, m] of counts.entries()) for (const [label, c] of m) node(k, label).count += c;
  for (const l of raw) {
    const src = node(l.k, l.src);
    if (l.dst === null) {
      if (p.direction === 'forward') src.dropOff += l.n;
      continue;
    }
    const dst = node(l.k + 1, l.dst);
    if (p.direction === 'forward') addLink(g, src, dst, l);
    else addLink(g, dst, src, l);
  }
  return g;
}

/** Links outside the people-per-link limits go, and nodes left with no links (but column 1). */
function limitLinks(spec: Spec, g: Grouped): { nodes: PathNode[]; links: PathLink[] } {
  const min = spec.minPeople ?? 0;
  const max = spec.maxPeople ?? Number.POSITIVE_INFINITY;
  const links = [...g.links.values()]
    .filter((l) => l.count >= min && l.count <= max)
    .map(({ seconds, ...l }) => ({
      ...l,
      avgSeconds: l.count ? Math.round(seconds / l.count) : null,
    }))
    .sort(
      (a, b) =>
        b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
    );
  const linked = new Set(links.flatMap((l) => [l.source, l.target]));
  const filtering = spec.minPeople !== undefined || spec.maxPeople !== undefined;
  const nodes = [...g.nodes.values()]
    .filter((x) => !filtering || linked.has(x.id))
    .sort(
      (a, b) =>
        a.column - b.column ||
        Number(a.other ?? false) - Number(b.other ?? false) ||
        b.count - a.count ||
        a.label.localeCompare(b.label),
    );
  return { nodes, links };
}

function topPathsOf(rows: Row[], p: Plan): PathsResult['topPaths'] {
  return rows.map((r) => {
    const items = cols<unknown>(p.n, (i) => r[`i${i}`])
      .filter((x) => x !== null && x !== undefined)
      .map(text);
    return { items: p.direction === 'forward' ? items : items.reverse(), count: num(r.n) };
  });
}

function pathsSummary(r: PathsResult, p: Plan): string {
  const noun = p.aggregation === 'session' ? 'sessions' : 'people';
  if (!r.total) return `No paths in this range.`;
  // The most common path that goes somewhere (a single page isn't much of a path).
  const top = r.topPaths.find((x) => x.items.length > 1) ?? r.topPaths[0];
  const first = r.nodes.filter(
    (x) => x.column === (p.direction === 'forward' ? 1 : p.n) && !x.other,
  )[0];
  const parts = [`${fmt(r.total)} ${noun}`];
  if (first)
    parts.push(
      `${p.direction === 'forward' ? 'most start at' : 'most end at'} ${first.label} (${fmt(first.count)})`,
    );
  if (top) parts.push(`the most common path is ${top.items.join(' → ')} (${fmt(top.count)})`);
  return `${parts.join('; ')}.`;
}

export async function runPaths(spec: Spec, ctx: QueryContext): Promise<PathsResult> {
  const p = planOf(spec, ctx);
  const sql = [linksSql(p, ctx), topPathsSql(p, ctx)];
  const [linkRows, topRows] = await Promise.all(sql.map((s) => ctx.execute(s)));
  const raw = rawLinks(linkRows!);
  const { nodes, links } = limitLinks(spec, groupLinks(p, raw));
  const result: PathsResult = {
    kind: 'paths',
    direction: p.direction,
    steps: p.n,
    total: [...positionCounts(raw, p.n)[1]!.values()].reduce((a, b) => a + b, 0),
    nodes,
    links,
    topPaths: topPathsOf(topRows!, p),
    summary: '',
    sql,
    range: { from: new Date(p.range.from).toISOString(), to: new Date(p.range.to).toISOString() },
  };
  result.summary = pathsSummary(result, p);
  return result;
}

// ── Actors ────────────────────────────────────────────────────────────────

export interface PathsSelection {
  /** A node id from the result ("3:/pricing"). */
  node: string;
  /** With a target node in the next column: those who took this link. */
  target?: string;
  /** Those who stopped at `node`. */
  dropOff?: boolean;
}

function parseNode(id: string, p: Plan): { k: number; label: string } {
  const m = /^(\d+):(.*)$/s.exec(id);
  if (!m) throw new TypeError(`"${id}" is not a path node id (column:label).`);
  const column = Number(m[1]);
  if (column < 1 || column > p.n) throw new RangeError(`Column ${column} is outside 1…${p.n}.`);
  if (m[2] === OTHER)
    throw new TypeError('"Other" groups several steps; list one of them, or raise perStep.');
  return { k: columnOf(p, column), label: m[2]! };
}

/** The actors behind a node, a link, or a node's drop-offs. */
export function compilePathsActors(
  spec: Spec,
  ctx: QueryContext,
  selection: PathsSelection,
  page: { limit: number; offset: number },
): string {
  const p = planOf(spec, ctx);
  const { d } = p;
  const at = parseNode(selection.node, p);
  const where = [`pc.i${at.k} = ${d.str(at.label)}`];
  if (selection.target) {
    const to = parseNode(selection.target, p);
    if (Math.abs(to.k - at.k) !== 1) throw new RangeError('A link joins neighbouring columns.');
    where.push(`pc.i${to.k} = ${d.str(to.label)}`);
  } else if (selection.dropOff) {
    if (p.direction === 'backward' || at.k >= p.n)
      throw new RangeError('Drop-offs are counted before the last column of a forward path.');
    where.push(`pc.i${at.k + 1} IS NULL`);
  }
  return `${pathsChain(p, ctx)}SELECT pc.actor AS actor, 1 AS n FROM pc WHERE ${where.join(' AND ')}
ORDER BY pc.actor LIMIT ${d.num(page.limit)} OFFSET ${d.num(page.offset)}`;
}

// ── Cleaning suggestions ──────────────────────────────────────────────────

/** Segments that look like ids: numbers, UUIDs, long hex, dates, and long mixed tokens. */
const ID_SEGMENTS: [RegExp, string][] = [
  [/^\d+$/, ':id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  [/^[0-9a-f]{8,}$/i, ':hash'],
  [/^\d{4}-\d{2}-\d{2}$/, ':date'],
  [/^(?=[a-z0-9_-]{16,}$)(?=.*\d)(?=.*[a-z])[a-z0-9_-]+$/i, ':token'],
];

function idName(segment: string): string | null {
  for (const [re, name] of ID_SEGMENTS) if (re.test(segment)) return name;
  return null;
}

export interface PathRuleSuggestion extends PathCleaningRule {
  /** How many different paths it would merge, and how many page views they had. */
  paths: number;
  views: number;
  examples: string[];
}

/**
 * Cleaning rules for paths that carry ids ("/users/42/settings" → "/users/:id/settings"),
 * from a sample of paths and their view counts. Only patterns that merge two or more paths.
 */
export function suggestPathRules(paths: { path: string; views: number }[]): PathRuleSuggestion[] {
  const groups = new Map<string, PathRuleSuggestion>();
  for (const { path, views } of paths) {
    const segments = path.split('/');
    const names = segments.map(idName);
    if (!names.some(Boolean)) continue;
    const match = segments.map((s, i) => (names[i] ? '*' : s)).join('/');
    const g = groups.get(match) ?? {
      match,
      alias: segments.map((s, i) => names[i] ?? s).join('/'),
      paths: 0,
      views: 0,
      examples: [],
    };
    g.paths += 1;
    g.views += views;
    if (g.examples.length < 3) g.examples.push(path);
    groups.set(match, g);
  }
  return [...groups.values()]
    .filter((g) => g.paths >= 2)
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);
}
