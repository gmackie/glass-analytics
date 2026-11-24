import type { WireEvent } from '@dataflare/core/events';
import { sha256Hex } from '@dataflare/core/hash';
import type { TimeRange } from '@dataflare/core/time';
import type { D1Database, Env } from './env.ts';

/** Only the project, time and a salted digest of the event ID survive the bot filter. */
export async function recordFilteredPageviews(
  env: Env,
  project: string,
  views: WireEvent[],
  timestamp: (e: WireEvent) => number,
) {
  if (!views.length) return;
  const salt = env.GLASS_SALT_SECRET ?? env.GLASS_ADMIN_KEY;
  const receipts = await Promise.all(
    views.map(async (e) => [
      await sha256Hex(JSON.stringify([salt, 'filtered-pageview', project, e.id])),
      timestamp(e),
    ]),
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO filtered_pageviews (project, event_hash, ts_ms)
     SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)`,
  )
    .bind(project, JSON.stringify(receipts))
    .run();
}

export async function filteredPageviews(db: D1Database, projects: string[], range: TimeRange) {
  const row = await db
    .prepare(
      `SELECT started_ms, (SELECT COUNT(*) FROM filtered_pageviews
      WHERE project IN (SELECT value FROM json_each(?1)) AND ts_ms >= ?2 AND ts_ms < ?3) AS n
     FROM traffic_collection WHERE id = 1`,
    )
    .bind(JSON.stringify(projects), range.from, range.to)
    .first<{ started_ms: number; n: number }>();
  if (!row) throw new Error('Apply the traffic classification migration to the Worker database.');
  return { startedMs: row.started_ms, count: row.n };
}
