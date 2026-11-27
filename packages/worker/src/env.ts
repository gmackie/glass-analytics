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

/** The slice of Cloudflare Email Sending's binding Dataflare uses: structured messages. */
export interface EmailSender {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    attachments?: {
      content: string;
      filename: string;
      type: string;
      disposition: 'inline' | 'attachment';
      contentId?: string;
    }[];
  }): Promise<{ messageId: string }>;
}

/** A Cloudflare Queues producer binding. */
interface QueueProducer {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: { body: unknown; delaySeconds?: number }[]): Promise<void>;
}

/** One message handed to the Worker's queue() handler. */
export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<T = unknown> {
  queue: string;
  messages: QueueMessage<T>[];
}

/** A Cloudflare Pipelines stream binding. */
export interface PipelineStream {
  send(records: object[]): Promise<void>;
}

/** Cloudflare supplies this execution context only after Access authenticates the request. */
export interface WorkerAccess {
  readonly aud: string;
  getIdentity(): Promise<{ email?: string; service_token_status?: boolean } | undefined>;
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
  /**
   * Cloudflare Email Sending (`send_email` binding), for emailed reports and alerts. Optional:
   * Workers Paid only, and the sender's domain must be onboarded. Without it, email isn't offered.
   */
  EMAIL?: EmailSender;
  /** The address reports are sent from (one of the binding's allowed sender addresses). */
  GLASS_EMAIL_FROM?: string;
  /** Queue for destination deliveries. Optional: without it, the five-minute task delivers. */
  DELIVERIES?: QueueProducer;
  /** Lake mode: Pipelines streams feeding Iceberg tables. */
  EVENTS_STREAM?: PipelineStream;
  IDENTITIES_STREAM?: PipelineStream;

  /** "d1" (default) or "lake". */
  GLASS_STORE?: string;
  /** Full-access key: queries plus flag, experiment and project changes. */
  GLASS_ADMIN_KEY?: string;
  /** Read-only key for agents and shared dashboards. */
  GLASS_READ_KEY?: string;
  /** Key for backends (import, flag definitions, source maps). Derived from the admin key when unset. */
  GLASS_SERVER_KEY?: string;
  /** Key for secrets stored in D1 (destination credentials). Derived from the salt secret when unset. */
  GLASS_ENCRYPTION_KEY?: string;
  /** Secret used to derive daily-rotating ids in cookieless mode. */
  GLASS_SALT_SECRET?: string;
  /** Public URL of this Worker (for links in agent responses). Inferred from requests when unset. */
  GLASS_PUBLIC_URL?: string;
  /** Collect first-party dashboard usage into this registered project on this Worker. */
  GLASS_DASHBOARD_ANALYTICS_PROJECT?: string;
  /** Access application audience for the dashboard and its same-origin browser API. */
  GLASS_ACCESS_AUD?: string;
  /** SHA-256 of the administrator's normalized Access email, kept out of the deployment manifest. */
  GLASS_ACCESS_ADMIN_EMAIL_SHA256?: string;
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
