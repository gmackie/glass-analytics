/**
 * Session replay storage.
 *
 * Each upload from replay.js is one gzipped JSON array of rrweb events, stored
 * as its own R2 object:
 *
 *   replays/<project>/<session>/<start>-<page>-<seq>.json.gz
 *
 * `start` is the chunk's first timestamp (so keys sort by time), `page` is a
 * random id per page load and `seq` counts chunks within that page load. A row
 * in the D1 `replays` table indexes the session (time range, counts, start URL),
 * so listing replays never touches R2.
 *
 * A session spans page loads, and rrweb numbers DOM nodes per page load, so
 * readers that resolve node ids (the transcript) need the chunks grouped by
 * page: see `loadReplayPages`.
 *
 * Once a session has ended, its summary (timeline and stats) is cached as
 *
 *   summaries/<project>/<session>.json
 *
 * and its counts and a searchable digest are copied onto the index row, so
 * search, sorting and cross-session analysis don't re-read every chunk.
 */

import type { RrwebEvent } from '@dataflare/core/replay-summary';
import { parseUserAgent } from '@dataflare/core/ua';
import type { D1Database, Env, R2Bucket } from './env.ts';
import { HttpError } from './http.ts';
import { cookielessIds, requestInfo } from './ingest.ts';
import { getProject } from './projects.ts';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_CHUNK_BYTES = 5_000_000;
const CHUNK_CONCURRENCY = 6;
const CHUNK_METADATA = { contentType: 'application/json', contentEncoding: 'gzip' };

export function replaysEnabled(env: Env): env is Env & { REPLAYS: R2Bucket } {
  return Boolean(env.REPLAYS);
}

function requireBucket(env: Env): R2Bucket {
  if (!env.REPLAYS) {
    throw new HttpError(
      501,
      'Session replay is not enabled on this deployment',
      'Enable R2 on your Cloudflare account, then run `dataflare upgrade`.',
    );
  }
  return env.REPLAYS;
}

