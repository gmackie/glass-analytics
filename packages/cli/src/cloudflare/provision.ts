/**
 * Provisioning: create (or find) every Cloudflare resource Dataflare needs, then
 * deploy the Worker. Every step is idempotent, so `dataflare init` can be re-run
 * safely and `dataflare upgrade` reuses the same steps.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAKE_SCHEMA_CHANGES,
  LAKE_TABLES,
  LAKE_VERSION,
  type LakeSchemaChange,
  type LakeTable,
  lakeTableName,
  streamSchemaFile,
} from '@dataflare/core/lake';
import type { GlassConfig } from '../config.ts';
import { must, parseJsonOutput, type Wrangler, WranglerError } from './wrangler.ts';

export type ProvisionReport = (
  status: 'ok' | 'created' | 'skipped',
  label: string,
  detail?: string,
) => void;

const isAlreadyExists = (err: unknown) =>
  err instanceof WranglerError && /already exists|already own|10004|11009/i.test(err.output);
const isR2Disabled = (err: unknown) =>
  err instanceof WranglerError &&
  /enable R2|R2 (is|has) not been enabled|purchase R2|10042/i.test(err.output);

/** Find or create the D1 database. */
export async function ensureD1(
  wrangler: Wrangler,
  name: string,
  eu: boolean,
  report: ProvisionReport,
): Promise<{ name: string; id: string }> {
  const find = async () =>
    parseJsonOutput<{ uuid: string; name: string }[]>(
      await must(wrangler, ['d1', 'list', '--json']),
    ).find((db) => db.name === name);
  let db = await find();
  if (db) {
    report('ok', `D1 database "${name}"`, 'exists');
  } else {
    await must(wrangler, ['d1', 'create', name, ...(eu ? ['--jurisdiction', 'eu'] : [])]);
    db = await find();
    if (!db) throw new Error(`Created D1 database "${name}" but could not find it afterwards.`);
    report('created', `D1 database "${name}"`);
  }
  return { name, id: db.uuid };
}

/** Create an R2 bucket. Returns false when R2 is not enabled on the account. */
export async function ensureBucket(
  wrangler: Wrangler,
  bucket: string,
  eu: boolean,
  report: ProvisionReport,
  purpose: string,
): Promise<boolean> {
  try {
    await must(wrangler, [
      'r2',
      'bucket',
      'create',
      bucket,
      ...(eu ? ['--jurisdiction', 'eu'] : []),
    ]);
    report('created', `R2 bucket "${bucket}" for ${purpose}`);
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) {
      report('ok', `R2 bucket "${bucket}" for ${purpose}`, 'exists');
      return true;
    }
    if (isR2Disabled(err)) return false;
    throw err;
  }
}

/** One Pipelines resource, as the REST API lists it. */
export interface PipelinesItem {
  id: string;
  name: string;
}

/** Lists streams, sinks or pipelines in the account. */
export type PipelinesLister = (kind: 'streams' | 'sinks' | 'pipelines') => Promise<PipelinesItem[]>;

/**
 * Lists Pipelines resources through the REST API. (`wrangler pipelines sinks list --json` prints a
 * JavaScript object literal rather than JSON, so the CLI can't parse it.)
 */
export function pipelinesLister(
  fetcher: typeof fetch,
  auth: { token: string; accountId: string },
): PipelinesLister {
  return async (kind) => {
    const items: PipelinesItem[] = [];
    for (let page = 1; page < 100; page++) {
      const res = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/pipelines/v1/${kind}?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        result?: PipelinesItem[];
        result_info?: { total_count?: number };
        errors?: { message?: string }[];
      } | null;
      if (!res.ok || !body?.success || !Array.isArray(body.result)) {
        const why = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
        throw new Error(`Could not list Pipelines ${kind}: ${why}`);
      }
      items.push(...body.result);
      if (body.result.length < 100 || items.length >= (body.result_info?.total_count ?? 0)) break;
    }
    return items;
  };
}

/**
 * Names of one deployment's Pipelines resources. Stream, sink and pipeline names are unique per
 * account, so they carry the deployment name: a fixed `glass_events` would make a second lake
 * deployment find the first one's resources and skip creating its own, losing its events.
 */
export function lakeResourceNames(
  deployment: string,
  table: LakeTable,
  version = 1,
): { stream: string; sink: string; pipeline: string } {
  const prefix = deployment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Version 2 onwards gets new names: a stream's schema is fixed, and its sink writes one table.
  const stream = `${prefix}_${lakeTableName(table, version)}`;
  return { stream, sink: `${stream}_sink`, pipeline: stream };
}

/**
 * Lake mode: an R2 bucket with the data catalog enabled, and for each table a
 * Pipelines stream (what the Worker writes to), a sink (Iceberg table) and a
 * pipeline (SQL connecting the two).
 */
