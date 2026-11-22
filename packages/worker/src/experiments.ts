/**
 * Experiments: a flag with metrics and a lifecycle.
 *
 *   draft → running ⇄ paused → stopped → shipped
 *                                 ↘ archived (from draft, stopped or shipped)
 *
 * Starting enables the flag; pausing disables it (everyone gets the default) and
 * resuming enables it again; resetting goes back to draft and forgets the start
 * time, so results begin again from the next start. Shipping gives everyone the
 * chosen variant. Results are computed on demand from exposures (see
 * packages/core/src/insights/experiment.ts).
 *
 * Holdouts keep a share of people out of every experiment that uses them: their
 * flag gives those people "holdout", and holdout results compare them with
 * everyone else exposed to those experiments.
 */

import type { FlagDefinition } from '@dataflare/core/flags';
import type { ExperimentMetric } from '@dataflare/core/insights/schemas';
import type { D1Database } from './env.ts';
import { getFlag, saveFlag } from './flags.ts';
import { HttpError } from './http.ts';

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'shipped' | 'archived';
export type ExperimentAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'ship'
  | 'reset'
  | 'archive'
  | 'unarchive';

export interface ExperimentGoal {
  event: string;
  filters?: { property: string; op?: string; value?: unknown }[];
  value?: string;
}

/** Analysis options stored with an experiment. */
interface ExperimentSettings {
  engine?: 'bayesian' | 'frequentist';
  confidence?: 0.9 | 0.95 | 0.99;
  exposure?: {
    event?: string;
    filters?: { property: string; op?: string; value?: unknown }[];
    multipleVariants?: 'exclude' | 'first_seen';
  };
  minimumDays?: number;
  minimumExposures?: number;
  mde?: number;
  filterTestAccounts?: boolean;
}

export interface Experiment extends ExperimentSettings {
  key: string;
  flag: string;
  status: ExperimentStatus;
  /** The simple form: one conversion event (and optional value). */
  goal: ExperimentGoal | null;
  /** Primary metrics; the first decides the winner. */
  metrics: ExperimentMetric[];
  secondary: ExperimentMetric[];
  hypothesis: string;
  holdout: string | null;
  startedAt: number | null;
  endedAt: number | null;
  shippedVariant: string | null;
  createdAt: number;
}

interface Row {
  key: string;
  flag_key: string;
  definition: string;
  status: ExperimentStatus;
  started_at: number | null;
  ended_at: number | null;
  shipped_variant: string | null;
  created_at: number;
}

interface Definition extends ExperimentSettings {
  goal?: ExperimentGoal | null;
  metrics?: ExperimentMetric[];
  /** Secondary metrics; version 1 stored plain goals ({ event, filters }). */
  secondary?: (ExperimentMetric | ExperimentGoal)[];
  hypothesis?: string;
  holdout?: string | null;
}

/** A version-1 secondary goal as a conversion metric. */
function asMetric(m: ExperimentMetric | ExperimentGoal): ExperimentMetric {
  if ('kind' in m) return m;
  return { kind: 'conversion', event: m.event, filters: m.filters as never };
}

function toExperiment(r: Row): Experiment {
  const def = JSON.parse(r.definition) as Definition;
  return {
    key: r.key,
    flag: r.flag_key,
    status: r.status,
    goal: def.goal ?? null,
    metrics: def.metrics ?? [],
    secondary: (def.secondary ?? []).map(asMetric),
    hypothesis: def.hypothesis ?? '',
    holdout: def.holdout ?? null,
    ...(def.engine ? { engine: def.engine } : {}),
    ...(def.confidence ? { confidence: def.confidence } : {}),
    ...(def.exposure ? { exposure: def.exposure } : {}),
    ...(def.minimumDays !== undefined ? { minimumDays: def.minimumDays } : {}),
    ...(def.minimumExposures !== undefined ? { minimumExposures: def.minimumExposures } : {}),
    ...(def.mde !== undefined ? { mde: def.mde } : {}),
    ...(def.filterTestAccounts ? { filterTestAccounts: true } : {}),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    shippedVariant: r.shipped_variant,
    createdAt: r.created_at,
  };
}

function definitionOf(e: Pick<Experiment, keyof Definition>): Definition {
  return {
    goal: e.goal,
    metrics: e.metrics,
    secondary: e.secondary,
    hypothesis: e.hypothesis,
    holdout: e.holdout,
    engine: e.engine,
    confidence: e.confidence,
    exposure: e.exposure,
    minimumDays: e.minimumDays,
    minimumExposures: e.minimumExposures,
    mde: e.mde,
    filterTestAccounts: e.filterTestAccounts,
  };
}