export const chunkPrefix = (project: string, session: string) => `replays/${project}/${session}/`;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** `POST /r` — store one chunk and update the session index. */
export async function handleReplayChunk(request: Request, env: Env, url: URL): Promise<void> {
  const bucket = requireBucket(env);
  const q = url.searchParams;
  const project = q.get('project') ?? '';
  let session = q.get('session') ?? '';
  let distinct = q.get('d') ?? '';
  const seq = Number(q.get('seq'));
  if (!(await getProject(env.DB, project)))
    throw new HttpError(404, `Unknown project "${project}"`);
  const info = requestInfo(request);
  if (q.get('cl') === '1') {
    // Cookieless: the browser has no ids, so derive the ones its events get. The
    // session comes from the page load's start, so every chunk of a page stays together.
    const now = Date.now();
    const pageStart = Math.min(now, Math.max(now - 86_400_000, Number(q.get('ps')) || now));
    const ids = await cookielessIds(env, project, info, pageStart);
    session = ids.sessionId(pageStart);
    distinct = ids.distinctId;
  }
  if (!SAFE_ID.test(session) || !Number.isInteger(seq) || seq < 0)
    throw new HttpError(400, 'Invalid session or seq');

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) return;
  if (raw.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, 'Replay chunk too large');
  const body = q.get('enc') === 'gzip' ? raw : await gzip(raw);
  // Keys sort by start time; the page id keeps chunks from different page loads apart.
  const startKey = String(Math.max(0, Math.floor(Number(q.get('start')) || Date.now()))).padStart(
    15,
    '0',
  );
  const page = /^[a-z0-9]{1,16}$/i.test(q.get('page') ?? '') ? q.get('page') : 'p';
  const chunk = `${startKey}-${page}-${String(seq).padStart(6, '0')}`;
  // The key is deterministic, so a retried upload overwrites the same object.
  await bucket.put(`${chunkPrefix(project, session)}${chunk}.json.gz`, body, {
    httpMetadata: CHUNK_METADATA,
  });

  const ua = parseUserAgent(info.userAgent);
  const n = (name: string) => {
    const v = Number(q.get(name));
    return Number.isFinite(v) ? v : 0;
  };
  const start = n('start') || Date.now();
  // The SDK retries an upload whose response was lost, so this chunk may already be counted.
  // The index only adds its counts when the chunk is new to replay_chunks, and both writes are
  // one transaction, so a retry after either outcome counts the chunk exactly once.
  const counts = env.DB.prepare(
    `INSERT INTO replays (project, session_id, distinct_id, user_id, started_at, ended_at, chunks, bytes, clicks, errors, start_url, device, browser, country,
       pages, rage_clicks, console_errors, failed_requests)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
     WHERE NOT EXISTS (SELECT 1 FROM replay_chunks WHERE project = ?1 AND session_id = ?2 AND chunk = ?18)
     ON CONFLICT (project, session_id) DO UPDATE SET
       pages = replays.pages + excluded.pages,
       rage_clicks = replays.rage_clicks + excluded.rage_clicks,
       console_errors = replays.console_errors + excluded.console_errors,
       failed_requests = replays.failed_requests + excluded.failed_requests,
       started_at = MIN(replays.started_at, excluded.started_at),
       ended_at = MAX(replays.ended_at, excluded.ended_at),
       chunks = replays.chunks + 1,
       bytes = replays.bytes + excluded.bytes,
       clicks = replays.clicks + excluded.clicks,
       errors = replays.errors + excluded.errors,
       user_id = COALESCE(excluded.user_id, replays.user_id),
       start_url = CASE WHEN excluded.started_at < replays.started_at THEN excluded.start_url ELSE replays.start_url END`,
  ).bind(
    project,
    session,
    distinct,
    q.get('u') || null,
    start,
    n('end') || start,
    body.byteLength,
    n('clicks'),
    n('errors'),
    (q.get('href') ?? '').slice(0, 500),
    ua.device,
    ua.browser,
    info.country,
    // Every page load starts its chunks at seq 0.
    seq === 0 ? 1 : 0,
    n('rage'),
    n('console'),
    n('failed'),
    chunk,
  );
  await env.DB.batch([
    counts,
    env.DB.prepare(
      'INSERT OR IGNORE INTO replay_chunks (project, session_id, chunk) VALUES (?, ?, ?)',
    ).bind(project, session, chunk),
  ]);
}

export interface ReplayRow {
  session_id: string;
  distinct_id: string;
  user_id: string | null;
  started_at: number;
  ended_at: number;
  chunks: number;
  bytes: number;
  clicks: number;
  errors: number;
  start_url: string;
  device: string;
  browser: string;
  country: string;
  pages: number;
  rage_clicks: number;
  dead_clicks: number;
  console_errors: number;
  failed_requests: number;
  active_ms: number | null;
  digest: string;
  summary_chunks: number | null;
}

/** Signals a session can be filtered on, and the column that counts each. */
export const SIGNALS = {
  errors: 'errors',
  rage_clicks: 'rage_clicks',
  dead_clicks: 'dead_clicks',
  console_errors: 'console_errors',
  failed_requests: 'failed_requests',
} as const;
export type Signal = keyof typeof SIGNALS | 'frustration';

const SORTS = {
  newest: 'started_at DESC',
  oldest: 'started_at ASC',
  longest: '(ended_at - started_at) DESC',
  most_active: 'COALESCE(active_ms, ended_at - started_at) DESC',
  most_errors: '(errors + console_errors + failed_requests) DESC, started_at DESC',
  most_frustrated:
    '(rage_clicks * 3 + dead_clicks * 2 + errors * 2 + console_errors + failed_requests) DESC, started_at DESC',
} as const;
export type ReplaySort = keyof typeof SORTS;

export interface ReplayQuery {
  person?: string;
  /** Sessions that have every one of these signals. "frustration" is any rage click, dead click or error. */
  has?: Signal[];
  from?: number;
  to?: number;
  minDurationMs?: number;
  /** Matches session id, person, first page and (once summarised) pages, clicked elements and errors. */
  search?: string;
  /** Only these sessions (from an events-store filter). */
  sessions?: string[];
  /** Never these sessions (e.g. ones where a goal event happened). */
  excludeSessions?: string[];
  /** Or-ed with `sessions`: also sessions whose first page contains this. */
  startUrl?: string;
  sort?: ReplaySort;
  limit?: number;
  offset?: number;
}

