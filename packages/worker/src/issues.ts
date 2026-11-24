/**
 * Error tracking in the Worker: exceptions become issues at ingest, issues are
 * resolved, suppressed, assigned and merged, alerts go out through destinations,
 * and minified stack frames are mapped back to source with uploaded source maps.
 *
 * At ingest, each `$exception` is fingerprinted (`@dataflare/core/issues`) and its
 * issue id written into `props.$issue_id`, so every store can group by issue. The
 * issue rows themselves (status, counts, the latest sample) live in D1. One D1
 * read and one batch of writes per ingest request, however many exceptions it has.
 */

import type { StoredEvent } from '@dataflare/core/events';
import { gunzip, gzip } from '@dataflare/core/exports';
import { sha256Hex } from '@dataflare/core/hash';
import { type ExceptionInfo, exceptionInfo, fingerprint, issueIdFor } from '@dataflare/core/issues';
import {
  type OriginalPosition,
  originalPositionFor,
  parseSourceMap,
  type RawSourceMap,
} from '@dataflare/core/sourcemap';
import { framePath, markInApp, parseStack, type StackFrame } from '@dataflare/core/stack';
import { type DeliveryMessage, deliveryEvent, sendMessages } from './destinations.ts';
import type { D1PreparedStatement, Env } from './env.ts';
import { HttpError } from './http.ts';
import type { EnrichContext } from './ingest.ts';

export type IssueStatus = 'active' | 'resolved' | 'suppressed' | 'merged';

const DEFAULT_RATE_PER_MINUTE = 100;
/** Alerts only for exceptions that happened recently (not for an import of last year's errors). */
const ALERT_WITHIN_MS = 3_600_000;
const SAMPLE_STACK_CHARS = 8000;

/** Exceptions kept per issue in the current minute, per isolate: an approximate, free rate limit. */
const rates = new Map<string, { minute: number; n: number }>();
export function clearIssueRateLimits(): void {
  rates.clear();
}

interface Known {
  fingerprint: string;
  id: string;
  status: IssueStatus;
  resolved_at: number | null;
  window_start: number;
  window_count: number;
  spike_alerted_at: number | null;
  occurrences: number;
}

interface Parsed {
  row: StoredEvent;
  props: Record<string, unknown>;
  info: ExceptionInfo;
  fp: string;
}

type AlertKind = 'new' | 'regression' | 'spike';

function sampleOf(p: Parsed) {
  return JSON.stringify({
    event_id: p.row.id,
    ts: p.row.ts_ms,
    type: p.info.type,
    message: p.info.message,
    stack: p.info.stack.slice(0, SAMPLE_STACK_CHARS),
    url: p.row.url,
    release: p.info.release,
    handled: p.info.handled,
    level: p.info.level,
    distinct_id: p.row.distinct_id,
    person_id: p.row.person_id,
    session_id: p.row.session_id,
    browser: p.row.browser,
    os: p.row.os,
  });
}

function alertText(
  kind: AlertKind,
  project: string,
  p: Parsed,
  extra: { count?: number; minutes?: number },
): string {
  const what = `${p.info.type}${p.info.message ? `: ${p.info.message.slice(0, 200)}` : ''}`;
  if (kind === 'new')
    return `New issue in ${project}: ${what}${p.row.path ? ` (on ${p.row.path})` : ''}`;
  if (kind === 'regression')
    return `Regression in ${project}: ${what} happened again after it was resolved`;
  return `Spike in ${project}: ${what} happened ${extra.count} times in ${extra.minutes} minutes`;
}

type Alert = { kind: AlertKind; id: string; p: Parsed; count?: number; minutes?: number };
type Settings = EnrichContext['project']['settings'];
type Group = { known?: Known; items: Parsed[] };

/** One ingest batch's issue work: what to write, what to drop, what to alert on. */
interface IssueRun {
  db: Env['DB'];
  project: string;
  now: number;
  minute: number;
  limit: number;
  alertsOn: Settings['errorAlerts'];
  known: Map<string, Known>;
  drop: Set<StoredEvent>;
  writes: D1PreparedStatement[];
  alerts: Alert[];
}