export async function listExperiments(
  db: D1Database,
  project: string,
  includeArchived = false,
): Promise<Experiment[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM experiments WHERE project = ? ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY created_at DESC`,
    )
    .bind(project)
    .all<Row>();
  return results.map(toExperiment);
}

export async function getExperiment(
  db: D1Database,
  project: string,
  key: string,
): Promise<Experiment> {
  const row = await db
    .prepare('SELECT * FROM experiments WHERE project = ? AND key = ?')
    .bind(project, key)
    .first<Row>();
  if (!row) throw new HttpError(404, `No experiment "${key}"`);
  return toExperiment(row);
}

export interface CreateExperimentInput extends ExperimentSettings {
  key: string;
  flag?: string;
  goal?: ExperimentGoal;
  metrics?: ExperimentMetric[];
  secondary?: (ExperimentMetric | ExperimentGoal)[];
  hypothesis?: string;
  /** Variants for a new flag. Default control/test 50/50. */
  variants?: { key: string; weight: number }[];
  holdout?: string;
  /** Web experiment: DOM changes per variant, applied by the browser SDK (stored as payloads). */
  transforms?: Record<string, WebTransform[]>;
}

/** One change a web experiment variant makes to the page. */
interface WebTransform {
  selector: string;
  text?: string;
  html?: string;
  css?: string;
  attributes?: Record<string, string>;
  hide?: boolean;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Create an experiment, creating its flag (disabled until start) if needed. */
function checkInput(input: CreateExperimentInput): void {
  if (!KEY.test(input.key))
    throw new HttpError(
      400,
      `Invalid experiment key "${input.key}"`,
      'Use lowercase letters, numbers, hyphens or underscores.',
    );
  if (!input.goal && !input.metrics?.length)
    throw new HttpError(400, 'An experiment needs a goal or at least one metric');
}

/** Every variant gets a web payload (control's is empty), so the SDK knows to record exposures. */
function webPayloads(input: CreateExperimentInput, variantKeys: string[]) {
  if (!input.transforms) return undefined;
  const unknown = Object.keys(input.transforms).filter((v) => !variantKeys.includes(v));
  if (unknown.length)
    throw new HttpError(400, `transforms for unknown variants: ${unknown.join(', ')}`);
  return Object.fromEntries(
    variantKeys.map((v) => [v, { type: 'web', transforms: input.transforms![v] ?? [] }]),
  );
}

const DEFAULT_VARIANTS = [
  { key: 'control', weight: 50 },
  { key: 'test', weight: 50 },
];

/** The experiment's flag: created off (with its variants) when new, given the page changes when not. */
async function experimentFlag(
  db: D1Database,
  project: string,
  input: CreateExperimentInput,
  actor: string,
): Promise<FlagDefinition> {
  const flagKey = input.flag ?? input.key;
  const flag = await getFlag(db, project, flagKey);
  const variantKeys = (flag?.variants ?? input.variants ?? DEFAULT_VARIANTS).map((v) => v.key);
  const payloads = webPayloads(input, variantKeys);
  if (flag && !payloads) return flag;
  const fields = flag
    ? { key: flagKey, payloads }
    : {
        key: flagKey,
        description: `Experiment: ${input.hypothesis ?? input.key}`,
        enabled: false,
        rollout: 100,
        variants: input.variants ?? DEFAULT_VARIANTS,
        ...(payloads ? { payloads } : {}),
      };
  return (await saveFlag(db, project, fields, actor)).flag;
}

function newDefinition(input: CreateExperimentInput): Definition {
  return {
    goal: input.goal ?? null,
    metrics: input.metrics ?? [],
    secondary: (input.secondary ?? []).map(asMetric),
    hypothesis: input.hypothesis ?? '',
    holdout: input.holdout ?? null,
    engine: input.engine,
    confidence: input.confidence,
    exposure: input.exposure,
    minimumDays: input.minimumDays,
    minimumExposures: input.minimumExposures,
    mde: input.mde,
    filterTestAccounts: input.filterTestAccounts,
  };
}

export async function createExperiment(
  db: D1Database,
  project: string,
  input: CreateExperimentInput,
  actor = '',
): Promise<Experiment> {
  checkInput(input);
  const flag = await experimentFlag(db, project, input, actor);
  if (!flag.variants || flag.variants.length < 2)
    throw new HttpError(400, `Flag "${flag.key}" needs at least two variants to run an experiment`);
  if (input.holdout) await applyHoldout(db, project, flag.key, input.holdout, actor);
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO experiments (project, key, flag_key, definition, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(project, input.key, flag.key, JSON.stringify(newDefinition(input)), 'draft', now, now)
    .run()
    .catch((err: unknown) => {
      if (String(err).includes('UNIQUE'))
        throw new HttpError(409, `Experiment "${input.key}" already exists`);
      throw err;
    });
  return getExperiment(db, project, input.key);
}

/** Change an experiment's metrics or analysis options (any status but archived). */
export async function updateExperimentDefinition(
  db: D1Database,
  project: string,
  key: string,
  changes: Partial<Definition>,
  actor = '',
): Promise<Experiment> {
  const exp = await getExperiment(db, project, key);
  if (exp.status === 'archived') throw new HttpError(409, 'Unarchive the experiment to change it');
  const next = {
    ...exp,
    ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
  } as Experiment;
  if (changes.holdout !== undefined && changes.holdout !== exp.holdout) {
    if (exp.status === 'running') {
      throw new HttpError(
        409,
        'Change the holdout before starting, or after stopping, the experiment',
      );
    }
    if (changes.holdout) await applyHoldout(db, project, exp.flag, changes.holdout, actor);
    else {
      const flag = await getFlag(db, project, exp.flag);
      if (flag?.holdout)
        await saveFlag(db, project, { key: exp.flag, holdout: null as never }, actor);
    }
  }
  if (!next.goal && !next.metrics.length)
    throw new HttpError(400, 'An experiment needs a goal or at least one metric');
  await db
    .prepare('UPDATE experiments SET definition = ?, updated_at = ? WHERE project = ? AND key = ?')
    .bind(JSON.stringify(definitionOf(next)), Date.now(), project, key)
    .run();
  return getExperiment(db, project, key);
}

const ALLOWED: Record<ExperimentAction, ExperimentStatus[]> = {
  start: ['draft', 'stopped'],
  pause: ['running'],
  resume: ['paused'],
  stop: ['running', 'paused'],
  ship: ['draft', 'running', 'paused', 'stopped'],
  reset: ['running', 'paused', 'stopped'],
  archive: ['draft', 'stopped', 'shipped'],
  unarchive: ['archived'],
};

export async function transitionExperiment(
  db: D1Database,
  project: string,
  key: string,
  action: ExperimentAction,
  variant?: string,
  actor = '',
): Promise<{ experiment: Experiment; flag: FlagDefinition }> {
  const exp = await getExperiment(db, project, key);
  const flag = await getFlag(db, project, exp.flag);
  if (!flag) throw new HttpError(409, `Flag "${exp.flag}" no longer exists`);
  if (!ALLOWED[action].includes(exp.status)) {
    throw new HttpError(
      409,
      `Can't ${action} an experiment that is ${exp.status}`,
      `${action} works on: ${ALLOWED[action].join(', ')}.`,
    );
  }
  const now = Date.now();
  const set = async (sql: string, ...args: unknown[]) =>
    db
      .prepare(`UPDATE experiments SET ${sql}, updated_at = ? WHERE project = ? AND key = ?`)
      .bind(...args, now, project, key)
      .run();
  switch (action) {
    case 'start':
      await saveFlag(db, project, { key: flag.key, enabled: true }, actor);
      await set("status = 'running', started_at = COALESCE(started_at, ?), ended_at = NULL", now);
      break;
    case 'pause':
      // Everyone gets the default experience while paused; results so far are kept.
      await saveFlag(db, project, { key: flag.key, enabled: false }, actor);
      await set("status = 'paused'");
      break;
    case 'resume':
      await saveFlag(db, project, { key: flag.key, enabled: true }, actor);
      await set("status = 'running'");
      break;
    case 'stop':
      await set("status = 'stopped', ended_at = ?", now);
      break;
    case 'reset':
      // Back to draft: the next start counts exposures from then on.
      await saveFlag(db, project, { key: flag.key, enabled: false }, actor);
      await set("status = 'draft', started_at = NULL, ended_at = NULL, shipped_variant = NULL");
      break;
    case 'archive':
      await set("status = 'archived'");
      break;
    case 'unarchive':
      await set(`status = '${exp.shippedVariant ? 'shipped' : exp.endedAt ? 'stopped' : 'draft'}'`);
      break;
    case 'ship': {
      if (!variant || !flag.variants?.some((v) => v.key === variant)) {
        throw new HttpError(
          400,
          `Pass the variant to ship, one of: ${(flag.variants ?? []).map((v) => v.key).join(', ')}`,
        );
      }
      // Everyone gets the shipped variant from now on, holdout included.
      await saveFlag(
        db,
        project,
        {
          key: flag.key,
          enabled: true,
          rollout: 100,
          rules: [{ conditions: [], rollout: 100, variant }],
          holdout: null as never,
        },
        actor,
      );
      await set(
        "status = 'shipped', ended_at = COALESCE(ended_at, ?), shipped_variant = ?",
        now,
        variant,
      );
      break;
    }
  }
  return {
    experiment: await getExperiment(db, project, key),
    flag: (await getFlag(db, project, exp.flag))!,
  };
}

