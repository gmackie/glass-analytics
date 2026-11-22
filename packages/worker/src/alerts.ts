/**
 * Alerts on saved analyses. Each alert has a check schedule; the five-minute cron runs up to
 * ten due checks, records every reading (kept 90 days for the alert's chart), and notifies the
 * alert's channels when it starts firing and when it resolves. Quiet hours and weekends skip
 * the check. An alert whose analysis is gone, or can't be alerted on, is disabled.
 */

import {
  type AlertCondition,
  type AlertEvaluation,
  type AlertTarget,
  describeCondition,
  evaluateAlert,
} from '@dataflare/core/alerts';
import type { Notice } from '@dataflare/core/destinations/notices';
import { noticeEmail } from '@dataflare/core/email';
import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import { inQuietHours, isWeekend, nextRun, type Schedule } from '@dataflare/core/schedule';
import { newId } from './dashboards.ts';
import { sendNotice } from './destinations.ts';
import type { D1Database } from './env.ts';
import { HttpError } from './http.ts';
import { type Channels, emailError, type ReportContext } from './reports.ts';

interface AlertChecks {
  schedule: Schedule;
  /** Check the bucket still filling up, not the last complete one. */
  ongoing?: boolean;
  skipWeekends?: boolean;
  quiet?: { from: string; to: string }[];
}

export type AlertState = 'ok' | 'firing' | 'errored' | 'disabled';

export interface Alert {
  id: string;
  name: string;
  insightKey: string;
  target: AlertTarget;
  condition: AlertCondition;
  checks: AlertChecks;
  channels: Channels;
  state: AlertState;
  enabled: boolean;
  lastValue: number | null;
  lastCheckedAt: number | null;
  nextCheckAt: number;
  error: string | null;
}

interface AlertRow {
  project: string;
  id: string;
  name: string;
  insight_key: string;
  target: string;
  condition: string;
  checks: string;
  channels: string;
  state: string;
  enabled: number;
  last_value: number | null;
  last_checked_at: number | null;
  next_check_at: number;
  error: string | null;
}

const CHECKS_PER_TICK = 10;
const HISTORY_DAYS = 90;
const ALERTABLE = new Set(['trends', 'funnel']);

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function toAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    name: r.name,
    insightKey: r.insight_key,
    target: parse(r.target, {}),
    condition: parse(r.condition, { type: 'value' }),
    checks: parse(r.checks, { schedule: { frequency: 'hourly' } }),
    channels: parse(r.channels, {}),
    state: r.state as AlertState,
    enabled: r.enabled === 1,
    lastValue: r.last_value,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    error: r.error,
  };
}