async function parseExceptions(
  rows: StoredEvent[],
  settings: Settings,
): Promise<Map<StoredEvent, Parsed>> {
  const parsed = new Map<StoredEvent, Parsed>();
  for (const row of rows) {
    if (row.event !== '$exception') continue;
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(row.props || '{}') as Record<string, unknown>;
    } catch {
      // keep {}
    }
    const info = exceptionInfo(props, row.host, settings.inAppIncludes);
    parsed.set(row, { row, props, info, fp: await fingerprint(info, props.$fingerprint) });
  }
  return parsed;
}

async function knownIssues(
  db: Env['DB'],
  project: string,
  fps: string[],
): Promise<Map<string, Known>> {
  const { results } = await db
    .prepare(
      `SELECT f.fingerprint, i.id, i.status, i.resolved_at, i.window_start, i.window_count, i.spike_alerted_at, i.occurrences
       FROM error_fingerprints f JOIN error_issues i ON i.project = f.project AND i.id = f.issue_id
       WHERE f.project = ?1 AND f.fingerprint IN (SELECT value FROM json_each(?2))`,
    )
    .bind(project, JSON.stringify(fps))
    .all<Known>();
  return new Map(results.map((r) => [r.fingerprint, r]));
}

function groupByIssue(parsed: Iterable<Parsed>, known: Map<string, Known>): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const p of parsed) {
    const k = known.get(p.fp);
    const id = k?.id ?? issueIdFor(p.fp);
    const g = groups.get(id) ?? { known: k, items: [] };
    g.items.push(p);
    groups.set(id, g);
  }
  return groups;
}

