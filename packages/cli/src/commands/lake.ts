/**
 * `dataflare lake maintain` — the deletes the Worker can't do in lake mode.
 *
 * Basin SQL is read-only, so erasing a person (`dataflare person <id> --delete`)
 * only queues their ids in D1 (`lake_deletions`), and retention can't run in the
 * Worker's cron. This command reads the queue, runs the bundled PyIceberg script
 * (packages/cli/lake/maintain.py) against Basin Catalog to delete the rows, and
 * marks the queue entries done. The deploy workflow runs it daily; it needs `uv`
 * (https://docs.astral.sh/uv/) to run Python.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lakeTableName } from '@dataflare/core/lake';
import { CI_WORKFLOW_PATH, inCi } from '../ci.ts';
import { createWrangler, must, parseJsonOutput, type Wrangler } from '../cloudflare/wrangler.ts';
import { glassDir, loadConfig, projectRoot, UsageError } from '../config.ts';
import { line, ok, printJson, skip } from '../output.ts';

/** PyIceberg, pinned: the maintenance job must behave the same in every run. */
export const PYICEBERG = 'pyiceberg[pyarrow,pyiceberg-core]==0.12.0';

const DAY_MS = 86_400_000;

/** The maintenance script: next to the CLI bundle when installed, or in the repo during development. */
export function maintainScript(): string {
  for (const c of [
    new URL('./lake/maintain.py', import.meta.url),
    new URL('../../lake/maintain.py', import.meta.url),
  ]) {
    const path = fileURLToPath(c);
    if (existsSync(path)) return path;
  }
  throw new Error('lake/maintain.py is missing from the CLI package.');
}

/** Run a Python script with PyIceberg through uv, feeding the job on stdin. Returns stdout. */
export function runWithUv(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'uv',
      ['run', '--no-project', '--quiet', '--python', '3.13', '--with', PYICEBERG, 'python', script],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'ENOENT'
          ? new UsageError(
              'Lake maintenance needs uv, which runs its Python (PyIceberg) job.',
              'Install it: https://docs.astral.sh/uv/getting-started/installation/ (the deploy workflow installs it for you).',
            )
          : err,
      ),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`The lake maintenance job failed (exit ${code}); its log is above.`)),
    );
    child.stdin.end(stdin);
  });
}

export interface LakeMaintainOptions {
  token?: string;
  json?: boolean;
  dryRun?: boolean;
}

export interface LakeMaintainDeps {
  wrangler?: (auth: { token: string; accountId: string }, cwd: string) => Wrangler;
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs the maintenance script with the job on stdin (tests use a local catalog). */
  run?: (script: string, stdin: string) => Promise<string>;
  /** Catalog connection; defaults to the deployment's Basin Catalog. */
  catalog?: Record<string, string>;
  now?: number;
}

interface Pending {
  id: number;
  project: string;
  ids: string;
  /** "person" (ids are a person's ids) or "group" (ids are [type, key]). */
  kind?: string;
}

/** Erasures of people: their ids. */
function personDeletions(pending: Pending[]) {
  return pending
    .filter((p) => (p.kind ?? 'person') === 'person')
    .map((p) => ({ id: p.id, project: p.project, ids: JSON.parse(p.ids) as string[] }));
}

/** Erasures of groups: [type, key]. */
function groupDeletions(pending: Pending[]) {
  return pending
    .filter((p) => p.kind === 'group')
    .map((p) => {
      const [type, key] = JSON.parse(p.ids) as [string, string];
      return { id: p.id, project: p.project, type, key };
    });
}

export async function lakeMaintain(
  options: LakeMaintainOptions,
  deps: LakeMaintainDeps = {},
): Promise<void> {
  const root = deps.root ?? projectRoot();
  const env = deps.env ?? process.env;
  const config = loadConfig(root);
  if (!config)
    throw new UsageError(
      'No Dataflare deployment in this project.',
      'Run `npx dataflare-cli init` first.',
    );
  if (config.store !== 'lake' || !config.lake)
    throw new UsageError(
      'This deployment keeps events in D1, which deletes them itself.',
      '`dataflare lake maintain` is only for lake mode (`dataflare init --lake`).',
    );
  const token = options.token ?? env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new UsageError(
      'CLOUDFLARE_API_TOKEN is not set.',
      inCi(env)
        ? `Map the repository secret to it (see ${CI_WORKFLOW_PATH}).`
        : 'Set it, or pass --token. It needs Workers R2 Data Catalog Edit and Workers R2 Storage Edit.',
    );
  const wrangler = (deps.wrangler ?? createWrangler)({ token, accountId: config.accountId }, root);
  const wranglerConfig = join(glassDir(root), 'wrangler.jsonc');
  const d1 = (sql: string) =>
    must(wrangler, [
      'd1',
      'execute',
      config.d1.name,
      '--remote',
      '--json',
      '--config',
      wranglerConfig,
      '--command',
      sql,
    ]);

  const [result] = parseJsonOutput<{ results: Pending[] }[]>(
    await d1(
      'SELECT id, project, ids, kind FROM lake_deletions WHERE done_at IS NULL ORDER BY id LIMIT 1000',
    ),
  );
  const pending = result?.results ?? [];
  const now = deps.now ?? Date.now();
  const cutoff = config.retentionDays ? now - config.retentionDays * DAY_MS : null;

  const summary = {
    erasures: pending.length,
    retentionCutoff: cutoff ? new Date(cutoff).toISOString() : null,
    dryRun: Boolean(options.dryRun),
  };
  if ((pending.length === 0 && !cutoff) || options.dryRun) {
    if (options.json) return printJson(summary);
    if (pending.length === 0 && !cutoff)
      return skip('Lake maintenance: no erasures queued and no retention set');
    line(
      `Would erase ${pending.length} queued people${cutoff ? ` and delete events before ${summary.retentionCutoff}` : ''}.`,
    );
    return;
  }

  const { bucket, namespace } = config.lake;
  const job = {
    catalog: deps.catalog ?? {
      type: 'rest',
      uri: `https://catalog.cloudflarestorage.com/${config.accountId}/${bucket}`,
      warehouse: `${config.accountId}_${bucket}`,
      token,
    },
    namespace,
    tables: Object.fromEntries(
      (['events', 'identities'] as const).map((table) => [
        table,
        (config.lake?.versions ?? [1]).map((v) => lakeTableName(table, v)),
      ]),
    ),
    deletions: personDeletions(pending),
    group_deletions: groupDeletions(pending),
    retention_cutoff_ms: cutoff,
  };
  const out = await (deps.run ?? runWithUv)(maintainScript(), JSON.stringify(job));
  const done =
    (JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { deletions?: number[] }).deletions ?? [];
  const ids = done.filter((id) => Number.isInteger(id));
  if (ids.length > 0)
    await d1(`UPDATE lake_deletions SET done_at = ${now} WHERE id IN (${ids.join(', ')})`);

  if (options.json) return printJson({ ...summary, erased: ids.length });
  ok(`Erased ${ids.length} queued ${ids.length === 1 ? 'person' : 'people'} from the lake`);
  if (cutoff) ok(`Deleted lake events before ${summary.retentionCutoff}`);
  line(
    '  Deleted rows are gone from queries now; their files go when Basin Catalog expires old snapshots.',
  );
}
