/**
 * Hourly housekeeping (Cron Trigger): data retention for events and replays,
 * and summaries of sessions that have finished (for replay search and
 * analysis; see `GlassService.summariseSettled`).
 */

import { DAY_MS } from '@dataflare/core/time';
import type { Env } from './env.ts';
import { resumeErasures } from './erasure.ts';
import { listProjects } from './projects.ts';
import {
  deleteReplays,
  moveLegacyReplays,
  REPLAY_DELETE_SLICE,
  sessionsToSummarise,
} from './replays.ts';
import { GlassService } from './service.ts';
import type { EventStore } from './stores/types.ts';

/** Sessions summarised per run: each reads all its chunks, and a run has a subrequest budget. */
const SUMMARIES_PER_RUN = 10;
/** Replay slices retention may delete per run, across all projects (see `REPLAY_DELETE_SLICE`). */
const RETENTION_SLICES_PER_RUN = 4;
/** Objects moved per run out of a pre-0.8.1 EU deployment's legacy replay bucket. */
const LEGACY_MOVES_PER_RUN = 50;
const SETTLED_MS = 30 * 60_000;

export async function runMaintenance(
  env: Env,
  store: EventStore,
  now = Date.now(),
): Promise<{
  events: number;
  replays: number;
  summarised: number;
  erased: number;
  legacyMoved: number;
}> {
  let events = 0;
  let replays = 0;
  // Erasures someone asked for come before routine retention.
  const erasures = await resumeErasures(env);
  replays += erasures.replays;
  const eventDays = Number(env.GLASS_RETENTION_DAYS);
  if (store.kind === 'd1' && eventDays > 0) {
    const cutoff = now - eventDays * DAY_MS;
    // Delete in slices so a big backlog never exceeds a single invocation's limits.
    for (let i = 0; i < 20; i++) {
      const res = await env.DB.prepare(
        'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE ts_ms < ? LIMIT 5000)',
      )
        .bind(cutoff)
        .run();
      const changes = res.meta.changes ?? 0;
      events += changes;
      if (changes < 5000) break;
    }
  }
  const replayDays = Number(env.GLASS_REPLAY_RETENTION_DAYS ?? 30);
  if (replayDays > 0) {
    const cutoff = now - replayDays * DAY_MS;
    let slices = RETENTION_SLICES_PER_RUN;
    for (const project of await listProjects(env.DB)) {
      while (slices > 0) {
        slices--;
        const n = await deleteReplays(env, project.id, 'started_at < ?', [cutoff]);
        replays += n;
        if (n < REPLAY_DELETE_SLICE) break;
      }
      if (slices === 0) break;
    }
  }
  let summarised = 0;
  if (env.REPLAYS) {
    const service = new GlassService(env, store, env.GLASS_PUBLIC_URL?.replace(/\/+$/, '') ?? '');
    summarised = await service.summariseSettled(
      await sessionsToSummarise(env.DB, now - SETTLED_MS, SUMMARIES_PER_RUN),
    );
  }
  const legacy = await moveLegacyReplays(env, LEGACY_MOVES_PER_RUN);
  return {
    events,
    replays,
    summarised,
    erased: erasures.completed,
    legacyMoved: legacy.moved,
  };
}
