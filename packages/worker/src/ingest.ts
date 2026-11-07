/**
 * Event ingest: `POST /e`.
 *
 * The pipeline, in order:
 *
 *   1. parse      — accept a WireBatch (text/plain JSON, no CORS preflight)
 *   2. admit      — known project, allowed origin, not a bot
 *   3. validate   — drop malformed events individually, never the whole batch
 *   4. identity   — apply identify() links and person property updates
 *   5. resolve    — person_id for every event + a snapshot of person properties
 *   6. enrich     — clock-skew correction, URL/UTM parsing, referrer, geo, user agent
 *   7. write      — hand the rows to the event store
 *
 * Steps 4–6 are separate functions so they can be tested and extended
 * independently (see docs/extending.md, "Enriching events").
 */

import {
  isValidEventName,
  type StoredEvent,
  type WireBatch,
  type WireEvent,
} from '@dataflare/core/events';
import { sha256Hex } from '@dataflare/core/hash';
import { isBot, parseUserAgent } from '@dataflare/core/ua';
import { parsePage, referrerHost } from '@dataflare/core/url';
import type { D1Database, Env } from './env.ts';
import { HttpError, readJson } from './http.ts';
import { getProject } from './projects.ts';
import type { EventStore } from './stores/types.ts';

const MAX_EVENTS = 200;
const MAX_PROPS_BYTES = 8_000;
const MAX_PAST_MS = 7 * 86_400_000;
const SESSION_BUCKET_MS = 30 * 60_000;

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

export async function handleIngest(
  request: Request,
  env: Env,
  store: EventStore,
  now = Date.now(),
): Promise<IngestResult> {
  const info = requestInfo(request);
  const batch = await readJson<Partial<WireBatch>>(request, 1_000_000);
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
  if (
    project.allowedOrigins.length > 0 &&
    info.origin &&
    !project.allowedOrigins.includes(info.origin)
  ) {
    throw new HttpError(403, `Origin ${info.origin} is not allowed for project "${project.id}"`);
  }
  // Server-side senders often have no user agent; only browsers that look like bots are dropped.
  if (info.userAgent && isBot(info.userAgent)) return { accepted: 0, dropped: batch.events.length };

  const events = batch.events.slice(0, MAX_EVENTS).filter(isWellFormed);
  const skew = typeof batch.sent_at === 'number' ? now - batch.sent_at : 0;
  const rows = await toRows(events, {
    project: project.id,
    info,
    now,
    skew,
    lib: String(batch.lib ?? '').slice(0, 50),
    env,
    store,
  });
  await store.write(rows);
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
  info: RequestInfo;
  now: number;
  skew: number;
  lib: string;
  env: Env;
  store: EventStore;
}

const str = (v: unknown, max = 500): string =>
  typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max);

/** Steps 4–6 for a validated batch. */
async function toRows(events: WireEvent[], ctx: RowContext): Promise<StoredEvent[]> {
  if (events.length === 0) return [];
  const anonymous = await deriveCookielessIds(ctx);
  const withIds = events.map((e) => {
    const ts = Math.min(
      ctx.now + 60_000,
      Math.max(ctx.now - MAX_PAST_MS, Math.round(e.ts + ctx.skew)),
    );
    const distinct = str(e.distinct_id, 200) || anonymous.distinctId;
    const session = str(e.session_id, 100) || anonymous.sessionId(ts);
    return { e, ts, distinct, user: str(e.user_id, 200) || null, session };
  });

  await applyIdentity(ctx, withIds);
  const personOf = await resolvePersons(ctx, withIds);
  const propsOf = await personProperties(ctx, [...new Set(personOf.values())]);
  const ua = parseUserAgent(ctx.info.userAgent);

  return withIds.map(({ e, ts, distinct, user, session }) => {
    const page = parsePage(e.url);
    const person = personOf.get(distinct + '\u0000' + (user ?? ''))!;
    return {
      id: str(e.id, 64),
      project: ctx.project,
      event: e.event,
      ts_ms: ts,
      distinct_id: distinct,
      user_id: user,
      person_id: person,
      session_id: session,
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
      country: ctx.info.country,
      region: ctx.info.region,
      city: ctx.info.city,
      device: ua.device === 'unknown' ? '' : ua.device,
      browser: ua.browser,
      os: ua.os,
      flags: JSON.stringify(e.flags && typeof e.flags === 'object' ? e.flags : {}),
      props: boundedJson(e.props),
      person_props: propsOf.get(person) ?? '{}',
      lib: ctx.lib,
      received_ms: ctx.now,
    };
  });
}

function boundedJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const text = JSON.stringify(value);
  return text.length > MAX_PROPS_BYTES ? JSON.stringify({ $truncated: true }) : text;
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

type WithIds = { e: WireEvent; ts: number; distinct: string; user: string | null; session: string };

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
    out.set(distinct + '\u0000' + (user ?? ''), user ?? links.get(distinct) ?? distinct);
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
