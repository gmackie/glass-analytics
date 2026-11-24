/**
 * Scheduled work (one Cron Trigger, every five minutes).
 *
 * Every tick runs the registered `FREQUENT_TASKS` (scheduled flag changes, error alerts,
 * batch exports, delivery retries…). Once an hour it also does housekeeping: data
 * retention for events and replays, erasures, and summaries of sessions that have
 * finished (for replay search and analysis; see `GlassService.summariseSettled`).
 *
 * Deployments from before the five-minute trigger run once an hour ("17 * * * *"); every
 * tick of theirs is an hourly tick.
 */

import { DAY_MS } from '@dataflare/core/time';
import { trimTrailingSlashes } from '@dataflare/core/url';
import { runAlerts } from './alerts.ts';
import { refreshFlagCohorts } from './cohorts.ts';
import type { Env } from './env.ts';
import { resumeErasures } from './erasure.ts';
import { applyDueSchedules, listFlags } from './flags.ts';
import { listProjects } from './projects.ts';
import {
  deleteReplays,
  moveLegacyReplays,
  REPLAY_DELETE_SLICE,
  sessionsToSummarise,
} from './replays.ts';
import { runReports } from './reports.ts';
import { GlassService } from './service.ts';
import type { EventStore } from './stores/types.ts';
import { minorsProjects } from './student-mode.ts';

/** Sessions summarised per run: each reads all its chunks, and a run has a subrequest budget. */
const SUMMARIES_PER_RUN = 10;
/** Replay slices retention may delete per run, across all projects (see `REPLAY_DELETE_SLICE`). */
const RETENTION_SLICES_PER_RUN = 4;
/** Objects moved per run out of a pre-0.8.1 EU deployment's legacy replay bucket. */
const LEGACY_MOVES_PER_RUN = 50;
const SETTLED_MS = 30 * 60_000;

/** The Cron Trigger every deployment gets (see renderWranglerConfig in the CLI). */
export const CRON_SCHEDULE = '*/5 * * * *';

/** Whether this tick should also run the hourly housekeeping. */
export function isHourlyTick(cron: string | undefined, now: number): boolean {
  // Unknown or legacy hourly schedules: every tick is the hourly one.
  if (cron !== CRON_SCHEDULE) return true;
  const minute = new Date(now).getUTCMinutes();
  return minute >= 15 && minute < 20;
}

/** Work that runs on every tick. Later features register here; each returns a count for the log. */
export type FrequentTask = (env: Env, store: EventStore, now: number) => Promise<number>;
export const FREQUENT_TASKS: { name: string; run: FrequentTask }[] = [
  { name: 'flagSchedules', run: async (env, _store, now) => applyDueSchedules(env.DB, now) },
  {
    // Dynamic cohorts that flags target, recomputed when an hour old (a few per tick).
    name: 'flagCohorts',
    run: async (env, store, now) =>
      refreshFlagCohorts(
        env,
        store,
        now,
        (project) => listFlags(env.DB, project),
        (await listProjects(env.DB)).map((p) => p.id),
      ),
  },
  // Scheduled reports: start the due ones, then compute a few tiles and send what's finished.
  {
    name: 'reports',
    run: async (env, store, now) => runReports(serviceFor(env, store).reportRunner(), now),
  },
  // Alerts: up to ten due checks.
  {
    name: 'alerts',
    run: async (env, store, now) => runAlerts(serviceFor(env, store).reportRunner(), now),
  },
];

function serviceFor(env: Env, store: EventStore): GlassService {
  return new GlassService(env, store, trimTrailingSlashes(env.GLASS_PUBLIC_URL ?? ''));
}

export interface MaintenanceResult {
  events: number;
  replays: number;
  summarised: number;
  erased: number;
  legacyMoved: number;
  hourly: boolean;
  tasks: Record<string, number | string>;
}