/** Copy an experiment (metrics, options, a new flag with the same variants) as a new draft. */
export async function duplicateExperiment(
  db: D1Database,
  project: string,
  key: string,
  newKey: string,
  actor = '',
): Promise<Experiment> {
  const exp = await getExperiment(db, project, key);
  const flag = await getFlag(db, project, exp.flag);
  return createExperiment(
    db,
    project,
    {
      key: newKey,
      flag: newKey,
      goal: exp.goal ?? undefined,
      metrics: exp.metrics,
      secondary: exp.secondary,
      hypothesis: exp.hypothesis,
      variants: flag?.variants,
      holdout: exp.holdout ?? undefined,
      engine: exp.engine,
      confidence: exp.confidence,
      exposure: exp.exposure,
      minimumDays: exp.minimumDays,
      minimumExposures: exp.minimumExposures,
      mde: exp.mde,
      filterTestAccounts: exp.filterTestAccounts,
    },
    actor,
  );
}

// ── Holdouts ───────────────────────────────────────────────────────────────

export interface Holdout {
  key: string;
  name: string;
  description: string;
  percentage: number;
  createdAt: number;
}

export async function listHoldouts(db: D1Database, project: string): Promise<Holdout[]> {
  const { results } = await db
    .prepare(
      'SELECT key, name, description, percentage, created_at FROM holdouts WHERE project = ? ORDER BY name',
    )
    .bind(project)
    .all<{
      key: string;
      name: string;
      description: string;
      percentage: number;
      created_at: number;
    }>();
  return results.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    percentage: r.percentage,
    createdAt: r.created_at,
  }));
}

