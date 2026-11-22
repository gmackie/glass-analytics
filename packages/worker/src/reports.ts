/**
 * Scheduled reports ("subscriptions") of a dashboard or a saved analysis, to chat channels
 * (Slack, Discord, Teams, webhooks) and email.
 *
 * The five-minute cron starts the runs that are due, then computes their tiles a few at a
 * time (so a 20-tile report fits the Free plan's per-invocation limits and resumes on the next
 * tick), then sends. Each tile's numbers and chart snapshot stay on the run; the chart images
 * in chat messages are signed links rendered on first fetch (GET /report/<run>/<n>.png).
 */

import type { Notice, NoticeItem } from '@dataflare/core/destinations/notices';
import { noticeEmail, recipientBatches } from '@dataflare/core/email';
import { type ReportTile, reportTile, snapshotPng } from '@dataflare/core/reports';
import { describeSchedule, nextRun, type Schedule } from '@dataflare/core/schedule';
import { getDashboard, newId, tileSpec } from './dashboards.ts';
import { sendNotice } from './destinations.ts';
import type { D1Database, Env } from './env.ts';
import { HttpError } from './http.ts';
import { sign, verify } from './signing.ts';

export interface Channels {
  destinations?: string[];
  emails?: string[];
}

export interface Subscription {
  id: string;
  target: 'dashboard' | 'insight';
  targetId: string;
  name: string;
  channels: Channels;
  schedule: Schedule;
  tiles: string[];
  message: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
}

/** What reports need from the service: run a query, link to the dashboard, the project zone. */
export interface ReportContext {
  env: Env;
  base: string;
  query(project: string, kind: string, spec: Record<string, unknown>): Promise<unknown>;
  timezone(project: string): Promise<string>;
  fetcher?: typeof fetch;
}

const MAX_REPORT_TILES = 20;
/** Tiles computed per cron tick, across runs: a query or two each, inside the Free plan's 50. */
const TILES_PER_TICK = 6;
const IMAGE_DAYS = 90;

