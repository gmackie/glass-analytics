/**
 * Event ingest: `POST /e` (browsers and servers) and `POST /api/import` (history, with a key).
 *
 * The pipeline, in order:
 *
 *   1. parse      — accept a WireBatch (text/plain JSON, no CORS preflight)
 *   2. admit      — known project, allowed origin, not a bot (public ingest only)
 *   3. validate   — drop malformed events individually, never the whole batch
 *   4. identity   — apply identify() links, person and group property updates
 *   5. resolve    — person_id for every event + snapshots of person and group properties
 *   6. enrich     — clock-skew correction, URL/UTM parsing, referrer, geo, user agent
 *   7. extend     — the enrichers registered in `ENRICHERS` (error issues, revenue, …)
 *   8. write      — hand the rows to the event store
 *
 * Steps 4–6 are separate functions so they can be tested and extended
 * independently (see docs/extending.md, "Enriching events").
 *
 * Public ingest corrects timestamps for the sender's clock and accepts events up to 7 days
 * old (a browser that was offline). Imports are trusted: they keep their timestamps however
 * old, so a history from another tool lands on the right days.
 */

import {
  isValidEventName,
  MAX_GROUP_TYPES,
  type StoredEvent,
  SYSTEM_EVENTS,
  type WireBatch,
  type WireEvent,
} from '@dataflare/core/events';
import { sha256Hex } from '@dataflare/core/hash';
import type { ProjectSettings } from '@dataflare/core/settings';
import { isMinors, sanitizeMinorsEvent } from '@dataflare/core/student-policy';
import { isBot, parseUserAgent } from '@dataflare/core/ua';
import { parsePage, referrerHost, trimTrailingSlashes } from '@dataflare/core/url';
import type { D1Database, Env } from './env.ts';
import { HttpError, readJson } from './http.ts';
import { getProject, type Project } from './projects.ts';
import type { EventStore } from './stores/types.ts';
import { getPolicy } from './student-mode.ts';
import { recordFilteredPageviews } from './traffic-collection.ts';

const MAX_EVENTS = 200;
const MAX_IMPORT_EVENTS = 1000;
const MAX_PROPS_BYTES = 8_000;
const MAX_GROUP_PROPS_BYTES = 4_000;
const MAX_PAST_MS = 7 * 86_400_000;
const SESSION_BUCKET_MS = 30 * 60_000;
/** Group types and keys: printable, no quotes or backslashes (they become JSON paths in SQL). */
const GROUP_TYPE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/;

/** What we know about the sender from the request itself. */
export interface RequestInfo {
  ip: string;
  userAgent: string;
  origin: string | null;
  country: string;
  region: string;
  city: string;
}

export function requestInfo(request: Request): RequestInfo {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  return {
    ip:
      request.headers.get('CF-Connecting-IP') ??
      request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
      '',
    userAgent: request.headers.get('User-Agent') ?? '',
    origin: request.headers.get('Origin'),
    country: String(cf.country ?? request.headers.get('CF-IPCountry') ?? ''),
    region: String(cf.region ?? ''),
    city: String(cf.city ?? ''),
  };
}

export interface IngestResult {
  accepted: number;
  dropped: number;
}

/** Hooks that run on rows after enrichment and before the write. Later features register here. */
export type Enricher = (rows: StoredEvent[], ctx: EnrichContext) => Promise<StoredEvent[]>;

export interface EnrichContext {
  project: Project;
  env: Env;
  store: EventStore;
  now: number;
  /** An import or a server SDK with a key, rather than public ingest. */
  trusted: boolean;
  /** The Worker's public base URL (for links in alerts). */
  base: string;
}

/** Registered enrichers, in order. Each may change, drop or add rows. */
export const ENRICHERS: Enricher[] = [];

/** Hooks that run after the write (destinations), with the rows exactly as stored. */
export type AfterWrite = (rows: StoredEvent[], ctx: EnrichContext) => Promise<void>;
export const AFTER_WRITE: AfterWrite[] = [];

