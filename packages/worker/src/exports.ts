/**
 * Batch exports: every hour (or day), the events received since the last run go
 * to an S3-compatible bucket (AWS S3, Cloudflare R2, B2, MinIO…) as gzipped
 * JSONL or CSV files, to a BigQuery table, or to an HTTP endpoint as NDJSON.
 *
 * Runs are driven by the five-minute task and work in pages of rows ordered by
 * (received_ms, id), resuming from a cursor, so a big window spreads over ticks
 * without ever exceeding a Worker invocation's limits. Snowflake, Databricks and
 * Spark can read the S3 files (or the lake store's Iceberg tables directly).
 */

import { signSigV4 } from '@dataflare/core/aws-sigv4';
import { decryptJson, encryptJson } from '@dataflare/core/crypto';
import { EVENT_COLUMNS } from '@dataflare/core/events';
import { type ExportFormat, exportRow, formatRows, gzip } from '@dataflare/core/exports';
import { googleAccessToken, type ServiceAccount } from '@dataflare/core/google-auth';
import { trimTrailingSlashes } from '@dataflare/core/url';
import { encryptionKey } from './destinations.ts';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';
import type { EventStore } from './stores/types.ts';

export type ExportTarget = 's3' | 'bigquery' | 'http';
const PAGE_ROWS = 2000;
const PAGES_PER_TICK = 5;
/** Uploads per five-minute tick across all exports (a BigQuery page costs up to three requests). */
const REQUESTS_PER_TICK = 10;
/** Events can arrive a little after they're received-stamped; leave a margin before closing a window. */
const SETTLE_MS = 5 * 60_000;

let exportFetch: typeof fetch = (input, init) => fetch(input, init);
export function configureExports(options: { fetch?: typeof fetch }): void {
  if (options.fetch) exportFetch = options.fetch;
}

export interface BatchExport {
  id: string;
  name: string;
  target: ExportTarget;
  format: ExportFormat;
  frequency: 'hour' | 'day';
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: string[];
  watermark: string;
  running: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  target: ExportTarget;
  format: ExportFormat;
  frequency: 'hour' | 'day';
  enabled: number;
  config: string;
  secrets: string | null;
  watermark: number;
  cursor: string | null;
  created_at: number;
  project?: string;
}

const SECRETS: Record<ExportTarget, string[]> = {
  s3: ['accessKeyId', 'secretAccessKey'],
  bigquery: ['serviceAccount'],
  http: ['headers', 'url'],
};
const REQUIRED: Record<ExportTarget, string[]> = {
  s3: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'],
  bigquery: ['projectId', 'dataset', 'table', 'serviceAccount'],
  http: ['url'],
};

async function view(env: Env, r: Row): Promise<BatchExport> {
  let secretsSet: string[] = [];
  if (r.secrets) {
    secretsSet = Object.keys(
      await decryptJson<Record<string, unknown>>(await encryptionKey(env), r.secrets).catch(
        () => ({}),
      ),
    );
  }
  return {
    id: r.id,
    name: r.name,
    target: r.target,
    format: r.format,
    frequency: r.frequency,
    enabled: r.enabled === 1,
    config: JSON.parse(r.config) as Record<string, unknown>,
    secretsSet,
    watermark: new Date(r.watermark).toISOString(),
    running: r.cursor !== null,
    createdAt: r.created_at,
  };
}

export async function listExports(env: Env, project: string): Promise<BatchExport[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM batch_exports WHERE project = ? ORDER BY name',
  )
    .bind(project)
    .all<Row>();
  return Promise.all(results.map((r) => view(env, r)));
}

interface ExportInput {
  id?: string;
  name?: string;
  target?: ExportTarget;
  format?: ExportFormat;
  frequency?: 'hour' | 'day';
  enabled?: boolean;
  settings?: Record<string, unknown>;
  /** Export events received from this time (default: now, i.e. only new events). */
  from?: number;
}

