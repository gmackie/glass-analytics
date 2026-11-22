/** Onboard an app to an existing deployment; never provision or deploy resources. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectFramework, FRAMEWORKS } from '@dataflare/core/instrument';
import { call } from '../client.ts';
import { workerClientSource } from '../client-files.ts';
import { loadClientConfig, loadCredentials, projectRoot, UsageError } from '../config.ts';
import { line, printJson } from '../output.ts';
import { ask } from '../prompt.ts';

export interface ClientInitOptions {
  host?: string;
  project?: string;
  service?: string;
  dryRun?: boolean;
  json?: boolean;
}

export async function clientInit(
  options: ClientInitOptions = {},
  deps: {
    root?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<void> {
  const root = deps.root ?? projectRoot();
  if (existsSync(join(root, '.glass', 'config.json'))) {
    throw new UsageError(
      'This repo owns a Dataflare deployment.',
      'Run client-init in the app repo; keep deployment provisioning in this repo.',
    );
  }
  const saved = loadClientConfig(root);
  const rawHost =
    options.host ??
    process.env.GLASS_HOST ??
    saved?.host ??
    (await ask('Existing Dataflare URL', { flag: '--host' }));
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
  const host = url.href.replace(/\/+$/, '');
  let pkg: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (existsSync(join(root, 'package.json'))) {
    try {
      pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    } catch {
      throw new UsageError('Cannot read package.json.', 'Fix its JSON before onboarding.');
    }
  }
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
  const wranglerPath = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((file) =>
    existsSync(join(root, file)),
  );
  let worker: { name?: string; durable_objects?: { bindings?: { name: string }[] } } | undefined;
  if (wranglerPath) {
    const { unstable_readConfig } = await import('wrangler');
    worker = unstable_readConfig({ config: join(root, wranglerPath) }, { hideWarnings: true });
  }
  const service =
    options.service ??
    saved?.service ??
    (wranglerPath
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
  if (
    saved &&
    (saved.host !== host || saved.project !== project || saved.service !== (service || undefined))
  ) {
    throw new UsageError(
      'This repo is already connected to a different Dataflare app.',
      'Review .glass/client.json and remove the generated onboarding files before reconnecting.',
    );
  }
  const framework = detectFramework(pkg);
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
  files['.glass/client/README.md'] = `# Dataflare app onboarding

Project: ${project}
Deployment: ${host}
Framework: ${FRAMEWORKS[framework].name}
${
  worker?.name
    ? `App Worker: ${worker.name}
`
    : ''
}${
  worker?.durable_objects?.bindings?.length
    ? `Durable Object bindings: ${worker.durable_objects.bindings.map((b) => b.name).join(', ')}
`
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

Merge binding.json into the services array in ${wranglerPath ?? 'your Wrangler config'} (do not replace existing bindings). Service bindings require both Workers in the same Cloudflare account. For named Wrangler environments, add the binding to each environment you deploy; bindings are not inherited.

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
  // Preflight every file before remote mutation: reruns must not erase local edits.
  for (const [path, content] of Object.entries(files)) {
    if (existsSync(join(root, path)) && readFileSync(join(root, path), 'utf8') !== content) {
      throw new UsageError(
        `Refusing to overwrite ${path}.`,
        'Review and move the existing file before changing onboarding settings.',
      );
    }
  }
  const result = {
    dryRun: Boolean(options.dryRun),
    host,
    project,
    framework,
    worker: worker?.name,
    durableObjects: worker?.durable_objects?.bindings?.map((b) => b.name) ?? [],
    files,
    next: 'Review .glass/client/README.md, integrate the generated files, then deploy the app through its normal pipeline.',
  };
  if (!options.dryRun) {
    const key = process.env.GLASS_API_KEY ?? loadCredentials(root)?.adminKey;
    if (!key)
      throw new UsageError(
        'Missing Dataflare admin API key.',
        'Set GLASS_API_KEY to register this app; --dry-run needs no key.',
      );
    const api = { host, key, fetcher: deps.fetcher };
    const { projects } = await call<{ projects: { id: string }[] }>(
      'GET',
      '/api/projects',
      undefined,
      api,
    );
    // POST is an upsert that resets origin restrictions; never upsert existing projects.
    if (!projects.some((p) => p.id === project))
      await call('POST', '/api/projects', { id: project }, api);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
  if (options.json) printJson(result);
  else {
    line(`${options.dryRun ? 'Preview' : 'Registered'} app ${project} → ${host}`);
    for (const path of Object.keys(files)) line(`  ${path}`);
    line(result.next);
  }
}
