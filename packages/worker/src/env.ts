/**
 * The Worker's environment: Cloudflare bindings, vars and secrets.
 *
 * The binding interfaces below are the narrow slices of Cloudflare's APIs that
 * Dataflare actually uses. Real bindings satisfy them structurally; the test
 * harness implements them over SQLite and memory. Keeping them narrow documents
 * exactly what Dataflare depends on, and is what makes alternative backends easy.
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; [key: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2Object {
  key: string;
  size: number;
}

export interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

/** A Cloudflare Pipelines stream binding. */
export interface PipelineStream {
  send(records: object[]): Promise<void>;
}

export interface Env {
  /** D1: config, persons, identities, flags, experiments, replay index — and events in "d1" mode. */
  DB: D1Database;
  /** R2 bucket for replay chunks. Optional: replay is disabled without it. */
  REPLAYS?: R2Bucket;
  /**
   * An EU deployment from before 0.8.1 wrote replays to a default-jurisdiction bucket. It stays
   * bound here until the hourly job has moved its objects into REPLAYS (see `moveLegacyReplays`).
   */
  REPLAYS_LEGACY?: R2Bucket;
  /** Lake mode: Pipelines streams feeding Iceberg tables. */
  EVENTS_STREAM?: PipelineStream;
  IDENTITIES_STREAM?: PipelineStream;

  /** "d1" (default) or "lake". */
  GLASS_STORE?: string;
  /** Full-access key: queries plus flag, experiment and project changes. */
  GLASS_ADMIN_KEY?: string;
  /** Read-only key for agents and shared dashboards. */
  GLASS_READ_KEY?: string;
  /** Secret used to derive daily-rotating ids in cookieless mode. */
  GLASS_SALT_SECRET?: string;
  /** Public URL of this Worker (for links in agent responses). Inferred from requests when unset. */
  GLASS_PUBLIC_URL?: string;
  /** Delete events older than this many days (d1 mode). Unset keeps everything. */
  GLASS_RETENTION_DAYS?: string;
  /** Delete replays older than this many days. Default 30. */
  GLASS_REPLAY_RETENTION_DAYS?: string;

  /** Lake mode settings. */
  LAKE_BUCKET?: string;
  LAKE_NAMESPACE?: string;
  /** Lake table versions queries read, e.g. "1,2" after a schema change (default "1"). */
  LAKE_VERSIONS?: string;
  CF_ACCOUNT_ID?: string;
  /** API token with Basin SQL Read (+ catalog read) for queries. */
  CF_API_TOKEN?: string;
}

/** Built bundles the Worker serves. Injected at build time; see scripts/build.ts. */
export interface Assets {
  /** Script-tag SDK (`/s.js`). */
  sdk: string;
  /** Replay recorder (`/replay.js`). */
  replay: string;
  /** Dashboard JavaScript and CSS. */
  dashboardJs: string;
  dashboardCss: string;
}