async function existingExport(
  env: Env,
  project: string,
  id: string | undefined,
): Promise<Row | null> {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT * FROM batch_exports WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<Row>();
  if (!row) throw new HttpError(404, `No export "${id}"`);
  return row;
}

function targetOf(input: ExportInput, existing: Row | null): ExportTarget {
  const target = input.target ?? existing?.target;
  if (!target || !(target in SECRETS))
    throw new HttpError(400, 'target must be "s3", "bigquery" or "http"');
  if (existing && input.target && input.target !== existing.target)
    throw new HttpError(400, "An export's target can't change");
  return target as ExportTarget;
}

/** Settings into config or secrets (credentials); null removes one. */
function applySettings(
  target: ExportTarget,
  settings: Record<string, unknown>,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(settings)) {
    const into = SECRETS[target].includes(k) ? secrets : config;
    if (v === null) delete into[k];
    else into[k] = k === 'serviceAccount' && typeof v === 'string' ? JSON.parse(v) : v;
  }
  const missing = REQUIRED[target].filter(
    (k) => (SECRETS[target].includes(k) ? secrets : config)[k] === undefined,
  );
  if (missing.length) throw new HttpError(400, `A ${target} export needs ${missing.join(', ')}`);
}

export async function saveExport(
  env: Env,
  project: string,
  input: ExportInput,
): Promise<BatchExport> {
  const existing = await existingExport(env, project, input.id);
  const target = targetOf(input, existing);
  const key = await encryptionKey(env);
  const config: Record<string, unknown> = existing ? JSON.parse(existing.config) : {};
  const secrets: Record<string, unknown> = existing?.secrets
    ? await decryptJson<Record<string, unknown>>(key, existing.secrets).catch(() => ({}))
    : {};
  applySettings(target, input.settings ?? {}, config, secrets);
  const now = Date.now();
  const id = existing?.id ?? input.id ?? crypto.randomUUID().slice(0, 12);
  const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
  await env.DB.prepare(
    `INSERT INTO batch_exports (project, id, name, target, format, frequency, enabled, config, secrets, watermark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, id) DO UPDATE SET name = excluded.name, format = excluded.format, frequency = excluded.frequency,
       enabled = excluded.enabled, config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at`,
  )
    .bind(
      project,
      id,
      input.name ?? existing?.name ?? `${target} export`,
      target,
      input.format ?? existing?.format ?? 'jsonl',
      input.frequency ?? existing?.frequency ?? 'hour',
      enabled ? 1 : 0,
      JSON.stringify(config),
      Object.keys(secrets).length ? await encryptJson(key, secrets) : null,
      existing?.watermark ?? input.from ?? now,
      existing?.created_at ?? now,
      now,
    )
    .run();
  const r = await env.DB.prepare('SELECT * FROM batch_exports WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<Row>();
  return view(env, r!);
}

export async function deleteExport(env: Env, project: string, id: string): Promise<void> {
  const res = await env.DB.prepare('DELETE FROM batch_exports WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No export "${id}"`);
  await env.DB.prepare('DELETE FROM batch_export_runs WHERE project = ? AND export_id = ?')
    .bind(project, id)
    .run();
}

/** Re-export from `from` onwards (a backfill): moves the watermark back. */
export async function backfillExport(
  env: Env,
  project: string,
  id: string,
  from: number,
): Promise<void> {
  const res = await env.DB.prepare(
    'UPDATE batch_exports SET watermark = ?, cursor = NULL WHERE project = ? AND id = ?',
  )
    .bind(from, project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No export "${id}"`);
}

export async function exportRuns(env: Env, project: string, id: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, started_at, finished_at, status, from_ms, to_ms, rows, files, bytes, error FROM batch_export_runs WHERE project = ? AND export_id = ? ORDER BY started_at DESC LIMIT 50',
  )
    .bind(project, id)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id,
    status: r.status,
    window: {
      from: new Date(Number(r.from_ms)).toISOString(),
      to: new Date(Number(r.to_ms)).toISOString(),
    },
    startedAt: new Date(Number(r.started_at)).toISOString(),
    finishedAt: r.finished_at ? new Date(Number(r.finished_at)).toISOString() : null,
    rows: r.rows,
    files: r.files,
    bytes: r.bytes,
    ...(r.error ? { error: r.error } : {}),
  }));
}

/** Where the current window ends: the last full hour or day before now (with a settling margin). */
export function windowEnd(frequency: 'hour' | 'day', now: number): number {
  const unit = frequency === 'hour' ? 3_600_000 : 86_400_000;
  return Math.floor((now - SETTLE_MS) / unit) * unit;
}

interface Upload {
  rows: Record<string, unknown>[];
  page: number;
  from: number;
  to: number;
}

type Uploader = (
  project: string,
  r: Row,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
  u: Upload,
) => Promise<number>;

const contentType = (format: string) => (format === 'csv' ? 'text/csv' : 'application/x-ndjson');

/** One gzipped file per page, under prefix/project/yyyy/mm/dd/hh/. */
const uploadS3: Uploader = async (project, r, config, secrets, u) => {
  const body = await gzip(formatRows(u.rows, r.format));
  const date = new Date(u.from).toISOString();
  const prefix = String(config.prefix ?? 'dataflare/').replace(/^\/+/, '');
  const key = `${prefix}${project}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(11, 13)}/${u.from}-${u.to}-${String(u.page).padStart(4, '0')}.${r.format}.gz`;
  const url = `${trimTrailingSlashes(String(config.endpoint))}/${encodeURIComponent(String(config.bucket))}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const headers = await signSigV4({
    method: 'PUT',
    url,
    region: String(config.region ?? 'auto'),
    accessKeyId: String(secrets.accessKeyId),
    secretAccessKey: String(secrets.secretAccessKey),
    headers: { 'content-type': contentType(r.format), 'content-encoding': 'gzip' },
    body,
  });
  const res = await exportFetch(url, { method: 'PUT', headers, body: body as BodyInit });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return body.byteLength;
};

const uploadHttp: Uploader = async (_project, r, config, secrets, u) => {
  const text = formatRows(u.rows, r.format, u.page === 0);
  const res = await exportFetch(String(secrets.url ?? config.url), {
    method: 'POST',
    headers: {
      'Content-Type': contentType(r.format),
      'X-Dataflare-Window': `${new Date(u.from).toISOString()}/${new Date(u.to).toISOString()}`,
      ...((secrets.headers as Record<string, string>) ?? {}),
    },
    body: text,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return text.length;
};

/** The events table, partitioned by day; an existing table (409) is fine. */
async function ensureBigQueryTable(
  base: string,
  auth: Record<string, string>,
  table: string,
): Promise<void> {
  const fields = [
    ...EVENT_COLUMNS.map((c) => ({
      name: c,
      type: c === 'ts_ms' || c === 'received_ms' ? 'INTEGER' : 'STRING',
    })),
    { name: 'timestamp', type: 'TIMESTAMP' },
  ];
  const created = await exportFetch(base, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      tableReference: { tableId: table },
      schema: { fields },
      timePartitioning: { type: 'DAY', field: 'timestamp' },
    }),
  });
  if (!created.ok && created.status !== 409)
    throw new Error(
      `BigQuery create table ${created.status}: ${(await created.text()).slice(0, 300)}`,
    );
}

/** Rows for insertAll: JSON columns go in as JSON text, which BigQuery's JSON functions read. */
function bigQueryRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => {
    const json = exportRow(row, 'jsonl');
    for (const c of ['props', 'person_props', 'flags'])
      json[c] = typeof json[c] === 'string' ? json[c] : JSON.stringify(json[c]);
    return { insertId: String(row.id), json };
  });
}

