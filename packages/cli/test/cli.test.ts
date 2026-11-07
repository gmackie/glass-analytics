/**
 * CLI tests. `dataflare init` runs against a fake Wrangler (which records the
 * commands and applies secrets to the test Worker) while every HTTP call goes
 * to the real Worker code running in-process. That covers the whole onboarding
 * path: provisioning, deploy, secrets, project creation, test event, agent files.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GLASS_VERSION } from '@dataflare/core/version';
import { testApp } from '../../worker/test/harness.ts';
import { agentsSection, importsAgentsMd, upsertSection } from '../src/agent-files.ts';
import {
  lakeResourceNames,
  renderWranglerConfig,
  replayBucketConfig,
} from '../src/cloudflare/provision.ts';
import {
  localWrangler,
  type RunResult,
  type Wrangler,
  WranglerError,
} from '../src/cloudflare/wrangler.ts';
import { init, normaliseRoute } from '../src/commands/init.ts';
import { lakeMaintain, PYICEBERG } from '../src/commands/lake.ts';
import { mcpBridge } from '../src/commands/mcp.ts';
import { ci, upgrade } from '../src/commands/upgrade.ts';
import type { GlassConfig } from '../src/config.ts';

const HOST = 'https://glass.test-account.workers.dev';

interface FakeOptions {
  r2Enabled?: boolean;
}

/** A fake Wrangler: records commands, simulates Cloudflare state, and applies secrets to the test Worker. */
function fakeWrangler(worker: ReturnType<typeof testApp>, options: FakeOptions = {}) {
  const commands: string[][] = [];
  const state = {
    d1: [] as { uuid: string; name: string }[],
    streams: [] as { id: string; name: string }[],
    sinks: [] as { id: string; name: string }[],
    pipelines: [] as { id: string; name: string }[],
  };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const wrangler: Wrangler = {
    async run(args) {
      commands.push(args);
      const cmd = args.join(' ');
      if (cmd === 'd1 list --json') return ok(`Wrangler 4\n${JSON.stringify(state.d1)}`);
      if (args[0] === 'd1' && args[1] === 'create') {
        state.d1.push({ uuid: 'db-uuid-1', name: args[2]! });
        return ok('Created');
      }
      if (cmd.startsWith('r2 bucket create')) {
        return options.r2Enabled === false
          ? {
              code: 1,
              stdout: '',
              stderr: 'Please enable R2 through the Cloudflare Dashboard. [code: 10042]',
            }
          : ok();
      }
      if (cmd.startsWith('r2 bucket catalog enable')) return ok('Warehouse: acct_glass-data');
      if (cmd.startsWith('basin catalog ')) return ok('Successfully enabled');
      for (const kind of ['streams', 'sinks'] as const) {
        if (cmd.startsWith(`pipelines ${kind} create`)) {
          state[kind].push({ id: `${kind}-${args[3]}`, name: args[3]! });
          return ok();
        }
      }
      if (cmd.startsWith('pipelines create')) {
        state.pipelines.push({ id: `p-${args[2]}`, name: args[2]! });
        return ok();
      }
      if (cmd.startsWith('d1 migrations apply')) return ok('Migrations applied');
      if (args[0] === 'deploy')
        return ok(
          `Uploaded glass\nDeployed glass triggers (1.2 sec)\n  ${HOST}\nCurrent Version ID: x`,
        );
      if (args[0] === 'secret' && args[1] === 'bulk') {
        // Secrets reach the running Worker, as they would on Cloudflare.
        Object.assign(worker.env, JSON.parse(readFileSync(args[2]!, 'utf8')));
        return ok('Finished processing secrets file');
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${cmd}` };
    },
  };
  return { wrangler, commands, state };
}

/**
 * Routes Cloudflare API calls to a stub and Worker calls to the in-process app. Pipelines list
 * calls are answered from the fake Wrangler's state, as the real API would.
 */
function fetcherFor(
  worker: ReturnType<typeof testApp>,
  state?: ReturnType<typeof fakeWrangler>['state'],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const pipelines = url.match(/\/pipelines\/v1\/(streams|sinks|pipelines)\?/);
    if (pipelines) {
      const kind = pipelines[1] as 'streams' | 'sinks' | 'pipelines';
      const result = state?.[kind] ?? [];
      return Response.json({ success: true, result, result_info: { total_count: result.length } });
    }
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) {
      return Response.json({ success: true, result: [{ id: 'acct-1', name: 'Test Account' }] });
    }
    if (url.startsWith(HOST)) {
      return worker.app.fetch(
        new Request(url.replace(HOST, 'https://glass.test'), init),
        worker.env,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function tempProject(
  pkg: object = { name: '@acme/web-app', dependencies: { next: '15.0.0' } },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'glass-init-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'CLAUDE.md'), '# Project notes\n');
  return dir;
}

function bundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'glass-bundle-'));
  writeFileSync(join(dir, 'worker.js'), 'export default {}');
  cpSync(
    fileURLToPath(new URL('../../worker/migrations', import.meta.url)),
    join(dir, 'migrations'),
    { recursive: true },
  );
  return dir;
}

const BUNDLE = bundleDir();

describe('dataflare init', () => {
  let worker: ReturnType<typeof testApp>;
  beforeEach(() => {
    worker = testApp({ GLASS_ADMIN_KEY: undefined, GLASS_READ_KEY: undefined });
  });

  it('provisions, deploys, creates the project and writes agent files', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init(
      { token: 'cf-token', json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );

    assert.deepEqual(
      fake.commands.map((c) => c.slice(0, 2).join(' ')),
      [
        'd1 list',
        'd1 create',
        'd1 list',
        'r2 bucket',
        'd1 migrations',
        'deploy --config',
        'secret bulk',
      ],
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config.host, HOST);
    assert.equal(config.project, 'web-app');
    // Named after the project, so another site in the same account gets its own Worker.
    assert.deepEqual(config.d1, { name: 'glass-web-app', id: 'db-uuid-1' });
    assert.deepEqual(config.replay, { bucket: 'glass-web-app-replays' });

    const wranglerConfig = readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8');
    assert.match(wranglerConfig, /"database_id": "db-uuid-1"/);
    assert.match(wranglerConfig, /"binding": "REPLAYS"/);
    assert.ok(existsSync(join(root, '.glass', 'worker.js')));
    assert.ok(existsSync(join(root, '.glass', 'migrations', '0001_init.sql')));
    assert.equal(readFileSync(join(root, '.glass', '.gitignore'), 'utf8'), 'credentials.json\n');
    assert.ok(
      !existsSync(join(root, '.glass', '.secrets.tmp.json')),
      'temporary secrets file is removed',
    );

    const credentials = JSON.parse(readFileSync(join(root, '.glass', 'credentials.json'), 'utf8'));
    assert.equal(worker.env.GLASS_ADMIN_KEY, credentials.adminKey);
    assert.match(credentials.adminKey, /^[0-9a-f]{64}$/);

    const projects = worker.db.sqlite.prepare('SELECT id FROM projects').all() as { id: string }[];
    assert.deepEqual(
      projects.map((p) => p.id),
      ['web-app'],
    );
    const events = worker.db.sqlite.prepare('SELECT event FROM events').all() as {
      event: string;
    }[];
    assert.deepEqual(
      events.map((e) => e.event),
      ['$install_check'],
    );

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- glass:start -->/);
    assert.match(agents, /next\/script|Script src=/);
    assert.match(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8'),
      /^# Project notes\n\n<!-- glass:start -->/,
    );
    assert.match(
      readFileSync(join(root, '.claude', 'skills', 'glass', 'SKILL.md'), 'utf8'),
      /^---\nname: glass\n/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.glass, {
      command: 'npx',
      args: ['-y', 'dataflare-cli', 'mcp'],
    });

    const workflow = readFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'utf8');
    assert.match(workflow, /^# Generated by `dataflare ci`\./);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /upgrade --ci/);
    assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(
      readFileSync(join(root, 'AGENTS.md'), 'utf8'),
      /Upgrades \(the Worker version is pinned/,
    );
  });

  it('is idempotent: a second run reuses resources and keys', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    const deps = {
      root,
      wrangler: () => fake.wrangler,
      fetcher: fetcherFor(worker),
      bundleDir: BUNDLE,
      pollMs: 1,
    };
    await init({ token: 'cf-token', json: true }, deps);
    const key = worker.env.GLASS_ADMIN_KEY;
    fake.commands.length = 0;
    await init({ token: 'cf-token', json: true }, deps);
    assert.ok(!fake.commands.some((c) => c[0] === 'd1' && c[1] === 'create'));
    assert.equal(worker.env.GLASS_ADMIN_KEY, key, 'keys are kept');
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.equal(
      agents.match(/glass:start/g)?.length,
      1,
      'the AGENTS.md section is replaced, not duplicated',
    );
  });

  it('carries on without session replay when R2 is not enabled', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker, { r2Enabled: false });
    await init(
      { token: 'cf-token', json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config.replay, null);
    assert.doesNotMatch(readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8'), /REPLAYS/);
  });

  it('provisions Pipelines and Iceberg tables in lake mode', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init(
      { token: 'cf-token', lake: true, json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker, fake.state),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    const events = lakeResourceNames(config.name, 'events');
    const identities = lakeResourceNames(config.name, 'identities');
    assert.match(events.stream, /^glass_[a-z0-9_]+_events$/);
    const created = fake.commands
      .filter((c) => c.includes('create'))
      .map((c) => c.slice(0, 4).join(' '));
    assert.ok(created.includes(`pipelines streams create ${events.stream}`));
    assert.ok(created.includes(`pipelines sinks create ${events.sink}`));
    assert.ok(created.includes(`pipelines create ${identities.pipeline} --sql`));
    const sink = fake.commands.find((c) => c[2] === 'create' && c[3] === events.sink)!;
    assert.deepEqual(sink.slice(sink.indexOf('--type'), sink.indexOf('--type') + 2), [
      '--type',
      'r2-data-catalog',
    ]);
    const schema = JSON.parse(readFileSync(join(root, '.glass', 'schemas', 'events.json'), 'utf8'));
    assert.ok(
      schema.fields.some(
        (f: { name: string; type: string }) => f.name === 'ts_ms' && f.type === 'int64',
      ),
    );
    const wranglerConfig = readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8');
    assert.match(wranglerConfig, /"GLASS_STORE": "lake"/);
    assert.match(wranglerConfig, new RegExp(`"stream": "streams-${events.stream}"`));
    assert.ok(
      fake.commands.some((c) => c.join(' ').startsWith('basin catalog snapshot-expiration enable')),
      'snapshot expiration removes deleted rows from R2',
    );
    const workflow = readFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'utf8');
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /lake maintain/);
    assert.match(workflow, /astral-sh\/setup-uv/);
    assert.equal(worker.env.CF_API_TOKEN, 'cf-token', 'the query token is stored as a secret');
  });

  it("creates its own Pipelines resources when another deployment's exist", async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    // Another lake deployment in the same account (and the pre-rename fixed names).
    for (const name of ['glass_events', 'glass_other_events']) {
      fake.state.streams.push({ id: `other-${name}`, name });
      fake.state.sinks.push({ id: `other-${name}-sink`, name: `${name}_sink` });
      fake.state.pipelines.push({ id: `other-${name}-p`, name });
    }
    await init(
      { token: 'cf-token', lake: true, json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker, fake.state),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    const { stream, sink } = lakeResourceNames(config.name, 'events');
    assert.equal(config.lake.streams.events, `streams-${stream}`);
    assert.ok(fake.commands.some((c) => c[1] === 'sinks' && c[2] === 'create' && c[3] === sink));
  });

  it('refuses lake mode in the EU jurisdiction', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await assert.rejects(
      init(
        { token: 'cf-token', lake: true, eu: true, json: true },
        { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE },
      ),
      /Basin Catalog does not support R2 buckets in a jurisdiction/,
    );
    assert.equal(fake.commands.filter((c) => c.includes('create')).length, 0);
  });

  it('changes nothing in a dry run', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init(
      { token: 'cf-token', dryRun: true, json: true },
      { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE },
    );
    assert.equal(fake.commands.length, 0);
    assert.ok(!existsSync(join(root, '.glass')));
  });
});

describe('agent files', () => {
  it('replaces the Dataflare section and leaves the rest of the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glass-agents-'));
    const path = join(dir, 'AGENTS.md');
    writeFileSync(
      path,
      '# Rules\n\nBe nice.\n\n<!-- glass:start -->\nold\n<!-- glass:end -->\n\n## Other\n',
    );
    const section = agentsSection({
      root: dir,
      host: HOST,
      project: 'p',
      snippet: { file: 'index.html', code: '<script src="x"></script>' },
    });
    upsertSection(path, section, true);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# Rules\n\nBe nice\.\n\n<!-- glass:start -->/);
    assert.match(text, /## Other\n$/);
    assert.doesNotMatch(text, /\nold\n/);
  });
});

describe('dataflare mcp (stdio bridge)', () => {
  it('forwards JSON-RPC lines to the Worker with the stored key', async () => {
    const worker = testApp();
    await worker.json('POST', '/api/projects', { body: { id: 'acme' } });
    const root = mkdtempSync(join(tmpdir(), 'glass-mcp-'));
    mkdirSync(join(root, '.glass'));
    writeFileSync(
      join(root, '.glass', 'config.json'),
      JSON.stringify({ host: HOST, project: 'acme' }),
    );
    writeFileSync(
      join(root, '.glass', 'credentials.json'),
      JSON.stringify({ adminKey: worker.env.GLASS_ADMIN_KEY }),
    );
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = '';
      output.on('data', (d: Buffer) => {
        text += d.toString();
      });
      const done = mcpBridge({ fetcher: fetcherFor(worker), input, output });
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })}\n`,
      );
      input.write('not json\n');
      input.end();
      await done;
      const messages = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.equal(messages.length, 3, 'one response per request; none for the notification');
      const byId = new Map(messages.map((m) => [m.id, m]));
      assert.equal(byId.get(1).result.serverInfo.name, 'glass');
      assert.match(byId.get(2).result.content[0].text, /acme/);
      assert.equal(byId.get(null).error.code, -32700);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('dataflare upgrade', () => {
  let worker: ReturnType<typeof testApp>;
  beforeEach(() => {
    worker = testApp({ GLASS_ADMIN_KEY: undefined, GLASS_READ_KEY: undefined });
  });

  async function installed(): Promise<{ root: string; fake: ReturnType<typeof fakeWrangler> }> {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init(
      { token: 'cf-token', json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );
    fake.commands.length = 0;
    return { root, fake };
  }
  const setVersion = (root: string, version: string) => {
    const path = join(root, '.glass', 'config.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }));
  };
  const version = (root: string) =>
    JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8')).version;
  const quiet = async (fn: () => Promise<void>) => {
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = write;
    }
  };

  it('moves a lake deployment to a new schema version with new tables', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init(
      { token: 'cf-token', lake: true, json: true },
      {
        root,
        wrangler: () => fake.wrangler,
        fetcher: fetcherFor(worker, fake.state),
        bundleDir: BUNDLE,
        pollMs: 1,
      },
    );
    fake.commands.length = 0;
    await quiet(() =>
      upgrade(
        { json: true, ci: true },
        {
          root,
          wrangler: () => fake.wrangler,
          fetcher: fetcherFor(worker, fake.state),
          bundleDir: BUNDLE,
          env: { CLOUDFLARE_API_TOKEN: 'cf-token', CI: 'true' },
          lakeVersion: 2,
          lakeChanges: [
            {
              version: 2,
              table: 'events',
              add: [{ name: 'locale', type: 'string', required: false }],
            },
          ],
        },
      ),
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    const v2 = lakeResourceNames(config.name, 'events', 2);
    assert.match(v2.stream, /_events_v2$/);
    assert.equal(config.lake.version, 2);
    assert.deepEqual(config.lake.versions, [1, 2]);
    assert.equal(config.lake.streams.events, `streams-${v2.stream}`);
    const sink = fake.commands.find(
      (c) => c[1] === 'sinks' && c[2] === 'create' && c[3] === v2.sink,
    )!;
    assert.equal(sink[sink.indexOf('--table') + 1], 'events_v2');
    const schema = JSON.parse(
      readFileSync(join(root, '.glass', 'schemas', 'events_v2.json'), 'utf8'),
    );
    assert.equal(schema.fields.at(-1).name, 'locale');
    const wranglerConfig = readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8');
    assert.match(wranglerConfig, /"LAKE_VERSIONS": "1,2"/);
    assert.match(wranglerConfig, new RegExp(`"stream": "streams-${v2.stream}"`));
  });

  it('only stages .glass/ on a laptop when the CI workflow exists', async () => {
    const { root, fake } = await installed();
    setVersion(root, '0.0.1');
    await quiet(() =>
      upgrade(
        { json: true },
        {
          root,
          wrangler: () => fake.wrangler,
          fetcher: fetcherFor(worker),
          bundleDir: BUNDLE,
          env: {},
        },
      ),
    );
    assert.deepEqual(fake.commands, [], 'nothing is deployed');
    assert.equal(version(root), GLASS_VERSION);
  });

  it('deploys in CI without credentials.json and leaves Worker secrets alone', async () => {
    const { root, fake } = await installed();
    rmSync(join(root, '.glass', 'credentials.json'));
    setVersion(root, '0.0.1');
    await quiet(() =>
      upgrade(
        { json: true },
        {
          root,
          wrangler: () => fake.wrangler,
          fetcher: fetcherFor(worker),
          bundleDir: BUNDLE,
          env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' },
        },
      ),
    );
    assert.deepEqual(
      fake.commands.map((c) => c.slice(0, 2).join(' ')),
      ['d1 migrations', 'deploy --config'],
    );
    assert.equal(version(root), GLASS_VERSION);
  });

  it('refuses to replace a newer Worker with an older CLI', async () => {
    const { root, fake } = await installed();
    setVersion(root, '99.0.0');
    await assert.rejects(
      upgrade(
        { json: true },
        {
          root,
          wrangler: () => fake.wrangler,
          fetcher: fetcherFor(worker),
          bundleDir: BUNDLE,
          env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' },
        },
      ),
      /runs Dataflare 99\.0\.0, which is newer than this CLI/,
    );
    assert.deepEqual(fake.commands, []);
    assert.equal(version(root), '99.0.0');
  });

  it('keeps session replay off through upgrades after --no-replay', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    const deps = {
      root,
      wrangler: () => fake.wrangler,
      fetcher: fetcherFor(worker),
      bundleDir: BUNDLE,
      pollMs: 1,
    };
    await init({ token: 'cf-token', replay: false, json: true }, deps);
    const config = () => JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config().replay, false);
    fake.commands.length = 0;
    setVersion(root, '0.0.1');
    await quiet(() =>
      upgrade({ json: true }, { ...deps, env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' } }),
    );
    assert.ok(!fake.commands.some((c) => c[0] === 'r2'), 'no replay bucket is created');
    assert.equal(config().replay, false);
    assert.doesNotMatch(readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8'), /REPLAYS/);
  });

  it('upgrade --no-replay stops retrying the replay bucket on an older install', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker, { r2Enabled: false });
    const deps = {
      root,
      wrangler: () => fake.wrangler,
      fetcher: fetcherFor(worker),
      bundleDir: BUNDLE,
      pollMs: 1,
    };
    await init({ token: 'cf-token', json: true }, deps);
    const config = () => JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config().replay, null, 'R2 was off, so replay is pending');
    fake.commands.length = 0;
    setVersion(root, '0.0.1');
    await quiet(() =>
      upgrade(
        { json: true, replay: false },
        { ...deps, env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' } },
      ),
    );
    assert.ok(!fake.commands.some((c) => c[0] === 'r2'), 'no replay bucket is attempted');
    assert.equal(config().replay, false);
  });

  it('upgrade --no-replay refuses on an install with a replay bucket', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    const deps = {
      root,
      wrangler: () => fake.wrangler,
      fetcher: fetcherFor(worker),
      bundleDir: BUNDLE,
      pollMs: 1,
    };
    await init({ token: 'cf-token', json: true }, deps);
    const config = () => JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    const before = config().replay;
    assert.ok(before?.bucket, 'replay is set up');
    fake.commands.length = 0;
    setVersion(root, '0.0.1');
    await assert.rejects(
      upgrade(
        { json: true, replay: false },
        { ...deps, env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' } },
      ),
      /Session replay is set up with bucket/,
    );
    assert.deepEqual(fake.commands, []);
    assert.deepEqual(config().replay, before);
  });

  it('dataflare ci keeps a hand-written workflow', async () => {
    const { root } = await installed();
    writeFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'name: mine\n');
    await quiet(async () => ci({ json: true }, { root }));
    assert.equal(
      readFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'utf8'),
      'name: mine\n',
    );
  });

  it('dataflare ci rewrites a workflow generated before the rename', async () => {
    const { root } = await installed();
    const path = join(root, '.github', 'workflows', 'glass.yml');
    writeFileSync(
      path,
      '# Generated by `glass ci`. Deploys the Glass analytics Worker from .glass/.\n' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable in the old workflow
        'npx -y "@glassanalytics/cli@${version}" upgrade --ci\n',
    );
    await quiet(async () => ci({ json: true }, { root }));
    const workflow = readFileSync(path, 'utf8');
    assert.match(workflow, /npx -y "dataflare-cli@\$\{version\}" upgrade --ci/);
    assert.doesNotMatch(workflow, /@glassanalytics/);
  });
});

describe('the bin', () => {
  it('runs when npm links it under another name', () => {
    // npm links the bin as `dataflare`; the entry must still run through the symlink.
    const dir = mkdtempSync(join(tmpdir(), 'glass-bin-'));
    const link = join(dir, 'dataflare');
    symlinkSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), link);
    const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.match(out, /^dataflare \d+\.\d+\.\d+/);
  });
});

