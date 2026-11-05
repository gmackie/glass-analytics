import { requireStandardCapture } from './capture-policy.ts';
/**
 * Feature flag storage and the public evaluation endpoint (`POST /f`).
 *
 * Flags are evaluated on the server so targeting rules (which may mention
 * person properties) are never shipped to browsers.
 */

import type { EvaluationContext } from '@dataflare/core/filters';
import { evaluateFlags, type FlagDefinition, validateFlag } from '@dataflare/core/flags';
import { parseUserAgent } from '@dataflare/core/ua';
import type { D1Database, Env } from './env.ts';
import { HttpError, readJson } from './http.ts';
import { requestInfo } from './ingest.ts';
import { getProject } from './projects.ts';

const cache = new Map<string, { flags: FlagDefinition[]; until: number }>();
const TTL_MS = 10_000;

export async function listFlags(
  db: D1Database,
  project: string,
  fresh = false,
): Promise<FlagDefinition[]> {
  const hit = cache.get(project);
  if (!fresh && hit && hit.until > Date.now()) return hit.flags;
  const { results } = await db
    .prepare('SELECT definition FROM flags WHERE project = ? ORDER BY key')
    .bind(project)
    .all<{ definition: string }>();
  const flags = results.map((r) => JSON.parse(r.definition) as FlagDefinition);
  cache.set(project, { flags, until: Date.now() + TTL_MS });
  return flags;
}

export async function getFlag(
  db: D1Database,
  project: string,
  key: string,
): Promise<FlagDefinition | null> {
  const row = await db
    .prepare('SELECT definition FROM flags WHERE project = ? AND key = ?')
    .bind(project, key)
    .first<{ definition: string }>();
  return row ? (JSON.parse(row.definition) as FlagDefinition) : null;
}

/** Create or replace a flag. Returns the stored definition and what changed. */
export async function saveFlag(
  db: D1Database,
  project: string,
  input: Partial<FlagDefinition> & { key: string },
) {
  const existing = await getFlag(db, project, input.key);
  const flag: FlagDefinition = {
    key: input.key,
    description: input.description ?? existing?.description,
    enabled: input.enabled ?? existing?.enabled ?? true,
    rollout: input.rollout ?? existing?.rollout ?? 100,
    variants: input.variants ?? existing?.variants,
    rules: input.rules ?? existing?.rules,
    salt: input.salt ?? existing?.salt,
  };
  const problems = validateFlag(flag);
  if (problems.length) throw new HttpError(400, `Invalid flag: ${problems.join('; ')}`);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO flags (project, key, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project, key) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
    )
    .bind(project, flag.key, JSON.stringify(flag), now, now)
    .run();
  cache.delete(project);
  const changed = Object.keys(flag).filter(
    (k) =>
      JSON.stringify((flag as unknown as Record<string, unknown>)[k]) !==
      JSON.stringify((existing as unknown as Record<string, unknown> | null)?.[k]),
  );
  return { flag, created: !existing, changed };
}

export async function deleteFlag(db: D1Database, project: string, key: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM flags WHERE project = ? AND key = ?')
    .bind(project, key)
    .run();
  cache.delete(project);
  return (res.meta.changes ?? 0) > 0;
}

/** Build the evaluation context for a user from D1 and the request. */
export async function flagContext(
  db: D1Database,
  project: string,
  distinctId: string,
  userId: string | null,
  request?: Request,
): Promise<EvaluationContext> {
  let personId = userId;
  if (!personId) {
    const link = await db
      .prepare('SELECT person_id FROM identities WHERE project = ? AND distinct_id = ?')
      .bind(project, distinctId)
      .first<{ person_id: string }>();
    personId = link?.person_id ?? null;
  }
  const row = personId
    ? await db
        .prepare('SELECT props FROM persons WHERE project = ? AND person_id = ?')
        .bind(project, personId)
        .first<{ props: string }>()
    : null;
  const info = request ? requestInfo(request) : null;
  const ua = info ? parseUserAgent(info.userAgent) : null;
  return {
    distinct_id: distinctId,
    user_id: userId,
    person: row ? (JSON.parse(row.props) as Record<string, unknown>) : {},
    country: info?.country ?? '',
    device: ua?.device ?? '',
    browser: ua?.browser ?? '',
    os: ua?.os ?? '',
  };
}

/** `POST /f` — { project, distinct_id, user_id } → { flags }. Public, like ingest. */
export async function handleFlagEvaluation(
  request: Request,
  env: Env,
): Promise<{ flags: Record<string, string> }> {
  const body = await readJson<{
    project?: string;
    distinct_id?: string | null;
    user_id?: string | null;
  }>(request, 10_000);
  if (!body.project || !(await getProject(env.DB, body.project)))
    throw new HttpError(404, 'Unknown project');
  await requireStandardCapture(env, body.project);
  // Cookieless visitors have no stable id, so they can't be bucketed consistently.
  if (!body.distinct_id) return { flags: {} };
  const flags = await listFlags(env.DB, body.project);
  if (flags.length === 0) return { flags: {} };
  const ctx = await flagContext(
    env.DB,
    body.project,
    String(body.distinct_id),
    body.user_id ? String(body.user_id) : null,
    request,
  );
  return { flags: evaluateFlags(flags, ctx) };
}
