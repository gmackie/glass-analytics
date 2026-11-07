/**
 * `dataflare upgrade` — redeploy the Worker bundled with this CLI version and
 * apply new migrations. When `.github/workflows/glass.yml` exists (see
 * `dataflare ci`), a run outside CI only stages the files and CI deploys them.
 * `dataflare ci` — write that workflow. `dataflare status` — check a deployment end to end.
 * `dataflare key` — print connection details for the dashboard or an agent.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAKE_VERSION, type LakeSchemaChange } from '@dataflare/core/lake';
import { GLASS_VERSION, isNewerThan, UPGRADE_COMMAND } from '@dataflare/core/version';
import {
  CI_WORKFLOW_PATH,
  ciNextSteps,
  defaultBranch,
  hasCiWorkflow,
  inCi,
  writeCiWorkflow,
} from '../ci.ts';
import { call } from '../client.ts';
import {
  deploy,
  ensureBucket,
  ensureLake,
  installWorkerFiles,
  migrate,
  pipelinesLister,
  putSecrets,
  renderWranglerConfig,
  replayBucketConfig,
} from '../cloudflare/provision.ts';
import { createWrangler, type Wrangler } from '../cloudflare/wrangler.ts';
import {
  connection,
  glassDir,
  loadConfig,
  loadCredentials,
  projectRoot,
  saveConfig,
  UsageError,
} from '../config.ts';
import { color, line, ok, printJson, skip } from '../output.ts';
import { ask } from '../prompt.ts';

/** Where the built Worker lives: next to the CLI bundle when installed, or in the repo during development. */
export function workerBundleDir(): string {
  const candidates = [
    new URL('./worker/', import.meta.url),
    new URL('../../../worker/dist/', import.meta.url),
  ];
  for (const c of candidates) {
    const dir = fileURLToPath(c);
    if (existsSync(join(dir, 'worker.js')) && existsSync(join(dir, 'migrations'))) return dir;
  }
  throw new UsageError(
    'The Worker bundle is missing.',
    'If you are working on Dataflare itself, run `pnpm build` first.',
  );
}

export interface UpgradeOptions {
  token?: string;
  json?: boolean;
  /** Deploy as a CI runner: no prompts, Worker secrets left as they are. Defaults to true when CI=true. */
  ci?: boolean;
  /** Deploy from this machine even though a Dataflare CI workflow exists. */
  local?: boolean;
  /** Allow replacing a newer deployed Worker with this CLI's older one. */
  allowDowngrade?: boolean;
  /** Delete events older than this many days (0 keeps them forever). Saved in .glass/config.json. */
  retentionDays?: number;
  /** `false` turns session replay off and stops upgrades from creating its R2 bucket. Saved. */
  replay?: boolean;
}

export interface UpgradeDeps {
  wrangler?: (auth: { token: string; accountId: string }, cwd: string) => Wrangler;
  fetcher?: typeof fetch;
  root?: string;
  bundleDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Lake schema version and changes to move to (tests simulate a schema change). */
  lakeVersion?: number;
  lakeChanges?: readonly LakeSchemaChange[];
}