const like = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listReplays(
  db: D1Database,
  project: string,
  options: ReplayQuery = {},
): Promise<{ rows: ReplayRow[]; total: number }> {
  const where = ['project = ?'];
  const args: unknown[] = [project];
  if (options.person) {
    where.push(
      '(user_id = ? OR distinct_id = ? OR distinct_id IN (SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?))',
    );
    args.push(options.person, options.person, project, options.person);
  }
  for (const signal of options.has ?? []) {
    if (signal === 'frustration')
      where.push(
        '(rage_clicks > 0 OR dead_clicks > 0 OR errors > 0 OR console_errors > 0 OR failed_requests > 0)',
      );
    else if (signal in SIGNALS) where.push(`${SIGNALS[signal]} > 0`);
  }
  if (options.from) {
    where.push('started_at >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('started_at < ?');
    args.push(options.to);
  }
  if (options.minDurationMs) {
    where.push('ended_at - started_at >= ?');
    args.push(options.minDurationMs);
  }
  if (options.search) {
    where.push(
      `(session_id = ? OR user_id = ? OR distinct_id = ? OR LOWER(start_url) LIKE ? ESCAPE '\\' OR LOWER(digest) LIKE ? ESCAPE '\\')`,
    );
    args.push(
      options.search,
      options.search,
      options.search,
      like(options.search),
      like(options.search),
    );
  }
  // Session lists are inlined: D1 allows 100 bound parameters, and these come from our own query (escaped anyway).
  const inline = (ids: string[]) => ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(',') || "''";
  if (options.excludeSessions?.length)
    where.push(`session_id NOT IN (${inline(options.excludeSessions)})`);
  if (options.sessions) {
    const list = inline(options.sessions);
    if (options.startUrl) {
      where.push(`(session_id IN (${list}) OR LOWER(start_url) LIKE ? ESCAPE '\\')`);
      args.push(like(options.startUrl));
    } else {
      where.push(`session_id IN (${list})`);
    }
  } else if (options.startUrl) {
    where.push(`LOWER(start_url) LIKE ? ESCAPE '\\'`);
    args.push(like(options.startUrl));
  }
  const clause = where.join(' AND ');
  const limit = Math.min(options.limit ?? 50, 500);
  const [page, count] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM replays WHERE ${clause} ORDER BY ${SORTS[options.sort ?? 'newest']} LIMIT ? OFFSET ?`,
      )
      .bind(...args, limit, Math.max(0, options.offset ?? 0))
      .all<ReplayRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM replays WHERE ${clause}`)
      .bind(...args)
      .first<{ n: number }>(),
  ]);
  return { rows: page.results, total: Number(count?.n ?? 0) };
}

export async function getReplay(
  db: D1Database,
  project: string,
  session: string,
): Promise<ReplayRow | null> {
  return db
    .prepare('SELECT * FROM replays WHERE project = ? AND session_id = ?')
    .bind(project, session)
    .first<ReplayRow>();
}

// ── Cached summaries ──────────────────────────────────────────────────────

export const summaryKey = (project: string, session: string) =>
  `summaries/${project}/${session}.json`;

/** The cached summary of a session, if it still covers every chunk. */
export async function readCachedSummary<T>(
  env: Env,
  project: string,
  row: ReplayRow,
): Promise<T | null> {
  if (!env.REPLAYS || row.summary_chunks == null || row.summary_chunks !== row.chunks) return null;
  const object = await env.REPLAYS.get(summaryKey(project, row.session_id));
  if (!object) return null;
  try {
    return JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as T;
  } catch {
    return null;
  }
}

export interface SummaryIndex {
  deadClicks: number;
  activeMs: number;
  digest: string;
}