export async function ensureLake(
  wrangler: Wrangler,
  options: {
    /** Deployment (Worker) name; Pipelines resource names are derived from it. */
    name: string;
    bucket: string;
    namespace: string;
    token: string;
    dir: string;
    list: PipelinesLister;
    /** Schema version to create streams, sinks and tables for (default: the current one). */
    version?: number;
    changes?: readonly LakeSchemaChange[];
  },
  report: ProvisionReport,
): Promise<{
  bucket: string;
  namespace: string;
  streams: Record<LakeTable, string>;
  version: number;
}> {
  const version = options.version ?? LAKE_VERSION;
  const changes = options.changes ?? LAKE_SCHEMA_CHANGES;
  // Basin Catalog doesn't support buckets in a jurisdiction (init refuses --lake with --eu).
  if (!(await ensureBucket(wrangler, options.bucket, false, report, 'event lake'))) {
    throw new Error(
      'Lake mode needs R2. Enable R2 in the Cloudflare dashboard, then run `dataflare init --lake` again.',
    );
  }
  // The data catalog was renamed (R2 Data Catalog → Basin Catalog); try both commands.
  let enabled = false;
  for (const args of [
    ['r2', 'bucket', 'catalog', 'enable', options.bucket],
    ['basin', 'catalog', 'enable', options.bucket],
  ]) {
    const r = await wrangler.run(args);
    if (r.code === 0 || /already enabled/i.test(r.stdout + r.stderr)) {
      enabled = true;
      break;
    }
  }
  if (!enabled)
    throw new Error(
      `Could not enable the data catalog on "${options.bucket}". Enable it in the R2 dashboard, then re-run.`,
    );
  report('ok', `Data catalog on "${options.bucket}"`);

  // Deletes (erasure, retention) are copy-on-write commits: the old files stay until their
  // snapshots expire. Expire after 7 days so erased rows leave R2 within a week; compaction keeps
  // Pipelines' small files (one per minute) from slowing queries.
  const maintenance: [string, string[]][] = [
    [
      'Snapshot expiration (7 days)',
      [
        'snapshot-expiration',
        'enable',
        options.bucket,
        '--older-than-days',
        '7',
        '--retain-last',
        '5',
        '--token',
        options.token,
      ],
    ],
    ['Compaction', ['compaction', 'enable', options.bucket, '--token', options.token]],
  ];
  for (const [label, args] of maintenance) {
    const r = await wrangler.run(['basin', 'catalog', ...args]);
    if (r.code === 0 || /already enabled/i.test(r.stdout + r.stderr)) report('ok', label);
    else report('skipped', label, 'enable it in the R2 dashboard (Basin Catalog settings)');
  }

  const streams = {} as Record<LakeTable, string>;
  for (const table of Object.keys(LAKE_TABLES) as LakeTable[]) {
    const {
      stream: streamName,
      sink: sinkName,
      pipeline: pipelineName,
    } = lakeResourceNames(options.name, table, version);
    const tableName = lakeTableName(table, version);
    const find = async (kind: 'streams' | 'sinks' | 'pipelines', name: string) =>
      (await options.list(kind)).find((i) => i.name === name);
    let stream = await find('streams', streamName);
    if (!stream) {
      const schemaPath = join(options.dir, 'schemas', `${tableName}.json`);
      mkdirSync(join(options.dir, 'schemas'), { recursive: true });
      writeFileSync(
        schemaPath,
        `${JSON.stringify(streamSchemaFile(table, version, changes), null, 2)}\n`,
      );
      await must(wrangler, [
        'pipelines',
        'streams',
        'create',
        streamName,
        '--schema-file',
        schemaPath,
        '--http-enabled',
        'false',
      ]);
      stream = await find('streams', streamName);
      if (!stream) throw new Error(`Created stream "${streamName}" but could not find it.`);
      report('created', `Pipelines stream "${streamName}"`);
    }
    streams[table] = stream.id;
    if (!(await find('sinks', sinkName))) {
      await must(wrangler, [
        'pipelines',
        'sinks',
        'create',
        sinkName,
        '--type',
        'r2-data-catalog',
        '--bucket',
        options.bucket,
        '--namespace',
        options.namespace,
        '--table',
        tableName,
        '--catalog-token',
        options.token,
        '--roll-interval',
        '60',
      ]);
      report('created', `Iceberg table "${options.namespace}.${tableName}"`);
    }
    if (!(await find('pipelines', pipelineName))) {
      await must(wrangler, [
        'pipelines',
        'create',
        pipelineName,
        '--sql',
        `INSERT INTO ${sinkName} SELECT * FROM ${streamName}`,
      ]);
      report('created', `Pipeline "${pipelineName}"`);
    }
  }
  return { bucket: options.bucket, namespace: options.namespace, streams, version };
}

/**
 * The replay bucket's settings for a deployment in `eu`. Before 0.8.1 the binding left out the
 * jurisdiction, so an EU deployment's Worker wrote to a default-jurisdiction bucket of the same
 * name, which Wrangler created on deploy. Such a config (EU, no jurisdiction recorded) moves to
 * the EU bucket and keeps the old one as the legacy bucket; the Worker moves its objects across.
 */