/** Streaming inserts (the table is created on first use). */
const uploadBigQuery: Uploader = async (_project, _r, config, secrets, u) => {
  const token = await googleAccessToken(
    secrets.serviceAccount as ServiceAccount,
    'https://www.googleapis.com/auth/bigquery',
    exportFetch,
  );
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(String(config.projectId))}/datasets/${encodeURIComponent(String(config.dataset))}/tables`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (u.page === 0) await ensureBigQueryTable(base, auth, String(config.table));
  const body = JSON.stringify({ rows: bigQueryRows(u.rows) });
  const res = await exportFetch(`${base}/${encodeURIComponent(String(config.table))}/insertAll`, {
    method: 'POST',
    headers: auth,
    body,
  });
  const result = (await res.json().catch(() => ({}))) as {
    insertErrors?: unknown[];
    error?: { message?: string };
  };
  if (!res.ok || result.insertErrors?.length)
    throw new Error(
      `BigQuery insertAll: ${result.error?.message ?? JSON.stringify(result.insertErrors?.[0] ?? res.status).slice(0, 300)}`,
    );
  return body.length;
};

const UPLOADERS: Record<string, Uploader> = {
  s3: uploadS3,
  http: uploadHttp,
  bigquery: uploadBigQuery,
};

function upload(
  project: string,
  r: Row,
  secrets: Record<string, unknown>,
  u: Upload,
): Promise<number> {
  const config = JSON.parse(r.config) as Record<string, unknown>;
  return (UPLOADERS[r.target] ?? uploadBigQuery)(project, r, config, secrets, u);
}

type Cursor = { ts: number; id: string; page: number; run: string; to: number };

/** One export's pass in this tick: where it is, and how many requests it may still make. */
interface ExportPass {
  env: Env;
  store: EventStore;
  r: Row;
  project: string;
  now: number;
  secrets: Record<string, unknown>;
  from: number;
  to: number;
  runId: string;
  cursor: Cursor | null;
  budget: number;
  rowsSent: number;
}

async function openPass(
  env: Env,
  store: EventStore,
  r: Row,
  now: number,
  budget: number,
): Promise<ExportPass> {
  const secrets = r.secrets
    ? await decryptJson<Record<string, unknown>>(await encryptionKey(env), r.secrets)
    : {};
  const cursor = r.cursor ? (JSON.parse(r.cursor) as Cursor) : null;
  const pass: ExportPass = {
    env,
    store,
    r,
    project: r.project!,
    now,
    secrets,
    from: r.watermark,
    to: cursor?.to ?? windowEnd(r.frequency, now),
    runId: cursor?.run ?? crypto.randomUUID().slice(0, 12),
    cursor,
    budget,
    rowsSent: 0,
  };
  // A run row per attempt: a retry after a failure continues the window under a new run.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO batch_export_runs (project, id, export_id, started_at, status, from_ms, to_ms) VALUES (?, ?, ?, ?, 'running', ?, ?)",
  )
    .bind(pass.project, pass.runId, r.id, now, pass.from, pass.to)
    .run();
  return pass;
}

function pageQuery(pass: ExportPass): string {
  const d = pass.store.dialect;
  const c = pass.cursor;
  const after = c
    ? `AND (received_ms > ${d.num(c.ts)} OR (received_ms = ${d.num(c.ts)} AND id > ${d.str(c.id)}))`
    : '';
  return `SELECT ${EVENT_COLUMNS.join(', ')} FROM ${d.table('events')}
