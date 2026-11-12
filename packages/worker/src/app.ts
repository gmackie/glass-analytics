/**
 * The Worker application: routing for every public path.
 *
 *   /e /r /f          ingest events, replay chunks, flag evaluation (public)
 *   /s.js /replay.js  the browser SDK and replay recorder
 *   /app              the dashboard
 *   /api/*            JSON API (API key)
 *   /mcp              MCP server (API key)
 *   /llms.txt         agent instructions for this deployment
 *   /health           status
 *
 * All paths also work under a `/_glass` prefix, so Dataflare can be mounted on
 * your own domain (first-party requests are not blocked by ad blockers).
 */

import { apiRouter } from './api.ts';
import { requireScope } from './auth.ts';
import { runMaintenance } from './cron.ts';
import type { Assets, Env } from './env.ts';
import { handleFlagEvaluation } from './flags.ts';
import { CORS_HEADERS, errorResponse, HttpError, json } from './http.ts';
import { handleIngest } from './ingest.ts';
import { llmsTxt } from './llms.ts';
import { handleMcp } from './mcp/server.ts';
import { handleReplayChunk } from './replays.ts';
import { GlassService } from './service.ts';
import { D1Store } from './stores/d1.ts';
import { LakeStore } from './stores/lake.ts';
import type { EventStore } from './stores/types.ts';
import { actorFromRequest } from './student-mode.ts';

export const MOUNT_PREFIX = '/_glass';

export interface AppOptions {
  assets: Assets;
  /** Override store creation (tests). */
  createStore?: (env: Env) => EventStore;
  now?: () => number;
}

export function createStore(env: Env): EventStore {
  return env.GLASS_STORE === 'lake' ? new LakeStore(env) : new D1Store(env.DB);
}

function withCors(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** The Dataflare mark, a pane with a green fill line. Keep in sync with site/public/favicon.svg. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset=".58" stop-color="#fff"/><stop offset=".58" stop-color="#cfe7df"/><stop offset=".78" stop-color="#cfe7df"/><stop offset=".78" stop-color="#2e7d6b"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="7" fill="url(#g)" stroke="#2e7d6b" stroke-width="2.5"/></svg>',
)}`;

function dashboardHtml(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="glass-base" content="${base}">
<title>Dataflare</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${base}/app/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="${base}/app/app.js"></script>
</body>
</html>`;
}

const DASHBOARD_CSP =
  "default-src 'self'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; frame-src 'self' blob: about:; connect-src 'self'; script-src 'self'";

export function createApp(options: AppOptions) {
  const makeStore = options.createStore ?? createStore;

  async function fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const prefix =
      url.pathname === MOUNT_PREFIX || url.pathname.startsWith(`${MOUNT_PREFIX}/`)
        ? MOUNT_PREFIX
        : '';
    const path = url.pathname.slice(prefix.length) || '/';
    const base =
      (env.GLASS_PUBLIC_URL?.replace(/\/+$/, '') ?? url.origin) +
      (env.GLASS_PUBLIC_URL ? '' : prefix);
    const store = makeStore(env);
    const service = new GlassService(env, store, base);
    const now = options.now?.() ?? Date.now();

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      switch (path) {
        case '/':
          return Response.redirect(`${url.origin}${prefix}/app`, 302);
        case '/health':
          return withCors(json(await service.health()));
        case '/e':
          if (request.method !== 'POST') break;
          await handleIngest(request, env, store, now);
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        case '/r':
          if (request.method !== 'POST') break;
          await handleReplayChunk(request, env, url);
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        case '/f':
          if (request.method !== 'POST') break;
          return withCors(json(await handleFlagEvaluation(request, env)));
        case '/s.js':
          return script(options.assets.sdk, 300);
        case '/replay.js':
          return script(options.assets.replay, 3600);
        case '/llms.txt':
          return new Response(llmsTxt(base, store.kind), {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        case '/app':
        case '/app/':
          return new Response(dashboardHtml(`${prefix}`), {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': DASHBOARD_CSP,
              'Cache-Control': 'no-cache',
            },
          });
        case '/app/app.js':
          return new Response(options.assets.dashboardJs, {
            headers: {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        case '/app/app.css':
          return new Response(options.assets.dashboardCss, {
            headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' },
          });
        case '/mcp': {
          const scope = requireScope(request, env, 'read');
          service.setActor(actorFromRequest(request, scope, 'mcp', 'mcp'));
          return withCors(await handleMcp(request, service, scope));
        }
      }
      if (path === '/api' || path.startsWith('/api/')) {
        const response = await apiRouter(service, env, request).handle(request, url, path);
        if (response) return withCors(response);
      }
      throw new HttpError(404, `Nothing at ${path}`, `See ${base}/api or ${base}/llms.txt`);
    } catch (err) {
      return withCors(errorResponse(err));
    }
  }

  async function scheduled(_controller: unknown, env: Env): Promise<void> {
    const result = await runMaintenance(env, makeStore(env));
    console.log('[glass] maintenance', JSON.stringify(result));
  }

  return { fetch, scheduled };
}

function script(source: string, maxAge: number): Response {
  return new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
