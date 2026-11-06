/**
 * Local configuration, kept in a `.glass/` folder at the project root:
 *
 *   .glass/config.json       deployment settings (commit this)
 *   .glass/credentials.json  API keys (git-ignored)
 *   .glass/wrangler.jsonc    generated Worker config (commit this)
 *   .glass/worker.js         the deployed Worker bundle (commit this)
 *   .glass/migrations/       D1 migrations
 *
 * Environment variables override files, for CI and agents:
 * GLASS_HOST, GLASS_API_KEY, GLASS_PROJECT.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface GlassConfig {
  /** Worker name. */
  name: string;
  accountId: string;
  /** Public URL of the Worker, e.g. https://glass.acme.workers.dev */
  host: string;
  /** Default project id. */
  project: string;
  store: 'd1' | 'lake';
  d1: { name: string; id: string };
  replay: { bucket: string } | null;
  lake: {
    bucket: string;
    namespace: string;
    streams: { events: string; identities: string };
    /** Schema version the Worker writes (absent: 1). The streams above are this version's. */
    version?: number;
    /** Table versions that hold data, which queries read together (absent: [1]). */
    versions?: number[];
  } | null;
  /** Optional route on your own domain, e.g. "acme.com/_glass/*". */
  route: string | null;
  /** Delete events older than this many days (D1 store). Unset keeps them. */
  retentionDays?: number | null;
  eu: boolean;
  /** Dataflare version last deployed. */
  version: string;
}

export interface Credentials {
  adminKey: string;
  readKey: string;
  saltSecret: string;
}

export const GLASS_DIR = '.glass';

/** The nearest directory (from cwd upwards) containing a deployment or client config in `.glass/`, else the nearest with package.json, else cwd. */
export function projectRoot(start = process.cwd()): string {
  let dir = resolve(start);
  let pkg: string | null = null;
  for (;;) {
    if (
      existsSync(join(dir, GLASS_DIR, 'config.json')) ||
      existsSync(join(dir, GLASS_DIR, 'client.json'))
    )
      return dir;
    if (!pkg && existsSync(join(dir, 'package.json'))) pkg = dir;
    const parent = dirname(dir);
    if (parent === dir) return pkg ?? resolve(start);
    dir = parent;
  }
}

export function glassDir(root = projectRoot()): string {
  return join(root, GLASS_DIR);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig(root = projectRoot()): GlassConfig | null {
  return readJson<GlassConfig>(join(glassDir(root), 'config.json'));
}

export interface ClientConfig {
  wranglerConfig?: string;
  environment?: string;
  host: string;
  project: string;
  service?: string;
}

export function loadClientConfig(root = projectRoot()): ClientConfig | null {
  return readJson<ClientConfig>(join(glassDir(root), 'client.json'));
}

export function saveConfig(config: GlassConfig, root = projectRoot()): void {
  writeJson(join(glassDir(root), 'config.json'), config);
}

export function loadCredentials(root = projectRoot()): Credentials | null {
  return readJson<Credentials>(join(glassDir(root), 'credentials.json'));
}

export function saveCredentials(credentials: Credentials, root = projectRoot()): void {
  const dir = glassDir(root);
  writeJson(join(dir, 'credentials.json'), credentials);
  // Keep keys out of git even if the user commits .glass/.
  writeFileSync(join(dir, '.gitignore'), 'credentials.json\n');
}

/** Where to send API calls, from env vars or `.glass/`. */
export function connection(): { host: string; key: string; project: string | undefined } {
  const config = loadClientConfig() ?? loadConfig();
  const credentials = loadCredentials();
  const host = process.env.GLASS_HOST ?? config?.host;
  const key = process.env.GLASS_API_KEY ?? credentials?.adminKey;
  if (!host || !key) {
    throw new UsageError(
      'No Dataflare deployment found here.',
      'Run `npx dataflare-cli init` in your project, or run `dataflare client-init` for an existing deployment, or set GLASS_HOST and GLASS_API_KEY.',
    );
  }
  return {
    host: host.replace(/\/+$/, ''),
    key,
    project: process.env.GLASS_PROJECT ?? config?.project,
  };
}

/** An error with a suggestion, printed without a stack trace. */
export class UsageError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}
