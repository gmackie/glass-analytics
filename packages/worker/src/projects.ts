/**
 * Projects: one Dataflare install can serve several sites or apps.
 */

import { type ProjectSettings, parseSettings } from '@dataflare/core/settings';
import type { D1Database } from './env.ts';
import { HttpError } from './http.ts';

export interface Project {
  id: string;
  name: string;
  allowedOrigins: string[];
  createdAt: number;
  settings: ProjectSettings;
}

interface ProjectRow {
  id: string;
  name: string;
  allowed_origins: string | null;
  created_at: number;
  settings?: string | null;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  allowedOrigins: r.allowed_origins ? (JSON.parse(r.allowed_origins) as string[]) : [],
  createdAt: r.created_at,
  settings: parseSettings(r.settings),
});

// Projects are read on every ingest request; cache them per isolate briefly.
const cache = new Map<string, { project: Project | null; until: number }>();
const TTL_MS = 30_000;

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.project;
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  const project = row ? toProject(row) : null;
  cache.set(id, { project, until: Date.now() + TTL_MS });
  return project;
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db
    .prepare('SELECT * FROM projects ORDER BY created_at')
    .all<ProjectRow>();
  return results.map(toProject);
}

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export async function createProject(
  db: D1Database,
  input: { id: string; name?: string; allowedOrigins?: string[] },
): Promise<Project> {
  if (!PROJECT_ID.test(input.id)) {
    throw new HttpError(
      400,
      'Project id must be 1-63 lowercase letters, digits, "-" or "_", starting with a letter or digit',
    );
  }
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO projects (id, name, allowed_origins, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, allowed_origins = excluded.allowed_origins',
    )
    .bind(
      input.id,
      input.name ?? input.id,
      input.allowedOrigins?.length ? JSON.stringify(input.allowedOrigins) : null,
      now,
    )
    .run();
  cache.delete(input.id);
  return (await getProject(db, input.id))!;
}

/** Replace a project's settings (already validated). */
export async function saveSettings(
  db: D1Database,
  id: string,
  settings: ProjectSettings,
): Promise<Project> {
  const res = await db
    .prepare('UPDATE projects SET settings = ? WHERE id = ?')
    .bind(JSON.stringify(settings), id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `Unknown project "${id}"`);
  cache.delete(id);
  return (await getProject(db, id))!;
}

/**
 * Pick the project for an API call: the one requested, or the only one, or
 * a helpful error listing the choices.
 */
export async function resolveProject(db: D1Database, requested?: string | null): Promise<string> {
  if (requested) {
    if (!(await getProject(db, requested)))
      throw new HttpError(404, `Unknown project "${requested}"`);
    return requested;
  }
  const projects = await listProjects(db);
  if (projects.length === 1) return projects[0]!.id;
  if (projects.length === 0)
    throw new HttpError(404, 'No projects yet', 'Create one with `dataflare projects add <id>`.');
  throw new HttpError(
    400,
    `Several projects exist; pass "project": one of ${projects.map((p) => `"${p.id}"`).join(', ')}`,
  );
}

export function clearProjectCache(): void {
  cache.clear();
}