export async function handleIngest(
  request: Request,
  env: Env,
  store: EventStore,
  now = Date.now(),
  base?: string,
): Promise<IngestResult> {
  const info = requestInfo(request);
  const batch = await readJson<Partial<WireBatch>>(request, 1_000_000);
  const project = await admitBatch(env, batch);
  if (
    project.allowedOrigins.length > 0 &&
    info.origin &&
    !project.allowedOrigins.includes(info.origin)
  ) {
    throw new HttpError(403, `Origin ${info.origin} is not allowed for project "${project.id}"`);
  }
  // Server-side senders often have no user agent; only browsers that look like bots are dropped.
  if (info.userAgent && isBot(info.userAgent)) {
    const views = batch
      .events!.slice(0, MAX_EVENTS)
      .filter(isWellFormed)
      .filter((e) => e.event === SYSTEM_EVENTS.pageview);
    const skew = typeof batch.sent_at === 'number' ? now - batch.sent_at : 0;
    await recordFilteredPageviews(env, project.id, views, (e) =>
      eventTime(e, { now, skew, trusted: false }),
    );
    return { accepted: 0, dropped: batch.events!.length };
  }
  return ingestBatch(batch as WireBatch, project, info, env, store, now, { trusted: false, base });
}

/**
 * `POST /api/import` (server or admin key): events with their own timestamps, for a history
 * from another tool or a backfill. Up to 1,000 events per request; ids de-duplicate retries.
 */
export async function handleImport(
  request: Request,
  env: Env,
  store: EventStore,
  now = Date.now(),
  options: { skipDestinations?: boolean; base?: string } = {},
): Promise<IngestResult & { project: string }> {
  const info = requestInfo(request);
  const batch = await readJson<Partial<WireBatch> & { skip_destinations?: boolean }>(
    request,
    5_000_000,
  );
  const project = await admitBatch(env, batch);
  if (batch.events!.length > MAX_IMPORT_EVENTS) {
    throw new HttpError(
      413,
      `At most ${MAX_IMPORT_EVENTS} events per import request`,
      'Send the history in chunks; `dataflare import` does this for you.',
    );
  }
  const result = await ingestBatch(batch as WireBatch, project, info, env, store, now, {
    trusted: true,
    skipDestinations: options.skipDestinations ?? batch.skip_destinations !== false,
    base: options.base,
  });
  return { ...result, project: project.id };
}

async function admitBatch(env: Env, batch: Partial<WireBatch>): Promise<Project> {
  if (typeof batch.project !== 'string' || !Array.isArray(batch.events)) {
    throw new HttpError(400, 'Expected { project, events: [...] }');
  }
  const project = await getProject(env.DB, batch.project);
  if (!project) {
    throw new HttpError(
      404,
      `Unknown project "${batch.project}"`,
      'Create it with `dataflare projects add <id>` or check data-project.',
    );
  }
  return project;
}

/**
 * Student mode: the server decides what is kept, whatever the SDK or importer sent. Events are
 * reduced to the project's allow-lists and the request's region and city are dropped.
 */
async function applyStudentPolicy(
  env: Env,
  projectId: string,
  events: WireEvent[],
  info: RequestInfo,
): Promise<{ events: WireEvent[]; info: RequestInfo }> {
  const policy = await getPolicy(env.DB, projectId);
  if (!isMinors(policy)) return { events, info };
  return {
    events: events
      .map((e) => sanitizeMinorsEvent(e, policy).event)
      .filter((e): e is WireEvent => e !== null),
    info: { ...info, region: '', city: '' },
  };
}

