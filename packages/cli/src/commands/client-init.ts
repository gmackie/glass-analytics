/** Onboard an app to an existing deployment; never provision or deploy resources. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { detectFramework, FRAMEWORKS, type Framework } from '@dataflare/core/instrument';
import { upsertNpmrc } from '../agent-files.ts';
import { call } from '../client.ts';
import { workerClientSource } from '../client-files.ts';
import {
  checkStaticDir,
  detectStaticDir,
  frontendFiles,
  frontendOnlyReason,
  type PackageJson,
  resolveOrigins,
  SNIPPET_TAG,
  type WranglerInfo,
} from '../client-static.ts';
import {
  type ClientConfig,
  loadClientConfig,
  loadCredentials,
  projectRoot,
  UsageError,
} from '../config.ts';
import { line, printJson } from '../output.ts';
import { ask } from '../prompt.ts';

export interface ClientInitOptions {
  host?: string;
  project?: string;
  service?: string;
  /** Browser snippet and registration only, for Cloudflare Pages and other static hosts. */
  frontendOnly?: boolean;
  /** Directory served at the site root (frontend-only). */
  staticDir?: string;
  /** Comma-separated allowed origins for browser ingest. */
  origins?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface ClientInitDeps {
  root?: string;
  fetcher?: typeof fetch;
}

interface Plan {
  mode: 'frontend-only' | 'app';
  reason?: string;
  config: ClientConfig;
  framework: Framework;
  worker?: WranglerInfo;
  staticDir?: string;
  origins: string[];
  files: Record<string, string>;
  /** Files that may already exist with local edits; kept rather than refused. */
  optional: string[];
  next: string;
}

export async function clientInit(
  options: ClientInitOptions = {},
  deps: ClientInitDeps = {},
): Promise<void> {
  const root = deps.root ?? projectRoot();
  if (existsSync(join(root, '.glass', 'config.json'))) {
    throw new UsageError(
      'This repo owns a Dataflare deployment.',
      'Run client-init in the app repo; keep deployment provisioning in this repo.',
    );
  }
  const saved = loadClientConfig(root);
  const plan = await buildPlan(root, options, saved);
  if (saved && JSON.stringify(sortKeys(saved)) !== JSON.stringify(sortKeys(plan.config))) {
    throw new UsageError(
      'This repo is already connected to a different Dataflare app.',
      'Review .glass/client.json and remove the generated onboarding files before reconnecting.',
    );
  }
  const kept = preflight(root, plan);
  let registration = registrationPreview(plan);
  if (!options.dryRun) {
    registration = await register(root, plan, deps.fetcher);
    for (const [path, content] of Object.entries(plan.files)) {
      if (kept.includes(path)) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    // The CLI it points agents at is @gmacko/dataflare-cli on the ForgeGraph registry (DATFLR-27).
    upsertNpmrc(join(root, '.npmrc'));
  }
  report(plan, kept, registration, Boolean(options.dryRun), Boolean(options.json));
}

const sortKeys = (config: ClientConfig) =>
  Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));

async function buildPlan(
  root: string,
  options: ClientInitOptions,
  saved: ClientConfig | null,
): Promise<Plan> {
  const host = checkHost(
    options.host ??
      process.env.GLASS_HOST ??
      saved?.host ??
      (await ask('Existing Dataflare URL', { flag: '--host' })),
  );
  const pkg = readPackage(root);
  const project = await resolveProject(options, saved, pkg);
  const worker = await readWrangler(root);
  const origins = resolveOrigins(root, project, options.origins);
  const framework = detectFramework(pkg);
  const reason = frontendOnlyReason(
    root,
    Boolean(options.frontendOnly || saved?.frontendOnly),
    worker,
  );
  const base = { host, project, framework, worker, origins };
  if (reason) {
    if (options.service) {
      throw new UsageError(
        `--service needs an app Worker, but this is a frontend-only site (${reason}).`,
        'Drop --service: Pages/static sites get the browser snippet only.',
      );
    }
    return frontendPlan(root, pkg, { ...base, reason }, options.staticDir ?? saved?.staticDir);
  }
  const service = await resolveService(options, saved, worker);
  return appPlan({ ...base, service });
}

function checkHost(rawHost: string): string {
  let url: URL;
  try {
    url = new URL(rawHost);
  } catch {
    throw new UsageError(
      'Invalid Dataflare URL.',
      'Pass --host https://your-dataflare.workers.dev.',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new UsageError('Dataflare URL must use HTTPS without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

function readPackage(root: string): PackageJson {
  if (!existsSync(join(root, 'package.json'))) return {};
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    throw new UsageError('Cannot read package.json.', 'Fix its JSON before onboarding.');
  }
}

async function resolveProject(
  options: ClientInitOptions,
  saved: ClientConfig | null,
  pkg: PackageJson,
): Promise<string> {
  const inferred = pkg.name
    ?.replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const project =
    options.project ??
    process.env.GLASS_PROJECT ??
    saved?.project ??
    (await ask('App project id', { flag: '--project', default: inferred }));
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) {
    throw new UsageError(
      'Invalid project id.',
      'Use 1–63 lowercase letters, digits, - or _, starting with a letter or digit.',
    );
  }
  return project;
}

async function readWrangler(root: string): Promise<WranglerInfo | undefined> {
  const path = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((file) =>
    existsSync(join(root, file)),
  );
  if (!path) return undefined;
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: join(root, path) }, { hideWarnings: true });
  return {
    path,
    name: config.name,
    main: config.main,
    pagesOutput: config.pages_build_output_dir
      ? relative(root, config.pages_build_output_dir) || '.'
      : undefined,
    durableObjects: config.durable_objects?.bindings?.map((b) => b.name) ?? [],
  };
}

