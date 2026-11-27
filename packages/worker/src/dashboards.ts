/**
 * Dashboards: saved analyses and text tiles on a 12-column grid. A dashboard's date range and
 * filters apply to every insight tile unless the tile ignores them. Tiles point at saved
 * analyses (the insights table), so editing an analysis updates every dashboard it is on.
 */

import { DASHBOARD_TEMPLATES, type DashboardTemplate } from '@dataflare/core/dashboard-templates';
import { randomToken } from '@dataflare/core/ids';
import type { D1Database, D1PreparedStatement } from './env.ts';
import { HttpError } from './http.ts';

export interface DashboardFilters {
  from?: string;
  to?: string;
  filters?: Record<string, unknown>[];
  filterTestAccounts?: boolean;
}

export interface Tile {
  id: string;
  kind: 'insight' | 'text';
  insightKey: string | null;
  text: string | null;
  width: number;
  height: number;
  position: number;
  ignoreFilters: boolean;
  overrides: Record<string, unknown>;
  /** The saved analysis an insight tile shows (null when it was deleted). */
  insight?: { key: string; name: string; kind: string; spec: Record<string, unknown> } | null;
}

export interface Dashboard {
  id: string;
  name: string;
  description: string;
  filters: DashboardFilters;
  tiles: Tile[];
  createdAt: number;
  updatedAt: number;
}

interface DashboardRow {
  id: string;
  name: string;
  description: string;
  filters: string;
  created_at: number;
  updated_at: number;
}

interface TileRow {
  id: string;
  kind: string;
  insight_key: string | null;
  text: string | null;
  width: number;
  height: number;
  position: number;
  ignore_filters: number;
  overrides: string;
  i_key: string | null;
  i_name: string | null;
  i_kind: string | null;
  i_spec: string | null;
}

const WIDTHS = [3, 4, 6, 12] as const;
const MAX_TILES = 40;

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const newId = (prefix: string) =>
  `${prefix}${randomToken(6)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 8)}`;

function toTile(r: TileRow): Tile {
  return {
    id: r.id,
    kind: r.kind === 'text' ? 'text' : 'insight',
    insightKey: r.insight_key,
    text: r.text,
    width: r.width,
    height: r.height,
    position: r.position,
    ignoreFilters: r.ignore_filters === 1,
    overrides: parse(r.overrides, {}),
    ...(r.kind === 'insight'
      ? {
          insight: r.i_key
            ? {
                key: r.i_key,
                name: r.i_name ?? r.i_key,
                kind: r.i_kind ?? 'trends',
                spec: parse(r.i_spec, {}),
              }
            : null,
        }
      : {}),
  };
}

