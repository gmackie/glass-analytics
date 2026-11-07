/**
 * Local implementations of the Cloudflare bindings Dataflare uses, so the real
 * Worker code runs in Node for tests and for `pnpm dev`:
 *
 * - D1 → node:sqlite (the same SQLite engine D1 runs)
 * - R2 → memory or a directory on disk
 * - Pipelines streams → arrays
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import type {
  Assets,
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  PipelineStream,
  R2Bucket,
  R2ObjectBody,
} from '../src/env.ts';
import { clearProjectCache } from '../src/projects.ts';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

type Value = null | number | bigint | string | Uint8Array;
const toSqlite = (v: unknown): Value =>
  v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Value);

const D1_MAX_PARAMETERS = 100;

class Statement implements D1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly args: Value[];

  constructor(db: DatabaseSync, sql: string, args: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    // D1 rejects a statement with more than 100 bound parameters; plain SQLite allows 32766.
    if (values.length > D1_MAX_PARAMETERS) {
      throw new Error(`D1 allows ${D1_MAX_PARAMETERS} bound parameters, got ${values.length}`);
    }
    return new Statement(this.db, this.sql, values.map(toSqlite));
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    // D1 reports changed_db from total_changes(), as miniflare does; the store relies on it.
    const before = this.totalChanges();
    const results = this.db.prepare(this.sql).all(...this.args) as T[];
    return { results, success: true, meta: { changed_db: this.totalChanges() !== before } };
  }

  private totalChanges(): number {
    return Number((this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  runSync(): D1Result {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
}

/** D1 over node:sqlite, with the Dataflare migrations applied. */
export class SqliteD1 implements D1Database {
  readonly sqlite: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    for (const file of readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      this.sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((s) => (s as Statement).runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }
}

const bytesOf = (value: ArrayBuffer | Uint8Array | string) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);

const body = (key: string, bytes: Uint8Array): R2ObjectBody => ({
  key,
  size: bytes.byteLength,
  arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
});

/** R2 in memory. */
export class MemoryR2 implements R2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    this.objects.set(key, bytesOf(value));
    return {};
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? body(key, bytes) : null;
  }
  async list({
    prefix,
    cursor,
    limit = 1000,
  }: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }) {
    // Like R2, a page holds at most `limit` keys, and its cursor resumes after the last one.
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor))
      .sort();
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.byteLength })),
      truncated,
      ...(truncated ? { cursor: page.at(-1) } : {}),
    };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

/** R2 backed by a directory, for `pnpm dev`. */
export class DirectoryR2 implements R2Bucket {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  private path(key: string) {
    return join(this.root, ...key.split('/').map((p) => encodeURIComponent(p)));
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytesOf(value));
    return {};
  }
  async get(key: string) {
    try {
      return body(key, new Uint8Array(readFileSync(this.path(key))));
    } catch {
      return null;
    }
  }
  async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) {
    const dir = this.path(prefix.replace(/\/$/, ''));
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      names = [];
    }
    const objects = names
      .slice(0, limit)
      .map((n) => ({ key: `${prefix}${decodeURIComponent(n)}`, size: 0 }));
    return { objects, truncated: names.length > limit };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) rmSync(this.path(k), { force: true });
  }
}

export class ArrayStream implements PipelineStream {
  readonly records: object[] = [];
  async send(records: object[]) {
    this.records.push(...records);
  }
}

export const TEST_ASSETS: Assets = {
  sdk: '/* sdk */',
  replay: '/* replay */',
  dashboardJs: '/* dashboard */',
  dashboardCss: '/* css */',
};

export const ADMIN = 'test-admin-key';
export const READ = 'test-read-key';

export interface TestApp {
  env: Env;
  db: SqliteD1;
  r2: MemoryR2;
  /** Make a request; `key` defaults to the admin key, pass null for none. */
  call(
    method: string,
    path: string,
    options?: { body?: unknown; key?: string | null; headers?: Record<string, string> },
  ): Promise<Response>;
  json<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: { body?: unknown; key?: string | null },
  ): Promise<T>;
  ingest(
    events: Record<string, unknown>[],
    options?: { project?: string; headers?: Record<string, string> },
  ): Promise<Response>;
  app: ReturnType<typeof createApp>;
}

export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function testApp(
  envOverrides: Partial<Env> = {},
  options: Partial<Parameters<typeof createApp>[0]> = {},
): TestApp {
  clearProjectCache();
  const db = new SqliteD1();
  const r2 = new MemoryR2();
  const env: Env = {
    DB: db,
    REPLAYS: r2,
    GLASS_ADMIN_KEY: ADMIN,
    GLASS_READ_KEY: READ,
    GLASS_SALT_SECRET: 'salt',
    ...envOverrides,
  };
  const app = createApp({ assets: TEST_ASSETS, ...options });
  const call: TestApp['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { 'User-Agent': CHROME_UA, ...o.headers };
    const key = o.key === undefined ? ADMIN : o.key;
    if (key) headers.Authorization = `Bearer ${key}`;
    const body =
      o.body === undefined
        ? undefined
        : typeof o.body === 'string' || o.body instanceof Uint8Array
          ? o.body
          : JSON.stringify(o.body);
    return app.fetch(
      new Request(`https://glass.test${path}`, {
        method,
        headers,
        body: body as BodyInit | undefined,
      }),
      env,
    );
  };
  return {
    env,
    db,
    r2,
    app,
    call,
    async json(method, path, o) {
      const res = await call(method, path, o);
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
      return JSON.parse(text);
    },
    ingest(events, o = {}) {
      return call('POST', '/e', {
        key: null,
        headers: { 'Content-Type': 'text/plain', ...o.headers },
        body: { project: o.project ?? 'acme', sent_at: Date.now(), lib: 'test', events },
      });
    },
  };
}

let n = 0;
/** A wire event with defaults. */
export function wire(event: string, extra: Record<string, unknown> = {}) {
  return {
    id: `e-${Date.now()}-${++n}`,
    event,
    ts: Date.now() - 1000,
    distinct_id: 'device-1',
    session_id: 'session-1',
    url: 'https://acme.com/',
    ...extra,
  };
}