WHERE project = ${d.str(pass.project)} AND received_ms >= ${d.num(pass.from)} AND received_ms < ${d.num(pass.to)} ${after}
ORDER BY received_ms, id LIMIT ${PAGE_ROWS}`;
}

async function sendPage(
  pass: ExportPass,
  rows: Record<string, unknown>[],
  page: number,
): Promise<void> {
  pass.budget -= pass.r.target === 'bigquery' ? 3 : 1;
  const bytes = await upload(pass.project, pass.r, pass.secrets, {
    rows,
    page,
    from: pass.from,
    to: pass.to,
  });
  pass.rowsSent += rows.length;
  await pass.env.DB.prepare(
    'UPDATE batch_export_runs SET rows = rows + ?, files = files + 1, bytes = bytes + ? WHERE project = ? AND id = ?',
  )
    .bind(rows.length, bytes, pass.project, pass.runId)
    .run();
}

/** The window is done: move the watermark to its end. */
async function closeWindow(pass: ExportPass): Promise<void> {
  const db = pass.env.DB;
  await db.batch([
    db
      .prepare(
        'UPDATE batch_exports SET watermark = ?, cursor = NULL, updated_at = ? WHERE project = ? AND id = ?',
      )
      .bind(pass.to, pass.now, pass.project, pass.r.id),
    db
      .prepare(
        "UPDATE batch_export_runs SET status = 'done', finished_at = ? WHERE project = ? AND id = ?",
      )
      .bind(pass.now, pass.project, pass.runId),
  ]);
  pass.cursor = null;
}

/** Send one page; false once the window is done. */
async function exportPage(pass: ExportPass): Promise<boolean> {
  const rows = await pass.store.query(pageQuery(pass));
  const page = pass.cursor?.page ?? 0;
  if (rows.length) await sendPage(pass, rows, page);
  if (rows.length < PAGE_ROWS) {
    await closeWindow(pass);
    return false;
  }
  const last = rows.at(-1)!;
  pass.cursor = {
    ts: Number(last.received_ms),
    id: String(last.id),
    page: page + 1,
    run: pass.runId,
    to: pass.to,
  };
  await pass.env.DB.prepare(
    'UPDATE batch_exports SET cursor = ?, updated_at = ? WHERE project = ? AND id = ?',
  )
    .bind(JSON.stringify(pass.cursor), pass.now, pass.project, pass.r.id)
    .run();
  return true;
}

/** Record the failure and keep the cursor: the next tick retries the same page under a new run. */
async function failPass(pass: ExportPass, err: unknown): Promise<void> {
  const db = pass.env.DB;
  await db
    .prepare(
      "UPDATE batch_export_runs SET status = 'failed', finished_at = ?, error = ? WHERE project = ? AND id = ?",
    )
    .bind(pass.now, err instanceof Error ? err.message : String(err), pass.project, pass.runId)
    .run();
  if (!pass.cursor) return;
  await db
    .prepare('UPDATE batch_exports SET cursor = ? WHERE project = ? AND id = ?')
    .bind(
      JSON.stringify({ ...pass.cursor, run: crypto.randomUUID().slice(0, 12) }),
      pass.project,
      pass.r.id,
    )
    .run();
}

async function runPass(pass: ExportPass): Promise<void> {
  try {
    for (let p = 0; p < PAGES_PER_TICK && pass.budget > 0; p++)
      if (!(await exportPage(pass))) break;
  } catch (err) {
    await failPass(pass, err);
  }
}

/**
 * Maintenance: advance every enabled export by a few pages. A window closes once all its rows
 * are sent; the watermark then moves to its end.
 */
export async function runExports(env: Env, store: EventStore, now: number): Promise<number> {
  // Only exports with work to do: a window in progress, or a closed window not yet sent.
  const { results } = await env.DB.prepare(
    `SELECT * FROM batch_exports WHERE enabled = 1
       AND (cursor IS NOT NULL OR watermark < CASE frequency WHEN 'day' THEN ?2 ELSE ?1 END)
     ORDER BY updated_at LIMIT 10`,
  )
    .bind(windowEnd('hour', now), windowEnd('day', now))
    .all<Row>();
  let rowsSent = 0;
  let budget = REQUESTS_PER_TICK;
  for (const r of results) {
    if (budget <= 0) break;
    if (r.watermark >= windowEnd(r.frequency, now) && !r.cursor) continue;
    const pass = await openPass(env, store, r, now, budget);
    await runPass(pass);
    rowsSent += pass.rowsSent;
    budget = pass.budget;
  }
  return rowsSent;
}