export async function listAlerts(
  db: D1Database,
  project: string,
  insightKey?: string,
): Promise<Alert[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM alerts WHERE project = ?${insightKey ? ' AND insight_key = ?' : ''} ORDER BY name COLLATE NOCASE`,
    )
    .bind(project, ...(insightKey ? [insightKey] : []))
    .all<AlertRow>();
  return results.map(toAlert);
}

export async function getAlert(db: D1Database, project: string, id: string): Promise<Alert> {
  const r = await db
    .prepare('SELECT * FROM alerts WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<AlertRow>();
  if (!r) throw new HttpError(404, `No alert "${id}"`);
  return toAlert(r);
}

export interface AlertInput {
  id?: string;
  name: string;
  insightKey: string;
  target?: AlertTarget;
  condition: AlertCondition;
  checks: AlertChecks;
  channels: Channels;
  enabled?: boolean;
}

async function insightOf(db: D1Database, project: string, key: string) {
  const i = await db
    .prepare('SELECT key, name, kind, spec FROM insights WHERE project = ? AND key = ?')
    .bind(project, key)
    .first<{ key: string; name: string; kind: string; spec: string }>();
  if (!i)
    throw new HttpError(
      404,
      `No saved analysis "${key}"`,
      'Alerts watch saved analyses: save it first.',
    );
  if (!ALERTABLE.has(i.kind))
    throw new HttpError(400, `Alerts work on trends and funnels, not ${i.kind}.`);
  return { ...i, spec: parse<Record<string, unknown>>(i.spec, {}) };
}

/** Saving keeps an alert's state (so a resolve is still announced), unless it is switched on or off. */
function stateAfterSave(before: AlertState | undefined, enabled: boolean | undefined): AlertState {
  if (enabled === false) return 'disabled';
  if (!before || before === 'disabled' || before === 'errored') return 'ok';
  return before;
}

export async function saveAlert(
  ctx: ReportContext,
  project: string,
  input: AlertInput,
  now: number,
) {
  const db = ctx.env.DB;
  await insightOf(db, project, input.insightKey);
  if (!(input.channels.destinations?.length || input.channels.emails?.length))
    throw new HttpError(400, 'Pick at least one channel or email address to alert.');
  if ((input.channels.destinations?.length ?? 0) + (input.channels.emails?.length ?? 0) > 5)
    throw new HttpError(400, 'An alert goes to at most 5 channels.');
  if (input.channels.emails?.length && !ctx.env.EMAIL)
    throw new HttpError(400, 'Email is not set up for this deployment.');
  const id = input.id ?? newId('a');
  const next = nextRun(input.checks.schedule, now, await ctx.timezone(project));
  const existing = input.id
    ? await db
        .prepare('SELECT state FROM alerts WHERE project = ? AND id = ?')
        .bind(project, id)
        .first<{ state: AlertState }>()
    : null;
  if (input.id && !existing) throw new HttpError(404, `No alert "${input.id}"`);
  const values = [
    input.name,
    input.insightKey,
    JSON.stringify(input.target ?? {}),
    JSON.stringify(input.condition),
    JSON.stringify(input.checks),
    JSON.stringify(input.channels),
    input.enabled === false ? 0 : 1,
    stateAfterSave(existing?.state, input.enabled),
    next,
    now,
  ];
  if (existing)
    await db
      .prepare(
        'UPDATE alerts SET name = ?, insight_key = ?, target = ?, condition = ?, checks = ?, channels = ?, enabled = ?, state = ?, next_check_at = ?, updated_at = ?, error = NULL WHERE project = ? AND id = ?',
      )
      .bind(...values, project, id)
      .run();
  else
    await db
      .prepare(
        'INSERT INTO alerts (name, insight_key, target, condition, checks, channels, enabled, state, next_check_at, updated_at, created_at, project, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(...values, now, project, id)
      .run();
  return { id, created: !existing, nextCheckAt: next };
}

export async function deleteAlert(db: D1Database, project: string, id: string): Promise<void> {
  const res = await db
    .prepare('DELETE FROM alerts WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No alert "${id}"`);
  await db
    .prepare('DELETE FROM alert_checks WHERE project = ? AND alert = ?')
    .bind(project, id)
    .run();
}

/** The checks of the last `days` days, oldest first. */
export async function alertHistory(
  db: D1Database,
  project: string,
  id: string,
  now: number,
  days = 30,
) {
  const { results } = await db
    .prepare(
      'SELECT at, value, breakdown, fired, error FROM alert_checks WHERE project = ? AND alert = ? AND at >= ? ORDER BY at',
    )
    .bind(project, id, now - days * 86_400_000)
    .all<{
      at: number;
      value: number | null;
      breakdown: string | null;
      fired: number;
      error: string | null;
    }>();
  return results.map((r) => ({
    at: r.at,
    value: r.value,
    breakdown: r.breakdown,
    fired: r.fired === 1,
    error: r.error,
  }));
}

// ── Checking ────────────────────────────────────────────────────────────────

/** The query an alert runs: its analysis, as trends lines (never a single number) for trends. */
function alertSpec(kind: string, spec: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'trends') return spec;
  const { display: _display, compare: _compare, ...rest } = spec;
  return rest;
}

async function evaluate(ctx: ReportContext, project: string, a: Alert) {
  const i = await insightOf(ctx.env.DB, project, a.insightKey);
  const result = (await ctx.query(project, i.kind, alertSpec(i.kind, i.spec))) as
    | TrendsResult
    | FunnelResult;
  return { insight: i, evaluation: evaluateAlert(result, a.target, a.condition, a.checks.ongoing) };
}

function readingText(value: number, percent: boolean): string {
  return percent ? `${Math.round(value * 1000) / 10}%` : value.toLocaleString('en-US');
}

function alertNotice(
  ctx: ReportContext,
  project: string,
  a: Alert,
  insight: { key: string; name: string; kind: string },
  e: AlertEvaluation,
  firing: boolean,
): Notice {
  const percent = insight.kind === 'funnel';
  const condition = describeCondition(a.condition, percent);
  const items = (firing ? e.breaches : e.readings.slice(0, 1)).slice(0, 10).map((r) => ({
    title: r.breakdown ? `${insight.name}: ${r.breakdown}` : insight.name,
    value: readingText(r.value, percent),
    ...(r.previous !== null ? { delta: `from ${readingText(r.previous, percent)}` } : {}),
    note: firing ? `Alert: ${condition}` : 'Back within the limit',
  }));
  return {
    kind: 'alert',
    title: firing ? `🔔 ${a.name}` : `✅ Resolved: ${a.name}`,
    intro: firing
      ? `${insight.name} is ${condition}.`
      : `${insight.name} is no longer ${condition}.`,
    items,
    link: `${ctx.base}/app#/insights/${insight.key}?project=${encodeURIComponent(project)}`,
    linkLabel: 'Open analysis',
  };
}

