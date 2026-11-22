/**
 * The lake store: Cloudflare Pipelines → Iceberg tables in R2 → Basin SQL.
 *
 * Writes go through Pipelines stream bindings (no credentials needed). Reads go
 * to the Basin SQL HTTP API with an API token. `dataflare init --lake` provisions
 * the streams, sinks and catalog; see packages/cli/src/cloudflare/provision.ts.
 *
 * Status: beta. Basin SQL (formerly R2 SQL) is in open beta and its API may
 * change; the endpoint paths and response parsing are isolated here for that reason.
 */

import type { StoredEvent } from '@dataflare/core/events';
import type { Row } from '@dataflare/core/insights/types';
import {
  LAKE_SCHEMA_CHANGES,
  type LakeSchemaChange,
  parseLakeVersions,
} from '@dataflare/core/lake';
import { basin } from '@dataflare/core/sql/dialect';
import type { Env } from '../env.ts';
import { HttpError } from '../http.ts';
import type { EventStore, IdentityLink } from './types.ts';

/** Basin SQL query endpoints, newest first. The `r2-sql` path predates the rename. */
const QUERY_PATHS = ['basin-sql', 'r2-sql'];
const API = 'https://api.sql.cloudflarestorage.com/api/v1/accounts';

export class LakeStore implements EventStore {
  readonly kind = 'lake';
  readonly dialect;
  /** Pipelines sinks roll files every 60s at the minimum setting. */
  readonly freshnessSeconds = 120;
  private readonly env: Env;
  private readonly fetcher: typeof fetch;

  constructor(
    env: Env,
    fetcher?: typeof fetch,
    /** Schema changes (tests pass their own to exercise multi-version tables). */
    changes: readonly LakeSchemaChange[] = LAKE_SCHEMA_CHANGES,
  ) {
    this.env = env;
    // Not `this.fetcher = fetch`: Workers throw "Illegal invocation" when fetch is called as a
    // method of another object, which `this.fetcher(...)` does.
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
    this.dialect = basin(
      env.LAKE_NAMESPACE ?? 'glass',
      parseLakeVersions(env.LAKE_VERSIONS),
      changes,
    );
  }

  async write(events: StoredEvent[]): Promise<void> {
    if (!this.env.EVENTS_STREAM)
      throw new HttpError(
        503,
        'EVENTS_STREAM binding is missing',
        'Run `dataflare init --lake` again.',
      );
    // Iceberg gets a real timestamp column for humans and partitioning; queries use ts_ms.
    await this.env.EVENTS_STREAM.send(
      events.map((e) => ({ ...e, ts: new Date(e.ts_ms).toISOString() })),
    );
  }

  async writeIdentity(link: IdentityLink): Promise<void> {
    await this.env.IDENTITIES_STREAM?.send([link]);
  }

  get userTables(): string {
    const ns = this.env.LAKE_NAMESPACE ?? 'glass';
    return `${ns}.events, ${ns}.identities`;
  }

  /**
   * People write `glass.events`; after a schema change the rows are split across `events` and
   * `events_v2`, so the plain names are replaced with the union of every version.
   */
  userSql(sql: string): string {
    const ns = this.env.LAKE_NAMESPACE ?? 'glass';
    return sql.replace(
      new RegExp(`\\b${ns}\\.(events|identities)\\b(?!_v\\d)`, 'g'),
      (_m, table: 'events' | 'identities') => this.dialect.table(table),
    );
  }

  async query(sql: string): Promise<Row[]> {
    const { CF_ACCOUNT_ID: account, LAKE_BUCKET: bucket, CF_API_TOKEN: token } = this.env;
    if (!account || !bucket || !token) {
      throw new HttpError(
        503,
        'Lake mode needs CF_ACCOUNT_ID, LAKE_BUCKET and CF_API_TOKEN',
        'Run `dataflare upgrade` to set them.',
      );
    }
    let last: Response | null = null;
    for (const path of QUERY_PATHS) {
      const res = await this.fetcher(`${API}/${account}/${path}/query/${bucket}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      if (res.status === 404) {
        last = res;
        continue;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const message = extractError(body) ?? `HTTP ${res.status}`;
        throw new HttpError(res.status === 400 ? 400 : 502, `Basin SQL error: ${message}`);
      }
      return normaliseRows(body);
    }
    throw new HttpError(502, `Basin SQL endpoint not found (HTTP ${last?.status ?? '?'})`);
  }

  async deleteGroupData(project: string, type: string, key: string): Promise<'queued'> {
    await this.env.DB.prepare(
      "INSERT INTO lake_deletions (project, ids, kind, requested_at) VALUES (?, ?, 'group', ?)",
    )
      .bind(project, JSON.stringify([type, key]), Date.now())
      .run();
    return 'queued';
  }

  async deletePersonEvents(project: string, ids: string[]): Promise<'queued'> {
    // Basin SQL is read-only, so an Iceberg engine deletes the rows: queue the ids for the lake
    // maintenance job (`dataflare lake maintain`, run daily from CI). See docs/lake.md.
    await this.env.DB.prepare(
      'INSERT INTO lake_deletions (project, ids, requested_at) VALUES (?, ?, ?)',
    )
      .bind(project, JSON.stringify(ids), Date.now())
      .run();
    return 'queued';
  }
}

function extractError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { errors?: { message?: string }[]; error?: string; message?: string };
  return b.errors?.[0]?.message ?? b.error ?? b.message ?? null;
}

/**
 * Accept the result shapes analytics APIs commonly return and produce plain row
 * objects. The Basin SQL response format is not yet documented, so this is
 * deliberately tolerant: arrays of objects, `{ rows, schema|columns }` with
 * positional rows, ClickHouse-style `{ meta, data }`, optionally wrapped in a
 * Cloudflare `{ result }` envelope.
 */
export function normaliseRows(body: unknown): Row[] {
  let value: unknown = body;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    value = (value as { result: unknown }).result;
  }
  if (Array.isArray(value)) {
    return value.every((r) => r && typeof r === 'object' && !Array.isArray(r))
      ? (value as Row[])
      : [];
  }
  if (!value || typeof value !== 'object') return [];
  const v = value as Record<string, unknown>;
  const rows = (v.rows ?? v.data ?? v.results) as unknown;
  if (!Array.isArray(rows)) return [];
  if (rows.length === 0 || !Array.isArray(rows[0])) return rows as Row[];
  const columns = (v.schema ?? v.columns ?? v.meta) as unknown;
  const names = Array.isArray(columns)
    ? columns.map((c) => (typeof c === 'string' ? c : String((c as { name?: string }).name ?? '')))
    : [];
  return (rows as unknown[][]).map((r) =>
    Object.fromEntries(r.map((cell, i) => [names[i] ?? `c${i}`, cell])),
  );
}
