/** Prepare app-specific integration kits from real Wrangler configs without mutating apps or registering projects. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.argv[2];
if (!workspace)
  throw new Error(
    'Pass the local repository parent: node scripts/prepare-app-integrations.ts /Volumes/dev',
  );
const manifest = JSON.parse(readFileSync(join(root, 'integrations/apps.json'), 'utf8')) as {
  host: string;
  apps: {
    id: string;
    repository: string;
    dir: string;
    config: string;
    environment?: string;
    collection: string;
  }[];
};
for (const app of manifest.apps) {
  const args = [
    join(root, 'packages/cli/src/index.ts'),
    'client-init',
    '--dir',
    join(resolve(workspace), app.repository, app.dir),
    '--config',
    app.config,
    '--host',
    manifest.host,
    '--project',
    app.id,
    '--dry-run',
    '--json',
  ];
  if (app.environment) args.push('--env', app.environment);
  const preview = JSON.parse(
    execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GLASS_HOST: manifest.host, GLASS_PROJECT: app.id },
    }),
  ) as {
    worker?: string;
    framework: string;
    durableObjects: string[];
    files: Record<string, string>;
  };
  const out = join(root, 'integrations', app.id);
  // Kits are committed source examples. client-init itself protects app-local edits on installation.
  for (const [path, content] of Object.entries(preview.files)) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(
    join(out, 'inspection.json'),
    JSON.stringify(
      {
        project: app.id,
        host: manifest.host,
        framework: preview.framework,
        worker: preview.worker,
        durableObjects: preview.durableObjects,
        environment: app.environment ?? null,
        collection: app.collection,
        registered: false,
        deployed: false,
        serviceBinding: 'pending confirmed Worker name and same-account access',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${app.id}: prepared ${preview.framework} / ${preview.worker}; no registration or app edits`,
  );
}