/** The version the live Worker reports, or null if it can't be reached quickly. */
async function liveVersion(host: string, fetcher: typeof fetch): Promise<string | null> {
  if (!host) return null;
  try {
    const res = await fetcher(`${host}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export async function upgrade(options: UpgradeOptions, deps: UpgradeDeps = {}): Promise<void> {
  const root = deps.root ?? projectRoot();
  const env = deps.env ?? process.env;
  const config = loadConfig(root);
  if (!config)
    throw new UsageError(
      'No Dataflare deployment in this project.',
      'Run `npx dataflare-cli init` first.',
    );
  if (options.retentionDays !== undefined) {
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 0)
      throw new UsageError(
        '--retention-days takes a whole number of days.',
        'For example --retention-days 400; 0 keeps events forever.',
      );
    config.retentionDays = options.retentionDays || null;
  }
  const ci = options.ci ?? inCi(env);
  const credentials = loadCredentials(root);
  if (!credentials && !ci)
    throw new UsageError(
      'No .glass/credentials.json in this project.',
      'Run `npx dataflare-cli init` again to restore keys, or deploy from CI (`dataflare upgrade --ci`), which leaves Worker secrets as they are.',
    );
  const dir = glassDir(root);
  const bundle = deps.bundleDir ?? workerBundleDir();

  // Never replace a newer Worker with an older one: CLI and Worker versions are the same number,
  // so an older CLI (an `npx` cache, a stale pin) would silently drop features and migrations.
  const live = await liveVersion(config.host, deps.fetcher ?? fetch);
  const deployed = [config.version, live]
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => (isNewerThan(a, b) ? -1 : 1))[0];
  if (deployed && isNewerThan(deployed, GLASS_VERSION) && !options.allowDowngrade) {
    throw new UsageError(
      `This deployment runs Dataflare ${deployed}, which is newer than this CLI (${GLASS_VERSION}). Nothing was changed.`,
      `Run \`${UPGRADE_COMMAND}\` (or npx dataflare-cli@${deployed} or later). --allow-downgrade forces the older Worker.`,
    );
  }
  const from = config.version;
  // `--no-replay` records an opt-out on an install without replay storage. With a bucket, dropping
  // the binding would strand its replays (and, mid EU move, the legacy bucket's), so refuse.
  if (options.replay === false && config.replay)
    throw new UsageError(
      `Session replay is set up with bucket "${config.replay.bucket}". Nothing was changed.`,
      '--no-replay only records the choice on installs without replay storage. To turn replay off here, delete the replays first, then set "replay": false in .glass/config.json.',
    );
  // An EU deployment from before 0.8.1 switches to its EU replay bucket (see replayBucketConfig).
  if (config.replay)
    config.replay = replayBucketConfig(config.replay.bucket, config.eu, config.replay);

  // With a CI workflow, a laptop upgrade only stages files; the workflow deploys them.
  if (hasCiWorkflow(root) && !ci && !options.local) {
    installWorkerFiles(dir, bundle);
    config.version = GLASS_VERSION;
    writeFileSync(join(dir, 'wrangler.jsonc'), renderWranglerConfig(config));
    saveConfig(config, root);
    // Refresh a generated workflow: one written before the rename runs `@glassanalytics/cli@<version>`,
    // which has no new versions, so it must switch to `dataflare` along with this upgrade.
    writeCiWorkflow(root);
    const branch = defaultBranch(root);
    if (options.json) {
      printJson({
        from,
        to: GLASS_VERSION,
        staged: true,
        deploy: CI_WORKFLOW_PATH,
        next: `Commit .glass/ and push to ${branch}`,
      });
      return;
    }
    ok(
      `Staged Dataflare ${from === GLASS_VERSION ? GLASS_VERSION : `${from} → ${GLASS_VERSION}`} in .glass/ (nothing deployed)`,
    );
    line(`  Commit .glass/ and push to ${branch}; ${CI_WORKFLOW_PATH} migrates and deploys it.`);
    line(color.dim('  Deploying from this machine instead: dataflare upgrade --local'));
    return;
  }

  const token =
    options.token ??
    env.CLOUDFLARE_API_TOKEN ??
    (ci
      ? undefined
      : await ask('Cloudflare API token', {
          flag: '--token (or CLOUDFLARE_API_TOKEN)',
          secret: true,
        }));
  if (!token)
    throw new UsageError(
      'CLOUDFLARE_API_TOKEN is not set.',
      `In CI, map the repository secret to it (see ${CI_WORKFLOW_PATH}).`,
    );
  const wrangler = (deps.wrangler ?? createWrangler)({ token, accountId: config.accountId }, root);
  const report = (status: 'ok' | 'created' | 'skipped', label: string, detail?: string) => {
    if (options.json) return;
    (status === 'skipped' ? skip : ok)(`${label}${detail ? color.dim(` (${detail})`) : ''}`);
  };

  // `--no-replay` turns replay off for good; an install from before that was recorded passes it once.
  if (options.replay === false) config.replay = false;
  // Replay may have been skipped because R2 wasn't enabled; try again, unless it was turned off.
  if (
    config.replay === null &&
    (await ensureBucket(wrangler, `${config.name}-replays`, config.eu, report, 'session replay'))
  ) {
    config.replay = replayBucketConfig(`${config.name}-replays`, config.eu, null);
  }
  // Lake schema change: a new version gets its own streams, sinks and tables (a stream's schema is
  // fixed and a sink can't write to an existing table). The Worker switches to writing the new
  // version; queries read every version together. Old tables keep their rows.
  const lakeVersion = deps.lakeVersion ?? LAKE_VERSION;
  if (config.lake && (config.lake.version ?? 1) < lakeVersion) {
    const from = config.lake.version ?? 1;
    const next = await ensureLake(
      wrangler,
      {
        name: config.name,
        bucket: config.lake.bucket,
        namespace: config.lake.namespace,
        token,
        dir,
        list: pipelinesLister(deps.fetcher ?? fetch, { token, accountId: config.accountId }),
        version: lakeVersion,
        changes: deps.lakeChanges,
      },
      report,
    );
    config.lake = {
      ...config.lake,
      streams: next.streams,
      version: lakeVersion,
      versions: [...new Set([...(config.lake.versions ?? [from]), lakeVersion])].sort(
        (a, b) => a - b,
      ),
    };
    report(
      'ok',
      `Lake schema ${from} → ${lakeVersion}`,
      'new events go to the new tables; old ones stay',
    );
  }
  installWorkerFiles(dir, bundle);
  const configPath = join(dir, 'wrangler.jsonc');
  writeFileSync(configPath, renderWranglerConfig(config));
  await migrate(wrangler, config.d1.name, configPath);
  report('ok', 'Migrations applied');
  await deploy(wrangler, configPath);
  if (credentials) {
    await putSecrets(
      wrangler,
      {
        GLASS_ADMIN_KEY: credentials.adminKey,
        GLASS_READ_KEY: credentials.readKey,
        GLASS_SALT_SECRET: credentials.saltSecret,
        // CF_API_TOKEN (lake mode) is set by init and left alone here, so a narrower token you set stays.
      },
      configPath,
      dir,
    );
  } else {
    report(
      'skipped',
      'Worker secrets',
      'no credentials.json here; the keys set by init stay in place',
    );
  }
  config.version = GLASS_VERSION;
  saveConfig(config, root);
  if (options.json)
    printJson({
      from,
      to: GLASS_VERSION,
      host: config.host,
      replay: Boolean(config.replay),
      staged: false,
    });
  else
    ok(
      `Dataflare ${from === GLASS_VERSION ? GLASS_VERSION : `${from} upgraded to ${GLASS_VERSION}`} is live at ${config.host}`,
    );
  if (!ci && !hasCiWorkflow(root) && !options.json) {
    line(
      color.dim(
        `  Tip: \`dataflare ci\` writes ${CI_WORKFLOW_PATH} so future upgrades deploy from CI instead of this machine.`,
      ),
    );
  }
}

