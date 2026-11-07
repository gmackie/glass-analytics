/**
 * Erasing a person, in steps that can resume.
 *
 * A person's replays can outnumber what one invocation may delete (each session is several R2
 * calls), so erasure is recorded in the `erasures` table and works through replays a slice at a
 * time: the request does a few slices, and the hourly job carries on until none match. Only then
 * do the person and identity rows go, with the erasure record, so "complete" means every
 * replay is gone. Events are deleted up front by the store (or queued, in the lake).
 */

import type { Env } from './env.ts';
import { deleteReplays, REPLAY_DELETE_SLICE } from './replays.ts';

/** Replay slices the erasure request itself works through before leaving the rest to the job. */
export const ERASURE_SLICES_PER_REQUEST = 2;
/** Replay slices the hourly job spends on pending erasures per run, across all of them. */
export const ERASURE_SLICES_PER_RUN = 4;

/** Record that `ids` (a person and their devices) are being erased, so the job can resume. */
export async function startErasure(
  env: Env,
  project: string,
  personId: string,
  ids: string[],
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO erasures (project, person_id, ids, requested_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project, person_id) DO UPDATE SET ids = excluded.ids`,
  )
    .bind(project, personId, JSON.stringify(ids), now)
    .run();
}

/**
 * Delete up to `slices` slices of the person's replays. When none are left, delete the person,
 * their identity links and the erasure record, and report complete.
 */
export async function continueErasure(
  env: Env,
  project: string,
  personId: string,
  ids: string[],
  slices: number,
): Promise<{ replays: number; complete: boolean; slices: number }> {
  // The ids go in as one JSON parameter: D1 binds at most 100, and a person can have any
  // number of devices.
  const json = JSON.stringify(ids);
  let replays = 0;
  for (let used = 1; used <= slices; used++) {
    const n = await deleteReplays(
      env,
      project,
      '(user_id IN (SELECT value FROM json_each(?)) OR distinct_id IN (SELECT value FROM json_each(?)))',
      [json, json],
    );
    replays += n;
    if (n < REPLAY_DELETE_SLICE) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM persons WHERE project = ? AND person_id = ?').bind(
          project,
          personId,
        ),
        env.DB.prepare('DELETE FROM identities WHERE project = ? AND person_id = ?').bind(
          project,
          personId,
        ),
        env.DB.prepare('DELETE FROM erasures WHERE project = ? AND person_id = ?').bind(
          project,
          personId,
        ),
      ]);
      return { replays, complete: true, slices: used };
    }
  }
  return { replays, complete: false, slices };
}

/** The hourly job's share: resume pending erasures, oldest first, within a slice budget. */
export async function resumeErasures(
  env: Env,
  budget = ERASURE_SLICES_PER_RUN,
): Promise<{ replays: number; completed: number }> {
  const { results } = await env.DB.prepare(
    'SELECT project, person_id, ids FROM erasures ORDER BY requested_at LIMIT ?',
  )
    .bind(budget)
    .all<{ project: string; person_id: string; ids: string }>();
  let replays = 0;
  let completed = 0;
  for (const job of results) {
    if (budget <= 0) break;
    const r = await continueErasure(env, job.project, job.person_id, JSON.parse(job.ids), budget);
    budget -= r.slices;
    replays += r.replays;
    if (r.complete) completed++;
  }
  return { replays, completed };
}