interface SubRow {
  id: string;
  target: string;
  target_id: string;
  name: string;
  channels: string;
  schedule: string;
  tiles: string;
  message: string;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function toSubscription(r: SubRow): Subscription {
  return {
    id: r.id,
    target: r.target === 'insight' ? 'insight' : 'dashboard',
    targetId: r.target_id,
    name: r.name,
    channels: parse(r.channels, {}),
    schedule: parse(r.schedule, { frequency: 'weekly' }),
    tiles: parse(r.tiles, []),
    message: r.message,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
  };
}

export async function listSubscriptions(
  db: D1Database,
  project: string,
  target?: { kind: string; id: string },
) {
  const where = target ? ' AND target = ? AND target_id = ?' : '';
  const { results } = await db
    .prepare(`SELECT * FROM subscriptions WHERE project = ?${where} ORDER BY created_at`)
    .bind(project, ...(target ? [target.kind, target.id] : []))
    .all<SubRow>();
  return results.map(toSubscription);
}

async function getSubscription(db: D1Database, project: string, id: string): Promise<Subscription> {
  const r = await db
    .prepare('SELECT * FROM subscriptions WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<SubRow>();
  if (!r) throw new HttpError(404, `No report "${id}"`);
  return toSubscription(r);
}

export interface SubscriptionInput {
  id?: string;
  target: 'dashboard' | 'insight';
  targetId: string;
  name?: string;
  channels: Channels;
  schedule: Schedule;
  tiles?: string[];
  message?: string;
  enabled?: boolean;
}

function checkChannels(env: Env, channels: Channels): void {
  const count = (channels.destinations?.length ?? 0) + (channels.emails?.length ?? 0);
  if (!count) throw new HttpError(400, 'Pick at least one channel or email address.');
  if (channels.emails?.length && !env.EMAIL)
    throw new HttpError(
      400,
      'Email is not set up for this deployment',
      'Run `dataflare email enable --from reports@yourdomain.com`.',
    );
}

export async function saveSubscription(
  ctx: ReportContext,
  project: string,
  input: SubscriptionInput,
  now: number,
) {
  const db = ctx.env.DB;
  checkChannels(ctx.env, input.channels);
  if ((input.tiles?.length ?? 0) > MAX_REPORT_TILES)
    throw new HttpError(400, `A report holds at most ${MAX_REPORT_TILES} tiles.`);
  await targetName(db, project, input.target, input.targetId);
  const id = input.id ?? newId('s');
  const next = nextRun(input.schedule, now, await ctx.timezone(project));
  const values = [
    input.target,
    input.targetId,
    input.name ?? '',
    JSON.stringify(input.channels),
    JSON.stringify(input.schedule),
    JSON.stringify(input.tiles ?? []),
    input.message ?? '',
    input.enabled === false ? 0 : 1,
    next,
    now,
  ];
  const existing = input.id
    ? await db
        .prepare('SELECT id FROM subscriptions WHERE project = ? AND id = ?')
        .bind(project, id)
        .first()
    : null;
  if (input.id && !existing) throw new HttpError(404, `No report "${input.id}"`);
  if (existing)
    await db
      .prepare(
        'UPDATE subscriptions SET target = ?, target_id = ?, name = ?, channels = ?, schedule = ?, tiles = ?, message = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE project = ? AND id = ?',
      )
      .bind(...values, project, id)
      .run();
  else
    await db
      .prepare(
        'INSERT INTO subscriptions (target, target_id, name, channels, schedule, tiles, message, enabled, next_run_at, updated_at, created_at, project, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(...values, now, project, id)
      .run();
  return { id, created: !existing, nextRunAt: next, when: describeSchedule(input.schedule) };
}

export async function deleteSubscription(
  db: D1Database,
  project: string,
  id: string,
): Promise<void> {
  const res = await db
    .prepare('DELETE FROM subscriptions WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No report "${id}"`);
}

async function targetName(
  db: D1Database,
  project: string,
  target: string,
  id: string,
): Promise<string> {
  const table = target === 'insight' ? 'insights' : 'dashboards';
  const col = target === 'insight' ? 'key' : 'id';
  const r = await db
    .prepare(`SELECT name FROM ${table} WHERE project = ? AND ${col} = ?`)
    .bind(project, id)
    .first<{ name: string }>();
  if (!r)
    throw new HttpError(404, `No ${target === 'insight' ? 'saved analysis' : 'dashboard'} "${id}"`);
  return r.name;
}

// ── Runs ────────────────────────────────────────────────────────────────────

/** One tile to compute: a saved analysis and the spec it runs with. */
interface PlannedTile {
  title: string;
  kind: string;
  spec: Record<string, unknown>;
  display?: string;
  link: string;
}

interface RunRow {
  id: string;
  project: string;
  subscription: string;
  tiles: string;
  tiles_done: number;
  results: string;
}

async function planTiles(
  ctx: ReportContext,
  project: string,
  s: Subscription,
): Promise<PlannedTile[]> {
  const link = (route: string) =>
    `${ctx.base}/app#/${route}?project=${encodeURIComponent(project)}`;
  if (s.target === 'insight') {
    const i = await ctx.env.DB.prepare(
      'SELECT key, name, kind, spec FROM insights WHERE project = ? AND key = ?',
    )
      .bind(project, s.targetId)
      .first<{ key: string; name: string; kind: string; spec: string }>();
    if (!i) throw new HttpError(404, `The analysis "${s.targetId}" was deleted.`);
    const spec = parse<Record<string, unknown>>(i.spec, {});
    return [
      {
        title: i.name,
        kind: i.kind,
        spec,
        display: spec.display as string | undefined,
        link: link(`insights/${i.key}`),
      },
    ];
  }
  const d = await getDashboard(ctx.env.DB, project, s.targetId);
  const chosen = s.tiles.length ? d.tiles.filter((t) => s.tiles.includes(t.id)) : d.tiles;
  return chosen
    .filter((t) => t.kind === 'insight' && t.insight)
    .slice(0, MAX_REPORT_TILES)
    .map((t) => ({
      title: t.insight!.name,
      kind: t.insight!.kind,
      spec: tileSpec(t.insight!.spec, d.filters, t.ignoreFilters),
      display: ((t.overrides.display as string | undefined) ?? t.insight!.spec.display) as
        | string
        | undefined,
      link: link(`insights/${t.insight!.key}`),
    }));
}

/** Start the due reports: a run each, and the next run time. */
async function startDueRuns(ctx: ReportContext, now: number, limit = 3): Promise<number> {
  const db = ctx.env.DB;
  const { results } = await db
    .prepare(
      'SELECT * FROM subscriptions WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?',
    )
    .bind(now, limit)
    .all<SubRow & { project: string }>();
  for (const r of results) {
    const s = toSubscription(r);
    const next = nextRun(s.schedule, now, await ctx.timezone(r.project));
    await db
      .prepare(
        'UPDATE subscriptions SET next_run_at = ?, last_run_at = ? WHERE project = ? AND id = ?',
      )
      .bind(next, now, r.project, s.id)
      .run();
    await startRun(ctx, r.project, s, now);
  }
  return results.length;
}

async function startRun(
  ctx: ReportContext,
  project: string,
  s: Subscription,
  now: number,
): Promise<string> {
  const id = newId('r');
  let tiles: PlannedTile[] = [];
  let error: string | null = null;
  try {
    tiles = await planTiles(ctx, project, s);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await ctx.env.DB.prepare(
    'INSERT INTO subscription_runs (id, project, subscription, started_at, status, tiles, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, project, s.id, now, error ? 'failed' : 'running', JSON.stringify(tiles), error)
    .run();
  if (error) await recordStatus(ctx.env.DB, project, s.id, 'failed', error);
  return id;
}

async function recordStatus(
  db: D1Database,
  project: string,
  id: string,
  status: string,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      'UPDATE subscriptions SET last_status = ?, last_error = ? WHERE project = ? AND id = ?',
    )
    .bind(status, error, project, id)
    .run();
}

async function computeTile(
  ctx: ReportContext,
  project: string,
  t: PlannedTile,
): Promise<ReportTile & { link: string }> {
  try {
    const spec = t.kind === 'trends' ? { ...t.spec, compare: true } : t.spec;
    const result = await ctx.query(project, t.kind, spec);
    return { ...reportTile(t.title, t.kind, result, t.display), link: t.link };
  } catch (err) {
    return {
      title: t.title,
      note: `Couldn't run: ${err instanceof Error ? err.message : String(err)}`,
      chart: null,
      link: t.link,
    };
  }
}

/** Compute up to `budget` tiles of a run; returns how many were computed. */
async function advanceRun(ctx: ReportContext, run: RunRow, budget: number): Promise<number> {
  const tiles = parse<PlannedTile[]>(run.tiles, []);
  const results = parse<(ReportTile & { link: string })[]>(run.results, []);
  const todo = tiles.slice(run.tiles_done, run.tiles_done + budget);
  for (const t of todo) results.push(await computeTile(ctx, run.project, t));
  await ctx.env.DB.prepare('UPDATE subscription_runs SET tiles_done = ?, results = ? WHERE id = ?')
    .bind(run.tiles_done + todo.length, JSON.stringify(results), run.id)
    .run();
  if (run.tiles_done + todo.length >= tiles.length)
    await finishRun(ctx, run.project, run.subscription, run.id, results);
  return todo.length;
}

/** The cron's report work: start what's due, then compute and send a few tiles' worth. */
export async function runReports(ctx: ReportContext, now: number): Promise<number> {
  await startDueRuns(ctx, now);
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, project, subscription, tiles, tiles_done, results FROM subscription_runs WHERE status = 'running' ORDER BY started_at LIMIT 3",
  ).all<RunRow>();
  let budget = TILES_PER_TICK;
  for (const run of results) {
    if (budget <= 0) break;
    budget -= await advanceRun(ctx, run, budget);
  }
  return TILES_PER_TICK - budget;
}

/** Compute every tile of a run now and send it ("Send test now"). */
export async function runNow(ctx: ReportContext, project: string, id: string, now: number) {
  const s = await getSubscription(ctx.env.DB, project, id);
  const runId = await startRun(ctx, project, s, now);
  const run = await ctx.env.DB.prepare(
    'SELECT id, project, subscription, tiles, tiles_done, results, status, error FROM subscription_runs WHERE id = ?',
  )
    .bind(runId)
    .first<RunRow & { status: string; error: string | null }>();
  if (run?.status === 'running') await advanceRun(ctx, run, MAX_REPORT_TILES);
  const done = await ctx.env.DB.prepare('SELECT status, error FROM subscription_runs WHERE id = ?')
    .bind(runId)
    .first<{ status: string; error: string | null }>();
  return { run: runId, status: done?.status ?? 'failed', error: done?.error ?? null };
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function imageUrl(
  ctx: ReportContext,
  run: string,
  index: number,
  now: number,
): Promise<string> {
  const expires = Math.floor(now / 1000) + IMAGE_DAYS * 86_400;
  const s = await sign(ctx.env, 'report-images', `${run}/${index}/${expires}`);
  return `${ctx.base}/report/${run}/${index}.png?e=${expires}&s=${s}`;
}

async function buildNotice(
  ctx: ReportContext,
  project: string,
  s: Subscription,
  run: string,
  tiles: (ReportTile & { link: string })[],
  now: number,
): Promise<Notice> {
  const name =
    s.name || (await targetName(ctx.env.DB, project, s.target, s.targetId).catch(() => s.targetId));
  const items: NoticeItem[] = [];
  for (const [i, t] of tiles.entries())
    items.push({
      title: t.title,
      value: t.value,
      delta: t.delta,
      note: t.note,
      link: t.link,
      ...(t.chart ? { imageUrl: await imageUrl(ctx, run, i, now) } : {}),
    });
  const route = s.target === 'dashboard' ? `dashboards/${s.targetId}` : `insights/${s.targetId}`;
  return {
    kind: 'report',
    title: name,
    intro: [s.message, describeSchedule(s.schedule)].filter(Boolean).join(' · '),
    items,
    link: `${ctx.base}/app#/${route}?project=${encodeURIComponent(project)}`,
    linkLabel: s.target === 'dashboard' ? 'Open dashboard' : 'Open analysis',
  };
}

async function unsubscribeLink(
  ctx: ReportContext,
  project: string,
  id: string,
  email: string,
): Promise<string> {
  const sig = await sign(ctx.env, 'unsubscribe', `${project}/${id}/${email}`);
  return `${ctx.base}/unsubscribe/${encodeURIComponent(project)}/${id}?email=${encodeURIComponent(email)}&s=${sig}`;
}

/** Email each address (in groups of 50), with the charts inline. */
async function emailNotice(
  ctx: ReportContext,
  project: string,
  id: string,
  notice: Notice,
  tiles: ReportTile[],
  emails: string[],
): Promise<string[]> {
  const email = ctx.env.EMAIL;
  const from = ctx.env.GLASS_EMAIL_FROM;
  if (!email || !from) return emails.length ? ['Email is not set up for this deployment.'] : [];
  const images = new Map<number, Uint8Array>();
  for (const [i, t] of tiles.entries()) if (t.chart) images.set(i, await snapshotPng(t.chart));
  const errors: string[] = [];
  // Each address gets its own unsubscribe link, so each is its own message when there are few.
  const groups = emails.length <= 10 ? emails.map((e) => [e]) : recipientBatches(emails);
  for (const to of groups) {
    const unsubscribe =
      to.length === 1 ? await unsubscribeLink(ctx, project, id, to[0]!) : undefined;
    try {
      await email.send(noticeEmail(notice, { from, to, images, unsubscribe }));
    } catch (err) {
      errors.push(emailError(err));
    }
  }
  return errors;
}

/** Email Sending's error codes, in words, with what to do. */
export function emailError(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  const hints: Record<string, string> = {
    E_SENDER_NOT_VERIFIED:
      'The sender address is not allowed by the binding: run `dataflare email enable` again.',
    E_SENDER_DOMAIN_NOT_AVAILABLE:
      'The sender domain is not onboarded for Email Sending in Cloudflare.',
    E_SENDER_DOMAIN_NOT_CONFIGURED: 'The sender domain has no Email Sending setup in Cloudflare.',
    E_EMAIL_SENDING_NOT_READY:
      'The domain is still being set up for Email Sending; it will retry next time.',
    E_RECIPIENT_NOT_ALLOWED: 'The binding does not allow this recipient.',
    E_RECIPIENT_PLAN_RESTRICTED:
      'Your plan only sends to verified addresses: verify the recipient in Cloudflare.',
    E_RECIPIENT_SUPPRESSED: 'The recipient is on the suppression list (bounced or complained).',
    E_DAILY_LIMIT_EXCEEDED: "Today's email quota is used up.",
  };
  const message = err instanceof Error ? err.message : String(err);
  return hints[code] ? `${code}: ${hints[code]}` : message;
}

async function finishRun(
  ctx: ReportContext,
  project: string,
  id: string,
  run: string,
  tiles: (ReportTile & { link: string })[],
): Promise<void> {
  const db = ctx.env.DB;
  const now = Date.now();
  const errors: string[] = [];
  try {
    const s = await getSubscription(db, project, id);
    const notice = await buildNotice(ctx, project, s, run, tiles, now);
    for (const dest of s.channels.destinations ?? []) {
      const outcome = await sendNotice(ctx.env, project, dest, notice, ctx.fetcher).catch(
        (err: unknown) => ({ ok: false, error: String(err) }),
      );
      if (!outcome.ok) errors.push(`${dest}: ${'error' in outcome ? outcome.error : 'failed'}`);
    }
    errors.push(...(await emailNotice(ctx, project, id, notice, tiles, s.channels.emails ?? [])));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const status = errors.length ? 'failed' : 'sent';
  const error = errors.length ? errors.join('; ').slice(0, 1000) : null;
  await db
    .prepare('UPDATE subscription_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?')
    .bind(status, now, error, run)
    .run();
  await recordStatus(db, project, id, status, error);
}

// ── Public links ────────────────────────────────────────────────────────────

/** GET /report/<run>/<n>.png?e=&s=: a report chart, if the link is signed and current. */
export async function reportImage(
  env: Env,
  run: string,
  index: number,
  expires: number,
  signature: string,
  now: number,
): Promise<Uint8Array> {
  if (!(await verify(env, 'report-images', `${run}/${index}/${expires}`, signature)))
    throw new HttpError(403, 'Bad link');
  if (expires * 1000 < now) throw new HttpError(410, 'This chart link has expired');
  const r = await env.DB.prepare('SELECT results FROM subscription_runs WHERE id = ?')
    .bind(run)
    .first<{ results: string }>();
  const chart = parse<ReportTile[]>(r?.results, [])[index]?.chart;
  if (!chart) throw new HttpError(404, 'No chart');
  return snapshotPng(chart);
}

/** GET /unsubscribe/<project>/<subscription>?email=&s=: take an address off a report. */
export async function unsubscribe(
  env: Env,
  project: string,
  id: string,
  email: string,
  signature: string,
): Promise<string> {
  if (!(await verify(env, 'unsubscribe', `${project}/${id}/${email}`, signature)))
    throw new HttpError(403, 'Bad link');
  const s = await getSubscription(env.DB, project, id).catch(() => null);
  if (!s) return 'That report no longer exists.';
  const emails = (s.channels.emails ?? []).filter((e) => e.toLowerCase() !== email.toLowerCase());
  const channels = { ...s.channels, emails };
  const empty = !emails.length && !(s.channels.destinations?.length ?? 0);
  await env.DB.prepare(
    'UPDATE subscriptions SET channels = ?, enabled = ? WHERE project = ? AND id = ?',
  )
    .bind(JSON.stringify(channels), empty ? 0 : s.enabled ? 1 : 0, project, id)
    .run();
  return `${email} won't get this report any more.`;
}