/** Install each editable starter once, atomically with its analyses and tiles. */
export async function ensureStarterDashboards(db: D1Database, project: string): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT 'website' AS template FROM dashboard_setup WHERE project = ?1
       UNION ALL SELECT template FROM dashboard_template_setup WHERE project = ?1`,
    )
    .bind(project)
    .all<{ template: string }>();
  const installed = new Set(results.map((r) => r.template));
  for (const template of DASHBOARD_TEMPLATES) {
    if (template.starter && !installed.has(template.id))
      await installStarter(db, project, template);
  }
}

async function installStarter(
  db: D1Database,
  project: string,
  template: DashboardTemplate,
): Promise<void> {
  const id = newId('d');
  const now = Date.now();
  // Keep Website overview on the marker used by earlier Worker revisions.
  const website = template.id === 'website';
  const marker = website ? [project] : [project, template.id];
  const claim = website
    ? 'INSERT INTO dashboard_setup (project) VALUES (?)'
    : 'INSERT INTO dashboard_template_setup (project, template) VALUES (?, ?)';
  const statements = [
    db.prepare(claim).bind(...marker),
    db
      .prepare(
        'INSERT INTO dashboards (project, id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(project, id, template.name, template.description, now, now),
  ];
  for (const [position, tile] of template.tiles({}).entries()) {
    const key = tile.insight ? `${id}-${position}` : null;
    if (tile.insight) {
      statements.push(
        db
          .prepare(
            'INSERT INTO insights (project, key, name, kind, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            project,
            key,
            tile.insight.name,
            tile.insight.kind,
            JSON.stringify(tile.insight.spec),
            now,
            now,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO dashboard_tiles (project, dashboard, id, kind, insight_key, text, width, height, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          project,
          id,
          newId('t'),
          key ? 'insight' : 'text',
          key,
          tile.text ?? null,
          tile.width,
          tile.height,
          position,
        ),
    );
  }
  try {
    await db.batch(statements);
  } catch (err) {
    // Two first visits can race. A committed marker guarantees the entire other batch succeeded.
    const completed = db
      .prepare(
        website
          ? 'SELECT 1 FROM dashboard_setup WHERE project = ?'
          : 'SELECT 1 FROM dashboard_template_setup WHERE project = ? AND template = ?',
      )
      .bind(...marker);
    if (!(await completed.first())) throw err;
  }
}

export async function listDashboards(db: D1Database, project: string) {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.name, d.description, d.updated_at, COUNT(t.id) AS tiles
       FROM dashboards d LEFT JOIN dashboard_tiles t ON t.project = d.project AND t.dashboard = d.id
       WHERE d.project = ? GROUP BY d.id, d.name, d.description, d.updated_at ORDER BY d.name COLLATE NOCASE`,
    )
    .bind(project)
    .all<{ id: string; name: string; description: string; updated_at: number; tiles: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    tiles: Number(r.tiles),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function getDashboard(
  db: D1Database,
  project: string,
  id: string,
): Promise<Dashboard> {
  const d = await db
    .prepare(
      'SELECT id, name, description, filters, created_at, updated_at FROM dashboards WHERE project = ? AND id = ?',
    )
    .bind(project, id)
    .first<DashboardRow>();
  if (!d) throw new HttpError(404, `No dashboard "${id}"`, 'List them with list_dashboards.');
  const { results } = await db
    .prepare(
      `SELECT t.id, t.kind, t.insight_key, t.text, t.width, t.height, t.position, t.ignore_filters, t.overrides,
              i.key AS i_key, i.name AS i_name, i.kind AS i_kind, i.spec AS i_spec
       FROM dashboard_tiles t LEFT JOIN insights i ON i.project = t.project AND i.key = t.insight_key
       WHERE t.project = ? AND t.dashboard = ? ORDER BY t.position, t.id`,
    )
    .bind(project, id)
    .all<TileRow>();
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    filters: parse(d.filters, {}),
    tiles: results.map(toTile),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

export async function saveDashboard(
  db: D1Database,
  project: string,
  input: { id?: string; name: string; description?: string; filters?: DashboardFilters },
  now: number,
): Promise<{ id: string; created: boolean }> {
  const existing = input.id
    ? await db
        .prepare('SELECT id FROM dashboards WHERE project = ? AND id = ?')
        .bind(project, input.id)
        .first()
    : null;
  if (input.id && !existing) throw new HttpError(404, `No dashboard "${input.id}"`);
  const id = input.id ?? newId('d');
  const filters = JSON.stringify(input.filters ?? {});
  if (existing)
    await db
      .prepare(
        'UPDATE dashboards SET name = ?, description = ?, filters = ?, updated_at = ? WHERE project = ? AND id = ?',
      )
      .bind(input.name, input.description ?? '', filters, now, project, id)
      .run();
  else
    await db
      .prepare(
        'INSERT INTO dashboards (project, id, name, description, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(project, id, input.name, input.description ?? '', filters, now, now)
      .run();
  return { id, created: !existing };
}

/** A dashboard goes with its tiles and the reports of it (its analyses stay). */
export async function deleteDashboard(db: D1Database, project: string, id: string): Promise<void> {
  const res = await db
    .prepare('DELETE FROM dashboards WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No dashboard "${id}"`);
  await db.batch([
    db.prepare('DELETE FROM dashboard_tiles WHERE project = ? AND dashboard = ?').bind(project, id),
    db
      .prepare(
        "DELETE FROM subscriptions WHERE project = ? AND target = 'dashboard' AND target_id = ?",
      )
      .bind(project, id),
  ]);
}

export interface TileInput {
  kind?: 'insight' | 'text';
  insightKey?: string;
  text?: string;
  width?: number;
  height?: number;
  ignoreFilters?: boolean;
  overrides?: Record<string, unknown>;
}

const width = (w: number | undefined, fallback = 6) =>
  (WIDTHS as readonly number[]).includes(w ?? -1) ? w! : fallback;
const height = (h: number | undefined, fallback = 1) => (h === 1 || h === 2 ? h : fallback);

async function touch(
  db: D1Database,
  project: string,
  dashboard: string,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE dashboards SET updated_at = ? WHERE project = ? AND id = ?')
    .bind(now, project, dashboard)
    .run();
}

export async function addTile(
  db: D1Database,
  project: string,
  dashboard: string,
  input: TileInput,
  now: number,
): Promise<Tile> {
  const d = await getDashboard(db, project, dashboard);
  if (d.tiles.length >= MAX_TILES)
    throw new HttpError(400, `A dashboard holds at most ${MAX_TILES} tiles.`);
  const kind = input.kind ?? (input.insightKey ? 'insight' : 'text');
  if (kind === 'insight') {
    const found = await db
      .prepare('SELECT key FROM insights WHERE project = ? AND key = ?')
      .bind(project, input.insightKey ?? '')
      .first();
    if (!found)
      throw new HttpError(
        404,
        `No saved analysis "${input.insightKey}"`,
        'Save it first with save_insight.',
      );
  } else if (!input.text?.trim()) throw new HttpError(400, 'A text tile needs text.');
  const tile: Tile = {
    id: newId('t'),
    kind,
    insightKey: kind === 'insight' ? input.insightKey! : null,
    text: kind === 'text' ? input.text! : null,
    width: width(input.width, kind === 'text' ? 12 : 6),
    height: height(input.height),
    position: d.tiles.reduce((m, t) => Math.max(m, t.position + 1), 0),
    ignoreFilters: Boolean(input.ignoreFilters),
    overrides: input.overrides ?? {},
  };
  await db
    .prepare(
      'INSERT INTO dashboard_tiles (project, dashboard, id, kind, insight_key, text, width, height, position, ignore_filters, overrides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      project,
      dashboard,
      tile.id,
      tile.kind,
      tile.insightKey,
      tile.text,
      tile.width,
      tile.height,
      tile.position,
      tile.ignoreFilters ? 1 : 0,
      JSON.stringify(tile.overrides),
    )
    .run();
  await touch(db, project, dashboard, now);
  return tile;
}

export async function updateTile(
  db: D1Database,
  project: string,
  dashboard: string,
  id: string,
  patch: TileInput,
  now: number,
): Promise<void> {
  const d = await getDashboard(db, project, dashboard);
  const t = d.tiles.find((x) => x.id === id);
  if (!t) throw new HttpError(404, `No tile "${id}" on this dashboard`);
  await db
    .prepare(
      'UPDATE dashboard_tiles SET text = ?, width = ?, height = ?, ignore_filters = ?, overrides = ? WHERE project = ? AND dashboard = ? AND id = ?',
    )
    .bind(
      t.kind === 'text' ? (patch.text ?? t.text) : null,
      width(patch.width, t.width),
      height(patch.height, t.height),
      (patch.ignoreFilters ?? t.ignoreFilters) ? 1 : 0,
      JSON.stringify(patch.overrides ?? t.overrides),
      project,
      dashboard,
      id,
    )
    .run();
  await touch(db, project, dashboard, now);
}

export async function removeTile(
  db: D1Database,
  project: string,
  dashboard: string,
  id: string,
  now: number,
): Promise<void> {
  const res = await db
    .prepare('DELETE FROM dashboard_tiles WHERE project = ? AND dashboard = ? AND id = ?')
    .bind(project, dashboard, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No tile "${id}" on this dashboard`);
  await touch(db, project, dashboard, now);
}

/** Put tiles in this order (ids not listed keep their place after the listed ones). */
export async function reorderTiles(
  db: D1Database,
  project: string,
  dashboard: string,
  ids: string[],
  now: number,
): Promise<void> {
  const d = await getDashboard(db, project, dashboard);
  const order = [
    ...ids.filter((id) => d.tiles.some((t) => t.id === id)),
    ...d.tiles.map((t) => t.id).filter((id) => !ids.includes(id)),
  ];
  const statements: D1PreparedStatement[] = order.map((id, i) =>
    db
      .prepare(
        'UPDATE dashboard_tiles SET position = ? WHERE project = ? AND dashboard = ? AND id = ?',
      )
      .bind(i, project, dashboard, id),
  );
  if (statements.length) await db.batch(statements);
  await touch(db, project, dashboard, now);
}

export async function duplicateDashboard(
  db: D1Database,
  project: string,
  id: string,
  name: string,
  now: number,
) {
  const d = await getDashboard(db, project, id);
  const copy = await saveDashboard(
    db,
    project,
    { name, description: d.description, filters: d.filters },
    now,
  );
  if (d.tiles.length)
    await db.batch(
      d.tiles.map((t) =>
        db
          .prepare(
            'INSERT INTO dashboard_tiles (project, dashboard, id, kind, insight_key, text, width, height, position, ignore_filters, overrides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            project,
            copy.id,
            newId('t'),
            t.kind,
            t.insightKey,
            t.text,
            t.width,
            t.height,
            t.position,
            t.ignoreFilters ? 1 : 0,
            JSON.stringify(t.overrides),
          ),
      ),
    );
  return copy;
}

/**
 * The spec an insight tile runs: the analysis's own spec, with the dashboard's date range and
 * filters on top unless the tile ignores them.
 */
export function tileSpec(
  spec: Record<string, unknown>,
  filters: DashboardFilters,
  ignore: boolean,
): Record<string, unknown> {
  if (ignore) return spec;
  return {
    ...spec,
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.filters?.length
      ? { filters: [...((spec.filters as unknown[]) ?? []), ...filters.filters] }
      : {}),
    ...(filters.filterTestAccounts ? { filterTestAccounts: true } : {}),
  };
}
