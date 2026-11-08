/**
 * Student mode storage: per-project policies and the audit log of reads.
 * The rules themselves live in `@dataflare/core/student-policy`.
 */

import { isMinors, type StudentPolicy, studentPolicySchema } from '@dataflare/core/student-policy';
import type { Scope } from './auth.ts';
import type { D1Database } from './env.ts';
import { HttpError } from './http.ts';

// Read on every ingest request, like projects; cached per isolate briefly.
const cache = new Map<string, { policy: StudentPolicy | null; until: number }>();
const TTL_MS = 30_000;

/**
 * The project's policy, or null for a project without one. A stored policy that no
 * longer parses fails closed: ingest stops rather than silently collecting everything.
 */
export async function getPolicy(db: D1Database, project: string): Promise<StudentPolicy | null> {
  const hit = cache.get(project);
  if (hit && hit.until > Date.now()) return hit.policy;
  const row = await db
    .prepare('SELECT policy FROM project_policies WHERE project = ?')
    .bind(project)
    .first<{ policy: string }>();
  let policy: StudentPolicy | null = null;
  if (row) {
    const parsed = studentPolicySchema.safeParse(safeJson(row.policy));
    if (!parsed.success)
      throw new HttpError(
        503,
        `The privacy policy of project "${project}" is invalid`,
        'An admin should set it again with `dataflare projects policy <id> --audience minors`.',
      );
    policy = parsed.data;
  }
  cache.set(project, { policy, until: Date.now() + TTL_MS });
  return policy;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function savePolicy(
  db: D1Database,
  project: string,
  policy: StudentPolicy,
  by: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_policies (project, policy, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (project) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(project, JSON.stringify(policy), now, by)
    .run();
  cache.delete(project);
}

/** Every project in student mode, with its policy. */
export async function minorsProjects(
  db: D1Database,
): Promise<{ project: string; policy: StudentPolicy }[]> {
  const { results } = await db
    .prepare('SELECT project, policy FROM project_policies')
    .all<{ project: string; policy: string }>();
  const out: { project: string; policy: StudentPolicy }[] = [];
  for (const row of results) {
    const parsed = studentPolicySchema.safeParse(safeJson(row.policy));
    // A damaged policy is treated as minors, so reads are still audited and retention applies.
    if (!parsed.success)
      out.push({ project: row.project, policy: studentPolicySchema.parse({ audience: 'minors' }) });
    else if (isMinors(parsed.data)) out.push({ project: row.project, policy: parsed.data });
  }
  return out;
}

export function clearPolicyCache(): void {
  cache.clear();
}

// ── Audit ─────────────────────────────────────────────────────────────────

/** Who is making a request, set by the HTTP and MCP surfaces before calling the service. */
export interface AuditActor {
  surface: 'api' | 'mcp' | 'dashboard';
  scope: Scope;
  /** Cloudflare Access email if present, else the key scope. */
  actor: string;
  /** "GET /api/persons/:id", "tool:sql", … */
  operation: string;
  /** SQL text or arguments, truncated. */
  detail?: string;
}

export function actorFromRequest(
  request: Request,
  scope: Scope,
  surface: AuditActor['surface'],
  operation: string,
): AuditActor {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  return { surface, scope, actor: email ? email.slice(0, 200) : `${scope}-key`, operation };
}

export async function recordAudit(
  db: D1Database,
  project: string,
  who: AuditActor,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_log (ts, project, surface, scope, actor, operation, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      now,
      project,
      who.surface,
      who.scope,
      who.actor,
      who.operation.slice(0, 200),
      (who.detail ?? '').slice(0, 2000),
    )
    .run();
}

export interface AuditRow {
  id: number;
  ts: number;
  project: string;
  surface: string;
  scope: string;
  actor: string;
  operation: string;
  detail: string;
}

export async function listAudit(
  db: D1Database,
  project: string,
  from: number,
  limit: number,
): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, ts, project, surface, scope, actor, operation, detail FROM audit_log WHERE project = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .bind(project, from, limit)
    .all<AuditRow>();
  return results;
}