/** A new issue's row, and a row for each fingerprint not seen before. */
function creationWrites(run: IssueRun, id: string, g: Group, items: Parsed[]): void {
  const first = items[0]!;
  const latest = items.at(-1)!;
  if (!g.known)
    run.writes.push(
      run.db
        .prepare(
          `INSERT OR IGNORE INTO error_issues (project, id, status, type, message, first_seen, last_seen, occurrences,
             first_release, last_release, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .bind(
          run.project,
          id,
          first.info.type,
          first.info.message,
          first.row.ts_ms,
          latest.row.ts_ms,
          first.info.release,
          latest.info.release,
          run.now,
          run.now,
        ),
    );
  for (const fp of new Set(items.map((p) => p.fp))) {
    if (run.known.has(fp)) continue;
    run.writes.push(
      run.db
        .prepare(
          'INSERT OR IGNORE INTO error_fingerprints (project, fingerprint, issue_id, first_seen) VALUES (?, ?, ?, ?)',
        )
        .bind(run.project, fp, id, run.now),
    );
  }
}

/** Under the per-minute limit for this issue (counted per isolate)? Counts it when it is. */
function withinRate(run: IssueRun, id: string): boolean {
  const key = `${run.project}\u0000${id}`;
  const rate = rates.get(key);
  const n = rate && rate.minute === run.minute ? rate.n : 0;
  if (n >= run.limit) return false;
  rates.set(key, { minute: run.minute, n: n + 1 });
  return true;
}

/** Suppressed issues keep nothing; others keep up to the per-minute limit. The rest are dropped. */
function keptOf(run: IssueRun, id: string, g: Group, items: Parsed[]): Parsed[] {
  const suppressed = g.known?.status === 'suppressed';
  const keep = items.filter((_p) => !suppressed && withinRate(run, id));
  for (const p of items) if (!keep.includes(p)) run.drop.add(p.row);
  if (rates.size > 10_000) for (const [k, r] of rates) if (r.minute < run.minute) rates.delete(k);
  for (const p of keep) {
    p.props.$issue_id = id;
    p.props.$exception_fingerprint = p.fp.slice(0, 32);
  }
  return keep;
}

/** The spike window (tumbling) after these exceptions, alerting once per window when it fills. */
function spikeWindow(run: IssueRun, id: string, g: Group, kept: number, latest: Parsed) {
  const w = {
    start: g.known?.window_start ?? 0,
    count: g.known?.window_count ?? 0,
    alertedAt: g.known?.spike_alerted_at ?? null,
  };
  const spike = run.alertsOn?.spike;
  if (!spike || !kept) return w;
  if (run.now - w.start >= spike.minutes * 60_000) {
    w.start = run.now;
    w.count = 0;
  }
  w.count += kept;
  if (w.count >= spike.count && (w.alertedAt === null || w.alertedAt < w.start)) {
    w.alertedAt = run.now;
    run.alerts.push({ kind: 'spike', id, p: latest, count: w.count, minutes: spike.minutes });
  }
  return w;
}

function updateWrite(
  run: IssueRun,
  id: string,
  items: Parsed[],
  keep: Parsed[],
  w: ReturnType<typeof spikeWindow>,
) {
  const kept = keep.at(-1);
  return run.db
    .prepare(
      `UPDATE error_issues SET occurrences = occurrences + ?, dropped = dropped + ?,
         last_seen = MAX(last_seen, ?), first_seen = MIN(first_seen, ?),
         last_release = COALESCE(?, last_release), sample = COALESCE(?, sample),
         window_start = ?, window_count = ?, spike_alerted_at = ?, updated_at = ?
       WHERE project = ? AND id = ?`,
    )
    .bind(
      keep.length,
      items.length - keep.length,
      items.at(-1)!.row.ts_ms,
      items[0]!.row.ts_ms,
      kept?.info.release ?? null,
      kept ? sampleOf(kept) : null,
      w.start,
      w.count,
      w.alertedAt,
      run.now,
      run.project,
      id,
    );
}

/** A resolved issue that happens again (after it was resolved) is a regression. */
function regression(run: IssueRun, id: string, g: Group, kept: Parsed | undefined): void {
  const resolvedAt = g.known?.status === 'resolved' ? (g.known.resolved_at ?? 0) : null;
  if (resolvedAt === null || !kept || kept.row.ts_ms <= resolvedAt) return;
  run.writes.push(
    run.db
      .prepare(
        `UPDATE error_issues SET status = 'active', resolved_at = NULL, regressed_at = ?, regressions = regressions + 1
         WHERE project = ? AND id = ? AND status = 'resolved'`,
      )
      .bind(run.now, run.project, id),
  );
  if (run.alertsOn?.onRegression !== false) run.alerts.push({ kind: 'regression', id, p: kept });
}

function processIssue(run: IssueRun, id: string, g: Group): void {
  const items = g.items.sort((a, b) => a.row.ts_ms - b.row.ts_ms);
  creationWrites(run, id, g, items);
  const keep = keptOf(run, id, g, items);
  const w = spikeWindow(run, id, g, keep.length, items.at(-1)!);
  run.writes.push(updateWrite(run, id, items, keep, w));
  const kept = keep.at(-1);
  regression(run, id, g, kept);
  if (!g.known && kept && run.alertsOn?.onNew !== false)
    run.alerts.push({ kind: 'new', id, p: kept });
}

function alertMessage(
  a: Alert,
  ctx: EnrichContext,
  destination: string,
  now: number,
): DeliveryMessage {
  const project = ctx.project.id;
  const link = ctx.base
    ? `${ctx.base}/app#/errors/${encodeURIComponent(a.id)}?project=${encodeURIComponent(project)}`
    : '';
  const text = alertText(a.kind, project, a.p, a);
  return {
    v: 1,
    project,
    destination,
    event: {
      ...deliveryEvent(a.p.row),
      id: `alert-${a.id}-${a.kind}-${now}`,
      event: '$issue_alert',
      ts_ms: now,
      props: {
        alert: a.kind,
        issue_id: a.id,
        type: a.p.info.type,
        message: a.p.info.message,
        release: a.p.info.release,
        ...(a.count ? { count: a.count, minutes: a.minutes } : {}),
        link,
        $alert_text: link ? `${text} ${link}` : text,
      },
    },
  };
}

/** Alerts for exceptions from the last hour only (not for an import of old errors). */
async function sendAlerts(run: IssueRun, ctx: EnrichContext): Promise<void> {
  if (!run.alertsOn || !run.alerts.length) return;
  const destination = run.alertsOn.destination;
  const recent = run.alerts.filter((a) => a.p.row.ts_ms >= run.now - ALERT_WITHIN_MS);
  try {
    await sendMessages(
      ctx.env,
      recent.map((a) => alertMessage(a, ctx, destination, run.now)),
    );
  } catch (err) {
    console.error('[glass] issue alert failed', err);
  }
}

/**
 * The ingest step (registered in extensions.ts): fingerprint exceptions, create or update their
 * issues, drop exceptions of suppressed issues and those over the per-minute limit, and alert.
 */
export async function assignIssues(
  rows: StoredEvent[],
  ctx: EnrichContext,
): Promise<StoredEvent[]> {
  if (!rows.some((r) => r.event === '$exception')) return rows;
  const settings = ctx.project.settings;
  const parsed = await parseExceptions(rows, settings);
  const fps = [...new Set([...parsed.values()].map((p) => p.fp))];
  const run: IssueRun = {
    db: ctx.env.DB,
    project: ctx.project.id,
    now: ctx.now,
    minute: Math.floor(ctx.now / 60_000),
    limit: settings.errorRateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE,
    alertsOn: settings.errorAlerts,
    known: await knownIssues(ctx.env.DB, ctx.project.id, fps),
    drop: new Set(),
    writes: [],
    alerts: [],
  };
  for (const [id, g] of groupByIssue(parsed.values(), run.known)) processIssue(run, id, g);
  if (run.writes.length) await run.db.batch(run.writes);
  await sendAlerts(run, ctx);
  return rows
    .filter((r) => !run.drop.has(r))
    .map((r) => {
      const p = parsed.get(r);
      return p ? { ...r, props: JSON.stringify(p.props) } : r;
    });
}

// ── Issue rows ──────────────────────────────────────────────────────────────

export interface IssueRow {
  id: string;
  status: IssueStatus;
  mergedInto: string | null;
  assignee: string | null;
  type: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  dropped: number;
  firstRelease: string | null;
  lastRelease: string | null;
  resolvedAt: string | null;
  regressedAt: string | null;
  regressions: number;
}

interface Row {
  id: string;
  status: IssueStatus;
  merged_into: string | null;
  assignee: string | null;
  type: string;
  message: string;
  first_seen: number;
  last_seen: number;
  occurrences: number;
  dropped: number;
  first_release: string | null;
  last_release: string | null;
  resolved_at: number | null;
  regressed_at: number | null;
  regressions: number;
  sample: string | null;
  symbolicated: string | null;
}

const iso = (ms: number | null) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

function view(r: Row): IssueRow {
  return {
    id: r.id,
    status: r.status,
    mergedInto: r.merged_into,
    assignee: r.assignee,
    type: r.type,
    message: r.message,
    firstSeen: iso(r.first_seen)!,
    lastSeen: iso(r.last_seen)!,
    occurrences: r.occurrences,
    dropped: r.dropped,
    firstRelease: r.first_release,
    lastRelease: r.last_release,
    resolvedAt: iso(r.resolved_at),
    regressedAt: iso(r.regressed_at),
    regressions: r.regressions,
  };
}

/** Issues in a project (not merged ones), newest activity first. */
export async function listIssueRows(
  env: Env,
  project: string,
  options: { status?: IssueStatus | 'all'; search?: string; limit?: number } = {},
): Promise<{ issues: IssueRow[]; merged: Map<string, string> }> {
  const status = options.status ?? 'active';
  const { results } = await env.DB.prepare(
    `SELECT * FROM error_issues WHERE project = ?1
       AND (?2 = 'all' AND status <> 'merged' OR status = ?2)
       AND (?3 = '' OR instr(lower(type || ' ' || message), lower(?3)) > 0)
     ORDER BY last_seen DESC LIMIT ?4`,
  )
    .bind(project, status, options.search ?? '', options.limit ?? 500)
    .all<Row>();
  const { results: merged } = await env.DB.prepare(
    "SELECT id, merged_into FROM error_issues WHERE project = ? AND status = 'merged'",
  )
    .bind(project)
    .all<{ id: string; merged_into: string }>();
  return { issues: results.map(view), merged: new Map(merged.map((m) => [m.id, m.merged_into])) };
}

/** One issue (a merged id resolves to the issue it was merged into) and the ids merged into it. */
export async function getIssueRow(env: Env, project: string, id: string) {
  let r = await env.DB.prepare('SELECT * FROM error_issues WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<Row>();
  for (let hops = 0; r?.status === 'merged' && r.merged_into && hops < 5; hops++) {
    r = await env.DB.prepare('SELECT * FROM error_issues WHERE project = ? AND id = ?')
      .bind(project, r.merged_into)
      .first<Row>();
  }
  if (!r)
    throw new HttpError(404, `No issue "${id}"`, 'list_issues shows the issues in a project.');
  const { results } = await env.DB.prepare(
    "SELECT id FROM error_issues WHERE project = ? AND merged_into = ? AND status = 'merged'",
  )
    .bind(project, r.id)
    .all<{ id: string }>();
  const fingerprints = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM error_fingerprints WHERE project = ? AND issue_id = ?',
  )
    .bind(project, r.id)
    .first<{ n: number }>();
  return {
    issue: view(r),
    merged: results.map((m) => m.id),
    fingerprints: Number(fingerprints?.n ?? 0),
    sample: r.sample ? (JSON.parse(r.sample) as IssueSample) : null,
    symbolicated: r.symbolicated ? (JSON.parse(r.symbolicated) as SymbolicatedCache) : null,
  };
}

export interface IssueSample {
  event_id: string;
  ts: number;
  type: string;
  message: string;
  stack: string;
  url: string;
  release: string | null;
  handled: boolean;
  level: string;
  distinct_id: string;
  person_id: string;
  session_id: string | null;
  browser: string;
  os: string;
}

export async function updateIssue(
  env: Env,
  project: string,
  id: string,
  change: { status?: 'active' | 'resolved' | 'suppressed'; assignee?: string | null },
): Promise<IssueRow> {
  const { issue } = await getIssueRow(env, project, id);
  const now = Date.now();
  const status = change.status ?? issue.status;
  await env.DB.prepare(
    `UPDATE error_issues SET status = ?, assignee = ?, resolved_at = ?, updated_at = ? WHERE project = ? AND id = ?`,
  )
    .bind(
      status,
      change.assignee === undefined ? issue.assignee : change.assignee,
      status === 'resolved'
        ? issue.status === 'resolved'
          ? Date.parse(issue.resolvedAt ?? '') || now
          : now
        : null,
      now,
      project,
      issue.id,
    )
    .run();
  return (await getIssueRow(env, project, issue.id)).issue;
}

/**
 * Merge issues into one: their fingerprints point at `into` from now on (so new exceptions join
 * it), and their past exceptions are counted with it.
 */
export async function mergeIssues(
  env: Env,
  project: string,
  into: string,
  ids: string[],
): Promise<IssueRow> {
  const target = (await getIssueRow(env, project, into)).issue;
  const others = [...new Set(ids)].filter((i) => i !== target.id);
  if (others.length === 0) throw new HttpError(400, 'Give at least one other issue to merge');
  const rows = await Promise.all(others.map((i) => getIssueRow(env, project, i)));
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const { issue } of rows) {
    if (issue.id === target.id) continue;
    writes.push(
      env.DB.prepare(
        'UPDATE error_fingerprints SET issue_id = ? WHERE project = ? AND issue_id = ?',
      ).bind(target.id, project, issue.id),
      env.DB.prepare(
        "UPDATE error_issues SET merged_into = ? WHERE project = ? AND merged_into = ? AND status = 'merged'",
      ).bind(target.id, project, issue.id),
      env.DB.prepare(
        `UPDATE error_issues SET occurrences = occurrences + ?, dropped = dropped + ?,
           first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?), updated_at = ?
         WHERE project = ? AND id = ?`,
      ).bind(
        issue.occurrences,
        issue.dropped,
        Date.parse(issue.firstSeen),
        Date.parse(issue.lastSeen),
        now,
        project,
        target.id,
      ),
      env.DB.prepare(
        "UPDATE error_issues SET status = 'merged', merged_into = ?, updated_at = ? WHERE project = ? AND id = ?",
      ).bind(target.id, now, project, issue.id),
    );
  }
  if (writes.length) await env.DB.batch(writes);
  return (await getIssueRow(env, project, target.id)).issue;
}

// ── Source maps ────────────────────────────────────────────────────────────

const MAX_MAP_BYTES = 25 * 1024 * 1024;

function bucket(env: Env) {
  if (!env.REPLAYS) {
    throw new HttpError(
      501,
      'Source maps are stored in R2, and this deployment has no R2 bucket',
      'Enable R2 on the Cloudflare account, then run `npx dataflare-cli upgrade`.',
    );
  }
  return env.REPLAYS;
}

/** The path a map is filed under: the served path of the minified file, e.g. "/assets/index-BxT8.js". */
function normalisePath(path: string): string {
  const p = framePath(path.trim()).replace(/\.map$/, '');
  return p.startsWith('/') || /^[a-z]+:/i.test(p) ? p : `/${p}`;
}

export async function uploadSourcemap(
  env: Env,
  project: string,
  release: string,
  path: string,
  text: string,
): Promise<{ release: string; path: string; bytes: number; sources: number }> {
  if (!release || release.length > 200)
    throw new HttpError(400, 'A release (1–200 characters) is required');
  if (!path)
    throw new HttpError(
      400,
      'The served path of the minified file is required, e.g. "/assets/index-BxT8.js"',
    );
  if (text.length > MAX_MAP_BYTES) throw new HttpError(413, 'Source maps can be at most 25 MB');
  let map: RawSourceMap;
  try {
    map = parseSourceMap(text);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Not a source map');
  }
  const served = normalisePath(path);
  const key = `sourcemaps/${project}/${(await sha256Hex(`${release}\u0000${served}`)).slice(0, 40)}.map.gz`;
  const body = await gzip(text);
  await bucket(env).put(key, body, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
  });
  await env.DB.prepare(
    `INSERT INTO sourcemaps (project, release, path, object_key, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, release, path) DO UPDATE SET object_key = excluded.object_key, bytes = excluded.bytes, uploaded_at = excluded.uploaded_at`,
  )
    .bind(project, release, served, key, text.length, Date.now())
    .run();
  // Cached symbolication may have used an older map.
  await env.DB.prepare(
    'UPDATE error_issues SET symbolicated = NULL WHERE project = ? AND symbolicated IS NOT NULL',
  )
    .bind(project)
    .run();
  parsedMaps.delete(key);
  return { release, path: served, bytes: text.length, sources: map.sources.length };
}