/** `dataflare ci`: write (or refresh) the GitHub Actions workflow that deploys Dataflare. */
export function ci(
  options: { branch?: string; secret?: string; json?: boolean },
  deps: { root?: string } = {},
): void {
  const root = deps.root ?? projectRoot();
  if (!loadConfig(root))
    throw new UsageError(
      'No Dataflare deployment in this project.',
      'Run `npx dataflare-cli init` first.',
    );
  const result = writeCiWorkflow(root, { branch: options.branch, secret: options.secret });
  const next = ciNextSteps(result);
  if (options.json) {
    printJson({ ...result, next });
    return;
  }
  (result.status === 'kept' ? skip : ok)(
    `${result.path} ${result.status === 'kept' ? 'already exists (left as is)' : result.status}`,
  );
  line();
  line(color.bold('Finish CI setup'));
  for (const [i, step] of next.entries()) line(`  ${i + 1}. ${step}`);
}

export async function status(options: { json?: boolean }): Promise<void> {
  const conn = connection();
  const config = loadConfig();
  const health = await call<{
    version: string;
    latest?: string | null;
    upgradeAvailable?: boolean;
    upgradeCommand?: string;
    store: string;
    replay: boolean;
    freshnessSeconds: number;
  }>('GET', '/health');
  const events = await call<{ events: { event: string; count: number; lastSeen: string }[] }>(
    'GET',
    `/api/events?days=1${conn.project ? `&project=${conn.project}` : ''}`,
  ).catch(() => ({ events: [] }));
  const total = events.events.reduce((a, e) => a + e.count, 0);
  const last = events.events
    .map((e) => e.lastSeen)
    .sort()
    .at(-1);
  const mcp = existsSync(join(projectRoot(), '.mcp.json'));
  const cliMismatch = health.version !== GLASS_VERSION;
  const npmNewer = Boolean(health.latest && isNewerThan(health.latest, health.version));
  const upgradeAvailable = Boolean(health.upgradeAvailable) || cliMismatch || npmNewer;
  const upgradeCommand = health.upgradeCommand ?? UPGRADE_COMMAND;
  const result = {
    host: conn.host,
    project: conn.project,
    version: health.version,
    latest: health.latest ?? null,
    cliVersion: GLASS_VERSION,
    store: health.store,
    replay: health.replay,
    eventsLast24h: total,
    lastEvent: last ?? null,
    mcpConfigured: mcp,
    upgradeAvailable,
    upgradeCommand,
    account: config?.accountId,
  };
  if (options.json) return printJson(result);
  ok(`Worker reachable at ${conn.host} (Dataflare ${health.version}, ${health.store} store)`);
  (total ? ok : skip)(
    total
      ? `${total.toLocaleString('en-US')} events in the last 24 hours, latest ${last}`
      : 'No events in the last 24 hours. Is the snippet installed?',
  );
  (health.replay ? ok : skip)(
    health.replay
      ? 'Session replay enabled'
      : 'Session replay disabled (no R2 bucket); `dataflare upgrade` retries',
  );
  (mcp ? ok : skip)(
    mcp
      ? 'MCP server configured in .mcp.json'
      : 'No .mcp.json; run `dataflare init` again to write agent files',
  );
  if (health.latest && isNewerThan(health.latest, health.version)) {
    skip(
      `Dataflare ${health.latest} is available (this deployment is ${health.version}). Run: ${upgradeCommand}`,
    );
  } else if (cliMismatch) {
    skip(
      `This CLI is Dataflare ${GLASS_VERSION}; the Worker runs ${health.version}. Run: ${upgradeCommand}`,
    );
  } else {
    ok(`Up to date (Dataflare ${health.version})`);
  }
}

export function key(options: { read?: boolean; json?: boolean }): void {
  const conn = connection();
  const credentials = loadCredentials();
  const value = options.read ? credentials?.readKey : conn.key;
  if (options.json) {
    printJson({
      host: conn.host,
      project: conn.project,
      dashboard: `${conn.host}/app`,
      key: value,
    });
    return;
  }
  line(`Dashboard: ${conn.host}/app`);
  line(`${options.read ? 'Read-only key' : 'Admin key'}: ${value}`);
  line(
    color.dim(
      options.read
        ? 'Safe to share for viewing.'
        : 'Full access. Use `dataflare key --read` for a key that can only view.',
    ),
  );
}
