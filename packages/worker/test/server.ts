/**
 * Local development server: the real Worker code on Node, with D1 as a SQLite
 * file and R2 as a folder, plus the demo site on a second port.
 *
 *   pnpm dev            → Dataflare on http://localhost:8787, demo site on http://localhost:8788
 *
 * Nothing here talks to Cloudflare. For workerd fidelity use `pnpm dev:wrangler`.
 * The e2e tests start this server with in-memory storage.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import type { Assets, Env, WorkerAccess } from '../src/env.ts';
import { createProject } from '../src/projects.ts';
import { DirectoryR2, MemoryR2, SqliteD1 } from './harness.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

function loadAssets(): Assets {
  const read = (path: string) => {
    try {
      return readFileSync(join(repo, path), 'utf8');
    } catch {
      throw new Error(`Missing ${path}. Run \`pnpm build\` first.`);
    }
  };
  return {
    sdk: read('packages/web/dist/glass.js'),
    replay: read('packages/web/dist/replay.js'),
    dashboardJs: read('packages/dashboard/dist/app.js'),
    dashboardCss: read('packages/dashboard/dist/app.css'),
  };
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!headers.has('CF-Connecting-IP'))
    headers.set('CF-Connecting-IP', req.socket.remoteAddress ?? '127.0.0.1');
  if (!headers.has('CF-IPCountry')) headers.set('CF-IPCountry', process.env.DEV_COUNTRY ?? 'GB');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error Node needs duplex for streaming request bodies
    duplex: 'half',
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

export interface DevServer {
  glassUrl: string;
  demoUrl: string;
  env: Env;
  close(): Promise<void>;
}

export async function startDevServer(
  options: {
    port?: number;
    demoPort?: number;
    memory?: boolean;
    dataDir?: string;
    /** The SDK and dashboard bundles to serve; the built ones by default. Tests that only call the API pass `TEST_ASSETS`, so they run before `pnpm build` (as CI does). */
    assets?: Assets;
    /** Simulate the runtime's Access context for a dashboard browser test. */
    access?: () => WorkerAccess | undefined;
  } = {},
): Promise<DevServer> {
  const dataDir = options.dataDir ?? join(repo, '.glass-dev');
  const env: Env = {
    DB: new SqliteD1(options.memory ? ':memory:' : join(dataDir, 'glass.db')),
    REPLAYS: options.memory ? new MemoryR2() : new DirectoryR2(join(dataDir, 'replays')),
    GLASS_ADMIN_KEY: 'dev-admin-key',
    GLASS_READ_KEY: 'dev-read-key',
    GLASS_SALT_SECRET: 'dev-salt',
  };
  await createProject(env.DB, { id: 'demo', name: 'Demo site' });
  const app = createApp({ assets: options.assets ?? loadAssets() });

  const glass = createServer(async (req, res) => {
    try {
      await send(
        res,
        await app.fetch(await toRequest(req, `http://${req.headers.host}`), env, {
          access: options.access?.(),
        }),
      );
    } catch (err) {
      console.error('[dev server]', err);
      res.statusCode = 500;
      res.end('Internal error (see the dev server log)');
    }
  });
  const glassPort = await listen(glass, options.port ?? 8787);
  const glassUrl = `http://127.0.0.1:${glassPort}`;

  // The demo site, with the Dataflare host filled in.
  const demoDir = join(repo, 'examples', 'demo-site');
  const demo = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '/index.html');
    const file = join(demoDir, path.replace(/\.\./g, ''));
    try {
      const body = readFileSync(file.endsWith('.html') ? file : `${file}.html`, 'utf8').replaceAll(
        '{{GLASS_HOST}}',
        glassUrl,
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  const demoPort = await listen(demo, options.demoPort ?? 8788);

  return {
    glassUrl,
    demoUrl: `http://127.0.0.1:${demoPort}`,
    env,
    close: () =>
      Promise.all([new Promise((r) => glass.close(r)), new Promise((r) => demo.close(r))]).then(
        () => undefined,
      ),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await startDevServer({
    port: Number(process.env.PORT ?? 8787),
    demoPort: Number(process.env.DEMO_PORT ?? 8788),
  });
  console.log(`Dataflare      ${server.glassUrl}/app   (key: dev-admin-key)`);
  console.log(`Demo site  ${server.demoUrl}/`);
  console.log(`MCP        ${server.glassUrl}/mcp`);
  console.log('Data is kept in .glass-dev/ (delete it to start fresh).');
}