export async function listSourcemaps(env: Env, project: string, release?: string) {
  const { results } = await env.DB.prepare(
    `SELECT release, path, bytes, uploaded_at FROM sourcemaps WHERE project = ?1 AND (?2 IS NULL OR release = ?2)
     ORDER BY uploaded_at DESC, path LIMIT 1000`,
  )
    .bind(project, release ?? null)
    .all<{ release: string; path: string; bytes: number; uploaded_at: number }>();
  return results.map((r) => ({
    release: r.release,
    path: r.path,
    bytes: r.bytes,
    uploadedAt: iso(r.uploaded_at),
  }));
}

export async function deleteSourcemaps(
  env: Env,
  project: string,
  release: string,
  path?: string,
): Promise<number> {
  const { results } = await env.DB.prepare(
    'SELECT path, object_key FROM sourcemaps WHERE project = ?1 AND release = ?2 AND (?3 IS NULL OR path = ?3)',
  )
    .bind(project, release, path ? normalisePath(path) : null)
    .all<{ path: string; object_key: string }>();
  if (results.length === 0) return 0;
  await bucket(env).delete(results.map((r) => r.object_key));
  await env.DB.prepare(
    'DELETE FROM sourcemaps WHERE project = ?1 AND release = ?2 AND (?3 IS NULL OR path = ?3)',
  )
    .bind(project, release, path ? normalisePath(path) : null)
    .run();
  return results.length;
}