export async function getHoldout(db: D1Database, project: string, key: string): Promise<Holdout> {
  const h = (await listHoldouts(db, project)).find((x) => x.key === key);
  if (!h) throw new HttpError(404, `No holdout "${key}"`, 'Create it with save_holdout first.');
  return h;
}

/** Create or update a holdout; experiments' flags that use it get the new percentage. */
export async function saveHoldout(
  db: D1Database,
  project: string,
  input: { key: string; name?: string; description?: string; percentage: number },
  actor = '',
): Promise<Holdout> {
  if (!KEY.test(input.key)) throw new HttpError(400, `Invalid holdout key "${input.key}"`);
  if (!(input.percentage > 0 && input.percentage <= 50)) {
    throw new HttpError(
      400,
      'A holdout keeps between 0 and 50% of people out',
      'Typical holdouts are 5–10%.',
    );
  }
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO holdouts (project, key, name, description, percentage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, key) DO UPDATE SET name = excluded.name, description = excluded.description,
         percentage = excluded.percentage, updated_at = excluded.updated_at`,
    )
    .bind(
      project,
      input.key,
      input.name ?? input.key,
      input.description ?? '',
      input.percentage,
      now,
      now,
    )
    .run();
  for (const exp of await experimentsUsingHoldout(db, project, input.key)) {
    if (exp.status !== 'shipped') await applyHoldout(db, project, exp.flag, input.key, actor);
  }
  return getHoldout(db, project, input.key);
}

export async function deleteHoldout(db: D1Database, project: string, key: string): Promise<void> {
  const using = (await experimentsUsingHoldout(db, project, key)).filter(
    (e) => e.status !== 'shipped' && e.status !== 'archived',
  );
  if (using.length) {
    throw new HttpError(
      409,
      `Holdout "${key}" is used by ${using.map((e) => `"${e.key}"`).join(', ')}`,
    );
  }
  await db.prepare('DELETE FROM holdouts WHERE project = ? AND key = ?').bind(project, key).run();
}

export async function experimentsUsingHoldout(
  db: D1Database,
  project: string,
  key: string,
): Promise<Experiment[]> {
  return (await listExperiments(db, project, true)).filter((e) => e.holdout === key);
}

async function applyHoldout(
  db: D1Database,
  project: string,
  flagKey: string,
  holdoutKey: string,
  actor: string,
): Promise<void> {
  const h = await getHoldout(db, project, holdoutKey);
  await saveFlag(
    db,
    project,
    { key: flagKey, holdout: { key: h.key, percentage: h.percentage } },
    actor,
  );
}