export function replayBucketConfig(
  bucket: string,
  eu: boolean,
  previous: Exclude<GlassConfig['replay'], false>,
): Exclude<GlassConfig['replay'], null | false> {
  if (!eu)
    return { bucket, ...(previous?.legacyBucket ? { legacyBucket: previous.legacyBucket } : {}) };
  const legacyBucket =
    previous?.legacyBucket ?? (previous && !previous.jurisdiction ? previous.bucket : undefined);
  return { bucket, jurisdiction: 'eu', ...(legacyBucket ? { legacyBucket } : {}) };
}

/** The Worker's wrangler.jsonc, generated from config. */
export function renderWranglerConfig(config: GlassConfig): string {
  const vars: Record<string, string> = { GLASS_STORE: config.store };
  if (config.lake) {
    vars.LAKE_BUCKET = config.lake.bucket;
    vars.LAKE_NAMESPACE = config.lake.namespace;
    vars.LAKE_VERSIONS = (config.lake.versions ?? [1]).join(',');
    vars.CF_ACCOUNT_ID = config.accountId;
  }
  if (config.route) vars.GLASS_PUBLIC_URL = `https://${config.route.replace(/\/\*$/, '')}`;
  if (config.retentionDays) vars.GLASS_RETENTION_DAYS = String(config.retentionDays);
  const wrangler: Record<string, unknown> = {
    name: config.name,
    main: 'worker.js',
    compatibility_date: '2026-10-01',
    // On a route, the zone's WAF and rate limits guard the Worker; a live
    // workers.dev address would be a way around them.
    workers_dev: !config.route,
    d1_databases: [
      {
        binding: 'DB',
        database_name: config.d1.name,
        database_id: config.d1.id,
        migrations_dir: 'migrations',
      },
    ],
    vars,
    triggers: { crons: ['17 * * * *'] },
    observability: { enabled: true },
  };
  if (config.replay) {
    const { bucket, jurisdiction, legacyBucket } = config.replay;
    wrangler.r2_buckets = [
      // Without the jurisdiction, an EU bucket is not found and Wrangler creates a
      // default-jurisdiction bucket of the same name instead.
      { binding: 'REPLAYS', bucket_name: bucket, ...(jurisdiction ? { jurisdiction } : {}) },
      ...(legacyBucket ? [{ binding: 'REPLAYS_LEGACY', bucket_name: legacyBucket }] : []),
    ];
  }
  if (config.lake) {
    wrangler.pipelines = [
      { binding: 'EVENTS_STREAM', stream: config.lake.streams.events },
      { binding: 'IDENTITIES_STREAM', stream: config.lake.streams.identities },
    ];
  }
  // A bare pattern lets Wrangler find the zone: it tries the route's host and each parent
  // domain in turn against the account's zones, so acme.co.uk and delegated subzones work.
  // Guessing the last two labels named "co.uk" as the zone.
  if (config.route) wrangler.routes = [config.route];
  return `// Generated by \`glass\`. Edit .glass/config.json and run \`dataflare upgrade\` instead of editing this file.\n${JSON.stringify(wrangler, null, 2)}\n`;
}

/** Copy the bundled Worker and migrations from the CLI package into .glass/. */
export function installWorkerFiles(dir: string, bundleDir: string): void {
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  copyFileSync(join(bundleDir, 'worker.js'), join(dir, 'worker.js'));
  for (const file of readdirSync(join(bundleDir, 'migrations'))) {
    copyFileSync(join(bundleDir, 'migrations', file), join(dir, 'migrations', file));
  }
}

export async function deploy(wrangler: Wrangler, configPath: string): Promise<string | null> {
  const out = await must(wrangler, ['deploy', '--config', configPath]);
  return /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? null;
}

export async function migrate(
  wrangler: Wrangler,
  database: string,
  configPath: string,
): Promise<void> {
  await must(wrangler, ['d1', 'migrations', 'apply', database, '--remote', '--config', configPath]);
}

export async function putSecrets(
  wrangler: Wrangler,
  secrets: Record<string, string>,
  configPath: string,
  dir: string,
): Promise<void> {
  // `secret bulk` reads a JSON file; write it, upload, then remove it.
  const file = join(dir, '.secrets.tmp.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    await must(wrangler, ['secret', 'bulk', file, '--config', configPath]);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Cloudflare accounts the token can see. */
export async function listAccounts(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; name: string }[]> {
  const res = await fetcher('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { id: string; name: string }[];
    errors?: { message: string }[];
  };
  if (!res.ok || !body.success) {
    throw new Error(
      `Cloudflare rejected the API token: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`,
    );
  }
  return body.result ?? [];
}

/** Token scopes Dataflare needs, shown when something is denied. */
export const TOKEN_SCOPES = [
  'Account › Workers Scripts › Edit',
  'Account › D1 › Edit',
  'Account › Workers R2 Storage › Edit',
  'Account › Account Settings › Read',
  'Zone › Workers Routes › Edit (only with --route)',
  'Account › Pipelines › Edit, Workers R2 Data Catalog › Edit, Workers R2 SQL › Read (only with --lake)',
];