export async function ingestBatch(
  batch: WireBatch,
  project: Project,
  received: RequestInfo,
  env: Env,
  store: EventStore,
  now: number,
  options: { trusted: boolean; skipDestinations?: boolean; base?: string },
): Promise<IngestResult> {
  const limit = options.trusted ? MAX_IMPORT_EVENTS : MAX_EVENTS;
  const { events, info } = await applyStudentPolicy(
    env,
    project.id,
    batch.events.slice(0, limit).filter(isWellFormed),
    received,
  );
  const skew = typeof batch.sent_at === 'number' ? now - batch.sent_at : 0;
  const ctx: RowContext = {
    project: project.id,
    settings: project.settings,
    info,
    now,
    skew: options.trusted ? 0 : skew,
    trusted: options.trusted,
    lib: String(batch.lib ?? '').slice(0, 50),
    env,
    store,
  };
  let rows = await toRows(events, ctx);
  const enrich: EnrichContext = {
    project,
    env,
    store,
    now,
    trusted: options.trusted,
    base: options.base ?? trimTrailingSlashes(env.GLASS_PUBLIC_URL ?? ''),
  };
  for (const enricher of ENRICHERS) rows = await enricher(rows, enrich);
  await store.write(rows);
  if (!options.skipDestinations) {
    // The events are stored: a hook that fails (a destination queue, say) must not fail the
    // request, or the SDK would resend events that were written.
    for (const hook of AFTER_WRITE) {
      try {
        await hook(rows, enrich);
      } catch (err) {
        console.error('[glass] after-write hook failed', err);
      }
    }
  }
  return { accepted: rows.length, dropped: batch.events.length - rows.length };
}

function isWellFormed(e: unknown): e is WireEvent {
  if (!e || typeof e !== 'object') return false;
  const w = e as WireEvent;
  return (
    typeof w.id === 'string' &&
    w.id.length <= 64 &&
    isValidEventName(w.event) &&
    typeof w.ts === 'number' &&
    Number.isFinite(w.ts)
  );
}

interface RowContext {
  project: string;
  settings: ProjectSettings;
  info: RequestInfo;
  now: number;
  skew: number;
  trusted: boolean;
  lib: string;
  env: Env;
  store: EventStore;
}

const str = (v: unknown, max = 500): string =>
  typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max);

/**
 * The event's time: corrected for the client's clock skew, never in the future. A browser that
 * was offline can send a week's backlog; older timestamps are clock errors. Imports keep theirs:
 * that is what an import is for.
 */
function eventTime(e: WireEvent, ctx: Pick<RowContext, 'now' | 'skew' | 'trusted'>): number {
  const corrected = Math.round(e.ts + ctx.skew);
  const earliest = ctx.trusted ? corrected : Math.max(ctx.now - MAX_PAST_MS, corrected);
  return Math.min(ctx.now + 60_000, earliest);
}

type Identified = {
  e: WireEvent;
  ts: number;
  distinct: string;
  user: string | null;
  session: string;
  groups: Record<string, string>;
};

function identify(
  e: WireEvent,
  ctx: RowContext,
  anonymous: Awaited<ReturnType<typeof deriveCookielessIds>>,
): Identified {
  const ts = eventTime(e, ctx);
  const user = str(e.user_id, 200) || null;
  // A server event with only a user id belongs to that user (no device to derive one from).
  const distinct = str(e.distinct_id, 200) || (ctx.trusted && user ? user : anonymous.distinctId);
  const session = str(e.session_id, 100) || anonymous.sessionId(ts);
  return { e, ts, distinct, user, session, groups: groupsOf(e) };
}

/** Where the event happened and on what: from a trusted sender's context, else the request. */
function placeAndDevice(e: WireEvent, ctx: RowContext, ua: ReturnType<typeof parseUserAgent>) {
  const c = ctx.trusted && e.context && typeof e.context === 'object' ? e.context : {};
  return {
    country: str(c.country, 2) || ctx.info.country,
    region: str(c.region, 100) || ctx.info.region,
    city: str(c.city, 100) || ctx.info.city,
    device: str(c.device, 20) || (ua.device === 'unknown' ? '' : ua.device),
    browser: str(c.browser, 50) || ua.browser,
    os: str(c.os, 50) || ua.os,
  };
}

/** Where on the site: the page, its UTM tags and where the visitor came from. */
function pageColumns(e: WireEvent) {
  const page = parsePage(e.url);
  return {
    url: page.url,
    host: page.host,
    path: page.path,
    referrer: str(e.referrer, 1000).split('?')[0]!,
    referrer_host: referrerHost(e.referrer, page.host),
    title: str(e.title, 300),
    utm_source: page.utm_source,
    utm_medium: page.utm_medium,
    utm_campaign: page.utm_campaign,
    utm_term: page.utm_term,
    utm_content: page.utm_content,
  };
}

