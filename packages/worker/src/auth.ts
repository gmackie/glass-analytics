/**
 * API keys.
 *
 * Three keys:
 * - GLASS_ADMIN_KEY (Worker secret): everything (queries and changes to flags, experiments, projects).
 * - GLASS_READ_KEY (Worker secret): queries only — safe to give to a read-only agent or teammate.
 * - The server key: for your backends. It imports history (`POST /api/import`), fetches flag
 *   definitions for local evaluation and uploads source maps, and nothing else. It is
 *   GLASS_SERVER_KEY when set, otherwise derived from the admin key (`dataflare key --server`).
 *
 * Ingest endpoints (/e, /r, /f) are public by design: browsers call them.
 */

import { deriveServerKey, timingSafeEqual } from '@dataflare/core/hash';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export type Scope = 'read' | 'admin' | 'server';

const derived = new Map<string, string>();

/** The server key for this deployment (explicit, or derived from the admin key). */
async function serverKey(env: Env): Promise<string | null> {
  if (env.GLASS_SERVER_KEY) return env.GLASS_SERVER_KEY;
  if (!env.GLASS_ADMIN_KEY) return null;
  let key = derived.get(env.GLASS_ADMIN_KEY);
  if (!key) {
    key = await deriveServerKey(env.GLASS_ADMIN_KEY);
    derived.set(env.GLASS_ADMIN_KEY, key);
  }
  return key;
}

function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

export async function authenticate(request: Request, env: Env): Promise<Scope | null> {
  const token = bearer(request);
  if (!token) return null;
  if (env.GLASS_ADMIN_KEY && timingSafeEqual(token, env.GLASS_ADMIN_KEY)) return 'admin';
  if (env.GLASS_READ_KEY && timingSafeEqual(token, env.GLASS_READ_KEY)) return 'read';
  const server = token.startsWith('srv_') || env.GLASS_SERVER_KEY ? await serverKey(env) : null;
  if (server && timingSafeEqual(token, server)) return 'server';
  return null;
}

/** Whether a key's scope covers what an action needs: admin covers everything, the others only themselves. */
function covers(scope: Scope, needed: Scope): boolean {
  return scope === 'admin' || scope === needed;
}

export async function requireScope(request: Request, env: Env, needed: Scope): Promise<Scope> {
  if (!env.GLASS_ADMIN_KEY) {
    throw new HttpError(
      503,
      'GLASS_ADMIN_KEY is not set on this Worker',
      'Run `dataflare upgrade` or set it with `wrangler secret put GLASS_ADMIN_KEY`.',
    );
  }
  const scope = await authenticate(request, env);
  if (!scope) {
    throw new HttpError(
      401,
      'Missing or invalid API key',
      'Send "Authorization: Bearer <key>". Keys are in .glass/credentials.json; run `dataflare key`.',
    );
  }
  if (!covers(scope, needed)) {
    if (needed === 'admin') throw new HttpError(403, 'This action needs the admin key');
    if (scope === 'server') {
      throw new HttpError(
        403,
        'The server key only imports events, reads flag definitions and uploads source maps',
        'Use the read key (`dataflare key --read`) to query, or the admin key to change things.',
      );
    }
    throw new HttpError(
      403,
      'This action needs the server or admin key',
      'Run `dataflare key --server`.',
    );
  }
  return scope;
}