export async function writeCachedSummary(
  env: Env,
  project: string,
  row: ReplayRow,
  summary: unknown,
  index: SummaryIndex,
): Promise<void> {
  const bucket = requireBucket(env);
  await bucket.put(summaryKey(project, row.session_id), JSON.stringify(summary), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.DB.prepare(
    'UPDATE replays SET dead_clicks = ?, active_ms = ?, digest = ?, summary_chunks = ? WHERE project = ? AND session_id = ? AND chunks = ?',
  )
    .bind(
      index.deadClicks,
      index.activeMs,
      index.digest.slice(0, 4000),
      row.chunks,
      project,
      row.session_id,
      row.chunks,
    )
    .run();
}

/** Sessions that ended a while ago and have no up-to-date cached summary. */
export async function sessionsToSummarise(
  db: D1Database,
  endedBefore: number,
  limit: number,
): Promise<(ReplayRow & { project: string })[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM replays WHERE ended_at < ? AND (summary_chunks IS NULL OR summary_chunks <> chunks) ORDER BY ended_at DESC LIMIT ?',
    )
    .bind(endedBefore, limit)
    .all<ReplayRow & { project: string }>();
  return results;
}

// ── Notes ─────────────────────────────────────────────────────────────────

export interface NoteRow {
  id: string;
  ts_ms: number;
  text: string;
  author: string;
  created_at: number;
}

export async function listNotes(
  db: D1Database,
  project: string,
  session: string,
): Promise<NoteRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, ts_ms, text, author, created_at FROM replay_notes WHERE project = ? AND session_id = ? ORDER BY ts_ms',
    )
    .bind(project, session)
    .all<NoteRow>();
  return results;
}