/** Steps 4–6 for a validated batch. */
async function toRows(events: WireEvent[], ctx: RowContext): Promise<StoredEvent[]> {
  if (events.length === 0) return [];
  const anonymous = await deriveCookielessIds(ctx);
  const withIds = events.map((e) => identify(e, ctx, anonymous));
  await applyIdentity(ctx, withIds);
  const types = await registerGroupTypes(ctx, withIds);
  await applyGroupIdentify(ctx, withIds, types);
  const personOf = await resolvePersons(ctx, withIds);
  const propsOf = await personProperties(ctx, [...new Set(personOf.values())]);
  const groupPropsOf = await groupProperties(ctx, withIds, types);
  const ua = parseUserAgent(ctx.info.userAgent);
  const browserVisit =
    !ctx.trusted && !!ua.browser && ua.browser !== 'Other' && ua.browser !== 'Bot';
  return withIds.map(({ e, ts, distinct, user, session, groups }) => {
    const person = personOf.get(`${distinct}\u0000${user ?? ''}`)!;
    const known = Object.fromEntries(Object.entries(groups).filter(([type]) => types.has(type)));
    return {
      id: str(e.id, 64),
      project: ctx.project,
      event: e.event,
      ts_ms: ts,
      distinct_id: distinct,
      user_id: user,
      person_id: person,
      session_id: session,
      ...pageColumns(e),
      ...placeAndDevice(e, ctx, ua),
      flags: JSON.stringify(e.flags && typeof e.flags === 'object' ? e.flags : {}),
      props: boundedProps(
        e.props,
        known,
        groupPropsOf,
        browserVisit && e.event === SYSTEM_EVENTS.pageview,
      ),
      person_props: propsOf.get(person) ?? '{}',
      lib: ctx.lib,
      received_ms: ctx.now,
    };
  });
}

/** Drop the largest properties until the rest fit, listing what went in `$truncated_keys`. */
function truncate(props: Record<string, unknown>): void {
  let text = JSON.stringify(props);
  if (text.length <= MAX_PROPS_BYTES) return;
  const sizes = Object.entries(props)
    .map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const dropped: string[] = [];
  for (const [k] of sizes) {
    if (text.length <= MAX_PROPS_BYTES - 200) break;
    delete props[k];
    dropped.push(k);
    text = JSON.stringify(props);
  }
  props.$truncated_keys = dropped.slice(0, 20);
}

/** A snapshot of the event's groups' properties, when it fits. */
function groupSnapshot(
  groups: Record<string, string>,
  groupProps: Map<string, Record<string, unknown>>,
) {
  const snapshot: Record<string, unknown> = {};
  for (const [type, key] of Object.entries(groups)) {
    const p = groupProps.get(`${type}\u0000${key}`);
    if (p && Object.keys(p).length) snapshot[type] = p;
  }
  const fits =
    Object.keys(snapshot).length && JSON.stringify(snapshot).length <= MAX_GROUP_PROPS_BYTES;
  return fits ? snapshot : null;
}

/**
 * Event properties as stored: at most 8 KB of your properties (the largest are dropped first and
 * listed in `$truncated_keys`), plus the event's groups and a snapshot of their properties.
 */
export function boundedProps(
  value: unknown,
  groups: Record<string, string> = {},
  groupProps: Map<string, Record<string, unknown>> = new Map(),
  browserPageview = false,
): string {
  const props: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  // Group fields are rebuilt below from what was validated.
  delete props.$groups;
  delete props.$group_props;
  delete props.$traffic_class;
  truncate(props);
  if (browserPageview) props.$traffic_class = 'likely_human';
  if (Object.keys(groups).length > 0) {
    props.$groups = groups;
    const snapshot = groupSnapshot(groups, groupProps);
    if (snapshot) props.$group_props = snapshot;
  }
  return JSON.stringify(props);
}

const groupKeyOf = (key: unknown) => (typeof key === 'number' ? String(key) : key);