/** Run each frequent task; one failing must not stop the others (or the hourly housekeeping). */
async function frequentTasks(
  env: Env,
  store: EventStore,
  now: number,
): Promise<Record<string, number | string>> {
  const tasks: Record<string, number | string> = {};
  for (const task of FREQUENT_TASKS) {
    try {
      tasks[task.name] = await task.run(env, store, now);
    } catch (err) {
      tasks[task.name] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return tasks;
}

/** Events past the retention period (D1 only), deleted in slices so a backlog never overruns a run. */
type MinorsPolicies = Awaited<ReturnType<typeof minorsProjects>>;

/** Delete events older than `cutoff` (in one project, when given), in slices within run limits. */
async function deleteEventsBefore(
  env: Env,
  cutoff: number,
  project?: string,
  table: 'events' | 'filtered_pageviews' = 'events',
): Promise<number> {
  const scope = project === undefined ? '' : 'project = ? AND ';
  const binds = project === undefined ? [cutoff] : [project, cutoff];
  let events = 0;
  for (let i = 0; i < 20; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${scope}ts_ms < ? LIMIT 5000)`,
    )
      .bind(...binds)
      .run();
    const changes = res.meta.changes ?? 0;
    events += changes;
    if (changes < 5000) break;
  }
  return events;
}

/** Student-mode projects may keep events and people for less time than the deployment. */
async function expireMinors(env: Env, minors: MinorsPolicies, now: number): Promise<number> {
  let events = 0;
  for (const { project, policy } of minors) {
    if (!policy.retention_days) continue;
    const cutoff = now - policy.retention_days * DAY_MS;
    events += await deleteEventsBefore(env, cutoff, project);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM persons WHERE project = ? AND last_seen < ?').bind(
        project,
        cutoff,
      ),
      env.DB.prepare('DELETE FROM identities WHERE project = ? AND created_at < ?').bind(
        project,
        cutoff,
      ),
    ]);
  }
  return events;
}

async function expireEvents(
  env: Env,
  store: EventStore,
  now: number,
  minors: MinorsPolicies,
): Promise<number> {
  const days = Number(env.GLASS_RETENTION_DAYS);
  if (days > 0) await deleteEventsBefore(env, now - days * DAY_MS, undefined, 'filtered_pageviews');
  for (const { project, policy } of minors) {
    if (policy.retention_days)
      await deleteEventsBefore(
        env,
        now - policy.retention_days * DAY_MS,
        project,
        'filtered_pageviews',
      );
  }
  if (store.kind !== 'd1') return 0;
  const events = days > 0 ? await deleteEventsBefore(env, now - days * DAY_MS) : 0;
  return events + (await expireMinors(env, minors, now));
}

/** Replay retention in days per project: the deployment's, or a student-mode project's if shorter. */
function replayDaysFor(env: Env, minors: MinorsPolicies): (project: string) => number {
  const configured = Number(env.GLASS_REPLAY_RETENTION_DAYS ?? 30);
  const deployment = configured > 0 ? configured : Number.POSITIVE_INFINITY;
  const perProject = new Map(
    minors.flatMap((m) =>
      m.policy.replay_retention_days ? [[m.project, m.policy.replay_retention_days] as const] : [],
    ),
  );
  return (project) => Math.min(deployment, perProject.get(project) ?? Number.POSITIVE_INFINITY);
}

async function expireReplays(env: Env, now: number, minors: MinorsPolicies): Promise<number> {
  const daysFor = replayDaysFor(env, minors);
  let replays = 0;
  let slices = RETENTION_SLICES_PER_RUN;
  for (const project of await listProjects(env.DB)) {
    const days = daysFor(project.id);
    if (!Number.isFinite(days)) continue;
    const cutoff = now - days * DAY_MS;
    for (let n = REPLAY_DELETE_SLICE; slices > 0 && n >= REPLAY_DELETE_SLICE; slices--) {
      n = await deleteReplays(env, project.id, 'started_at < ?', [cutoff]);
      replays += n;
    }
    if (slices === 0) break;
  }
  return replays;
}

async function summarise(env: Env, store: EventStore, now: number): Promise<number> {
  if (!env.REPLAYS) return 0;
  const service = new GlassService(env, store, trimTrailingSlashes(env.GLASS_PUBLIC_URL ?? ''));
  return service.summariseSettled(
    await sessionsToSummarise(env.DB, now - SETTLED_MS, SUMMARIES_PER_RUN),
  );
}

export async function runMaintenance(
  env: Env,
  store: EventStore,
  now = Date.now(),
  options: { hourly?: boolean } = {},
): Promise<MaintenanceResult> {
  const hourly = options.hourly ?? true;
  const tasks = await frequentTasks(env, store, now);
  if (!hourly)
    return { events: 0, replays: 0, summarised: 0, erased: 0, legacyMoved: 0, hourly, tasks };
  // Erasures someone asked for come before routine retention.
  const erasures = await resumeErasures(env);
  const minors = await minorsProjects(env.DB);
  const events = await expireEvents(env, store, now, minors);
  const replays = erasures.replays + (await expireReplays(env, now, minors));
  const summarised = await summarise(env, store, now);
  const legacy = await moveLegacyReplays(env, LEGACY_MOVES_PER_RUN);
  return {
    events,
    replays,
    summarised,
    erased: erasures.completed,
    legacyMoved: legacy.moved,
    hourly,
    tasks,
  };
}