describe('onboarding details', () => {
  it('accepts a route as a bare host, a path, or the full pattern', () => {
    for (const input of ['acme.com', 'https://acme.com/', 'acme.com/_glass', 'acme.com/_glass/*']) {
      assert.equal(normaliseRoute(input), 'acme.com/_glass/*', input);
    }
    assert.equal(normaliseRoute(undefined), undefined);
  });

  it('runs the installed wrangler rather than downloading one with npx', () => {
    const bin = localWrangler();
    assert.ok(bin?.endsWith(join('wrangler', 'bin', 'wrangler.js')), String(bin));
    assert.ok(bin && existsSync(bin));
  });

  it('turns workers.dev off once the Worker has a route, so zone rules cannot be bypassed', () => {
    const config: GlassConfig = {
      name: 'glass-web-app',
      accountId: 'acc',
      host: HOST,
      project: 'web-app',
      store: 'd1',
      d1: { name: 'glass-web-app', id: 'db' },
      replay: null,
      lake: null,
      route: null,
      eu: false,
      version: GLASS_VERSION,
    };
    assert.match(renderWranglerConfig(config), /"workers_dev": true/);
    assert.match(
      renderWranglerConfig({ ...config, route: 'acme.com/_glass/*' }),
      /"workers_dev": false/,
    );
  });

  it("doesn't copy the Dataflare section into a CLAUDE.md that imports AGENTS.md", () => {
    const dir = mkdtempSync(join(tmpdir(), 'glass-md-'));
    const claude = join(dir, 'CLAUDE.md');
    writeFileSync(claude, '@AGENTS.md\n');
    assert.equal(importsAgentsMd(claude), true);
    writeFileSync(claude, '# Notes\n\nNo import here.\n');
    assert.equal(importsAgentsMd(claude), false);
  });

  it('shows why wrangler failed, not the end of its upload log', () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `binding line ${i}`).join('\n');
    const err = new WranglerError(['deploy'], {
      code: 1,
      stdout,
      stderr: 'X [ERROR] A request to the Cloudflare API failed: route not permitted',
    });
    assert.match(err.message, /route not permitted/);
    assert.doesNotMatch(err.message, /binding line 29/);
  });
});