/** Parsed maps kept per isolate (they're expensive to parse), a few at a time. */
const parsedMaps = new Map<string, RawSourceMap>();

async function loadMap(env: Env, key: string): Promise<RawSourceMap | null> {
  const hit = parsedMaps.get(key);
  if (hit) return hit;
  const obj = await env.REPLAYS?.get(key);
  if (!obj) return null;
  const map = parseSourceMap(await gunzip(new Uint8Array(await obj.arrayBuffer())));
  parsedMaps.set(key, map);
  while (parsedMaps.size > 5) parsedMaps.delete(parsedMaps.keys().next().value!);
  return map;
}

export interface SymbolicatedFrame extends StackFrame {
  original?: OriginalPosition;
}

interface SymbolicatedCache {
  event_id: string;
  frames: SymbolicatedFrame[];
  mapped: number;
}

const MAPPED_FRAMES = 20;

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * The uploaded map for each of these frames' files. An exception with a release uses that
 * release's maps only (another build's map would point at the wrong lines); one without uses the
 * newest map uploaded for the file.
 */
async function mapKeys(
  env: Env,
  project: string,
  frames: StackFrame[],
  release: string | null | undefined,
): Promise<Map<string, string>> {
  const paths = [
    ...new Set(
      frames
        .filter((f) => f.line !== null)
        .slice(0, MAPPED_FRAMES)
        .map((f) => framePath(f.file)),
    ),
  ];
  const keyFor = new Map<string, string>();
  if (!paths.length) return keyFor;
  const { results } = await env.DB.prepare(
    `SELECT path, release, object_key, uploaded_at FROM sourcemaps
     WHERE project = ?1 AND path IN (SELECT value FROM json_each(?2)) ORDER BY uploaded_at DESC`,
  )
    .bind(project, JSON.stringify(paths))
    .all<{ path: string; release: string; object_key: string }>();
  for (const r of results)
    if (release ? r.release === release : !keyFor.has(r.path)) keyFor.set(r.path, r.object_key);
  return keyFor;
}

