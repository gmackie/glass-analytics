/** Frontend-only onboarding for Cloudflare Pages and other static hosts (DATFLR-18). */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { UsageError } from './config.ts';

/** Inlined by scripts/build.ts; read from the repository when running from source. */
declare const __JOURNEY_LOADER__: string | undefined;

export const SNIPPET_TAG = '<script defer src="/dataflare.js" data-enabled="true"></script>';

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface WranglerInfo {
  path: string;
  name?: string;
  main?: string;
  /** pages_build_output_dir, relative to the repo root. */
  pagesOutput?: string;
  durableObjects: string[];
}

const has = (root: string, ...files: string[]) => files.some((f) => existsSync(join(root, f)));

const isJekyll = (root: string) => has(root, '_config.yml', '_config.yaml', '_config.toml');
const isHugo = (root: string) => has(root, 'hugo.toml', 'hugo.yaml', 'hugo.json');
const isPlainHtml = (root: string) => !has(root, 'package.json') && has(root, 'index.html');

/** Why this repo is frontend-only, or undefined when it may have a Worker. */
export function frontendOnlyReason(
  root: string,
  forced: boolean,
  worker: WranglerInfo | undefined,
): string | undefined {
  // Detected reasons first, so a rerun from the saved config explains itself the same way.
  return detectedReason(root, worker) ?? (forced ? '--frontend-only' : undefined);
}

function detectedReason(root: string, worker: WranglerInfo | undefined): string | undefined {
  if (worker?.pagesOutput) return `${worker.path} sets pages_build_output_dir`;
  if (worker?.main) return undefined;
  if (isJekyll(root)) return 'Jekyll site with no Worker main';
  if (isHugo(root)) return 'Hugo site with no Worker main';
  if (isPlainHtml(root)) return 'static HTML site with no Worker main';
  return undefined;
}

// Frameworks whose dev server and build copy this directory to the site root.
const PUBLIC_DIRS: [string, string][] = [
  ['@sveltejs/kit', 'static'],
  ['vite', 'public'],
  ['next', 'public'],
  ['astro', 'public'],
  ['nuxt', 'public'],
  ['react-scripts', 'public'],
];

/** The source directory served at the site root, with the reason, or undefined when unsure. */
export function detectStaticDir(
  root: string,
  pkg: PackageJson,
  pagesOutput: string | undefined,
): { dir: string; why: string } | undefined {
  if (isJekyll(root)) return { dir: '.', why: 'Jekyll copies the site root into _site' };
  if (isHugo(root)) return { dir: 'static', why: 'Hugo serves static/ at the site root' };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = PUBLIC_DIRS.find(([dep]) => dep in deps);
  if (framework) return { dir: framework[1], why: `${framework[0]} serves ${framework[1]}/` };
  if (has(root, 'public')) return { dir: 'public', why: 'public/ exists' };
  if (pagesOutput && !pkg.scripts?.build)
    return { dir: pagesOutput, why: 'Pages uploads pages_build_output_dir with no build step' };
  if (isPlainHtml(root)) return { dir: '.', why: 'index.html is at the repo root' };
  return undefined;
}

/** A static dir as a clean relative path inside the repo. */
export function checkStaticDir(root: string, dir: string): string {
  const rel = relative(root, resolve(root, dir)) || '.';
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new UsageError(
      `--static-dir ${dir} is outside the repository.`,
      'Pass the directory served at the site root, relative to the repo (e.g. public or .).',
    );
  }
  return rel.split('\\').join('/');
}

function configUrl(root: string, file: string): string | undefined {
  if (!has(root, file)) return undefined;
  return /^url:\s*["']?([^"'\s#]+)/m.exec(readFileSync(join(root, file), 'utf8'))?.[1];
}

function siteUrls(root: string, project: string): string[] {
  for (const file of [`_config.${project}.yml`, '_config.yml']) {
    const url = configUrl(root, file);
    if (url) return [url];
  }
  const cname = has(root, 'CNAME') ? readFileSync(join(root, 'CNAME'), 'utf8').trim() : '';
  return cname ? [`https://${cname.split(/\s+/)[0]}`] : [];
}

function toOrigin(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // Reported below.
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new UsageError(
      `Invalid origin ${value}.`,
      'Pass --origins https://example.com,https://www.example.com.',
    );
  }
  return url.origin;
}

/** Allowed origins from --origins, else the Jekyll site url or CNAME. */
export function resolveOrigins(root: string, project: string, flag?: string): string[] {
  const raw = flag ? flag.split(',') : siteUrls(root, project);
  const values = raw.map((s) => s.trim()).filter(Boolean);
  return [...new Set(values.map(toOrigin))];
}

function loaderTemplate(): string {
  if (typeof __JOURNEY_LOADER__ === 'string') return __JOURNEY_LOADER__;
  return readFileSync(
    new URL('../../../deployments/observe/journey-loader/dataflare.js', import.meta.url),
    'utf8',
  );
}

/** The canonical journey loader with its project (and deployment URL) filled in. */
export function journeyLoader(host: string, project: string): string {
  const template = loaderTemplate();
  const projectLine = "project: '__PROJECT__',";
  const hostLine = /const HOST = '[^']*';/;
  if (!template.includes(projectLine) || !hostLine.test(template)) {
    throw new Error('The journey loader template changed; update client-static.ts.');
  }
  return template
    .replace(projectLine, `project: '${project}',`)
    .replace(hostLine, `const HOST = ${/['\\]/.test(host) ? JSON.stringify(host) : `'${host}'`};`);
}

function asset(staticDir: string): string {
  return staticDir === '.' ? 'dataflare.js' : `${staticDir}/dataflare.js`;
}

export function frontendFiles(input: {
  host: string;
  project: string;
  staticDir: string;
  reason: string;
}): Record<string, string> {
  const { host, project, staticDir, reason } = input;
  const loader = asset(staticDir);
  const config = { host, project, frontendOnly: true, staticDir };
  return {
    '.glass/client.json': `${JSON.stringify(config, null, 2)}\n`,
    [loader]: journeyLoader(host, project),
    '.glass/client/README.md': `# Dataflare app onboarding

Project: ${project}
Deployment: ${host}
Mode: frontend-only (${reason})

## Browser

\`${loader}\` is Dataflare's journey loader (deployments/observe/journey-loader in the Dataflare
repo). Edit only its CONFIG block: \`exclude\`, \`only\`, \`persistence\`, \`identify\`, \`routes\`.

Load it once from the root layout, inside \`<head>\`:

\`\`\`html
${SNIPPET_TAG}
\`\`\`

Record key actions with \`window.dataflare?.track('signup_completed', { plan })\`.

## Not generated

No Worker or Durable Object capture helpers, service binding or \`/_glass\` proxy: a Pages or
static site has no Worker to mount them in. The browser sends events straight to ${host}, so
the project's allowed origins must include the site (\`dataflare projects\`; rerun with \`--origins\`
to add one).

Pages Functions could later send server events through a service binding to the Dataflare
Worker. client-init does not generate that yet.

## Verify

Deploy the site through its normal pipeline, open it, and check that beacons to ${host}/e return
204. Then run \`dataflare events '$pageview'\` with GLASS_API_KEY set. Keys are never saved here.
`,
  };
}
