/**
 * Build every artifact with esbuild, in dependency order:
 *
 *   1. packages/web/dist        npm SDK (ESM + .d.ts), script-tag SDK, replay recorder
 *   1b. packages/node/dist      server SDK (ESM + .d.ts)
 *   2. packages/dashboard/dist  app.js + app.css
 *   3. packages/worker/dist     worker.js with the SDK and dashboard embedded, + migrations
 *   4. packages/cli/dist        glass.js with the Worker bundle alongside it
 *
 * Run with `pnpm build`. Add `--watch`-style tooling later if you need it; a
 * full build takes about a second.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (name: string, ...parts: string[]) => join(root, 'packages', name, ...parts);
const sizes: [string, number, number][] = [];

// The dashboard upgrade banner compares Worker /health.version to the latest
// dataflare on npm. Those must stay in lockstep or upgrades look stuck.
{
  const cliVersion = JSON.parse(readFileSync(pkg('cli', 'package.json'), 'utf8')).version as string;
  const versionSrc = readFileSync(pkg('core', 'src', 'version.ts'), 'utf8');
  const match = /export const GLASS_VERSION = '([^']+)'/.exec(versionSrc);
  if (!match || match[1] !== cliVersion) {
    throw new Error(
      `GLASS_VERSION (${match?.[1] ?? 'missing'}) must equal packages/cli version (${cliVersion}). ` +
        'Update packages/core/src/version.ts before building.',
    );
  }
}

function record(file: string): void {
  const bytes = readFileSync(file);
  sizes.push([file.replace(`${root}/`, ''), bytes.length, gzipSync(bytes).length]);
}

async function bundle(options: esbuild.BuildOptions & { outfile: string }): Promise<void> {
  await esbuild.build({ bundle: true, logLevel: 'warning', legalComments: 'none', ...options });
  record(options.outfile);
}

function clean(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// 1. Browser SDK ───────────────────────────────────────────────────────────
const webDist = pkg('web', 'dist');
clean(webDist);
await bundle({
  entryPoints: [pkg('web', 'src', 'index.ts')],
  outfile: join(webDist, 'index.js'),
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
});
await bundle({
  entryPoints: [pkg('web', 'src', 'script.ts')],
  outfile: join(webDist, 'glass.js'),
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  minify: true,
});
await bundle({
  entryPoints: [pkg('web', 'src', 'replay.ts')],
  outfile: join(webDist, 'replay.js'),
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  minify: true,
});
// Type declarations for the npm package. The SDK's public types are self-contained,
// so the emitted .d.ts files never reference the private @dataflare/core package.
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', pkg('web', 'tsconfig.build.json')],
  { stdio: 'inherit' },
);
for (const file of ['index.d.ts', 'client.d.ts', 'types.d.ts']) {
  // Declaration output keeps `.ts` specifiers; published files must point at `.js`.
  const declaration = readFileSync(join(webDist, '.types', 'web', 'src', file), 'utf8').replace(
    /(from\s+'\.{1,2}\/[^']+)\.ts'/g,
    "$1.js'",
  );
  if (/^(import|export)\b[^\n]*'@glass\//m.test(declaration)) {
    throw new Error(
      `${file} imports a private @glass package; keep the SDK's public types self-contained.`,
    );
  }
  writeFileSync(join(webDist, file), declaration);
}
rmSync(join(webDist, '.types'), { recursive: true, force: true });

// 1b. Server SDK (dataflare-node) ──────────────────────────────────────────
const nodeDist = pkg('node', 'dist');
clean(nodeDist);
await bundle({
  entryPoints: [pkg('node', 'src', 'index.ts')],
  outfile: join(nodeDist, 'index.js'),
  format: 'esm',
  // Fetch and WebCrypto only: the same file runs on Node 18+, Bun, Deno and Workers.
  platform: 'neutral',
  target: 'es2022',
});
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    pkg('node', 'tsconfig.build.json'),
  ],
  { stdio: 'inherit' },
);
{
  const declaration = readFileSync(join(nodeDist, '.types', 'node', 'src', 'index.d.ts'), 'utf8');
  if (/^(import|export)\b[^\n]*'@dataflare\/core/m.test(declaration)) {
    throw new Error(
      "dataflare-node's index.d.ts imports @dataflare/core; keep its public types self-contained.",
    );
  }
  writeFileSync(join(nodeDist, 'index.d.ts'), declaration);
  rmSync(join(nodeDist, '.types'), { recursive: true, force: true });
}

// 2. Dashboard ─────────────────────────────────────────────────────────────
const dashDist = pkg('dashboard', 'dist');
clean(dashDist);
await esbuild.build({
  entryPoints: { app: pkg('dashboard', 'src', 'main.ts') },
  outdir: dashDist,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
record(join(dashDist, 'app.js'));
record(join(dashDist, 'app.css'));

// 3. Worker ────────────────────────────────────────────────────────────────
const workerDist = pkg('worker', 'dist');
clean(workerDist);
const assets = {
  sdk: readFileSync(join(webDist, 'glass.js'), 'utf8'),
  replay: readFileSync(join(webDist, 'replay.js'), 'utf8'),
  dashboardJs: readFileSync(join(dashDist, 'app.js'), 'utf8'),
  dashboardCss: readFileSync(join(dashDist, 'app.css'), 'utf8'),
};
await bundle({
  entryPoints: [pkg('worker', 'src', 'index.ts')],
  outfile: join(workerDist, 'worker.js'),
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  define: { __GLASS_ASSETS__: JSON.stringify(assets) },
});
cpSync(pkg('worker', 'migrations'), join(workerDist, 'migrations'), { recursive: true });

// 4. CLI ───────────────────────────────────────────────────────────────────
const cliDist = pkg('cli', 'dist');
clean(cliDist);
await bundle({
  entryPoints: [pkg('cli', 'src', 'index.ts')],
  outfile: join(cliDist, 'glass.js'),
  format: 'esm',
  target: 'node20',
  platform: 'node',
  // Bundle @dataflare/* into the CLI so `npx dataflare-cli` works
  // without installing workspace packages. Wrangler stays a real dependency.
  external: ['wrangler'],
  banner: { js: '#!/usr/bin/env node' },
  // `client-init --frontend-only` installs the canonical journey loader (DATFLR-18).
  define: {
    __JOURNEY_LOADER__: JSON.stringify(
      readFileSync(join(root, 'deployments', 'observe', 'journey-loader', 'dataflare.js'), 'utf8'),
    ),
  },
});
cpSync(workerDist, join(cliDist, 'worker'), { recursive: true });
// The lake maintenance job (PyIceberg), run by `dataflare lake maintain`.
cpSync(pkg('cli', 'lake'), join(cliDist, 'lake'), { recursive: true });

// Report ───────────────────────────────────────────────────────────────────
const width = Math.max(...sizes.map(([f]) => f.length));
for (const [file, raw, gz] of sizes) {
  console.log(
    `${file.padEnd(width)}  ${(raw / 1024).toFixed(1).padStart(7)} KB  ${(gz / 1024).toFixed(1).padStart(6)} KB gzip`,
  );
}
console.log(`built in ${process.uptime().toFixed(1)}s`);
statSync(join(cliDist, 'worker', 'worker.js'));