export async function addNote(
  db: D1Database,
  project: string,
  session: string,
  note: Omit<NoteRow, 'id' | 'created_at'>,
): Promise<NoteRow> {
  const row = { ...note, id: crypto.randomUUID().slice(0, 8), created_at: Date.now() };
  await db
    .prepare(
      'INSERT INTO replay_notes (project, session_id, id, ts_ms, text, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(project, session, row.id, row.ts_ms, row.text, row.author, row.created_at)
    .run();
  return row;
}

export async function deleteNote(
  db: D1Database,
  project: string,
  session: string,
  id: string,
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM replay_notes WHERE project = ? AND session_id = ? AND id = ?')
    .bind(project, session, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** One page load's part of a recording. Node ids are only meaningful within it. */
export interface ReplayPage {
  page: string;
  events: RrwebEvent[];
}

const byTime = (a: RrwebEvent, b: RrwebEvent) => a.timestamp - b.timestamp;

/** A session's recording as one event list per page load, each in time order, earliest page first. */
export async function loadReplayPages(
  env: Env,
  project: string,
  session: string,
): Promise<ReplayPage[]> {
  const bucket = requireBucket(env);
  if (!SAFE_ID.test(session)) throw new HttpError(400, 'Invalid session id');
  const prefix = chunkPrefix(project, session);
  // Chunks not yet moved out of a legacy bucket (see `moveLegacyReplays`) are read from there.
  const from = new Map<string, R2Bucket>();
  for (const b of [env.REPLAYS_LEGACY, bucket]) {
    if (b) for (const key of await listKeys(b, prefix)) from.set(key, b);
  }
  const keys = [...from.keys()].sort();

  // Fetch a few chunks at a time: one by one is slow for long sessions, all at once can exhaust memory.
  const chunks: (RrwebEvent[] | null)[] = new Array(keys.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const i = next++;
      const key = keys[i]!;
      try {
        const object = await from.get(key)!.get(key);
        if (!object) continue;
        const chunk: unknown = JSON.parse(await gunzip(await object.arrayBuffer()));
        if (!Array.isArray(chunk)) throw new Error('chunk is not an array of rrweb events');
        chunks[i] = chunk as RrwebEvent[];
      } catch (err) {
        console.warn('[glass] skipping unreadable replay chunk', key, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, keys.length) }, worker));

  const pages = new Map<string, RrwebEvent[]>();
  keys.forEach((key, i) => {
    const chunk = chunks[i];
    if (!chunk) return;
    const page = key.slice(prefix.length).split('-')[1] ?? 'p';
    const list = pages.get(page) ?? [];
    // A loop rather than push(...chunk): a big chunk has more events than a call can take arguments.
    for (const event of chunk) list.push(event);
    pages.set(page, list);
  });
  return [...pages]
    .map(([page, events]) => ({ page, events: events.sort(byTime) }))
    .sort((a, b) => (a.events[0]?.timestamp ?? 0) - (b.events[0]?.timestamp ?? 0));
}

/** All rrweb events of a session in time order, for playback. */
export async function loadReplayEvents(
  env: Env,
  project: string,
  session: string,
): Promise<RrwebEvent[]> {
  return (await loadReplayPages(env, project, session)).flatMap((p) => p.events).sort(byTime);
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Sessions deleted per call to `deleteReplays`. Each costs a few R2 calls per bucket (list,
 * delete chunks, delete summary) and the slice one D1 batch, so a slice fits well inside one
 * invocation's limits. Callers loop over slices within their own budget.
 */
export const REPLAY_DELETE_SLICE = 50;

/**
 * Delete up to `limit` replays (R2 chunks, cached summary, index row, notes) matching a SQL
 * condition on the replays table, and return how many. Fewer than `limit` means none are left.
 *
 * R2 objects go first and the index rows last, in one transaction: if anything fails part way,
 * the rows that find the session are still there, so calling again finishes the job.
 */
export async function deleteReplays(
  env: Env,
  project: string,
  where: string,
  args: unknown[],
  limit = REPLAY_DELETE_SLICE,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT session_id FROM replays WHERE project = ? AND ${where} LIMIT ${limit}`,
  )
    .bind(project, ...args)
    .all<{ session_id: string }>();
  if (results.length === 0) return 0;
  const sessions = results.map((r) => r.session_id);
  for (const bucket of [env.REPLAYS, env.REPLAYS_LEGACY]) {
    if (!bucket) continue;
    for (const session of sessions) {
      // Each page is deleted before the next listing, so list from the start each time.
      for (;;) {
        const page = await bucket.list({ prefix: chunkPrefix(project, session), limit: 1000 });
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
        if (!page.truncated) break;
      }
      await bucket.delete(summaryKey(project, session));
    }
  }
  const json = JSON.stringify(sessions);
  await env.DB.batch(
    ['replays', 'replay_notes', 'replay_chunks'].map((table) =>
      env.DB.prepare(
        `DELETE FROM ${table} WHERE project = ? AND session_id IN (SELECT value FROM json_each(?))`,
      ).bind(project, json),
    ),
  );
  return sessions.length;
}

/**
 * Move objects from `REPLAYS_LEGACY` into `REPLAYS`, a few at a time. Before 0.8.1, an EU
 * deployment bound its replay bucket without the jurisdiction, so Wrangler created a bucket of
 * the same name in the default jurisdiction and the Worker wrote there. `dataflare upgrade`
 * binds the EU bucket and keeps the old one as `REPLAYS_LEGACY`; readers fall back to it and
 * the hourly job empties it with this. Each object costs three R2 calls (get, put, delete).
 */
export async function moveLegacyReplays(
  env: Env,
  limit: number,
): Promise<{ moved: number; done: boolean }> {
  const legacy = env.REPLAYS_LEGACY;
  if (!env.REPLAYS || !legacy) return { moved: 0, done: true };
  const page = await legacy.list({ prefix: '', limit });
  let moved = 0;
  for (const { key } of page.objects) {
    const object = await legacy.get(key);
    if (object) {
      await env.REPLAYS.put(key, await object.arrayBuffer(), {
        httpMetadata: key.endsWith('.json.gz')
          ? CHUNK_METADATA
          : { contentType: 'application/json' },
      });
    }
    // Delete only once the copy is written: a failure in between leaves both, and the next run
    // copies again.
    await legacy.delete(key);
    moved++;
  }
  return { moved, done: !page.truncated };
}