async function resolveService(
  options: ClientInitOptions,
  saved: ClientConfig | null,
  worker: WranglerInfo | undefined,
): Promise<string | undefined> {
  const service =
    options.service ??
    saved?.service ??
    (worker
      ? await ask('Existing Dataflare Worker name (blank for direct browser capture)', {
          flag: '--service',
          default: '',
        })
      : undefined);
  if (service && !/^[a-zA-Z0-9_-]+$/.test(service)) {
    throw new UsageError(
      'Invalid Worker service name.',
      'Pass --service with the existing Dataflare Worker name.',
    );
  }
  return service || undefined;
}

interface PlanBase {
  host: string;
  project: string;
  framework: Framework;
  worker: WranglerInfo | undefined;
  origins: string[];
}

async function frontendPlan(
  root: string,
  pkg: PackageJson,
  base: PlanBase & { reason: string },
  requestedDir: string | undefined,
): Promise<Plan> {
  const detected = detectStaticDir(root, pkg, base.worker?.pagesOutput);
  const staticDir = checkStaticDir(
    root,
    requestedDir ??
      detected?.dir ??
      (await ask('Directory served at the site root (where dataflare.js goes)', {
        flag: '--static-dir',
      })),
  );
  const files = frontendFiles({ ...base, staticDir });
  const loader = Object.keys(files).find((path) => path.endsWith('dataflare.js'));
  return {
    ...base,
    mode: 'frontend-only',
    config: { host: base.host, project: base.project, frontendOnly: true, staticDir },
    staticDir,
    files,
    optional: loader ? [loader] : [],
    next: 'Review .glass/client/README.md, then deploy the site through its normal pipeline.',
  };
}

function appPlan(base: PlanBase & { service: string | undefined }): Plan {
  const { host, project, framework, service } = base;
  const snippet = FRAMEWORKS[framework === 'worker' ? 'html' : framework].snippet({
    host: service ? '/_glass' : host,
    project,
  });
  const config = { host, project, ...(service ? { service } : {}) };
  const files: Record<string, string> = {
    '.glass/client.json': `${JSON.stringify(config, null, 2)}\n`,
  };
  if (service) {
    files['.glass/client/worker.ts'] = workerClientSource(host, project);
    files['.glass/client/binding.json'] =
      `${JSON.stringify({ services: [{ binding: 'DATAFLARE', service }] }, null, 2)}\n`;
  }
  files['.glass/client/README.md'] = appReadme({ ...base, snippet });
  return {
    ...base,
    mode: 'app',
    config,
    files,
    optional: [],
    next: 'Review .glass/client/README.md, integrate the generated files, then deploy the app through its normal pipeline.',
  };
}

function appReadme(
  input: PlanBase & { service: string | undefined; snippet: { file: string; code: string } },
): string {
  const { host, project, framework, worker, service, snippet } = input;
  return `# Dataflare app onboarding

Project: ${project}
Deployment: ${host}
Framework: ${FRAMEWORKS[framework].name}
${worker?.name ? `App Worker: ${worker.name}\n` : ''}${
  worker?.durableObjects.length
    ? `Durable Object bindings: ${worker.durableObjects.join(', ')}\n`
    : ''
}
## Browser

Add this to ${snippet.file}:

\`\`\`
${snippet.code}
\`\`\`

${
  service
    ? `## Worker and Durable Objects

Merge binding.json into the services array in ${worker?.path ?? 'your Wrangler config'} (do not replace existing bindings). Service bindings require both Workers in the same Cloudflare account. For named Wrangler environments, add the binding to each environment you deploy; bindings are not inherited.

Import dataflareProxy and capture from .glass/client/worker.ts using the appropriate relative path. Before your Worker router:

\`\`\`ts
const analytics = await dataflareProxy(request, env);
if (analytics) return analytics;
\`\`\`

From a Worker or a DO with the DATAFLARE binding:

\`\`\`ts
await capture(env, {
  event: 'workflow_stage_changed',
  distinct_id: caseId,
  props: { journey_id: caseId, stage: 'completed' },
  id: persistedEventId,
  ts: persistedEventTime,
});
\`\`\`

Use ctx.waitUntil(capture(...)) for best-effort Worker telemetry, or await capture from a DO method. Use an outbox for required delivery and reuse its event ID and timestamp on retries. The helper does not add transactions or an outbox. Ingest deduplication depends on the deployment's event store.

The proxy exposes /s.js, /replay.js, /e, /f and /r only; /api, /mcp and dashboard routes stay unavailable. Visitor metadata is forwarded through the binding; verify geolocation and cookieless counts after deployment.
`
    : `For same-origin capture on Cloudflare, review and remove these onboarding files, then rerun with --service <existing-dataflare-worker>. An ordinary rewrite proxy can break geolocation and cookieless counts.
`
}
## Correlation and verification