/** A valid group type and key, or null. */
function validGroup(type: unknown, key: unknown): [string, string] | null {
  const k = groupKeyOf(key);
  return typeof type === 'string' &&
    GROUP_TYPE.test(type) &&
    typeof k === 'string' &&
    validGroupKey(k)
    ? [type, k]
    : null;
}

/** The groups an event names (`props.$groups`), validated. A `$groupidentify` names its own group. */
function groupsOf(e: WireEvent): Record<string, string> {
  const props = (e.props ?? {}) as Record<string, unknown>;
  const raw = props.$groups;
  const named =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  const pairs = named.map(([type, key]) => validGroup(type, key));
  if (e.event === SYSTEM_EVENTS.groupIdentify)
    pairs.push(validGroup(props.$group_type, props.$group_key));
  return Object.fromEntries(pairs.filter((p): p is [string, string] => p !== null));
}

function validGroupKey(key: string): boolean {
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  return key.length > 0 && key.length <= 200 && !/[\u0000-\u001f]/.test(key);
}

/**
 * Cookieless mode: when the SDK sends no ids, derive a visitor id from a daily
 * secret salt + IP + user agent, so nothing is stored on the device and ids can't
 * be linked across days. Sessions are 30-minute windows of that id.
 */
function deriveCookielessIds(ctx: RowContext) {
  return cookielessIds(ctx.env, ctx.project, ctx.info, ctx.now);
}

/**
 * The ids used when the browser stores nothing: a visitor hash of IP + user
 * agent with a salt that rotates daily, and a session per 30-minute bucket.
 * Cookieless replays use the same ids, so they join the visit's events.
 */
export async function cookielessIds(env: Env, project: string, info: RequestInfo, now: number) {
  const day = Math.floor(now / 86_400_000);
  const salt = `${env.GLASS_SALT_SECRET ?? env.GLASS_ADMIN_KEY ?? 'glass'}:${day}`;
  const visitor = (await sha256Hex(`${salt}:${project}:${info.ip}:${info.userAgent}`)).slice(0, 20);
  return {
    distinctId: `c_${visitor}`,
    sessionId: (ts: number) => `cs_${visitor}_${Math.floor(ts / SESSION_BUCKET_MS)}`,
  };
}

type WithIds = {
  e: WireEvent;
  ts: number;
  distinct: string;
  user: string | null;
  session: string;
  groups: Record<string, string>;
};