/** Map one frame to its source position; true when it was mapped. */
async function mapFrame(env: Env, f: SymbolicatedFrame, key: string | undefined): Promise<boolean> {
  if (!key || f.line === null) return false;
  try {
    const map = await loadMap(env, key);
    const pos = map ? originalPositionFor(map, f.line, f.column ?? 1) : null;
    if (!pos) return false;
    f.original = pos;
    f.inApp = !/(^|\/)node_modules\//.test(pos.source);
    return true;
  } catch (err) {
    console.error('[glass] symbolication failed', err);
    return false;
  }
}

/**
 * The sample's frames, mapped to source where a map was uploaded for the frame's file (for the
 * exception's release, else the latest upload for that path). Cached on the issue.
 */
export async function symbolicatedFrames(
  env: Env,
  project: string,
  issueId: string,
  sample: IssueSample,
  cached: SymbolicatedCache | null,
  inAppIncludes?: readonly string[],
): Promise<{ frames: SymbolicatedFrame[]; mapped: number }> {
  if (cached && cached.event_id === sample.event_id) return cached;
  const frames: SymbolicatedFrame[] = markInApp(
    parseStack(sample.stack),
    hostOfUrl(sample.url),
    inAppIncludes,
  );
  let mapped = 0;
  if (env.REPLAYS) {
    const keyFor = await mapKeys(env, project, frames, sample.release);
    for (const f of frames.slice(0, MAPPED_FRAMES))
      if (await mapFrame(env, f, f.line !== null ? keyFor.get(framePath(f.file)) : undefined))
        mapped++;
  }
  const result = { event_id: sample.event_id, frames, mapped };
  await env.DB.prepare('UPDATE error_issues SET symbolicated = ? WHERE project = ? AND id = ?')
    .bind(JSON.stringify(result), project, issueId)
    .run();
  return result;
}
