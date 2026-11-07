// Checks the deployments ForgeGraph ships from this fork (DATFLR-7). Run after `pnpm build`.
//
//   node scripts/check-deployments.ts
//
// Each deployments/<name>/.glass/ holds the Worker's wrangler.jsonc (deployed by ForgeGraph) and
// the CLI's config.json (for `dataflare lake maintain` / `person --delete`). Both must describe the
// same Worker, point at the bundle and migrations `pnpm build` writes, and carry no credentials.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploymentsDir = join(root, 'deployments');
const bundle = join(root, 'packages/worker/dist/worker.js');
const migrations = join(root, 'packages/worker/dist/migrations');

/** wrangler.jsonc allows comments; these files have only whole-line `//` comments. */
function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

const problems: string[] = [];
const fail = (name: string, message: string) => problems.push(`${name}: ${message}`);

if (!existsSync(bundle)) problems.push(`missing ${bundle}; run pnpm build first`);

const names = readdirSync(deploymentsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (names.length === 0) problems.push('no deployments found');

for (const name of names) {
  const glass = join(deploymentsDir, name, '.glass');
  if (existsSync(join(glass, 'credentials.json'))) {
    const ignore = existsSync(join(glass, '.gitignore'))
      ? readFileSync(join(glass, '.gitignore'), 'utf8')
      : '';
    if (!ignore.split('\n').includes('credentials.json'))
      fail(name, 'credentials.json is not git-ignored');
  }
  const wrangler = readJsonc(join(glass, 'wrangler.jsonc'));
  const config = JSON.parse(readFileSync(join(glass, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  if (resolve(glass, String(wrangler.main)) !== bundle)
    fail(name, `main must be the built bundle, got ${wrangler.main}`);
  const d1 =
    (wrangler.d1_databases as { database_name: string; migrations_dir: string }[] | undefined) ??
    [];
  if (d1.length !== 1) fail(name, 'expected exactly one D1 database');
  for (const db of d1) {
    if (resolve(glass, db.migrations_dir) !== migrations)
      fail(name, `migrations_dir must be the built migrations, got ${db.migrations_dir}`);
  }
  if (wrangler.name !== config.name)
    fail(name, `wrangler name ${wrangler.name} != config.json name ${config.name}`);
  if (d1[0] && (config.d1 as { name?: string } | undefined)?.name !== d1[0].database_name)
    fail(name, 'config.json d1.name does not match the wrangler D1 binding');

  // Credentials live in ForgeGraph and as Worker secrets, never in these files.
  const raw =
    readFileSync(join(glass, 'wrangler.jsonc'), 'utf8') +
    readFileSync(join(glass, 'config.json'), 'utf8');
  if (/"(api_?token|token|adminKey|readKey|saltSecret|CF_API_TOKEN)"\s*:/i.test(raw))
    fail(name, 'looks like it contains a credential');
}

if (problems.length > 0) {
  console.error(`Deployment check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Deployments OK: ${names.join(', ')}`);
