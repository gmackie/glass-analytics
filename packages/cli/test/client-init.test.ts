import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ADMIN, testApp } from '../../worker/test/harness.ts';
import { workerClientSource } from '../src/client-files.ts';
import { journeyLoader } from '../src/client-static.ts';
import { clientInit } from '../src/commands/client-init.ts';
import { init } from '../src/commands/init.ts';
import { connection, projectRoot } from '../src/config.ts';

const HOST = 'https://dataflare.example';
const roots: string[] = [];
const originalKey = process.env.GLASS_API_KEY;
const originalHost = process.env.GLASS_HOST;
const originalProject = process.env.GLASS_PROJECT;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    GLASS_API_KEY: originalKey,
    GLASS_HOST: originalHost,
    GLASS_PROJECT: originalProject,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'dataflare-client-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@forgegraph/my-app', type: 'module' }),
  );
  process.env.GLASS_API_KEY = ADMIN;
  delete process.env.GLASS_HOST;
  delete process.env.GLASS_PROJECT;
  return root;
}
function api(worker: ReturnType<typeof testApp>): typeof fetch {
  return async (input, init) => worker.app.fetch(new Request(input, init), worker.env);
}
async function helper(root: string) {
  const path = join(root, 'worker.ts');
  writeFileSync(path, workerClientSource(HOST, 'my-app'));
  return import(pathToFileURL(path).href) as Promise<{
    dataflareProxy(
      request: Request,
      env: { DATAFLARE: { fetch: (request: Request) => Promise<Response> } },
    ): Promise<Response | null>;
    capture(
      env: { DATAFLARE: { fetch: (request: Request) => Promise<Response> } },
      event: {
        event: string;
        distinct_id: string;
        id?: string;
        ts?: number;
        session_id?: string;
        props?: Record<string, unknown>;
      },
    ): Promise<void>;
  }>;
}

