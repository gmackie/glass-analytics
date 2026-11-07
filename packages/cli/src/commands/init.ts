/**
 * `dataflare init` — deploy Dataflare into your Cloudflare account and wire it into
 * the current project. Safe to re-run: every step finds existing resources.
 *
 * Init is the only deploy meant to run from a laptop (it has to create the
 * resources and keys). It also writes .github/workflows/glass.yml, so every
 * later upgrade is a commit: `dataflare upgrade` stages, CI deploys (see ci.ts).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken } from '@dataflare/core/ids';
import { detectFramework, FRAMEWORKS } from '@dataflare/core/instrument';
import { LAKE_VERSION } from '@dataflare/core/lake';
import { GLASS_VERSION } from '@dataflare/core/version';
import { writeAgentFiles } from '../agent-files.ts';
import { CI_WORKFLOW_PATH, ciNextSteps, writeCiWorkflow } from '../ci.ts';
import { call } from '../client.ts';
import {
  deploy,
  ensureBucket,
  ensureD1,
  ensureLake,
  installWorkerFiles,
  listAccounts,
  migrate,
  type ProvisionReport,
  pipelinesLister,
  putSecrets,
  renderWranglerConfig,
  replayBucketConfig,
  TOKEN_SCOPES,
} from '../cloudflare/provision.ts';
import { createWrangler, type Wrangler, WranglerError } from '../cloudflare/wrangler.ts';
import {
  type Credentials,
  type GlassConfig,
  glassDir,
  loadConfig,
  loadCredentials,
  projectRoot,
  saveConfig,
  saveCredentials,
  UsageError,
} from '../config.ts';
import { color, line, ok, printJson, skip } from '../output.ts';
import { ask, choose } from '../prompt.ts';
import { workerBundleDir } from './upgrade.ts';

export interface InitOptions {
  token?: string;
  account?: string;
  project?: string;
  name?: string;
  lake?: boolean;
  eu?: boolean;
  route?: string;
  /** Remove a route set by an earlier init. */
  noRoute?: boolean;
  /** Delete events older than this many days. */
  retentionDays?: number;
  replay?: boolean;
  agentFiles?: boolean;
  /** Write the GitHub Actions workflow that deploys upgrades (default true). */
  ci?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/** Dependencies, injectable for tests. */
export interface InitDeps {
  wrangler?: (auth: { token: string; accountId: string }, cwd: string) => Wrangler;
  fetcher?: typeof fetch;
  root?: string;
  /** Directory containing worker.js and migrations/ (defaults to the bundled Worker). */
  bundleDir?: string;
  /** Delay between health checks, ms. */
  pollMs?: number;
}

/**
 * "acme.com", "acme.com/_glass" and "acme.com/_glass/*" all mean the same route. Accepting the bare
 * host also saves people from shells that expand the unquoted `*`.
 */
export function normaliseRoute(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const bare = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!bare.includes('/')) return `${bare}/_glass/*`;
  return bare.endsWith('/*') ? bare : `${bare}/*`;
}

function defaultProjectId(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    const id = (pkg.name ?? '')
      .replace(/^@[^/]+\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (id) return id.slice(0, 63);
  } catch {
    // no package.json
  }
  return 'default';
}

function readPackageJson(
  root: string,
): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function waitForWorker(
  host: string,
  key: string,
  fetcher: typeof fetch,
  pollMs: number,
): Promise<void> {
  // New deployments and secrets take a few seconds to propagate.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetcher(`${host}/api`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) return;
    } catch {
      // not reachable yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new UsageError(
    `The Worker at ${host} did not come up.`,
    'Run `dataflare status` in a minute; if it persists, `dataflare upgrade` redeploys.',
  );
}

