/**
 * Transformations: ordered rules applied to events at ingest, before they are
 * stored or forwarded (packages/core/src/transformations.ts has the rules).
 * Cached briefly per project, since ingest reads them on every batch.
 */

import type { StoredEvent } from '@dataflare/core/events';
import {
  applyTransformations,
  type Transformation,
  transformationSchema,
} from '@dataflare/core/transformations';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export interface TransformationRow {
  id: string;
  position: number;
  enabled: boolean;
  rule: Transformation;
  applied: number;
  createdAt: number;
  updatedAt: number;
}

const cache = new Map<string, { rules: TransformationRow[]; until: number }>();

export function clearTransformationCache(): void {
  cache.clear();
}

export async function listTransformations(
  env: Env,
  project: string,
  fresh = false,
): Promise<TransformationRow[]> {
  const hit = cache.get(project);
  if (!fresh && hit && hit.until > Date.now()) return hit.rules;
  const { results } = await env.DB.prepare(
    'SELECT id, position, enabled, rule, applied, created_at, updated_at FROM transformations WHERE project = ? ORDER BY position, created_at',
  )
    .bind(project)
    .all<{
      id: string;
      position: number;
      enabled: number;
      rule: string;
      applied: number;
      created_at: number;
      updated_at: number;
    }>();
  const rules = results.map((r) => ({
    id: r.id,
    position: r.position,
    enabled: r.enabled === 1,
    rule: transformationSchema.parse(JSON.parse(r.rule)),
    applied: r.applied,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  cache.set(project, { rules, until: Date.now() + 10_000 });
  return rules;
}

export async function saveTransformation(
  env: Env,
  project: string,
  input: { id?: string; rule: Transformation; enabled?: boolean; position?: number },
): Promise<TransformationRow> {
  const rule = transformationSchema.parse(input.rule);
  const existing = input.id
    ? (await listTransformations(env, project, true)).find((t) => t.id === input.id)
    : undefined;
  if (input.id && !existing) throw new HttpError(404, `No transformation "${input.id}"`);
  const now = Date.now();
  const id = existing?.id ?? crypto.randomUUID().slice(0, 12);
  const position =
    input.position ??
    existing?.position ??
    (await listTransformations(env, project, true)).reduce((m, t) => Math.max(m, t.position), 0) +
      10;
  await env.DB.prepare(
    `INSERT INTO transformations (project, id, position, enabled, rule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, id) DO UPDATE SET position = excluded.position, enabled = excluded.enabled, rule = excluded.rule, updated_at = excluded.updated_at`,
  )
    .bind(
      project,
      id,
      position,
      (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      JSON.stringify(rule),
      existing?.createdAt ?? now,
      now,
    )
    .run();
  cache.delete(project);
  return (await listTransformations(env, project, true)).find((t) => t.id === id)!;
}

export async function deleteTransformation(env: Env, project: string, id: string): Promise<void> {
  const res = await env.DB.prepare('DELETE FROM transformations WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No transformation "${id}"`);
  cache.delete(project);
}

/** The secret hashing is keyed with, so hashes can't be reversed by guessing inputs. */
export function hashSalt(env: Env, project: string): string {
  return `${env.GLASS_SALT_SECRET ?? env.GLASS_ADMIN_KEY ?? 'glass'}:${project}:transform`;
}

/** The ingest enricher: apply the project's enabled rules, and count what they did. */
export async function transformRows(
  rows: StoredEvent[],
  env: Env,
  project: string,
): Promise<StoredEvent[]> {
  if (rows.length === 0) return rows;
  const rules = (await listTransformations(env, project)).filter((t) => t.enabled);
  if (rules.length === 0) return rows;
  const result = await applyTransformations(
    rows,
    rules.map((r) => r.rule),
    hashSalt(env, project),
  );
  const touched = rules
    .map((r, i) => [r.id, result.counts[i] ?? 0] as const)
    .filter(([, n]) => n > 0);
  if (touched.length) {
    await env.DB.batch(
      touched.map(([id, n]) =>
        env.DB.prepare(
          'UPDATE transformations SET applied = applied + ? WHERE project = ? AND id = ?',
        ).bind(n, project, id),
      ),
    );
  }
  return result.rows;
}