describe('client-init', () => {
  it('previews offline without credentials or writes, and detects Wrangler DO bindings', async () => {
    const root = repo();
    delete process.env.GLASS_API_KEY;
    writeFileSync(
      join(root, 'wrangler.toml'),
      `name = "my-app"\ncompatibility_date = "2026-11-01"\n[[durable_objects.bindings]]\nname = "CASES"\nclass_name = "Case"\n`,
    );
    await clientInit(
      { host: HOST, project: 'my-app', service: 'analytics', dryRun: true, json: true },
      {
        root,
        fetcher: async () => {
          throw new Error('Must stay offline');
        },
      },
    );
    assert.equal(existsSync(join(root, '.glass')), false);
  });

  it('routes CLI flags to an offline JSON preview', () => {
    const root = repo();
    const output = execFileSync(
      process.execPath,
      [
        new URL('../src/index.ts', import.meta.url).pathname,
        'client-init',
        '--host',
        HOST,
        '--project',
        'my-app',
        '--service',
        'analytics',
        '--dry-run',
        '--json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const result = JSON.parse(output);
    assert.equal(result.dryRun, true);
    assert.equal(result.project, 'my-app');
    assert.ok(result.files['.glass/client/worker.ts']);
    assert.equal(existsSync(join(root, '.glass')), false);
  });

  it('registers once, writes no secrets, and preserves allowed origins on rerun', async () => {
    const root = repo();
    const worker = testApp();
    const options = { host: HOST, project: 'my-app', service: 'analytics' };
    await clientInit(options, { root, fetcher: api(worker) });
    const initial = readFileSync(join(root, '.glass/client/worker.ts'), 'utf8');
    assert.ok(!initial.includes(ADMIN));
    assert.equal(existsSync(join(root, '.glass/credentials.json')), false);
    assert.equal(existsSync(join(root, '.glass/config.json')), false);
    await worker.json('POST', '/api/projects', {
      body: { id: 'my-app', allowed_origins: ['https://my-app.example'] },
    });
    await clientInit(options, { root, fetcher: api(worker) });
    const projects = await worker.json<{ projects: { id: string; allowedOrigins: string[] }[] }>(
      'GET',
      '/api/projects',
    );
    assert.deepEqual(projects.projects.find((p) => p.id === 'my-app')?.allowedOrigins, [
      'https://my-app.example',
    ]);
    assert.equal(readFileSync(join(root, '.glass/client/worker.ts'), 'utf8'), initial);
    assert.ok(readFileSync(join(root, '.glass/client/README.md'), 'utf8').includes('/_glass/s.js'));
    await assert.rejects(init({ dryRun: true }, { root }), /repo is a Dataflare client/);
    const nested = join(root, 'src');
    mkdirSync(nested);
    assert.equal(projectRoot(nested), root);
    const cwd = process.cwd();
    try {
      process.chdir(nested);
      assert.deepEqual(connection(), { host: HOST, project: 'my-app', key: ADMIN });
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses edited files and deployment repos before remote registration', async () => {
    const root = repo();
    mkdirSync(join(root, '.glass/client'), { recursive: true });
    writeFileSync(join(root, '.glass/client/worker.ts'), '// local edits');
    const fetcher: typeof fetch = async () => {
      throw new Error('Unexpected network');
    };
    await assert.rejects(
      clientInit({ host: HOST, project: 'my-app', service: 'analytics' }, { root, fetcher }),
      /Refusing to overwrite/,
    );
    writeFileSync(join(root, '.glass/config.json'), '{}');
    await assert.rejects(
      clientInit({ host: HOST, project: 'my-app' }, { root, fetcher }),
      /owns a Dataflare deployment/,
    );
  });

  it('rejects unsafe hosts, invalid projects and missing credentials', async () => {
    const root = repo();
    for (const host of [
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com/?token=secret',
    ]) {
      await assert.rejects(
        clientInit({ host, project: 'my-app', dryRun: true }, { root }),
        /must use HTTPS/,
      );
    }
    await assert.rejects(
      clientInit({ host: HOST, project: '../invalid', dryRun: true }, { root }),
      /Invalid project/,
    );
    delete process.env.GLASS_API_KEY;
    await assert.rejects(
      clientInit({ host: HOST, project: 'my-app' }, { root }),
      /Missing Dataflare admin/,
    );
    assert.equal(existsSync(join(root, '.glass')), false);
  });

  it('executes generated Worker/DO capture through real ingest, preserving correlation and retry timestamps', async () => {
    const root = repo();
    const worker = testApp();
    await worker.json('POST', '/api/projects', { body: { id: 'my-app' } });
    const { capture } = await helper(root);
    const env = {
      DATAFLARE: { fetch: (request: Request) => worker.app.fetch(request, worker.env) },
    };
    const event = {
      id: 'persisted-id',
      ts: Date.now() - 60_000,
      event: 'stage_changed',
      distinct_id: 'case-1',
      session_id: 'session-1',
      props: { journey_id: 'case-1', stage: 'done' },
    };
    await capture(env, event);
    await capture(env, event);
    await assert.rejects(capture(env, { ...event, event: 'bad\u0001name' }), /custom event name/);
    const rows = worker.db.sqlite.prepare('SELECT * FROM events WHERE project = ?').all('my-app');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ts_ms, event.ts);
    assert.equal(rows[0]?.distinct_id, 'case-1');
    assert.equal(rows[0]?.session_id, 'session-1');
    assert.equal(JSON.parse(String(rows[0]?.props)).journey_id, 'case-1');
    await assert.rejects(capture(env, { event: 'stage_changed', distinct_id: '' }), /distinct_id/);
    await assert.rejects(
      capture(env, { event: 'stage_changed', distinct_id: 'case-1', ts: NaN }),
      /finite timestamp/,
    );
    await assert.rejects(
      capture({ DATAFLARE: { fetch: async () => new Response(null, { status: 503 }) } }, event),
      /HTTP 503/,
    );
  });

  it('limits the proxy to public endpoints and strips app secrets while preserving visitor headers', async () => {
    const root = repo();
    const { dataflareProxy } = await helper(root);
    const forwarded: Request[] = [];
    const env = {
      DATAFLARE: {
        fetch: async (request: Request) => {
          forwarded.push(request);
          return new Response(null, { status: 204 });
        },
      },
    };
    assert.equal(await dataflareProxy(new Request('https://app.example/home'), env), null);
    for (const path of ['/api/projects', '/mcp', '/app', '//evil.example', '/e/extra']) {
      assert.equal(
        (await dataflareProxy(new Request(`https://app.example/_glass${path}`), env))?.status,
        404,
      );
    }
    assert.equal(
      (await dataflareProxy(new Request('https://app.example/_glass/e'), env))?.status,
      405,
    );
    assert.equal(forwarded.length, 0);
    const request = new Request('https://app.example/_glass/e', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer app-secret',
        Cookie: 'session=secret',
        'CF-Connecting-IP': '192.0.2.1',
        'User-Agent': 'browser',
        Origin: 'https://app.example',
        'CF-IPCountry': 'US',
      },
      body: '{"project":"my-app","events":[]}',
    });
    await dataflareProxy(request, env);
    assert.equal(forwarded[0]?.url, `${HOST}/e`);
    assert.equal(forwarded[0]?.headers.get('Authorization'), null);
    assert.equal(forwarded[0]?.headers.get('Cookie'), null);
    assert.equal(forwarded[0]?.headers.get('CF-Connecting-IP'), '192.0.2.1');
    assert.equal(forwarded[0]?.headers.get('Origin'), 'https://app.example');
    assert.equal(await forwarded[0]?.text(), '{"project":"my-app","events":[]}');
    const worker = testApp();
    await worker.json('POST', '/api/projects', { body: { id: 'my-app' } });
    const response = await dataflareProxy(
      new Request('https://app.example/_glass/e', {
        method: 'POST',
        headers: { 'CF-IPCountry': 'US', 'CF-Connecting-IP': '192.0.2.1' },
        body: JSON.stringify({
          project: 'my-app',
          events: [{ id: 'browser-event', ts: Date.now(), event: '$pageview' }],
        }),
      }),
      { DATAFLARE: { fetch: (r) => worker.app.fetch(r, worker.env) } },
    );
    assert.equal(response?.status, 204);
    const stored = worker.db.sqlite
      .prepare('SELECT country FROM events WHERE id = ?')
      .get('browser-event');
    assert.equal(stored?.country, 'US');
  });

  describe('frontend-only (Cloudflare Pages and static hosts)', () => {
    const offline: typeof fetch = async () => {
      throw new Error('Must stay offline');
    };
    const WORKER_FILES = ['.glass/client/worker.ts', '.glass/client/binding.json'];

    function cli(root: string, ...args: string[]): string {
      return execFileSync(
        process.execPath,
        [new URL('../src/index.ts', import.meta.url).pathname, 'client-init', ...args],
        { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } },
      );
    }
    function preview(root: string, ...args: string[]) {
      return JSON.parse(
        cli(root, '--host', HOST, '--project', 'my-app', '--dry-run', '--json', ...args),
      ) as {
        mode: string;
        reason?: string;
        staticDir?: string;
        snippet?: string;
        origins: string[];
        registration: string;
        files: Record<string, string>;
      };
    }
    function assertFrontendOnly(result: ReturnType<typeof preview>, loader: string) {
      assert.equal(result.mode, 'frontend-only');
      assert.equal(
        result.snippet,
        '<script defer src="/dataflare.js" data-enabled="true"></script>',
      );
      assert.match(result.registration, /Register project my-app/);
      assert.ok(result.files['.glass/client.json']);
      assert.ok(result.files['.glass/client/README.md']?.includes(result.snippet));
      assert.match(result.files[loader] ?? '', /project: 'my-app',/);
      for (const file of WORKER_FILES) assert.equal(result.files[file], undefined);
      const all = Object.values(result.files).join('\n');
      assert.ok(!all.includes('dataflareProxy') && !all.includes('"binding"'));
    }

    it('detects a Pages project from wrangler.toml and installs into the framework public dir', () => {
      const root = repo();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'my-app',
          scripts: { build: 'vite build' },
          devDependencies: { vite: '^6.0.0' },
        }),
      );
      writeFileSync(
        join(root, 'wrangler.toml'),
        'name = "my-app"\ncompatibility_date = "2026-11-01"\npages_build_output_dir = "./dist"\n',
      );
      const result = preview(
        root,
        '--origins',
        'https://my-app.example/path,https://my-app.example',
      );
      assertFrontendOnly(result, 'public/dataflare.js');
      assert.equal(result.reason, 'wrangler.toml sets pages_build_output_dir');
      assert.equal(result.staticDir, 'public');
      assert.deepEqual(result.origins, ['https://my-app.example']);
      assert.equal(existsSync(join(root, '.glass')), false);
      assert.equal(existsSync(join(root, 'public')), false);
    });

    it('detects a Pages project from wrangler.jsonc and uses an unbuilt output dir as is', () => {
      const root = repo();
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app' }));
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        '{\n  // Pages project\n  "name": "my-app",\n  "pages_build_output_dir": "site",\n}\n',
      );
      const result = preview(root);
      assertFrontendOnly(result, 'site/dataflare.js');
      assert.equal(result.reason, 'wrangler.jsonc sets pages_build_output_dir');
      assert.equal(result.staticDir, 'site');
      assert.match(result.registration, /no origin restriction/);
    });

    it('forces frontend-only with --frontend-only and explains the skipped Worker steps', () => {
      const root = repo();
      assert.throws(() => preview(root, '--frontend-only'), /Missing --static-dir/);
      const result = preview(root, '--frontend-only', '--static-dir', 'static');
      assertFrontendOnly(result, 'static/dataflare.js');
      assert.equal(result.reason, '--frontend-only');
      const text = cli(
        root,
        '--host',
        HOST,
        '--project',
        'my-app',
        '--frontend-only',
        '--static-dir',
        '.',
        '--dry-run',
      );
      assert.match(text, /^Pages\/static site: browser snippet only \(--frontend-only\)/);
      assert.match(text, /Root layout <head>: <script defer src="\/dataflare.js"/);
      assert.equal(existsSync(join(root, '.glass')), false);
      assert.equal(existsSync(join(root, 'dataflare.js')), false);
    });

    it('rejects a service binding and static dirs outside the repo', async () => {
      const root = repo();
      const options = { host: HOST, project: 'my-app', frontendOnly: true, dryRun: true };
      await assert.rejects(
        clientInit({ ...options, service: 'analytics', staticDir: 'public' }, { root }),
        /--service needs an app Worker/,
      );
      await assert.rejects(
        clientInit({ ...options, staticDir: '../elsewhere' }, { root }),
        /outside the repository/,
      );
      await assert.rejects(
        clientInit({ ...options, staticDir: 'public', origins: 'ftp://x' }, { root }),
        /Invalid origin/,
      );
    });

    it('installs a Jekyll site at its root, registers origins idempotently and keeps edited loaders', async () => {
      const root = repo();
      rmSync(join(root, 'package.json'));
      writeFileSync(join(root, '_config.yml'), 'title: Blog\nurl: https://blog.example\n');
      writeFileSync(join(root, '_config.my-app.yml'), 'url: "https://my-app.example" # site\n');
      const worker = testApp();
      const options = { host: HOST, project: 'my-app' };
      await clientInit({ ...options, dryRun: true }, { root, fetcher: offline });
      assert.equal(existsSync(join(root, '.glass')), false);
      assert.equal(existsSync(join(root, 'dataflare.js')), false);

      await clientInit(options, { root, fetcher: api(worker) });
      const loader = readFileSync(join(root, 'dataflare.js'), 'utf8');
      assert.equal(loader, journeyLoader(HOST, 'my-app'));
      assert.deepEqual(JSON.parse(readFileSync(join(root, '.glass/client.json'), 'utf8')), {
        host: HOST,
        project: 'my-app',
        frontendOnly: true,
        staticDir: '.',
      });
      for (const file of WORKER_FILES) assert.equal(existsSync(join(root, file)), false);
      const origins = async () =>
        (
          await worker.json<{ projects: { id: string; allowedOrigins: string[] }[] }>(
            'GET',
            '/api/projects',
          )
        ).projects.find((p) => p.id === 'my-app')?.allowedOrigins;
      assert.deepEqual(await origins(), ['https://my-app.example']);

      // Rerun: same files, same project; an edited loader is kept, a new origin is added.
      writeFileSync(join(root, 'dataflare.js'), `${loader}\n// local edit\n`);
      await clientInit(
        { ...options, origins: 'https://my-app.example,https://www.my-app.example' },
        { root, fetcher: api(worker) },
      );
      assert.match(readFileSync(join(root, 'dataflare.js'), 'utf8'), /local edit/);
      assert.deepEqual(await origins(), ['https://my-app.example', 'https://www.my-app.example']);
      await clientInit(options, { root, fetcher: api(worker) });
      assert.deepEqual(await origins(), ['https://my-app.example', 'https://www.my-app.example']);

      // An unrestricted existing project stays unrestricted.
      await worker.json('POST', '/api/projects', { body: { id: 'my-app' } });
      await clientInit(options, { root, fetcher: api(worker) });
      assert.deepEqual(await origins(), []);

      await assert.rejects(
        clientInit({ ...options, frontendOnly: false, service: 'analytics' }, { root }),
        /--service needs an app Worker/,
      );
    });

    it('fills in the journey loader project and deployment URL only', () => {
      const loader = journeyLoader('https://analytics.example', 'site');
      assert.match(loader, /project: 'site',/);
      assert.match(loader, /const HOST = 'https:\/\/analytics.example';/);
      assert.ok(!loader.includes('__PROJECT__'));
    });

    it('keeps Worker repos and plain package repos in app mode', () => {
      const root = repo();
      writeFileSync(
        join(root, 'wrangler.toml'),
        'name = "my-app"\nmain = "src/index.ts"\ncompatibility_date = "2026-11-01"\n',
      );
      writeFileSync(join(root, 'index.html'), '<!doctype html>');
      const result = preview(root, '--service', 'analytics');
      assert.equal(result.mode, 'app');
      assert.ok(result.files['.glass/client/worker.ts']);
      assert.equal(preview(repo()).mode, 'app');
    });
  });
});