/** Retry while the new Worker's secrets are still propagating (missing key, 401, 5xx). */
async function settle<T>(fn: () => Promise<T>, pollMs: number, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = /is not set on this Worker|unauthori[sz]ed|401|50\d|fetch failed/i.test(
        message,
      );
      if (!transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export async function init(options: InitOptions, deps: InitDeps = {}): Promise<void> {
  const root = deps.root ?? projectRoot();
  const dir = glassDir(root);
  const fetcher = deps.fetcher ?? fetch;
  const existing = loadConfig(root);
  const quiet = Boolean(options.json);
  const steps: { status: string; label: string; detail?: string }[] = [];
  const report: ProvisionReport = (status, label, detail) => {
    steps.push({ status, label, detail });
    if (quiet) return;
    const text = `${label}${detail ? color.dim(` (${detail})`) : status === 'created' ? color.dim(' (created)') : ''}`;
    if (status === 'skipped') skip(text);
    else ok(text);
  };

  if (!quiet) {
    line(color.bold('Dataflare: analytics in your own Cloudflare account'));
    line();
  }

  const token =
    options.token ??
    process.env.CLOUDFLARE_API_TOKEN ??
    (await ask('Cloudflare API token', {
      flag: '--token (or CLOUDFLARE_API_TOKEN)',
      secret: true,
    }));
  if (!token)
    throw new UsageError(
      'A Cloudflare API token is required.',
      `Create one at https://dash.cloudflare.com/profile/api-tokens with: ${TOKEN_SCOPES.join('; ')}.`,
    );
  const accounts = await listAccounts(token, fetcher).catch((err: unknown) => {
    throw new UsageError(
      err instanceof Error ? err.message : String(err),
      'Check the token, or create a new one at https://dash.cloudflare.com/profile/api-tokens',
    );
  });
  const accountId = options.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? existing?.accountId;
  const account = accountId
    ? (accounts.find((a) => a.id === accountId) ?? { id: accountId, name: accountId })
    : await choose('Which account?', accounts, (a) => `${a.name} (${a.id})`, '--account');
  if (!account)
    throw new UsageError(
      'This token cannot see any Cloudflare accounts.',
      `Give it account permissions: ${TOKEN_SCOPES.join('; ')}.`,
    );
  report('ok', `Cloudflare token works (account ${account.name})`);

  const project = options.project ?? existing?.project ?? defaultProjectId(root);
  // Named after the project, so several sites can each have their own Dataflare in one account.
  // (A shared default would make the second site redeploy, and re-route, the first site's Worker.)
  const name = options.name ?? existing?.name ?? `glass-${project}`;
  const lake = options.lake ?? existing?.store === 'lake';
  const eu = options.eu ?? existing?.eu ?? false;
  if (lake && eu)
    throw new UsageError(
      'Lake mode cannot keep data in the EU jurisdiction: Basin Catalog does not support R2 buckets in a jurisdiction yet.',
      'Use the D1 store with --eu, or lake mode without --eu.',
    );
  const route = options.noRoute ? null : (normaliseRoute(options.route) ?? existing?.route ?? null);
  const retentionDays = options.retentionDays ?? existing?.retentionDays ?? null;
  const wantReplay = options.replay ?? true;

  if (options.dryRun) {
    const plan = {
      account: account.id,
      worker: name,
      project,
      store: lake ? 'lake' : 'd1',
      eu,
      route,
      replay: wantReplay,
      resources: [
        `D1 database "${name}"`,
        wantReplay ? `R2 bucket "${name}-replays"` : null,
        lake
          ? `R2 bucket "${name}-data" with data catalog, Pipelines streams/sinks for events and identities`
          : null,
      ].filter(Boolean),
      files: [
        '.glass/config.json',
        '.glass/wrangler.jsonc',
        '.glass/worker.js',
        '.glass/migrations/',
        '.glass/credentials.json (git-ignored)',
        'AGENTS.md',
        '.claude/skills/glass/SKILL.md',
        '.mcp.json',
        ...(options.ci === false ? [] : [CI_WORKFLOW_PATH]),
      ],
    };
    if (quiet) printJson(plan);
    else {
      line();
      line('Dry run: nothing was changed. This would create:');
      for (const r of plan.resources) line(`  ${r}`);
      line(
        `and deploy Worker "${name}" for project "${project}", writing ${plan.files.join(', ')}.`,
      );
    }
    return;
  }

  const wrangler = (deps.wrangler ?? createWrangler)({ token, accountId: account.id }, root);
  try {
    const d1 = await ensureD1(wrangler, name, eu, report);
    let replay: GlassConfig['replay'] = wantReplay ? null : false;
    if (wantReplay) {
      const bucket = `${name}-replays`;
      if (await ensureBucket(wrangler, bucket, eu, report, 'session replay'))
        replay = replayBucketConfig(bucket, eu, existing?.replay || null);
      else
        report(
          'skipped',
          'Session replay',
          'R2 is not enabled on this account; enable it in the Cloudflare dashboard, then run `dataflare upgrade`',
        );
    } else {
      report('skipped', 'Session replay', 'disabled with --no-replay');
    }
    // Re-running init keeps an existing deployment's schema version; `upgrade` moves it on.
    const lakeVersion = existing?.lake?.version ?? LAKE_VERSION;
    const lakeConfig = lake
      ? {
          ...(await ensureLake(
            wrangler,
            {
              name,
              bucket: `${name}-data`,
              namespace: 'glass',
              token,
              dir,
              list: pipelinesLister(fetcher, { token, accountId: account.id }),
              version: lakeVersion,
            },
            report,
          )),
          versions: existing?.lake?.versions ?? [lakeVersion],
        }
      : null;

    const config: GlassConfig = {
      name,
      accountId: account.id,
      host: existing?.host ?? '',
      project,
      store: lake ? 'lake' : 'd1',
      d1,
      replay,
      lake: lakeConfig,
      route,
      retentionDays,
      eu,
      version: GLASS_VERSION,
    };
    const credentials: Credentials = loadCredentials(root) ?? {
      adminKey: randomToken(),
      readKey: randomToken(),
      saltSecret: randomToken(),
    };
    installWorkerFiles(dir, deps.bundleDir ?? workerBundleDir());
    const configPath = join(dir, 'wrangler.jsonc');
    writeFileSync(configPath, renderWranglerConfig(config));
    saveCredentials(credentials, root);

    await migrate(wrangler, d1.name, configPath);
    report('ok', 'Database migrated');
    const url = await deploy(wrangler, configPath);
    config.host = route ? `https://${route.replace(/\/\*$/, '')}` : (url ?? config.host);
    if (!config.host)
      throw new UsageError(
        'Deployed, but could not read the Worker URL.',
        'Enable a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then run `dataflare upgrade`.',
      );
    await putSecrets(
      wrangler,
      {
        GLASS_ADMIN_KEY: credentials.adminKey,
        GLASS_READ_KEY: credentials.readKey,
        GLASS_SALT_SECRET: credentials.saltSecret,
        ...(lake ? { CF_API_TOKEN: token } : {}),
      },
      configPath,
      dir,
    );
    saveConfig(config, root);
    report('ok', `Worker deployed at ${config.host}`);

    await waitForWorker(config.host, credentials.adminKey, fetcher, deps.pollMs ?? 1500);
    // Secrets reach every Cloudflare location a few seconds after the Worker answers somewhere,
    // so a request can still land where GLASS_ADMIN_KEY isn't set yet: retry those.
    await settle(
      () =>
        call(
          'POST',
          '/api/projects',
          { id: project },
          { host: config.host, key: credentials.adminKey, fetcher },
        ),
      deps.pollMs ?? 1500,
    );
    report('ok', `Project "${project}" ready`);
    const auth = { host: config.host, key: credentials.adminKey, fetcher };
    await call(
      'POST',
      '/e',
      {
        project,
        events: [
          {
            id: randomToken(16),
            event: '$install_check',
            ts: Date.now(),
            distinct_id: 'glass-cli',
          },
        ],
      },
      auth,
    );
    if (lake) {
      report('ok', 'Test event sent', 'the lake shows events within about two minutes');
    } else {
      const seen = await call<{ events: { event: string }[] }>(
        'GET',
        `/api/events?days=1&project=${encodeURIComponent(project)}`,
        undefined,
        auth,
      );
      if (seen.events.some((e) => e.event === '$install_check'))
        report('ok', 'Test event received');
      else report('skipped', 'Test event not visible yet', 'run `dataflare status` in a minute');
    }

    const framework = detectFramework(readPackageJson(root));
    const snippet = FRAMEWORKS[framework].snippet({ host: config.host, project });
    const written =
      options.agentFiles === false
        ? []
        : writeAgentFiles({ root, host: config.host, project, snippet });
    const workflow = options.ci === false ? null : writeCiWorkflow(root);
    if (workflow && workflow.status !== 'kept') written.push(workflow.path);
    const ci = workflow
      ? {
          workflow: workflow.path,
          status: workflow.status,
          branch: workflow.branch,
          secret: workflow.secret,
          next: ciNextSteps(workflow),
        }
      : null;

    if (quiet) {
      printJson({
        host: config.host,
        project,
        dashboard: `${config.host}/app`,
        framework,
        snippet,
        written,
        ci,
        steps,
      });
      return;
    }
    line();
    line(color.bold(`Next: add Dataflare to your site (${FRAMEWORKS[framework].name})`));
    line();
    line(color.dim(`  ${snippet.file}`));
    for (const l of snippet.code.split('\n')) line(`  ${l}`);
    line();
    line(
      `Then track what matters: ${color.cyan("glass.capture('signup_completed', { plan: 'pro' })")}`,
    );
    line();
    line(color.bold('Before you ship it'));
    line(
      `  Cookie banner? Load Dataflare with ${color.cyan('data-persistence="cookieless"')} (it stores nothing on the device) and call ${color.cyan('glass.consent(true)')} on Accept. Session replay starts after consent, or add ${color.cyan('data-replay-cookieless="true"')} to record without storing anything.`,
    );
    line(
      '  Add Dataflare to your privacy page: your own analytics, in your Cloudflare account, cookieless until consent.',
    );
    line(
      `  Already sending events to GA, Meta or PostHog? Add ${color.cyan('glass.capture')} to that same helper, then mark the events that mean success with the ${color.cyan('mark_event')} tool.`,
    );
    if (!route)
      line(
        `  Not on Cloudflare (Vercel, Netlify)? Load from ${color.cyan(config.host)} directly. A rewrite proxy hides visitors' IPs, which breaks countries and cookieless counts.`,
      );
    if (written.length) {
      line();
      line(color.bold('Written for your agent'));
      for (const f of written) line(`  ${f}`);
      line(
        `  .glass/ ${color.dim('(deployment config: commit it; credentials.json is git-ignored)')}`,
      );
    }
    if (ci) {
      line();
      line(color.bold('Upgrades deploy from CI'));
      line(
        color.dim(
          `  ${ci.workflow} deploys the version pinned in .glass/config.json. Agents: finish these steps now.`,
        ),
      );
      for (const [i, step] of ci.next.entries()) line(`  ${i + 1}. ${step}`);
    }
    line();
    line(
      `Dashboard: ${color.cyan(`${config.host}/app`)} ${color.dim('(sign in with the key from `npx dataflare-cli key`)')}`,
    );
  } catch (err) {
    if (
      err instanceof WranglerError &&
      /Authentication|not authorized|permission|10000|9109/i.test(err.output)
    ) {
      throw new UsageError(
        `Cloudflare refused a request: ${err.message.split('\n')[0]}`,
        `The API token needs: ${TOKEN_SCOPES.join('; ')}.`,
      );
    }
    throw err;
  }
}