describe('lake maintenance', () => {
  // Runs the real PyIceberg job against a local Iceberg catalog (SQLite + files). Needs uv;
  // CI sets DATAFLARE_REQUIRE_PYTHON=1 so a missing uv fails rather than skips.
  const uv = (() => {
    try {
      execFileSync('uv', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const required = process.env.DATAFLARE_REQUIRE_PYTHON === '1';
  const fixture = fileURLToPath(new URL('./lake_fixture.py', import.meta.url));
  const uvArgs = [
    'run',
    '--no-project',
    '--quiet',
    '--python',
    '3.13',
    '--with',
    `${PYICEBERG}`,
    '--with',
    'pyiceberg[sql-sqlite]==0.12.0',
  ];
  const python = (args: string[], input?: string) =>
    execFileSync('uv', [...uvArgs, 'python', ...args], { input, encoding: 'utf8' });

  it('erases queued people and applies retention', {
    skip: !uv && !required && 'uv is not installed',
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'glass-lake-'));
    const warehouse = join(root, 'lake');
    mkdirSync(warehouse);
    python([fixture, 'seed', warehouse]);
    mkdirSync(join(root, '.glass'));
    const now = 1_790_000_000_000;
    writeFileSync(
      join(root, '.glass', 'config.json'),
      JSON.stringify({
        name: 'glass-acme',
        accountId: 'acct-1',
        host: HOST,
        project: 'acme',
        store: 'lake',
        d1: { name: 'glass-acme', id: 'db-1' },
        replay: null,
        lake: {
          bucket: 'glass-acme-data',
          namespace: 'glass',
          streams: { events: 's1', identities: 's2' },
          // After a schema change: events_v2 exists, identities_v2 has no table yet.
          version: 2,
          versions: [1, 2],
        },
        route: null,
        retentionDays: 365,
        eu: false,
        version: GLASS_VERSION,
      }),
    );
    const sql: string[] = [];
    const wrangler: Wrangler = {
      async run(args) {
        const command = args[args.indexOf('--command') + 1]!;
        sql.push(command);
        const results = command.startsWith('SELECT')
          ? [{ id: 7, project: 'acme', ids: JSON.stringify(['alice', 'dev-alice']) }]
          : [];
        return { code: 0, stdout: JSON.stringify([{ results, success: true }]), stderr: '' };
      },
    };
    await lakeMaintain(
      { token: 'cf-token', json: true },
      {
        root,
        now,
        wrangler: () => wrangler,
        catalog: {
          type: 'sql',
          uri: `sqlite:///${warehouse}/catalog.db`,
          warehouse: `file://${warehouse}/warehouse`,
        },
        run: async (script, stdin) => python([script], stdin),
      },
    );
    const left = JSON.parse(python([fixture, 'dump', warehouse])) as {
      events: { project: string; distinct_id: string; ts_ms: number }[];
      events_v2: { distinct_id: string }[];
      identities: { distinct_id: string }[];
    };
    assert.deepEqual(
      left.events_v2.map((e) => e.distinct_id),
      ['dev-carol'],
      'erasure reaches every schema version',
    );
    // Alice's events in acme are gone (by device and by user id); the same device in another
    // project stays; Bob's old event is past the 365-day retention.
    assert.deepEqual(left.events.map((e) => `${e.project}:${e.distinct_id}`).sort(), [
      'acme:dev-bob',
      'other:dev-alice',
    ]);
    assert.ok(left.events.every((e) => e.ts_ms > now - 365 * 86_400_000));
    assert.deepEqual(
      left.identities.map((i) => i.distinct_id),
      ['dev-bob'],
    );
    assert.match(
      sql.at(-1)!,
      /^UPDATE lake_deletions SET done_at = 1790000000000 WHERE id IN \(7\)$/,
    );
  });

  it('refuses a D1 deployment', async () => {
    const root = tempProject();
    mkdirSync(join(root, '.glass'));
    writeFileSync(join(root, '.glass', 'config.json'), JSON.stringify({ store: 'd1', lake: null }));
    await assert.rejects(lakeMaintain({ token: 't' }, { root }), /keeps events in D1/);
  });
});

describe('generated wrangler config', () => {
  const base: GlassConfig = {
    name: 'glass-web-app',
    accountId: 'acc',
    host: HOST,
    project: 'web-app',
    store: 'd1',
    d1: { name: 'glass-web-app', id: 'db' },
    replay: null,
    lake: null,
    route: null,
    eu: false,
    version: GLASS_VERSION,
  };
  const render = (config: Partial<GlassConfig>) =>
    JSON.parse(renderWranglerConfig({ ...base, ...config }).replace(/^\/\/.*\n/, '')) as {
      r2_buckets?: Record<string, string>[];
      routes?: unknown[];
    };

  it('binds an EU replay bucket with its jurisdiction', () => {
    assert.deepEqual(render({ replay: replayBucketConfig('r', false, null) }).r2_buckets, [
      { binding: 'REPLAYS', bucket_name: 'r' },
    ]);
    assert.deepEqual(render({ eu: true, replay: replayBucketConfig('r', true, null) }).r2_buckets, [
      { binding: 'REPLAYS', bucket_name: 'r', jurisdiction: 'eu' },
    ]);
  });

  it('moves a pre-0.8.1 EU deployment to its EU bucket and keeps the old one as legacy', () => {
    // Before 0.8.1 an EU config recorded no jurisdiction, and the Worker wrote to a
    // default-jurisdiction bucket of the same name.
    const migrated = replayBucketConfig('r', true, { bucket: 'r' });
    assert.deepEqual(migrated, { bucket: 'r', jurisdiction: 'eu', legacyBucket: 'r' });
    assert.deepEqual(render({ eu: true, replay: migrated }).r2_buckets, [
      { binding: 'REPLAYS', bucket_name: 'r', jurisdiction: 'eu' },
      { binding: 'REPLAYS_LEGACY', bucket_name: 'r' },
    ]);
    // Running upgrade again keeps the legacy bucket, and a current config gains none.
    assert.deepEqual(replayBucketConfig('r', true, migrated), migrated);
    assert.deepEqual(replayBucketConfig('r', true, { bucket: 'r', jurisdiction: 'eu' }), {
      bucket: 'r',
      jurisdiction: 'eu',
    });
    assert.deepEqual(replayBucketConfig('r', false, { bucket: 'r' }), { bucket: 'r' });
  });

  it('leaves the zone of a route to Wrangler, so multi-label domains work', () => {
    for (const route of [
      'example.com/_glass/*',
      'analytics.example.co.uk/_glass/*',
      'a.team.example.com/_glass/*',
    ]) {
      assert.deepEqual(render({ route }).routes, [route]);
    }
    assert.equal(render({}).routes, undefined);
  });
});
