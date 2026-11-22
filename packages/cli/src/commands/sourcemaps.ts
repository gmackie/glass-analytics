/**
 * `dataflare sourcemaps upload <dir> --release <version>`: send a build's source
 * maps to the Worker, so error tracking can show stack traces in your own code.
 * Each `x.js.map` is filed under the path its `x.js` is served at: the file's path
 * in <dir>, under `--url-prefix` (default "/"). Run it in CI after the build, with
 * the same release your app passes to `glass.init({ release })`.
 *
 * Also `dataflare sourcemaps list [--release <version>]` and
 * `dataflare sourcemaps delete --release <version>`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { trimSlashes } from '@dataflare/core/url';
import { call, withProject } from '../client.ts';
import { connection, UsageError } from '../config.ts';
import { color, line, ok, printJson, table } from '../output.ts';

function mapFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js.map') || name.endsWith('.mjs.map') || name.endsWith('.cjs.map'))
        out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** The served path of the minified file a map belongs to. */
export function servedPath(dir: string, file: string, prefix = '/'): string {
  const rel = relative(dir, file)
    .split(sep)
    .join('/')
    .replace(/\.map$/, '');
  return `/${trimSlashes(prefix)}/${rel}`.replace(/\/{2,}/g, '/');
}

interface Options {
  release?: string;
  urlPrefix?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
}

type Deps = { fetcher?: typeof fetch };

/** The query string: the project when there is one, plus the rest. */
const queryOf = (project: string | undefined, rest: Record<string, string> = {}) =>
  new URLSearchParams({ ...(project ? { project } : {}), ...rest });

async function listMaps(project: string | undefined, options: Options, deps: Deps): Promise<void> {
  const q = queryOf(project, options.release ? { release: options.release } : {});
  const res = await call<{
    sourcemaps: { release: string; path: string; bytes: number; uploadedAt: string }[];
    summary: string;
  }>('GET', `/api/sourcemaps?${q}`, undefined, { fetcher: deps.fetcher });
  if (options.json) return printJson(res);
  line(res.summary);
  if (!res.sourcemaps.length) return;
  table(
    ['Release', 'Path', 'KB', 'Uploaded'],
    res.sourcemaps.map((m) => [
      m.release,
      m.path,
      String(Math.round(m.bytes / 1024)),
      m.uploadedAt.slice(0, 16),
    ]),
  );
}

async function deleteMaps(
  project: string | undefined,
  options: Options,
  deps: Deps,
): Promise<void> {
  if (!options.release)
    throw new UsageError('Usage: dataflare sourcemaps delete --release <version>');
  const q = queryOf(project, { release: options.release });
  const res = await call<{ deleted: number; summary: string }>(
    'DELETE',
    `/api/sourcemaps?${q}`,
    undefined,
    {
      fetcher: deps.fetcher,
    },
  );
  if (options.json) return printJson(res);
  return ok(res.summary);
}

/** The maps under `dir`, after checking the command has what an upload needs. */
function mapsToUpload(dir: string | undefined, release: string | undefined): string[] {
  if (!dir)
    throw new UsageError(
      'Usage: dataflare sourcemaps upload <dir> --release <version> [--url-prefix /assets]',
      'Also: dataflare sourcemaps list [--release <version>], dataflare sourcemaps delete --release <version>.',
    );
  if (!release)
    throw new UsageError(
      'Pass --release with the version your app sends, e.g. --release "$GITHUB_SHA".',
      'Set the same value in glass.init({ release }) or data-release on the script tag.',
    );
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // Missing: same message as a file.
  }
  if (!isDir) throw new UsageError(`${dir} is not a directory.`);
  const files = mapFiles(dir);
  if (files.length === 0)
    throw new UsageError(
      `No .js.map files in ${dir}.`,
      'Build with source maps on (e.g. build.sourcemap: true in Vite).',
    );
  return files;
}

/** PUT one map. The file is the one the user named: sending it is the point of the command. */
async function putMap(
  fetcher: typeof fetch,
  project: string | undefined,
  release: string,
  path: string,
  text: string,
): Promise<void> {
  const conn = connection();
  const res = await fetcher(`${conn.host}/api/sourcemaps?${queryOf(project, { release, path })}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${conn.key}`, 'Content-Type': 'application/json' },
    body: text,
  });
  if (res.ok) return;
  const err = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  throw new UsageError(`Uploading ${path}: ${err.error ?? `HTTP ${res.status}`}`, err.hint);
}

function reportUpload(uploaded: { path: string; bytes: number }[], options: Options): void {
  const result = { release: options.release, files: uploaded, dryRun: Boolean(options.dryRun) };
  if (options.json) {
    printJson(result);
    return;
  }
  const n = uploaded.length;
  ok(
    `${options.dryRun ? 'Would upload' : 'Uploaded'} ${n} source map${n === 1 ? '' : 's'} for release ${options.release}`,
  );
  for (const u of uploaded.slice(0, 10)) line(color.dim(`  ${u.path}`));
  if (n > 10) line(color.dim(`  … and ${n - 10} more`));
  line(
    color.dim(
      "Maps don't need to be deployed with your site: delete them from the build output if you'd rather not serve them.",
    ),
  );
}

async function uploadMaps(
  dir: string | undefined,
  project: string | undefined,
  options: Options,
  deps: Deps,
): Promise<void> {
  const files = mapsToUpload(dir, options.release);
  const uploaded: { path: string; bytes: number }[] = [];
  for (const file of files) {
    const path = servedPath(dir!, file, options.urlPrefix);
    const text = readFileSync(file, 'utf8');
    if (!options.dryRun) await putMap(deps.fetcher ?? fetch, project, options.release!, path, text);
    uploaded.push({ path, bytes: text.length });
  }
  reportUpload(uploaded, options);
}

export async function sourcemaps(
  sub: string | undefined,
  arg: string | undefined,
  options: Options,
  deps: Deps = {},
): Promise<void> {
  const project = withProject({ project: options.project }).project;
  if (sub === 'list') return listMaps(project, options, deps);
  if (sub === 'delete') return deleteMaps(project, options, deps);
  return uploadMaps(sub === 'upload' ? arg : undefined, project, options, deps);
}