/** Step 4: identify() links and $set / $set_once person updates. */
async function applyIdentity(ctx: RowContext, events: WithIds[]): Promise<void> {
  const db = ctx.env.DB;
  for (const { e, distinct, user, ts } of events) {
    const props = (e.props ?? {}) as { $set?: unknown; $set_once?: unknown };
    if (e.event === '$identify' && user) {
      const res = await db
        .prepare(
          'INSERT OR IGNORE INTO identities (project, distinct_id, person_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(ctx.project, distinct, user, ts)
        .run();
      if ((res.meta.changes ?? 0) > 0) {
        await ctx.store.writeIdentity({
          project: ctx.project,
          distinct_id: distinct,
          person_id: user,
          created_at: ts,
        });
      }
    }
    const set = isObject(props.$set) ? props.$set : null;
    const once = isObject(props.$set_once) ? props.$set_once : null;
    if (
      (e.event === '$identify' || e.event === '$set') &&
      (set || once || e.event === '$identify')
    ) {
      const person = user ?? (await lookupIdentity(db, ctx.project, distinct)) ?? distinct;
      await upsertPerson(db, ctx.project, person, ts, set ?? {}, once ?? {});
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

async function lookupIdentity(
  db: D1Database,
  project: string,
  distinct: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT person_id FROM identities WHERE project = ? AND distinct_id = ?')
    .bind(project, distinct)
    .first<{ person_id: string }>();
  return row?.person_id ?? null;
}

export async function upsertPerson(
  db: D1Database,
  project: string,
  personId: string,
  ts: number,
  set: Record<string, unknown>,
  setOnce: Record<string, unknown> = {},
): Promise<void> {
  // json_patch(a, b) merges b into a: $set overwrites, $set_once only fills gaps.
  await db
    .prepare(
      `INSERT INTO persons (project, person_id, props, first_seen, last_seen)
       VALUES (?1, ?2, json_patch(json(?4), json(?3)), ?5, ?5)
       ON CONFLICT (project, person_id) DO UPDATE SET
         props = json_patch(json_patch(json(?4), persons.props), json(?3)),
         last_seen = MAX(persons.last_seen, ?5),
         first_seen = MIN(persons.first_seen, ?5)`,
    )
    .bind(project, personId, JSON.stringify(set), JSON.stringify(setOnce), ts)
    .run();
}

// ── Groups ─────────────────────────────────────────────────────────────────

const typeCache = new Map<string, { types: Set<string>; until: number }>();

/** Group types the project already has, cached briefly per isolate. */
async function groupTypes(db: D1Database, project: string, fresh = false) {
  const hit = typeCache.get(project);
  if (!fresh && hit && hit.until > Date.now()) return hit.types;
  const { results } = await db
    .prepare('SELECT type FROM group_types WHERE project = ? ORDER BY idx')
    .bind(project)
    .all<{ type: string }>();
  const types = new Set(results.map((r) => r.type));
  typeCache.set(project, { types, until: Date.now() + 10_000 });
  return types;
}

export function clearGroupTypeCache(): void {
  typeCache.clear();
}

/** Register new group types (up to five per project). Returns the types events may use. */
async function registerGroupTypes(ctx: RowContext, events: WithIds[]): Promise<Set<string>> {
  const seen = new Set(events.flatMap((e) => Object.keys(e.groups)));
  if (seen.size === 0) return new Set();
  let types = await groupTypes(ctx.env.DB, ctx.project);
  const fresh = [...seen].filter((t) => !types.has(t));
  if (fresh.length > 0 && types.size < MAX_GROUP_TYPES) {
    const db = ctx.env.DB;
    await db.batch(
      fresh.slice(0, MAX_GROUP_TYPES - types.size).map((type) =>
        db
          .prepare(
            `INSERT INTO group_types (project, type, idx, created_at)
             SELECT ?1, ?2, (SELECT COALESCE(MAX(idx) + 1, 0) FROM group_types WHERE project = ?1), ?3
             WHERE (SELECT COUNT(*) FROM group_types WHERE project = ?1) < ${MAX_GROUP_TYPES}
             ON CONFLICT (project, type) DO NOTHING`,
          )
          .bind(ctx.project, type, ctx.now),
      ),
    );
    types = await groupTypes(db, ctx.project, true);
  }
  return types;
}

/** `$groupidentify` (glass.group(type, key, props)): set the group's properties. Every seen group gets a row. */
/** The latest time each known group shows up in the batch. */
function touchedGroups(
  events: WithIds[],
  types: Set<string>,
): Map<string, { type: string; key: string; ts: number }> {
  const touched = new Map<string, { type: string; key: string; ts: number }>();
  for (const { ts, groups } of events)
    for (const [type, key] of Object.entries(groups)) {
      if (!types.has(type)) continue;
      const id = `${type}\u0000${key}`;
      const prev = touched.get(id);
      if (!prev || prev.ts < ts) touched.set(id, { type, key, ts });
    }
  return touched;
}

/** A `$groupidentify`'s set and set-once properties, applied to its group (null for other events). */
function groupIdentifyWrite(ctx: RowContext, x: WithIds, types: Set<string>) {
  if (x.e.event !== SYSTEM_EVENTS.groupIdentify) return null;
  const props = (x.e.props ?? {}) as Record<string, unknown>;
  const type = String(props.$group_type ?? '');
  const key = x.groups[type];
  if (!key || !types.has(type)) return null;
  const set = isObject(props.$group_set) ? props.$group_set : {};
  const once = isObject(props.$group_set_once) ? props.$group_set_once : {};
  return ctx.env.DB.prepare(
    `INSERT INTO groups (project, type, key, props, first_seen, last_seen)
     VALUES (?1, ?2, ?3, json_patch(json(?5), json(?4)), ?6, ?6)
     ON CONFLICT (project, type, key) DO UPDATE SET
       props = json_patch(json_patch(json(?5), groups.props), json(?4)),
       last_seen = MAX(groups.last_seen, ?6),
       first_seen = MIN(groups.first_seen, ?6)`,
  ).bind(ctx.project, type, key, JSON.stringify(set), JSON.stringify(once), x.ts);
}

async function applyGroupIdentify(
  ctx: RowContext,
  events: WithIds[],
  types: Set<string>,
): Promise<void> {
  if (types.size === 0) return;
  const db = ctx.env.DB;
  const statements = events
    .map((x) => groupIdentifyWrite(ctx, x, types))
    .filter((st) => st !== null);
  const touched = touchedGroups(events, types);
  if (touched.size > 0)
    statements.push(
      db
        .prepare(
          `INSERT INTO groups (project, type, key, props, first_seen, last_seen)
           SELECT ?1, json_extract(value, '$.type'), json_extract(value, '$.key'), '{}',
             json_extract(value, '$.ts'), json_extract(value, '$.ts')
           FROM json_each(?2) WHERE true
           ON CONFLICT (project, type, key) DO UPDATE SET
             last_seen = MAX(groups.last_seen, excluded.last_seen),
             first_seen = MIN(groups.first_seen, excluded.first_seen)`,
        )
        .bind(ctx.project, JSON.stringify([...touched.values()])),
    );
  if (statements.length) await db.batch(statements);
}

/** Current properties of every group the batch names, keyed by "type\0key". */
async function groupProperties(
  ctx: RowContext,
  events: WithIds[],
  types: Set<string>,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const ids = [
    ...new Set(
      events.flatMap((e) =>
        Object.entries(e.groups)
          .filter(([type]) => types.has(type))
          .map(([type, key]) => `${type}\u0000${key}`),
      ),
    ),
  ];
  if (ids.length === 0) return out;
  const { results } = await ctx.env.DB.prepare(
    `SELECT type, key, props FROM groups
     WHERE project = ?1 AND (type || char(0) || key) IN (SELECT value FROM json_each(?2))`,
  )
    .bind(ctx.project, JSON.stringify(ids))
    .all<{ type: string; key: string; props: string }>();
  for (const r of results) {
    try {
      out.set(`${r.type}\u0000${r.key}`, JSON.parse(r.props) as Record<string, unknown>);
    } catch {
      // A malformed row shouldn't stop ingest.
    }
  }
  return out;
}

// ── People ─────────────────────────────────────────────────────────────────

/** Step 5a: person_id for each (distinct_id, user_id) pair. */
async function resolvePersons(ctx: RowContext, events: WithIds[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const anonymous = [...new Set(events.filter((e) => !e.user).map((e) => e.distinct))];
  const links = new Map<string, string>();
  for (let i = 0; i < anonymous.length; i += 90) {
    const chunk = anonymous.slice(i, i + 90);
    const { results } = await ctx.env.DB.prepare(
      `SELECT distinct_id, person_id FROM identities WHERE project = ? AND distinct_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(ctx.project, ...chunk)
      .all<{ distinct_id: string; person_id: string }>();
    for (const r of results) links.set(r.distinct_id, r.person_id);
  }
  for (const { distinct, user } of events) {
    out.set(`${distinct}\u0000${user ?? ''}`, user ?? links.get(distinct) ?? distinct);
  }
  return out;
}

/** Step 5b: current properties for each person, stamped onto their events. */
async function personProperties(ctx: RowContext, persons: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // D1 binds at most 100 parameters per statement, so read and touch people 90 at a time.
  for (let i = 0; i < persons.length; i += 90) {
    const chunk = persons.slice(i, i + 90);
    const { results } = await ctx.env.DB.prepare(
      `SELECT person_id, props FROM persons WHERE project = ? AND person_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(ctx.project, ...chunk)
      .all<{ person_id: string; props: string }>();
    if (results.length === 0) continue;
    for (const r of results) out.set(r.person_id, r.props);
    await ctx.env.DB.prepare(
      `UPDATE persons SET last_seen = MAX(last_seen, ?) WHERE project = ? AND person_id IN (${results.map(() => '?').join(', ')})`,
    )
      .bind(ctx.now, ctx.project, ...results.map((r) => r.person_id))
      .run();
  }
  return out;
}
