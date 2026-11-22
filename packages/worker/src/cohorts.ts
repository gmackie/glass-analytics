/**
 * Saved cohorts in D1: definitions, static members, and the materialised
 * membership that feature flags look up.
 *
 * Queries read a cohort as SQL (packages/core/src/cohorts.ts). A static
 * cohort's members live in `cohort_members`: the D1 store reads that table in
 * place, and the lake (which can't see D1) gets them inlined, up to
 * STATIC_LAKE_LIMIT people. Dynamic cohorts that flags target are recomputed
 * into `cohort_members` (source "dynamic") hourly, because `/f` must answer in
 * milliseconds and can't run an analytical query per request.
 */

import {
  type CohortContext,
  type CohortDefinition,
  cohortReferences,
  compileCohort,
  normaliseCohort,
} from '@dataflare/core/cohorts';
import { COHORT_PROPERTY } from '@dataflare/core/filters';
import type { FlagDefinition } from '@dataflare/core/flags';
import type { D1Database, Env } from './env.ts';
import { HttpError } from './http.ts';
import type { EventStore } from './stores/types.ts';

/** Static cohorts the lake can read inline. */
const STATIC_LAKE_LIMIT = 10_000;
/** Dynamic cohorts recomputed per maintenance tick, and how stale they may get. */
const REFRESH_PER_TICK = 5;
const REFRESH_AFTER_MS = 60 * 60_000;

export interface CohortRow {
  key: string;
  name: string;
  description: string;
  kind: 'dynamic' | 'static';
  definition: CohortDefinition;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number | null;
}

interface Raw {
  key: string;
  name: string;
  description: string | null;
  kind: string | null;
  definition: string;
  created_at: number;
  updated_at: number;
  refreshed_at: number | null;
}

const toRow = (r: Raw): CohortRow => {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(r.definition || '{}');
  } catch {
    parsed = {};
  }
  const kind = r.kind === 'static' ? 'static' : 'dynamic';
  return {
    key: r.key,
    name: r.name,
    description: r.description ?? '',
    kind,
    definition:
      kind === 'static'
        ? { match: 'all', groups: [{ conditions: [{ type: 'performed', event: '*' }] }] }
        : normaliseCohort(parsed),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    refreshedAt: r.refreshed_at,
  };
};

export async function loadCohorts(
  db: D1Database,
  project: string,
): Promise<Map<string, CohortRow>> {
  const { results } = await db
    .prepare(
      'SELECT key, name, description, kind, definition, created_at, updated_at, refreshed_at FROM cohorts WHERE project = ? ORDER BY name COLLATE NOCASE',
    )
    .bind(project)
    .all<Raw>();
  return new Map(results.map((r) => [r.key, toRow(r)]));
}

/** Every cohort key reachable from `keys` through cohort conditions. */
function reachable(cohorts: Map<string, CohortRow>, keys: string[]): Set<string> {
  const out = new Set<string>();
  const visit = (k: string) => {
    if (out.has(k)) return;
    out.add(k);
    const c = cohorts.get(k);
    if (c && c.kind === 'dynamic') for (const ref of cohortReferences(c.definition)) visit(ref);
  };
  keys.forEach(visit);
  return out;
}

/**
 * What core needs to compile cohorts for one store: definitions by key, and static members
 * (a D1 table read, or inlined ids for the lake, loaded up front for the cohorts `keys` reach).
 */
export async function cohortContext(
  env: Env,
  store: EventStore,
  project: string,
  cohorts: Map<string, CohortRow>,
  keys: string[],
  now = Date.now(),
): Promise<CohortContext> {
  const d = store.dialect;
  const inline = new Map<string, string[]>();
  if (store.kind !== 'd1') {
    for (const key of reachable(cohorts, keys)) {
      if (cohorts.get(key)?.kind !== 'static') continue;
      const { results } = await env.DB.prepare(
        `SELECT person_id FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static' LIMIT ${STATIC_LAKE_LIMIT + 1}`,
      )
        .bind(project, key)
        .all<{ person_id: string }>();
      if (results.length > STATIC_LAKE_LIMIT) {
        throw new HttpError(
          400,
          `Static cohort "${key}" has more than ${STATIC_LAKE_LIMIT.toLocaleString('en-US')} people, which the lake store can't read inline`,
          'Use a dynamic cohort (conditions) for groups this large in lake mode.',
        );
      }
      inline.set(
        key,
        results.map((r) => r.person_id),
      );
    }
  }
  return {
    dialect: d,
    project,
    now,
    lookup: (key) => {
      const c = cohorts.get(key);
      if (!c) return undefined;
      return c.kind === 'static' ? 'static' : c.definition;
    },
    staticMembers: (key) => {
      if (store.kind === 'd1') {
        return `SELECT person_id AS pid FROM cohort_members WHERE project = ${d.str(project)} AND cohort = ${d.str(key)} AND source = 'static'`;
      }
      const ids = inline.get(key) ?? [];
      if (ids.length === 0) return `SELECT pid FROM (SELECT '' AS pid) none WHERE 1 = 0`;
      return `SELECT column1 AS pid FROM (VALUES ${ids.map((id) => `(${d.str(id)})`).join(', ')}) v`;
    },
  };
}