async function notify(
  ctx: ReportContext,
  project: string,
  a: Alert,
  notice: Notice,
): Promise<string[]> {
  const errors: string[] = [];
  for (const dest of a.channels.destinations ?? []) {
    const outcome = await sendNotice(ctx.env, project, dest, notice, ctx.fetcher).catch(
      (err: unknown) => ({ ok: false, error: String(err) }),
    );
    if (!outcome.ok) errors.push(`${dest}: ${'error' in outcome ? outcome.error : 'failed'}`);
  }
  const email = ctx.env.EMAIL;
  const from = ctx.env.GLASS_EMAIL_FROM;
  if (email && from && a.channels.emails?.length)
    await email
      .send(noticeEmail(notice, { from, to: a.channels.emails }))
      .catch((err: unknown) => errors.push(emailError(err)));
  return errors;
}

async function record(
  db: D1Database,
  project: string,
  a: Alert,
  e: AlertEvaluation | null,
  error: string | null,
  now: number,
): Promise<void> {
  const rows = e?.readings.length
    ? e.readings
    : [{ breakdown: null, value: null as number | null, breached: false }];
  await db.batch([
    ...rows.map((r) =>
      db
        .prepare(
          'INSERT INTO alert_checks (project, alert, at, value, breakdown, fired, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(project, a.id, now, r.value, r.breakdown, r.breached ? 1 : 0, error),
    ),
    db
      .prepare('DELETE FROM alert_checks WHERE project = ? AND alert = ? AND at < ?')
      .bind(project, a.id, now - HISTORY_DAYS * 86_400_000),
  ]);
}

/** The state after a check, and whether to tell anyone. */
function transition(
  before: AlertState,
  firing: boolean,
): { state: AlertState; tell: 'firing' | 'resolved' | null } {
  if (firing) return { state: 'firing', tell: before === 'firing' ? null : 'firing' };
  return { state: 'ok', tell: before === 'firing' ? 'resolved' : null };
}

/** Check one alert now: evaluate, record, notify on a change of state. */
export async function checkAlert(ctx: ReportContext, project: string, a: Alert, now: number) {
  const db = ctx.env.DB;
  try {
    const { insight, evaluation } = await evaluate(ctx, project, a);
    const { state, tell } = transition(a.state, evaluation.breaches.length > 0);
    await record(db, project, a, evaluation, null, now);
    const errors = tell
      ? await notify(
          ctx,
          project,
          a,
          alertNotice(ctx, project, a, insight, evaluation, tell === 'firing'),
        )
      : [];
    await db
      .prepare(
        'UPDATE alerts SET state = ?, last_value = ?, last_checked_at = ?, error = ? WHERE project = ? AND id = ?',
      )
      .bind(
        state,
        evaluation.value,
        now,
        errors.length ? errors.join('; ').slice(0, 500) : null,
        project,
        a.id,
      )
      .run();
    return { state, evaluation, notified: tell, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Gone or no longer alertable: stop checking until someone fixes it.
    const gone = err instanceof HttpError && (err.status === 404 || err.status === 400);
    await record(db, project, a, null, message, now);
    await db
      .prepare(
        'UPDATE alerts SET state = ?, enabled = ?, last_checked_at = ?, error = ? WHERE project = ? AND id = ?',
      )
      .bind(gone ? 'disabled' : 'errored', gone ? 0 : 1, now, message.slice(0, 500), project, a.id)
      .run();
    return {
      state: gone ? 'disabled' : 'errored',
      evaluation: null,
      notified: null,
      errors: [message],
    };
  }
}

/** The cron's alert work: up to ten due checks (quiet hours and weekends skip to the next). */
export async function runAlerts(ctx: ReportContext, now: number): Promise<number> {
  const db = ctx.env.DB;
  const { results } = await db
    .prepare(
      'SELECT * FROM alerts WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT ?',
    )
    .bind(now, CHECKS_PER_TICK)
    .all<AlertRow>();
  let checked = 0;
  for (const r of results) {
    const a = toAlert(r);
    const tz = await ctx.timezone(r.project);
    const next = nextRun(a.checks.schedule, now, tz);
    await db
      .prepare('UPDATE alerts SET next_check_at = ? WHERE project = ? AND id = ?')
      .bind(next, r.project, a.id)
      .run();
    const skip =
      inQuietHours(a.checks.quiet, now, tz) || (a.checks.skipWeekends && isWeekend(now, tz));
    if (skip) continue;
    await checkAlert(ctx, r.project, a, now);
    checked++;
  }
  return checked;
}