Use the same pseudonymous user_id (after browser identify) and session_id for browser/server person journeys. Send session correlation explicitly from the app; do not use a DO instance id as a person id. Case journeys should use a case distinct_id and journey_id property; they are separate from person journeys. Cross-app linking is opt-in, not inferred.

No replay sampling is enabled by these snippets. Apply each app's collection policy before enabling autocapture, identity linking or replay.

After merging the binding, mounting the handler and installing the snippet, deploy through your app's normal pipeline. Send a custom event and confirm it with dataflare events <event> using GLASS_API_KEY. Check browser requests to /_glass/e when using the binding. No resources were deployed by client-init.

CLI queries use .glass/client.json and GLASS_API_KEY; keys are never saved here.
`;
}

/** Check every file before remote mutation: reruns must not erase local edits. Returns kept files. */
function preflight(root: string, plan: Plan): string[] {
  const kept: string[] = [];
  for (const [path, content] of Object.entries(plan.files)) {
    const full = join(root, path);
    if (!existsSync(full) || readFileSync(full, 'utf8') === content) continue;
    if (plan.optional.includes(path)) {
      kept.push(path);
      continue;
    }
    throw new UsageError(
      `Refusing to overwrite ${path}.`,
      'Review and move the existing file before changing onboarding settings.',
    );
  }
  return kept;
}

function registrationPreview(plan: Plan): string {
  const origins = plan.origins.length
    ? `allowed origins ${plan.origins.join(', ')}`
    : 'no origin restriction';
  return `Register project ${plan.config.project} with ${origins} if missing; an existing project keeps its name and origins.`;
}

async function register(
  root: string,
  plan: Plan,
  fetcher: typeof fetch | undefined,
): Promise<string> {
  const key = process.env.GLASS_API_KEY ?? loadCredentials(root)?.adminKey;
  if (!key)
    throw new UsageError(
      'Missing Dataflare admin API key.',
      'Set GLASS_API_KEY to register this app; --dry-run needs no key.',
    );
  const api = { host: plan.config.host, key, fetcher };
  const { project } = plan.config;
  const { projects } = await call<{
    projects: { id: string; name: string; allowedOrigins: string[] }[];
  }>('GET', '/api/projects', undefined, api);
  const existing = projects.find((p) => p.id === project);
  if (!existing) {
    const body = plan.origins.length ? { allowed_origins: plan.origins } : {};
    await call('POST', '/api/projects', { id: project, ...body }, api);
    return `Registered project ${project}${plan.origins.length ? ` for ${plan.origins.join(', ')}` : ''}.`;
  }
  // POST is an upsert that replaces the name and origins: only ever widen an existing allowlist.
  const missing = plan.origins.filter((o) => !existing.allowedOrigins.includes(o));
  if (!existing.allowedOrigins.length || !missing.length)
    return `Project ${project} already exists; kept its name and origins.`;
  await call(
    'POST',
    '/api/projects',
    {
      id: project,
      name: existing.name,
      allowed_origins: [...existing.allowedOrigins, ...missing],
    },
    api,
  );
  return `Added ${missing.join(', ')} to project ${project}'s allowed origins.`;
}

function report(
  plan: Plan,
  kept: string[],
  registration: string,
  dryRun: boolean,
  json: boolean,
): void {
  const { host, project } = plan.config;
  if (json) {
    printJson({
      dryRun,
      mode: plan.mode,
      ...(plan.reason ? { reason: plan.reason } : {}),
      host,
      project,
      framework: plan.framework,
      worker: plan.worker?.name,
      durableObjects: plan.worker?.durableObjects ?? [],
      ...(plan.staticDir ? { staticDir: plan.staticDir, snippet: SNIPPET_TAG } : {}),
      origins: plan.origins,
      registration,
      files: plan.files,
      kept,
      next: plan.next,
    });
    return;
  }
  if (plan.reason) {
    line(
      `Pages/static site: browser snippet only (${plan.reason}); no Worker/Durable Object helpers, service binding or /_glass proxy.`,
    );
  }
  line(`${dryRun ? 'Preview' : 'Connected'} app ${project} → ${host}`);
  line(`  ${registration}`);
  for (const path of Object.keys(plan.files)) {
    line(`  ${path}${kept.includes(path) ? ' (exists with local edits; kept)' : ''}`);
  }
  if (plan.staticDir) line(`Root layout <head>: ${SNIPPET_TAG}`);
  line(plan.next);
}