/** Membership SQL (selecting `pid`) for a saved cohort. */
export function membershipSql(row: CohortRow, ctx: CohortContext): string {
  return row.kind === 'static'
    ? ctx.staticMembers(row.key)
    : compileCohort(row.definition, ctx, [row.key]);
}

/** Cohort keys any flag's targeting refers to. */
/** The cohort keys a condition names (`cohort` is one key or a list). */
function cohortKeysOf(c: { property: string; value?: unknown }): string[] {
  if (c.property !== COHORT_PROPERTY) return [];
  const values = Array.isArray(c.value) ? c.value : [c.value];
  return values.filter((v) => v !== undefined && v !== null).map(String);
}

export function cohortsUsedByFlags(flags: FlagDefinition[]): Set<string> {
  const conditions = flags.flatMap((f) => (f.rules ?? []).flatMap((rule) => rule.conditions ?? []));
  return new Set(conditions.flatMap(cohortKeysOf));
}

/** Recompute one dynamic cohort's members into cohort_members. Returns the member count. */
export async function materialise(
  env: Env,
  store: EventStore,
  project: string,
  row: CohortRow,
  cohorts: Map<string, CohortRow>,
  now = Date.now(),
): Promise<number> {
  const ctx = await cohortContext(env, store, project, cohorts, [row.key], now);
  const sql = membershipSql(row, ctx);
  const db = env.DB;
  let count: number;
  if (store.kind === 'd1') {
    // Events live in the same database: one statement replaces the membership.
    await db.batch([
      db
        .prepare(
          "DELETE FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'dynamic'",
        )
        .bind(project, row.key),
      db
        .prepare(
          `INSERT OR IGNORE INTO cohort_members (project, cohort, person_id, source, added_at)
           SELECT ?, ?, m.pid, 'dynamic', ? FROM (${sql}) m`,
        )
        .bind(project, row.key, now),
    ]);
    const c = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'dynamic'",
      )
      .bind(project, row.key)
      .first<{ n: number }>();
    count = Number(c?.n ?? 0);
  } else {
    const ids = (await store.query(sql)).map((r) => String(r.pid));
    const statements = [
      db
        .prepare(
          "DELETE FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'dynamic'",
        )
        .bind(project, row.key),
    ];
    // ~2,000 ids per statement stays well under D1's 100 KB statement limit.
    for (let i = 0; i < ids.length; i += 2000) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO cohort_members (project, cohort, person_id, source, added_at)
             SELECT ?1, ?2, value, 'dynamic', ?3 FROM json_each(?4)`,
          )
          .bind(project, row.key, now, JSON.stringify(ids.slice(i, i + 2000))),
      );
    }
    await db.batch(statements);
    count = ids.length;
  }
  await db
    .prepare('UPDATE cohorts SET refreshed_at = ? WHERE project = ? AND key = ?')
    .bind(now, project, row.key)
    .run();
  return count;
}

/** Maintenance: refresh the stalest dynamic cohorts that flags target, a few per tick. */
export async function refreshFlagCohorts(
  env: Env,
  store: EventStore,
  now: number,
  listFlagsFor: (project: string) => Promise<FlagDefinition[]>,
  projects: string[],
): Promise<number> {
  let refreshed = 0;
  for (const project of projects) {
    if (refreshed >= REFRESH_PER_TICK) break;
    const used = cohortsUsedByFlags(await listFlagsFor(project));
    if (used.size === 0) continue;
    const cohorts = await loadCohorts(env.DB, project);
    const stale = [...used]
      .map((k) => cohorts.get(k))
      .filter((c): c is CohortRow => !!c && c.kind === 'dynamic')
      .filter((c) => !c.refreshedAt || now - c.refreshedAt >= REFRESH_AFTER_MS)
      .sort((a, b) => (a.refreshedAt ?? 0) - (b.refreshedAt ?? 0));
    for (const row of stale.slice(0, REFRESH_PER_TICK - refreshed)) {
      await materialise(env, store, project, row, cohorts, now);
      refreshed++;
    }
  }
  return refreshed;
}

/** The saved cohorts a person belongs to, for flag evaluation (static and materialised). */
export async function cohortsOf(
  db: D1Database,
  project: string,
  personIds: string[],
): Promise<string[]> {
  if (personIds.length === 0) return [];
  const { results } = await db
    .prepare(
      'SELECT DISTINCT cohort FROM cohort_members WHERE project = ?1 AND person_id IN (SELECT value FROM json_each(?2))',
    )
    .bind(project, JSON.stringify(personIds))
    .all<{ cohort: string }>();
  return results.map((r) => r.cohort);
}
