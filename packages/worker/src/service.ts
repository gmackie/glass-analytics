/**
 * The Dataflare service: every operation the HTTP API, the MCP server and the
 * dashboard can perform, in one place. Inputs are validated here (with the
 * shared zod schemas), so all three surfaces behave identically and an agent
 * gets the same answer whichever way it asks.
 */

import { COHORT_PROPERTY, type CohortMembers, type Filter, toList } from '@dataflare/core/filters';
import {
  experimentSpec,
  filterSchema,
  INSIGHTS,
  type InsightKind,
  isInsightKind,
  sqlSpec,
  webSpec,
} from '@dataflare/core/insights';
import { runExperiment } from '@dataflare/core/insights/experiment';
import {
  type EventRole,
  type KeyEvent,
  runConversions,
  runHealth,
  runSources,
  SOURCE_DIMENSIONS,
  type SourceDimension,
} from '@dataflare/core/insights/report';
import { runSites } from '@dataflare/core/insights/sites';
import type { QueryContext, ResultBase } from '@dataflare/core/insights/types';
import { runWeb } from '@dataflare/core/insights/web';
import {
  EVENT_DOCUMENTATION_GUIDE,
  EVENT_NAMING_GUIDE,
  FRAMEWORKS,
  type Framework,
} from '@dataflare/core/instrument';
import { analyseReplays } from '@dataflare/core/replay-analysis';
import {
  clock,
  parseOffset,
  type ReplaySummary,
  renderSummary,
  snapshotAt,
  summariseReplay,
  type TimelineItem,
} from '@dataflare/core/replay-summary';
import { propertyText } from '@dataflare/core/sql/filters';
import { assertReadOnlySql } from '@dataflare/core/sql/guard';
import { eventsCte, num, text } from '@dataflare/core/sql/source';
import { DAY_MS, resolveRange } from '@dataflare/core/time';
import { estimateUsage } from '@dataflare/core/usage';
import {
  GLASS_VERSION,
  isNewerThan,
  UPGRADE_COMMAND,
  upgradeMessage,
} from '@dataflare/core/version';
import { z } from 'zod/v4';
import type { Env } from './env.ts';
import { continueErasure, ERASURE_SLICES_PER_REQUEST, startErasure } from './erasure.ts';
import {
  type CreateExperimentInput,
  createExperiment,
  getExperiment,
  listExperiments,
  transitionExperiment,
} from './experiments.ts';
import { deleteFlag, getFlag, listFlags, saveFlag } from './flags.ts';
import { HttpError } from './http.ts';
import { upsertPerson } from './ingest.ts';
import { DEFAULT_INSIGHTS } from './insight-defaults.ts';
import { fetchLatestVersion } from './latest.ts';
import { createProject, listProjects, resolveProject } from './projects.ts';
import {
  addNote,
  deleteNote,
  getReplay,
  listNotes,
  listReplays,
  loadReplayEvents,
  loadReplayPages,
  type ReplayQuery,
  type ReplayRow,
  readCachedSummary,
  replaysEnabled,
  writeCachedSummary,
} from './replays.ts';
import type { EventStore } from './stores/types.ts';

const project = z.string().optional();
/** Event-store matches feeding a replay search are capped (they are inlined into a D1 query). */
const SESSION_MATCH_LIMIT = 1000;
/** A session that hasn't uploaded anything for this long is finished, and its summary can be cached. */
const SETTLED_MS = 30 * 60_000;
/** analyse_replays computes at most this many missing summaries per call (each reads every chunk of a session). */
const FRESH_SUMMARIES_PER_CALL = 3;
const insightKind = z.enum(['trends', 'funnel', 'retention']);

const csv = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : v;
const jsonValue = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** Ways to narrow down recorded sessions, shared by list_replays and analyse_replays. */
const replayFilters = {
  project,
  person: z.string().optional().describe('Only sessions of this person (user id or device id).'),
  with_errors: z
    .boolean()
    .optional()
    .describe('Only sessions with JavaScript errors. Same as has: ["errors"].'),
  has: z
    .preprocess(
      csv,
      z.array(
        z.enum([
          'errors',
          'rage_clicks',
          'dead_clicks',
          'console_errors',
          'failed_requests',
          'frustration',
        ]),
      ),
    )
    .optional()
    .describe(
      'Only sessions with all of these signals. "frustration" is any of them. Dead clicks are known once a session is summarised (~30 min after it ends).',
    ),
  from: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Start of the window, e.g. "-7d". Default: all retained sessions.'),
  to: z.union([z.string(), z.number()]).optional(),
  min_duration: z.coerce
    .number()
    .min(0)
    .optional()
    .describe('Only sessions at least this many seconds long.'),
  search: z
    .string()
    .optional()
    .describe(
      "Text to find: a session or person id, a URL, or (in summarised sessions) a clicked element's label or selector or an error message.",
    ),
  url: z
    .string()
    .optional()
    .describe('Only sessions that visited a URL containing this text, e.g. "/checkout".'),
  did_event: z
    .string()
    .optional()
    .describe(
      'Only sessions where this event happened, e.g. "plan_selected". With url: on that URL.',
    ),
  not_event: z
    .string()
    .optional()
    .describe(
      'Exclude sessions where this event happened, e.g. "signup_completed" to watch people who dropped off.',
    ),
  filters: z
    .preprocess(jsonValue, z.array(filterSchema))
    .optional()
    .describe(
      'Event or person filters any event in the session must match, e.g. [{"property":"utm_source","value":"google"}] or a cohort.',
    ),
};

/** Date range and filters shared by the Reports queries. */
const reportRange = {
  project,
  from: z.union([z.string(), z.number()]).optional().describe('Start, e.g. "-30d". Default -30d.'),
  to: z.union([z.string(), z.number()]).optional(),
  filters: z
    .preprocess(jsonValue, z.array(filterSchema))
    .optional()
    .describe('Only events matching these, e.g. [{"property":"utm_source","value":"google"}].'),
};

export const inputs = {
  overview: z.object({
    project,
    from: z.union([z.string(), z.number()]).optional(),
    to: z.union([z.string(), z.number()]).optional(),
  }),
  sites: z.object({
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Start, e.g. "-30d". Default -30d.'),
    to: z.union([z.string(), z.number()]).optional(),
  }),
  markEvent: z.object({
    project,
    event: z.string().describe('Event name, e.g. "signup_completed".'),
    role: z
      .enum(['conversion', 'important', 'none'])
      .describe(
        '"conversion": a goal the site exists for (signup, purchase, pledge, lead); Reports show its conversion rate overall and per source. "important": worth watching but not a goal (share, search, download). "none" clears it.',
      ),
  }),
  reportConversions: z.object(reportRange),
  reportSources: z.object({
    ...reportRange,
    dimension: z
      .enum(Object.keys(SOURCE_DIMENSIONS) as [SourceDimension, ...SourceDimension[]])
      .optional()
      .describe(
        'Group visitors by this, attributed to their first visit in the range. Default "channel".',
      ),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  reportHealth: z.object(reportRange),
  usage: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Days of history to project from. Default 7.'),
  }),
  listEvents: z.object({
    project,
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Look-back window in days. Default 30.'),
  }),
  describeEvent: z.object({
    project,
    event: z.string().describe('Event name, e.g. "signup_completed".'),
  }),
  defineEvent: z.object({
    project,
    event: z.string().describe('Event name, e.g. "signup_completed".'),
    description: z
      .string()
      .optional()
      .describe(
        'How and when this event is fired: the user action or code path that triggers capture. Example: "Fired when payment succeeds and the account is marked active."',
      ),
    owner: z.string().optional().describe('Team or person responsible for this event.'),
    properties: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Property name → what it means and which values to expect. Example: { "plan": "Chosen plan id (free|pro|enterprise)", "amount": "Charge in the account currency" }.',
      ),
  }),
  propertyValues: z.object({
    project,
    property: z
      .string()
      .describe(
        'Property to list values of: a column ("utm_source"), event property ("plan") or person property ("person.plan"). "cohort" lists saved cohorts.',
      ),
    event: z.string().optional().describe('Only values seen on this event.'),
    query: z.string().optional().describe('Only values containing this text (case-insensitive).'),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Look-back window in days. Default 30.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  }),
  listPersonProperties: z.object({ project }),
  instrument: z.object({
    event: z
      .string()
      .describe('Event name to track, snake_case past tense, e.g. "checkout_started".'),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Example properties to send with it.'),
    framework: z
      .enum(Object.keys(FRAMEWORKS) as [Framework, ...Framework[]])
      .optional()
      .describe('Defaults to plain HTML / script tag.'),
    project,
  }),
  searchPersons: z.object({
    project,
    query: z.string().optional().describe('Matches person id or any property value.'),
    limit: z.number().int().min(1).max(200).optional(),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Window for the anonymous-device count. Default 30.'),
  }),
  getPerson: z.object({
    project,
    person_id: z.string().describe('Your user id, or an anonymous device id.'),
  }),
  setPersonProperties: z.object({
    project,
    person_id: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  cohortDefinition: z.object({
    filters: z
      .array(filterSchema)
      .default([])
      .describe('Person/event filters, e.g. [{"property":"person.plan","value":"pro"}].'),
    didEvent: z
      .string()
      .optional()
      .describe('Only people who did this event in the look-back window.'),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Look-back for membership. Default -90d.'),
  }),
  listCohorts: z.object({ project }),
  saveCohort: z.object({
    project,
    key: z.string().optional().describe('Stable id. Defaults to a slug of the name.'),
    name: z.string().min(1).describe('Human label, e.g. "Pro plan".'),
    filters: z.array(filterSchema).default([]),
    didEvent: z.string().optional(),
    from: z.union([z.string(), z.number()]).optional(),
  }),
  deleteCohort: z.object({ project, key: z.string() }),
  countCohort: z.object({
    project,
    filters: z.array(filterSchema).default([]),
    didEvent: z.string().optional(),
    from: z.union([z.string(), z.number()]).optional(),
  }),
  listReplays: z.object({
    ...replayFilters,
    sort: z
      .enum(['newest', 'oldest', 'longest', 'most_active', 'most_errors', 'most_frustrated'])
      .optional()
      .describe('Default "newest". "most_frustrated" weighs rage clicks, dead clicks and errors.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe('For paging: skip this many sessions.'),
  }),
  replay: z.object({
    project,
    session_id: z.string(),
    format: z
      .enum(['text', 'json'])
      .optional()
      .describe(
        '"json" adds the structured timeline (one item per click, page, error, request, note).',
      ),
    detail: z
      .enum(['normal', 'full'])
      .optional()
      .describe('"full" also lists routine console logs and successful network requests.'),
  }),
  replayEvents: z.object({ project, session_id: z.string() }),
  replaySnapshot: z.object({
    project,
    session_id: z.string(),
    at: z
      .union([z.string(), z.number()])
      .describe(
        'Moment to describe: "mm:ss" from the start of the transcript (e.g. "01:24"), a string of seconds ("84"), or a number of ms.',
      ),
  }),
  analyseReplays: z.object({
    ...replayFilters,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Most recent matching sessions to analyse. Default 30.'),
  }),
  annotateReplay: z.object({
    project,
    session_id: z.string(),
    at: z
      .union([z.string(), z.number()])
      .describe(
        'Moment the note is about: "mm:ss" from the start of the transcript (e.g. "00:14"), a string of seconds, or a number of ms.',
      ),
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'What happened or why, e.g. "Pay is disabled because email validation failed silently".',
      ),
    author: z.string().max(60).optional().describe('Shown next to the note. Default "agent".'),
  }),
  deleteReplayNote: z.object({ project, session_id: z.string(), id: z.string() }),
  flagKey: z.object({ project, key: z.string() }),
  saveFlag: z.object({
    project,
    key: z.string().describe('Flag key, e.g. "new-checkout".'),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    rollout: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Percentage of users who get the flag.'),
    variants: z
      .array(z.object({ key: z.string(), weight: z.number().min(0) }))
      .optional()
      .describe('For multivariate flags; first is control.'),
    rules: z
      .array(
        z.object({
          conditions: z.array(filterSchema),
          rollout: z.number().min(0).max(100).optional(),
          variant: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        'Targeting rules, first match wins, e.g. [{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}].',
      ),
  }),
  createExperiment: z.object({
    project,
    key: z.string().describe('Experiment key, e.g. "pricing-page-v2".'),
    flag: z
      .string()
      .optional()
      .describe(
        'Existing multivariate flag to use. Default: a new flag named after the experiment with control/test 50/50.',
      ),
    goal: z.object({
      event: z.string(),
      filters: z.array(filterSchema).optional(),
      value: z.string().optional(),
    }),
    secondary: z
      .array(z.object({ event: z.string(), filters: z.array(filterSchema).optional() }))
      .optional(),
    hypothesis: z.string().optional(),
    variants: z.array(z.object({ key: z.string(), weight: z.number().min(0) })).optional(),
  }),
  experimentKey: z.object({ project, key: z.string() }),
  updateExperiment: z.object({
    project,
    key: z.string(),
    action: z.enum(['start', 'stop', 'ship']),
    variant: z.string().optional().describe('Required for "ship": the variant everyone gets.'),
  }),
  createProject: z.object({
    id: z.string().describe('Lowercase id, e.g. "acme-web".'),
    name: z.string().optional(),
    allowed_origins: z
      .array(z.string())
      .optional()
      .describe('Restrict browser ingest to these origins.'),
  }),
  listInsights: z.object({ project }),
  getInsight: z.object({ project, key: z.string() }),
  saveInsight: z.object({
    project,
    key: z.string().optional().describe('Stable id. Defaults to a slug of the name.'),
    name: z.string().min(1).describe('Title shown in the Insights list.'),
    description: z.string().optional().describe('Short explanation of what this analysis answers.'),
    kind: insightKind,
    spec: z
      .record(z.string(), z.unknown())
      .describe('Query spec without kind/project (series, steps, cohortEvent, …).'),
  }),
  deleteInsight: z.object({ project, key: z.string() }),
};

export class GlassService {
  readonly env: Env;
  readonly store: EventStore;
  readonly baseUrl: string;

  constructor(env: Env, store: EventStore, baseUrl: string) {
    this.env = env;
    this.store = store;
    this.baseUrl = baseUrl;
  }

  private async context(requested?: string): Promise<QueryContext> {
    const project = await resolveProject(this.env.DB, requested);
    return { dialect: this.store.dialect, project, execute: (sql) => this.store.query(sql) };
  }

  /** A link to the same view in the dashboard, included in every response. */
  link(route: string, params: Record<string, unknown> = {}): string {
    const q = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ).toString();
    return `${this.baseUrl}/app#/${route}${q ? `?${q}` : ''}`;
  }

  async health() {
    const latest = await fetchLatestVersion();
    const upgradeAvailable = latest != null && isNewerThan(latest, GLASS_VERSION);
    return {
      ok: true,
      version: GLASS_VERSION,
      latest,
      upgradeAvailable,
      upgradeCommand: UPGRADE_COMMAND,
      store: this.store.kind,
      freshnessSeconds: this.store.freshnessSeconds,
      replay: replaysEnabled(this.env),
      ...(upgradeAvailable && latest ? { summary: upgradeMessage(GLASS_VERSION, latest) } : {}),
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  async runInsight(kind: string, input: unknown) {
    if (!isInsightKind(kind)) {
      throw new HttpError(
        400,
        `Unknown query kind "${kind}"`,
        `Use one of: ${Object.keys(INSIGHTS).join(', ')}, or the sql tool.`,
      );
    }
    const def = INSIGHTS[kind as InsightKind];
    const spec = def.schema.parse(input) as { project?: string };
    const ctx = await this.context(spec.project);
    const run = def.run as unknown as (s: unknown, c: QueryContext) => Promise<ResultBase>;
    const result = await run(await this.resolveCohorts(ctx.project, spec), ctx);
    // Web lives under Reports; trends/funnel/retention stay as ephemeral Insights links.
    const route = kind === 'web' ? 'reports' : `insights/${kind}`;
    return {
      ...result,
      project: ctx.project,
      dashboard: this.link(route, { project: ctx.project, spec: { ...spec, project: undefined } }),
    };
  }

  async sql(input: unknown) {
    const spec = sqlSpec.parse(input);
    const ctx = await this.context(spec.project);
    const safe = this.store.userSql(assertReadOnlySql(spec.query));
    const limit = spec.limit ?? 1000;
    const wrapped = `SELECT * FROM (${safe}) glass_q LIMIT ${limit}`;
    const rows = await this.store.query(wrapped);
    return {
      kind: 'sql',
      project: ctx.project,
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows,
      sql: [wrapped],
      summary: `${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length === limit ? ` (limit ${limit} reached)` : ''}.`,
      tables: this.store.userTables,
      dashboard: this.link('sql', { project: ctx.project, query: spec.query }),
    };
  }

  /** Headline numbers for a period plus the events that moved most. A good first call. */
  async overview(input: unknown) {
    const spec = inputs.overview.parse(input);
    const ctx = await this.context(spec.project);
    const web = await runWeb(webSpec.parse({ from: spec.from, to: spec.to }), ctx);
    const range = resolveRange(spec.from, spec.to);
    const length = range.to - range.from;
    const d = this.store.dialect;
    const sql = `SELECT event,
  SUM(CASE WHEN ts_ms >= ${range.from} THEN 1 ELSE 0 END) AS cur,
  SUM(CASE WHEN ts_ms < ${range.from} THEN 1 ELSE 0 END) AS prev
FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND ts_ms >= ${range.from - length} AND ts_ms < ${range.to}
GROUP BY event ORDER BY cur DESC, event ASC LIMIT 50`;
    const rows = await this.store.query(sql);
    const events = rows.map((r) => {
      const cur = num(r.cur);
      const prev = num(r.prev);
      return {
        event: text(r.event),
        count: cur,
        previous: prev,
        change: prev ? (cur - prev) / prev : null,
      };
    });
    const movers = events
      .filter((e) => e.count + e.previous >= 20 && e.change !== null && Math.abs(e.change) >= 0.2)
      .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))
      .slice(0, 5);
    const top = (k: keyof typeof web.breakdowns) => web.breakdowns[k].slice(0, 5);
    const [health, goals] = await Promise.all([this.health(), this.keyEvents(ctx.project)]);
    const conversions = goals.length
      ? await runConversions(
          { from: spec.from ?? '-30d', to: spec.to, goals },
          { ...ctx, execute: (q) => this.store.query(q) },
        )
      : null;
    const baseSummary =
      `${web.summary} ` +
      (movers.length
        ? `Biggest movers: ${movers.map((m) => `${m.event} ${m.change! > 0 ? '+' : ''}${Math.round(m.change! * 100)}%`).join(', ')}.`
        : 'No events moved more than 20% vs the previous period.');
    return {
      project: ctx.project,
      range: web.range,
      web: { totals: web.totals, previous: web.previous },
      topPages: top('pages'),
      topReferrers: top('referrers'),
      topErrors: top('errors'),
      keyEvents: conversions
        ? conversions.goals.map((g) => ({
            event: g.event,
            role: g.role,
            count: g.count,
            visitors: g.visitors,
            rate: g.rate,
            previous: g.previous,
          }))
        : [],
      ...(goals.length
        ? {}
        : {
            hint: 'No conversion events are marked. Use list_events, then mark_event with role "conversion" on the events that mean success (signup, purchase).',
          }),
      events: events.slice(0, 15),
      movers,
      upgradeAvailable: health.upgradeAvailable,
      ...(health.upgradeAvailable
        ? {
            upgrade: {
              version: health.version,
              latest: health.latest,
              command: health.upgradeCommand,
            },
          }
        : {}),
      summary: `${conversions ? `${baseSummary} Key events: ${conversions.summary}` : baseSummary}${health.upgradeAvailable && health.latest ? ` ${upgradeMessage(health.version, health.latest)}` : ''}`,
      sql: [...web.sql, sql],
      dashboard: this.link('reports', { project: ctx.project, from: spec.from, to: spec.to }),
    };
  }

  /** Every project side by side for one range, with each one's change vs the previous period. */
  async sites(input: unknown) {
    const spec = inputs.sites.parse(input);
    const projects = (await listProjects(this.env.DB)).map((p) => p.id);
    const result = await runSites({ from: spec.from ?? '-30d', to: spec.to }, projects, {
      dialect: this.store.dialect,
      execute: (sql) => this.store.query(sql),
    });
    return {
      ...result,
      sites: result.sites.map((site) => ({
        ...site,
        dashboard: this.link('reports', { project: site.project, from: spec.from, to: spec.to }),
      })),
      dashboard: this.link('sites', { from: spec.from, to: spec.to }),
    };
  }

  // ── Key events and report queries ───────────────────────────────────────

  /** Events marked as conversions or important, conversions first. */
  async keyEvents(project: string): Promise<KeyEvent[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT event, role, description FROM event_definitions WHERE project = ? AND role IN ('conversion', 'important') ORDER BY role, event",
    )
      .bind(project)
      .all<{ event: string; role: EventRole; description: string }>();
    return results;
  }

  async markEvent(input: unknown) {
    const spec = inputs.markEvent.parse(input);
    const ctx = await this.context(spec.project);
    const role = spec.role === 'none' ? '' : spec.role;
    await this.env.DB.prepare(
      `INSERT INTO event_definitions (project, event, role, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project, event) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    )
      .bind(ctx.project, spec.event, role, Date.now())
      .run();
    const all = await this.keyEvents(ctx.project);
    return {
      project: ctx.project,
      event: spec.event,
      role: role || null,
      keyEvents: all,
      summary: role
        ? `"${spec.event}" is now ${role === 'conversion' ? 'a conversion' : 'an important event'}. Reports show it with its rate${role === 'conversion' ? ' overall and per traffic source' : ''}.`
        : `"${spec.event}" is no longer a key event.`,
      dashboard: this.link('reports', { project: ctx.project }),
    };
  }

  private async reportContext(spec: { project?: string; filters?: unknown }) {
    const ctx = await this.context(spec.project);
    const { filters } = await this.resolveCohorts(ctx.project, {
      filters: (spec.filters ?? []) as Filter[],
    });
    return { ctx, filters: filters as Filter[] };
  }

  /** Counts and rates of key events, for the Reports pages. */
  async reportConversions(input: unknown) {
    const spec = inputs.reportConversions.parse(input);
    const { ctx, filters } = await this.reportContext(spec);
    const goals = await this.keyEvents(ctx.project);
    const r = await runConversions({ from: spec.from, to: spec.to, filters, goals }, ctx);
    return { project: ctx.project, ...r };
  }

  /** Visitors by channel, referrer, campaign or landing page (first touch), with conversion rates. */
  async reportSources(input: unknown) {
    const spec = inputs.reportSources.parse(input);
    const { ctx, filters } = await this.reportContext(spec);
    const goals = await this.keyEvents(ctx.project);
    const conversions = goals.filter((g) => g.role === 'conversion').map((g) => g.event);
    const r = await runSources(
      {
        from: spec.from,
        to: spec.to,
        filters,
        dimension: spec.dimension ?? 'channel',
        conversions,
        limit: spec.limit,
      },
      ctx,
    );
    return {
      project: ctx.project,
      conversions,
      ...r,
      summary: r.rows.length
        ? `Top ${SOURCE_DIMENSIONS[r.dimension].toLowerCase()}s by visitors: ${r.rows
            .slice(0, 5)
            .map(
              (x) =>
                `${x.value} ${x.visitors}${conversions.length ? ` (${(x.rate * 100).toFixed(1)}% converted)` : ''}`,
            )
            .join(', ')}.`
        : 'No visitors in this range.',
    };
  }

  /** Errors over time and sessions affected, likely 404 pages, and the slowest pages. */
  async reportHealth(input: unknown) {
    const spec = inputs.reportHealth.parse(input);
    const { ctx, filters } = await this.reportContext(spec);
    const r = await runHealth({ from: spec.from, to: spec.to, filters }, ctx);
    let frustration: {
      rageClicks: number;
      deadClicks: number;
      failedRequests: number;
      consoleErrors: number;
      sessions: number;
    } | null = null;
    if (replaysEnabled(this.env)) {
      const range = resolveRange(spec.from ?? '-30d', spec.to);
      frustration = await this.env.DB.prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(rage_clicks), 0) AS rageClicks, COALESCE(SUM(dead_clicks), 0) AS deadClicks,
          COALESCE(SUM(failed_requests), 0) AS failedRequests, COALESCE(SUM(console_errors), 0) AS consoleErrors
         FROM replays WHERE project = ? AND started_at >= ? AND started_at < ?`,
      )
        .bind(ctx.project, range.from, range.to)
        .first();
    }
    return { project: ctx.project, ...r, replays: frustration };
  }

  // ── Usage and cost ──────────────────────────────────────────────────────

  /** What this deployment adds to the Cloudflare bill, projected to a month, with ways to cut it. */
  async usage(input: unknown) {
    const spec = inputs.usage.parse(input ?? {});
    const days = spec.days ?? 7;
    const since = Date.now() - days * DAY_MS;
    const d = this.store.dialect;
    const PV = "'$pageview'";
    const [perProject, topEvents, replayRows, storedReplays, storedEvents, sizeProbe] =
      await Promise.all([
        this.store.query(`SELECT project, COUNT(*) AS n, SUM(CASE WHEN event = ${PV} THEN 1 ELSE 0 END) AS pv, COUNT(DISTINCT session_id) AS sessions
FROM ${d.table('events')} WHERE ts_ms >= ${since} GROUP BY project`),
        this.store.query(
          `SELECT event, COUNT(*) AS n FROM ${d.table('events')} WHERE ts_ms >= ${since} GROUP BY event ORDER BY n DESC, event ASC LIMIT 10`,
        ),
        replaysEnabled(this.env)
          ? this.env.DB.prepare(
              'SELECT project, COUNT(*) AS sessions, SUM(chunks) AS chunks, SUM(bytes) AS bytes FROM replays WHERE started_at >= ? GROUP BY project',
            )
              .bind(since)
              .all<{ project: string; sessions: number; chunks: number; bytes: number }>()
          : Promise.resolve({
              results: [] as { project: string; sessions: number; chunks: number; bytes: number }[],
            }),
        replaysEnabled(this.env)
          ? this.env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM replays').first<{
              bytes: number;
            }>()
          : Promise.resolve({ bytes: 0 }),
        this.store.kind === 'd1'
          ? this.env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>()
          : Promise.resolve({ n: 0 }),
        this.env.DB.prepare('SELECT 1 AS one').run(),
      ]);
    const replays = new Map(replayRows.results.map((r) => [r.project, r]));
    const projects = new Set([...perProject.map((r) => text(r.project)), ...replays.keys()]);
    const sizeAfter = Number((sizeProbe.meta as { size_after?: number }).size_after);
    const report = estimateUsage({
      days,
      store: this.store.kind === 'lake' ? 'lake' : 'd1',
      projects: [...projects].map((project) => {
        const e = perProject.find((r) => text(r.project) === project);
        const r = replays.get(project);
        return {
          project,
          events: num(e?.n),
          pageviews: num(e?.pv),
          sessions: num(e?.sessions),
          replaySessions: Number(r?.sessions ?? 0),
          replayChunks: Number(r?.chunks ?? 0),
          replayBytes: Number(r?.bytes ?? 0),
        };
      }),
      topEvents: topEvents.map((r) => ({ event: text(r.event), count: num(r.n) })),
      stored: {
        events: Number(storedEvents?.n ?? 0),
        replayBytes: Number(storedReplays?.bytes ?? 0),
        d1Bytes: Number.isFinite(sizeAfter) && sizeAfter > 0 ? sizeAfter : null,
      },
      retentionDays:
        Number(this.env.GLASS_RETENTION_DAYS) > 0 ? Number(this.env.GLASS_RETENTION_DAYS) : null,
      replayRetentionDays: Number(this.env.GLASS_REPLAY_RETENTION_DAYS ?? 30) || 30,
    });
    return { store: this.store.kind, ...report, dashboard: this.link('usage') };
  }

  // ── Event taxonomy ───────────────────────────────────────────────────────

  async listEvents(input: unknown) {
    const spec = inputs.listEvents.parse(input);
    const ctx = await this.context(spec.project);
    const since = Date.now() - (spec.days ?? 30) * DAY_MS;
    const d = this.store.dialect;
    const sql = `SELECT event, COUNT(*) AS n, MAX(ts_ms) AS last_seen FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND ts_ms >= ${since}
GROUP BY event ORDER BY n DESC, event ASC LIMIT 500`;
    const [rows, defs] = await Promise.all([
      this.store.query(sql),
      this.env.DB.prepare(
        'SELECT event, description, owner, role FROM event_definitions WHERE project = ?',
      )
        .bind(ctx.project)
        .all<{ event: string; description: string; owner: string; role: string }>(),
    ]);
    const described = new Map(defs.results.map((r) => [r.event, r]));
    const events = rows.map((r) => ({
      event: text(r.event),
      count: num(r.n),
      lastSeen: new Date(num(r.last_seen)).toISOString(),
      description: described.get(text(r.event))?.description ?? '',
      role: (described.get(text(r.event))?.role || null) as EventRole | null,
      system: text(r.event).startsWith('$'),
    }));
    const undocumented = events.filter((e) => !e.system && !e.description).map((e) => e.event);
    const keyCount = events.filter((e) => e.role).length;
    return {
      project: ctx.project,
      days: spec.days ?? 30,
      events,
      undocumented,
      summary: `${events.length} distinct events in the last ${spec.days ?? 30} days${undocumented.length ? `; ${undocumented.length} custom events have no description (use define_event)` : ''}${keyCount ? '' : '; no key events are marked yet (use mark_event to mark conversions such as signups)'}.`,
      namingGuide: EVENT_NAMING_GUIDE,
      documentationGuide: EVENT_DOCUMENTATION_GUIDE,
      sql: [sql],
      dashboard: this.link('events', { project: ctx.project }),
    };
  }

  /** Properties seen on an event (sampled), with types and example values. */
  async describeEvent(input: unknown) {
    const spec = inputs.describeEvent.parse(input);
    const ctx = await this.context(spec.project);
    const d = this.store.dialect;
    const since = Date.now() - 30 * DAY_MS;
    const sql = `SELECT props, ts_ms FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND event = ${d.str(spec.event)} AND ts_ms >= ${since}
ORDER BY ts_ms DESC LIMIT 500`;
    const rows = await this.store.query(sql);
    const props = new Map<string, { types: Set<string>; examples: Set<string>; seen: number }>();
    for (const row of rows) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text(row.props) || '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        const p = props.get(key) ?? { types: new Set(), examples: new Set(), seen: 0 };
        p.seen++;
        p.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        if (p.examples.size < 5 && value !== null && typeof value !== 'object')
          p.examples.add(String(value).slice(0, 80));
        props.set(key, p);
      }
    }
    const def = await this.env.DB.prepare(
      'SELECT description, owner, properties FROM event_definitions WHERE project = ? AND event = ?',
    )
      .bind(ctx.project, spec.event)
      .first<{ description: string; owner: string; properties: string }>();
    const documented = def ? (JSON.parse(def.properties) as Record<string, string>) : {};
    return {
      project: ctx.project,
      event: spec.event,
      sampled: rows.length,
      lastSeen: rows[0] ? new Date(num(rows[0].ts_ms)).toISOString() : null,
      description: def?.description ?? '',
      owner: def?.owner ?? '',
      properties: [...props.entries()]
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([name, p]) => ({
          name,
          types: [...p.types],
          coverage: rows.length ? p.seen / rows.length : 0,
          examples: [...p.examples],
          description: documented[name] ?? '',
        })),
      summary: rows.length
        ? `"${spec.event}": ${props.size} properties across the latest ${rows.length} events.`
        : `No "${spec.event}" events in the last 30 days.`,
      sql: [sql],
    };
  }

  /** Most common values of a property, for filter typeahead. Counts come from events, so they match what a filter would select. */
  async propertyValues(input: unknown) {
    const spec = inputs.propertyValues.parse(input);
    const ctx = await this.context(spec.project);
    const limit = spec.limit ?? 50;
    const q = spec.query?.trim().toLowerCase() ?? '';
    if (spec.property.trim() === COHORT_PROPERTY) {
      const cohorts = await this.env.DB.prepare(
        'SELECT key, name FROM cohorts WHERE project = ? ORDER BY name COLLATE NOCASE',
      )
        .bind(ctx.project)
        .all<{ key: string; name: string }>();
      const values = cohorts.results
        .filter((c) => !q || c.key.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
        .slice(0, limit)
        .map((c) => ({ value: c.key, label: c.name, count: null, people: null }));
      return {
        project: ctx.project,
        property: COHORT_PROPERTY,
        values,
        summary: `${values.length} saved cohort${values.length === 1 ? '' : 's'}.`,
        sql: [],
      };
    }
    const d = this.store.dialect;
    const now = Date.now();
    let expr: string;
    try {
      expr = propertyText(spec.property, d);
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : `Invalid property "${spec.property}"`,
        'Use a column name, an event property, or person.<name>.',
      );
    }
    const sql = `WITH ${eventsCte(d, { project: ctx.project, from: now - (spec.days ?? 30) * DAY_MS, to: now + 60_000, events: spec.event ? [spec.event] : undefined })}
SELECT v, COUNT(*) AS n, COUNT(DISTINCT pid) AS people FROM (SELECT ${expr} AS v, pid FROM ev) pv
WHERE v IS NOT NULL AND v <> ''${q ? ` AND ${d.containsIgnoreCase('v', q)}` : ''}
GROUP BY v ORDER BY n DESC, v ASC LIMIT ${d.num(limit)}`;
    const values = (await this.store.query(sql)).map((r) => ({
      value: text(r.v),
      label: text(r.v),
      count: num(r.n),
      people: num(r.people),
    }));
    return {
      project: ctx.project,
      property: spec.property,
      values,
      summary: values.length
        ? `Top ${values.length} values of "${spec.property}"${spec.event ? ` on "${spec.event}"` : ''}: ${values
            .slice(0, 5)
            .map((v) => v.value)
            .join(', ')}${values.length > 5 ? ', …' : ''}.`
        : `No values of "${spec.property}"${spec.event ? ` on "${spec.event}"` : ''} in the last ${spec.days ?? 30} days.`,
      sql: [sql],
    };
  }

  async defineEvent(input: unknown) {
    const spec = inputs.defineEvent.parse(input);
    const ctx = await this.context(spec.project);
    await this.env.DB.prepare(
      `INSERT INTO event_definitions (project, event, description, owner, properties, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, event) DO UPDATE SET description = excluded.description, owner = excluded.owner, properties = excluded.properties, updated_at = excluded.updated_at`,
    )
      .bind(
        ctx.project,
        spec.event,
        spec.description ?? '',
        spec.owner ?? '',
        JSON.stringify(spec.properties ?? {}),
        Date.now(),
      )
      .run();
    const hasDescription = Boolean(spec.description?.trim());
    const propCount = Object.keys(spec.properties ?? {}).length;
    return {
      project: ctx.project,
      event: spec.event,
      saved: true,
      summary: `Saved the definition of "${spec.event}".`,
      hint: !hasDescription
        ? 'Add a how/when description (which user action or code path fires this event).'
        : propCount === 0
          ? 'If this event has properties, call define_event again with property meanings.'
          : EVENT_DOCUMENTATION_GUIDE,
    };
  }

  instrument(input: unknown) {
    const spec = inputs.instrument.parse(input);
    const framework = spec.framework ?? 'html';
    const snippet = FRAMEWORKS[framework].snippet({
      host: this.baseUrl,
      project: spec.project ?? '<project>',
    });
    const warnings: string[] = [];
    if (spec.event.startsWith('$'))
      warnings.push('Names starting with "$" are reserved for Dataflare.');
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(spec.event))
      warnings.push(`Consider snake_case object_action names. ${EVENT_NAMING_GUIDE}`);
    return {
      framework: FRAMEWORKS[framework].name,
      install: { file: snippet.file, code: snippet.code },
      capture: snippet.capture(spec.event, spec.properties),
      declarative: `<button data-glass-event="${spec.event}"${Object.entries(spec.properties ?? {})
        .map(([k, v]) => ` data-glass-prop-${k.replace(/_/g, '-')}="${String(v)}"`)
        .join('')}>…</button>`,
      warnings,
      summary: `Add the install snippet once, then call capture where "${spec.event}" happens. After deploying, check with describe_event, then define_event with how/when it fires and property meanings.`,
    };
  }

  // ── Persons ──────────────────────────────────────────────────────────────

  async searchPersons(input: unknown) {
    const spec = inputs.searchPersons.parse(input);
    const ctx = await this.context(spec.project);
    const q = spec.query?.trim();
    const days = spec.days ?? 30;
    const [{ results }, stats] = await Promise.all([
      this.env.DB.prepare(
        `SELECT person_id, props, first_seen, last_seen FROM persons WHERE project = ?
         ${q ? 'AND (instr(lower(person_id), lower(?)) > 0 OR instr(lower(props), lower(?)) > 0)' : ''}
         ORDER BY last_seen DESC LIMIT ?`,
      )
        .bind(ctx.project, ...(q ? [q, q] : []), spec.limit ?? 50)
        .all<{ person_id: string; props: string; first_seen: number; last_seen: number }>(),
      this.peopleStats(ctx.project, days),
    ]);
    return {
      project: ctx.project,
      persons: results.map((r) => ({
        id: r.person_id,
        properties: JSON.parse(r.props) as Record<string, unknown>,
        firstSeen: new Date(r.first_seen).toISOString(),
        lastSeen: new Date(r.last_seen).toISOString(),
      })),
      stats,
      summary:
        `${stats.identified} identified ${stats.identified === 1 ? 'person' : 'people'}, ` +
        `${stats.anonymousDevices} anonymous device${stats.anonymousDevices === 1 ? '' : 's'} active in the last ${days} days` +
        (q
          ? `; showing ${results.length} matching "${q}"`
          : results.length < stats.identified
            ? `; showing the ${results.length} most recently active`
            : '') +
        '.',
      sql: stats.sql,
      dashboard: this.link('users', { project: ctx.project, q }),
    };
  }

  /** Identified people (persons table) plus anonymous devices active in the window. */
  private async peopleStats(
    project: string,
    days: number,
  ): Promise<{
    identified: number;
    anonymousDevices: number;
    days: number;
    sql: string[];
  }> {
    const from = Date.now() - days * DAY_MS;
    const identifiedRow = await this.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM persons WHERE project = ?',
    )
      .bind(project)
      .first<{ n: number }>();
    const identified = Number(identifiedRow?.n ?? 0);
    const d = this.store.dialect;
    let anonymousDevices: number;
    let sql: string;
    if (this.store.kind === 'd1') {
      // Same SQLite DB holds events, persons and identities.
      sql = `SELECT COUNT(DISTINCT e.distinct_id) AS n
FROM ${d.table('events')} e
WHERE e.project = ${d.str(project)} AND e.ts_ms >= ${d.num(from)}
  AND e.distinct_id NOT IN (SELECT distinct_id FROM identities WHERE project = ${d.str(project)})
  AND e.distinct_id NOT IN (SELECT person_id FROM persons WHERE project = ${d.str(project)})`;
      anonymousDevices = num((await this.store.query(sql))[0]?.n);
    } else {
      sql = `SELECT DISTINCT distinct_id AS d FROM ${d.table('events')}
WHERE project = ${d.str(project)} AND ts_ms >= ${d.num(from)}`;
      const [devices, linked, people] = await Promise.all([
        this.store.query(sql),
        this.env.DB.prepare('SELECT distinct_id FROM identities WHERE project = ?')
          .bind(project)
          .all<{ distinct_id: string }>(),
        this.env.DB.prepare('SELECT person_id FROM persons WHERE project = ?')
          .bind(project)
          .all<{ person_id: string }>(),
      ]);
      const skip = new Set<string>([
        ...linked.results.map((r) => r.distinct_id),
        ...people.results.map((r) => r.person_id),
      ]);
      anonymousDevices = devices.reduce((n, r) => n + (skip.has(text(r.d)) ? 0 : 1), 0);
    }
    return { identified, anonymousDevices, days, sql: [sql] };
  }

  /** Person property keys (sampled from the most recently active people), for filter pickers. */
  async listPersonProperties(input: unknown) {
    const spec = inputs.listPersonProperties.parse(input);
    const ctx = await this.context(spec.project);
    const { results } = await this.env.DB.prepare(
      'SELECT props FROM persons WHERE project = ? ORDER BY last_seen DESC LIMIT 1000',
    )
      .bind(ctx.project)
      .all<{ props: string }>();
    const props = new Map<string, { types: Set<string>; examples: Set<string>; seen: number }>();
    for (const row of results) {
      for (const [key, value] of Object.entries(safeParse(row.props))) {
        const p = props.get(key) ?? { types: new Set(), examples: new Set(), seen: 0 };
        p.seen++;
        p.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        if (p.examples.size < 5 && value !== null && typeof value !== 'object')
          p.examples.add(String(value).slice(0, 80));
        props.set(key, p);
      }
    }
    const properties = [...props.entries()]
      .sort((a, b) => b[1].seen - a[1].seen)
      .map(([name, p]) => ({
        name: `person.${name}`,
        types: [...p.types],
        coverage: results.length ? p.seen / results.length : 0,
        examples: [...p.examples],
        description: '',
      }));
    return {
      project: ctx.project,
      sampled: results.length,
      properties,
      summary: properties.length
        ? `${properties.length} person properties across the ${results.length} most recently active people. Filter on them as "person.<name>".`
        : 'No person properties yet. Send them with glass.identify(userId, { plan: "pro" }).',
    };
  }

  async getPerson(input: unknown) {
    const spec = inputs.getPerson.parse(input);
    const ctx = await this.context(spec.project);
    const id = spec.person_id;
    const [person, devices] = await Promise.all([
      this.env.DB.prepare(
        'SELECT props, first_seen, last_seen FROM persons WHERE project = ? AND person_id = ?',
      )
        .bind(ctx.project, id)
        .first<{ props: string; first_seen: number; last_seen: number }>(),
      this.env.DB.prepare('SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?')
        .bind(ctx.project, id)
        .all<{ distinct_id: string }>(),
    ]);
    const now = Date.now();
    const d = this.store.dialect;
    const sql = `WITH ${eventsCte(d, { project: ctx.project, from: now - 90 * DAY_MS, to: now + 60_000 })}
SELECT event, ts_ms, path, session_id, props FROM ev WHERE pid = ${d.str(id)} OR distinct_id = ${d.str(id)}
ORDER BY ts_ms DESC LIMIT 100`;
    const events = (await this.store.query(sql)).map((r) => ({
      event: text(r.event),
      time: new Date(num(r.ts_ms)).toISOString(),
      path: text(r.path),
      session: text(r.session_id),
      properties: safeParse(text(r.props)),
    }));
    const replays = replaysEnabled(this.env)
      ? (await listReplays(this.env.DB, ctx.project, { person: id, limit: 20 })).rows
      : [];
    if (!person && events.length === 0)
      throw new HttpError(404, `No person or device "${id}" in project "${ctx.project}"`);
    return {
      project: ctx.project,
      id,
      identified: Boolean(person),
      properties: person ? (JSON.parse(person.props) as Record<string, unknown>) : {},
      firstSeen: person ? new Date(person.first_seen).toISOString() : (events.at(-1)?.time ?? null),
      lastSeen: person ? new Date(person.last_seen).toISOString() : (events[0]?.time ?? null),
      devices: devices.results.map((r) => r.distinct_id),
      recentEvents: events,
      replays: replays.map((r) => ({
        session: r.session_id,
        started: new Date(r.started_at).toISOString(),
        errors: r.errors,
        url: r.start_url,
      })),
      summary: `${person ? 'Identified person' : 'Anonymous device'} "${id}": ${events.length} events in 90 days${replays.length ? `, ${replays.length} recorded sessions` : ''}.`,
      sql: [sql],
      dashboard: this.link(`users/${encodeURIComponent(id)}`, { project: ctx.project }),
    };
  }

  async setPersonProperties(input: unknown) {
    const spec = inputs.setPersonProperties.parse(input);
    const ctx = await this.context(spec.project);
    await upsertPerson(this.env.DB, ctx.project, spec.person_id, Date.now(), spec.properties);
    return {
      project: ctx.project,
      id: spec.person_id,
      updated: Object.keys(spec.properties),
      summary: 'Person properties updated.',
    };
  }

  /** GDPR erasure: events (where the store allows), person, identity links and replays. */
  async deletePerson(input: unknown) {
    const spec = inputs.getPerson.parse(input);
    const ctx = await this.context(spec.project);
    const devices = (
      await this.env.DB.prepare(
        'SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?',
      )
        .bind(ctx.project, spec.person_id)
        .all<{ distinct_id: string }>()
    ).results.map((r) => r.distinct_id);
    const ids = [spec.person_id, ...devices];
    const events = await this.store.deletePersonEvents(ctx.project, ids);
    // Replays go a slice at a time; whatever this request can't finish, the hourly job does.
    await startErasure(this.env, ctx.project, spec.person_id, ids);
    const erased = await continueErasure(
      this.env,
      ctx.project,
      spec.person_id,
      ids,
      ERASURE_SLICES_PER_REQUEST,
    );
    const replays = erased.replays;
    const who = `person "${spec.person_id}"`;
    const lake =
      events === 'queued'
        ? ' Their events in the lake are queued for deletion: the daily lake maintenance job removes them (see docs/lake.md).'
        : '';
    let summary: string;
    if (erased.complete) {
      summary =
        events === 'deleted'
          ? `Deleted ${who}, ${devices.length} device links, their events and ${replays} replays.`
          : `Deleted ${who}, ${devices.length} device links and ${replays} replays.${lake}`;
    } else {
      summary = `Deleted ${events === 'deleted' ? 'the events and ' : ''}${replays} replays of ${who}. More replays remain: the hourly maintenance job deletes them, then the person and their ${devices.length} device links.${lake}`;
    }
    return {
      project: ctx.project,
      id: spec.person_id,
      devices,
      eventsDeleted: events === 'deleted',
      eventsQueued: events === 'queued',
      replaysDeleted: replays,
      /** False while replays remain; the hourly job finishes the erasure. */
      complete: erased.complete,
      summary,
    };
  }

  // ── Cohorts ──────────────────────────────────────────────────────────────

  /** How many distinct people match a cohort definition in its look-back window. */
  async countCohort(input: unknown) {
    const spec = inputs.countCohort.parse(input);
    const ctx = await this.context(spec.project);
    const { count, sql, range } = await this.cohortMembership(ctx.project, {
      filters: spec.filters,
      didEvent: spec.didEvent,
      from: spec.from,
    });
    return {
      project: ctx.project,
      count,
      range,
      summary: `${count} ${count === 1 ? 'person' : 'people'} match this cohort in the selected window.`,
      sql: [sql],
    };
  }

  async listCohorts(input: unknown) {
    const spec = inputs.listCohorts.parse(input);
    const ctx = await this.context(spec.project);
    const { results } = await this.env.DB.prepare(
      'SELECT key, name, definition, created_at, updated_at FROM cohorts WHERE project = ? ORDER BY name COLLATE NOCASE',
    )
      .bind(ctx.project)
      .all<{
        key: string;
        name: string;
        definition: string;
        created_at: number;
        updated_at: number;
      }>();
    const cohorts = [];
    for (const row of results) {
      const definition = safeParse(row.definition) as {
        filters?: unknown;
        didEvent?: string;
        from?: string | number;
      };
      const filters = Array.isArray(definition.filters) ? definition.filters : [];
      const parsed = inputs.cohortDefinition.parse({
        filters,
        didEvent: definition.didEvent,
        from: definition.from,
      });
      const { count, sql } = await this.cohortMembership(ctx.project, parsed);
      cohorts.push({
        key: row.key,
        name: row.name,
        filters: parsed.filters,
        didEvent: parsed.didEvent ?? null,
        from: parsed.from ?? '-90d',
        count,
        updatedAt: new Date(row.updated_at).toISOString(),
        sql: [sql],
        retention: this.link('insights/retention', {
          project: ctx.project,
          spec: {
            cohortEvent: { event: parsed.didEvent || '$pageview', filters: parsed.filters },
            returnEvent: { event: '$pageview' },
            period: 'week',
            periods: 8,
            filters: parsed.filters,
          },
        }),
      });
    }
    return {
      project: ctx.project,
      cohorts,
      summary: cohorts.length
        ? `${cohorts.length} cohort${cohorts.length === 1 ? '' : 's'}: ${cohorts.map((c) => `${c.name} (${c.count})`).join(', ')}.`
        : 'No cohorts yet. Save a person filter from the People tab.',
      dashboard: this.link('users', { project: ctx.project }),
    };
  }

  async saveCohort(input: unknown) {
    const spec = inputs.saveCohort.parse(input);
    if (spec.filters.some((f) => f.property === COHORT_PROPERTY)) {
      throw new HttpError(
        400,
        'A cohort cannot filter on another cohort',
        "Copy the other cohort's person filters into this one instead.",
      );
    }
    const ctx = await this.context(spec.project);
    const key = (spec.key?.trim() || slugKey(spec.name)).slice(0, 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new HttpError(
        400,
        `Invalid cohort key "${key}"`,
        'Use lowercase letters, numbers, hyphens or underscores.',
      );
    }
    const definition = {
      filters: spec.filters,
      didEvent: spec.didEvent,
      from: spec.from ?? '-90d',
    };
    const now = Date.now();
    const existing = await this.env.DB.prepare(
      'SELECT key FROM cohorts WHERE project = ? AND key = ?',
    )
      .bind(ctx.project, key)
      .first();
    await this.env.DB.prepare(
      existing
        ? 'UPDATE cohorts SET name = ?, definition = ?, updated_at = ? WHERE project = ? AND key = ?'
        : 'INSERT INTO cohorts (project, key, name, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        ...(existing
          ? [spec.name, JSON.stringify(definition), now, ctx.project, key]
          : [ctx.project, key, spec.name, JSON.stringify(definition), now, now]),
      )
      .run();
    const { count, sql } = await this.cohortMembership(ctx.project, definition);
    return {
      project: ctx.project,
      key,
      name: spec.name,
      created: !existing,
      count,
      summary: `${existing ? 'Updated' : 'Created'} cohort "${spec.name}" (${count} people).`,
      sql: [sql],
      dashboard: this.link('users', { project: ctx.project }),
    };
  }

  async deleteCohort(input: unknown) {
    const spec = inputs.deleteCohort.parse(input);
    const ctx = await this.context(spec.project);
    const result = await this.env.DB.prepare('DELETE FROM cohorts WHERE project = ? AND key = ?')
      .bind(ctx.project, spec.key)
      .run();
    if (!result.meta.changes) throw new HttpError(404, `No cohort "${spec.key}"`);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted cohort "${spec.key}".` };
  }

  /**
   * Attach saved definitions to every `cohort` filter in a query spec, so core
   * can compile membership without reading the cohorts table. Returns a copy.
   */
  private async resolveCohorts<T>(project: string, spec: T): Promise<T> {
    const refs: Filter[] = [];
    const copy = structuredClone(spec);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.property === COHORT_PROPERTY) refs.push(o as unknown as Filter);
        else Object.values(o).forEach(walk);
      }
    };
    walk(copy);
    if (refs.length === 0) return copy;
    const { results } = await this.env.DB.prepare(
      'SELECT key, definition FROM cohorts WHERE project = ?',
    )
      .bind(project)
      .all<{ key: string; definition: string }>();
    const saved = new Map(results.map((r) => [r.key, r.definition]));
    const now = Date.now();
    for (const f of refs) {
      f.cohorts = {};
      for (const key of toList(f.value)) {
        const raw = saved.get(key);
        if (raw === undefined) {
          throw new HttpError(
            400,
            `No cohort "${key}" in project "${project}"`,
            saved.size
              ? `Saved cohorts: ${[...saved.keys()].join(', ')}.`
              : 'Save one with save_cohort or from the People tab first.',
          );
        }
        const def = inputs.cohortDefinition.parse(safeParse(raw));
        const range = resolveRange(def.from ?? '-90d', undefined, now);
        const members: CohortMembers = {
          project,
          from: range.from,
          to: range.to,
          filters: def.filters as Filter[],
        };
        if (def.didEvent) members.events = [def.didEvent];
        f.cohorts[key] = members;
      }
    }
    return copy;
  }

  private async cohortMembership(
    project: string,
    definition: { filters?: Filter[]; didEvent?: string; from?: string | number },
  ): Promise<{ count: number; sql: string; range: { from: number; to: number } }> {
    const range = resolveRange(definition.from ?? '-90d', undefined);
    const d = this.store.dialect;
    const sql = `WITH ${eventsCte(d, {
      project,
      from: range.from,
      to: range.to,
      events: definition.didEvent ? [definition.didEvent] : undefined,
      filters: definition.filters,
    })}
SELECT COUNT(DISTINCT pid) AS n FROM ev`;
    const count = num((await this.store.query(sql))[0]?.n);
    return { count, sql, range };
  }

  // ── Replays ──────────────────────────────────────────────────────────────

  private replayLink(project: string, session: string, t?: number): string {
    return this.link(`replays/${session}`, {
      project,
      t: t === undefined ? undefined : String(Math.round(t)),
    });
  }

  private replayItem(project: string, r: ReplayRow) {
    const summarised = r.summary_chunks != null;
    return {
      session: r.session_id,
      person: r.user_id ?? r.distinct_id,
      started: new Date(r.started_at).toISOString(),
      durationSeconds: Math.round((r.ended_at - r.started_at) / 1000),
      activeSeconds: r.active_ms == null ? null : Math.round(r.active_ms / 1000),
      pages: r.pages,
      clicks: r.clicks,
      rageClicks: r.rage_clicks,
      deadClicks: summarised ? r.dead_clicks : null,
      errors: r.errors,
      consoleErrors: r.console_errors,
      failedRequests: r.failed_requests,
      url: r.start_url,
      device: [r.device, r.browser, r.country].filter(Boolean).join(', '),
      summarised,
      dashboard: this.replayLink(project, r.session_id),
    };
  }

  /** Session ids (most recent first) with an event matching the conditions, from the event store. */
  private async sessionsWithEvents(
    project: string,
    range: { from: number; to: number },
    where: { event?: string; filters?: Filter[]; url?: string },
  ): Promise<string[]> {
    const d = this.store.dialect;
    const { filters } = await this.resolveCohorts(project, { filters: where.filters ?? [] });
    const url = where.url ? `\n  AND LOWER(url) LIKE ${d.str(`%${where.url.toLowerCase()}%`)}` : '';
    const sql = `WITH ${eventsCte(d, { project, from: range.from, to: range.to, events: where.event ? [where.event] : undefined, filters: filters as Filter[] })}
SELECT session_id, MAX(ts_ms) AS last_ms FROM ev
WHERE session_id IS NOT NULL AND session_id <> ''${url}
GROUP BY session_id ORDER BY last_ms DESC LIMIT ${SESSION_MATCH_LIMIT}`;
    return (await this.store.query(sql)).map((r) => text(r.session_id));
  }

  /** Turn list/analyse filters into a query on the replays index (resolving event conditions through the event store). */
  private async replayQuery(
    projectId: string,
    spec: z.infer<z.ZodObject<typeof replayFilters>>,
  ): Promise<ReplayQuery & { capped: boolean }> {
    const explicit = spec.from !== undefined || spec.to !== undefined;
    const range = explicit ? resolveRange(spec.from ?? '-30d', spec.to) : undefined;
    const has = [...(spec.has ?? []), ...(spec.with_errors ? (['errors'] as const) : [])];
    const q: ReplayQuery & { capped: boolean } = {
      person: spec.person,
      has: [...new Set(has)],
      from: range?.from,
      to: range?.to,
      minDurationMs: spec.min_duration ? spec.min_duration * 1000 : undefined,
      search: spec.search?.trim() || undefined,
      capped: false,
    };
    // Event conditions look a little past the window: a session's events can trail its start.
    const window = range ?? resolveRange('-90d', undefined);
    const eventRange = { from: window.from, to: window.to + DAY_MS };
    if (spec.did_event || spec.filters?.length || spec.url) {
      const sessions = await this.sessionsWithEvents(projectId, eventRange, {
        event: spec.did_event,
        filters: spec.filters as Filter[] | undefined,
        url: spec.url,
      });
      q.sessions = sessions;
      q.capped = sessions.length >= SESSION_MATCH_LIMIT;
      // Recordings can start before the SDK's first pageview arrives: also match on the recorded first page.
      if (spec.url && !spec.did_event && !spec.filters?.length) q.startUrl = spec.url;
    }
    if (spec.not_event) {
      q.excludeSessions = await this.sessionsWithEvents(projectId, eventRange, {
        event: spec.not_event,
      });
    }
    return q;
  }

  async listReplays(input: unknown) {
    const spec = inputs.listReplays.parse(input);
    const ctx = await this.context(spec.project);
    if (!replaysEnabled(this.env))
      return {
        project: ctx.project,
        enabled: false,
        total: 0,
        replays: [],
        summary: 'Session replay is not enabled on this deployment.',
      };
    const q = await this.replayQuery(ctx.project, spec);
    const { rows, total } = await listReplays(this.env.DB, ctx.project, {
      ...q,
      sort: spec.sort,
      limit: spec.limit,
      offset: spec.offset,
    });
    const offset = spec.offset ?? 0;
    const more = offset + rows.length < total;
    return {
      project: ctx.project,
      enabled: true,
      total,
      offset,
      replays: rows.map((r) => this.replayItem(ctx.project, r)),
      summary: `${total} recorded session${total === 1 ? '' : 's'} match${total === 1 ? 'es' : ''}${rows.length < total ? `; showing ${offset + 1}–${offset + rows.length}` : ''}.${more ? ` Pass offset: ${offset + rows.length} for more.` : ''}${q.capped ? ` Event conditions matched the most recent ${SESSION_MATCH_LIMIT} sessions only; narrow the window with from/to.` : ''} Use summarise_replay to read one, analyse_replays for patterns across them.`,
    };
  }

  async replayEvents(input: unknown) {
    const spec = inputs.replayEvents.parse(input);
    const ctx = await this.context(spec.project);
    const meta = await this.replayRow(ctx.project, spec.session_id);
    return { meta, events: await loadReplayEvents(this.env, ctx.project, spec.session_id) };
  }

  private async replayRow(project: string, session: string): Promise<ReplayRow> {
    if (!replaysEnabled(this.env))
      throw new HttpError(
        501,
        'Session replay is not enabled on this deployment',
        'Enable R2 on your Cloudflare account, then run `dataflare upgrade`.',
      );
    const row = await getReplay(this.env.DB, project, session);
    if (!row)
      throw new HttpError(
        404,
        `No replay for session "${session}"`,
        'Find sessions with list_replays (GET /api/replays).',
      );
    return row;
  }

  /** Dataflare events recorded in the same session (pageviews, custom events, errors). */
  private async sessionEvents(project: string, row: ReplayRow) {
    const d = this.store.dialect;
    const sql = `SELECT event, ts_ms, path, url, title, props FROM ${d.table('events')}
WHERE project = ${d.str(project)} AND session_id = ${d.str(row.session_id)}
  AND ts_ms >= ${row.started_at - 60_000} AND ts_ms <= ${row.ended_at + 60_000}
ORDER BY ts_ms LIMIT 2000`;
    return (await this.store.query(sql)).map((r) => ({
      event: text(r.event),
      ts_ms: num(r.ts_ms),
      path: text(r.path),
      url: text(r.url),
      title: text(r.title),
      props: safeParse(text(r.props)),
    }));
  }

  /**
   * A session's summary without notes: from the cache when it covers every
   * chunk, otherwise computed (and cached once the session has settled).
   */
  private async replaySummary(
    project: string,
    row: ReplayRow,
  ): Promise<Omit<ReplaySummary, 'text'>> {
    const cached = await readCachedSummary<Omit<ReplaySummary, 'text'>>(this.env, project, row);
    if (cached) return cached;
    const [pages, events] = await Promise.all([
      loadReplayPages(this.env, project, row.session_id),
      this.sessionEvents(project, row),
    ]);
    const { text: _text, ...base } = summariseReplay(
      pages.map((p) => p.events),
      events,
    );
    if (row.ended_at < Date.now() - SETTLED_MS) await this.cacheSummary(project, row, base);
    return base;
  }

  private async cacheSummary(
    project: string,
    row: ReplayRow,
    base: Omit<ReplaySummary, 'text'>,
  ): Promise<void> {
    const parts = new Set<string>();
    for (const item of base.timeline) {
      if (item.kind === 'page' && item.url) parts.add(item.url);
      if (item.label) parts.add(item.label);
      if (item.selector) parts.add(item.selector);
      if (item.kind === 'error' || item.kind === 'event' || item.level === 'error')
        parts.add(item.text);
    }
    await writeCachedSummary(this.env, project, row, base, {
      deadClicks: base.stats.deadClicks,
      activeMs: base.stats.activeSeconds * 1000,
      digest: [...parts].join(' | '),
    });
  }

  /** Summarise sessions that ended a while ago, so search and analysis can read them cheaply. Called by the cron. */
  async summariseSettled(rows: (ReplayRow & { project: string })[]): Promise<number> {
    let done = 0;
    for (const row of rows) {
      try {
        await this.replaySummary(row.project, row);
        done++;
      } catch (err) {
        console.warn('[glass] could not summarise replay', row.session_id, err);
      }
    }
    return done;
  }

  /** Epoch ms that transcript times count from: the first recorded or Dataflare event of the session. */
  private async sessionStart(project: string, row: ReplayRow): Promise<number> {
    const d = this.store.dialect;
    const first = await this.store.query(`SELECT MIN(ts_ms) AS first_ms FROM ${d.table('events')}
WHERE project = ${d.str(project)} AND session_id = ${d.str(row.session_id)} AND ts_ms >= ${row.started_at - 60_000} AND ts_ms <= ${row.ended_at + 60_000}`);
    const ts = num(first[0]?.first_ms);
    return ts > 0 ? Math.min(ts, row.started_at) : row.started_at;
  }

  private offset(at: string | number): number {
    try {
      return parseOffset(at);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  /** A transcript of a session: what the user saw, clicked, typed into, and what broke. */
  async summariseReplay(input: unknown) {
    const spec = inputs.replay.parse(input);
    const ctx = await this.context(spec.project);
    const row = await this.replayRow(ctx.project, spec.session_id);
    const [base, notes] = await Promise.all([
      this.replaySummary(ctx.project, row),
      listNotes(this.env.DB, ctx.project, row.session_id),
    ]);
    const person = row.user_id ?? row.distinct_id;
    const device = [row.device, row.browser, row.country].filter(Boolean).join(', ');
    const full = renderSummary(base, {
      sessionId: row.session_id,
      person,
      device,
      detail: spec.detail,
      notes: notes.map((n) => ({ id: n.id, ts: n.ts_ms, text: n.text, author: n.author })),
    });
    const important = (i: TimelineItem) =>
      i.level === 'error' || Boolean(i.signals?.length) || i.kind === 'note';
    return {
      project: ctx.project,
      session: row.session_id,
      person,
      device,
      started: new Date(row.started_at).toISOString(),
      transcript: full.text,
      stats: full.stats,
      highlights: full.timeline
        .filter(important)
        .slice(0, 25)
        .map((i) => ({
          at: clock(i.t),
          what: i.text,
          link: this.replayLink(ctx.project, row.session_id, i.t),
        })),
      notes: notes.map((n) => ({
        id: n.id,
        at: clock(n.ts_ms - full.startedAt),
        text: n.text,
        author: n.author,
      })),
      ...(spec.format === 'json'
        ? { startedAt: full.startedAt, endedAt: full.endedAt, timeline: full.timeline }
        : {}),
      summary: full.text.split('\n').slice(0, 4).join(' '),
      hint: 'Use replay_snapshot with a time from the transcript to read what was on screen; annotate_replay to leave a finding on the timeline.',
      dashboard: this.replayLink(ctx.project, row.session_id),
    };
  }

  /** What was on screen at one moment of a session, as text. */
  async replaySnapshot(input: unknown) {
    const spec = inputs.replaySnapshot.parse(input);
    const ctx = await this.context(spec.project);
    const row = await this.replayRow(ctx.project, spec.session_id);
    const t = this.offset(spec.at);
    const [pages, start] = await Promise.all([
      loadReplayPages(this.env, ctx.project, row.session_id),
      this.sessionStart(ctx.project, row),
    ]);
    const shot = snapshotAt(
      pages.map((p) => p.events),
      start + t,
    );
    return {
      project: ctx.project,
      session: row.session_id,
      at: clock(t),
      url: shot.url,
      viewport: shot.viewport,
      scrollY: shot.scrollY,
      screen: shot.text,
      summary: `Screen at ${clock(t)}${shot.url ? ` on ${shot.url}` : ''}${shot.viewport ? ` (${shot.viewport}, scrolled ${shot.scrollY}px)` : ''}. Inputs are masked by the recorder.`,
      dashboard: this.replayLink(ctx.project, row.session_id, t),
    };
  }

  /** Patterns across many sessions: rage- and dead-clicked elements, errors, failing requests, exit pages. */
  async analyseReplays(input: unknown) {
    const spec = inputs.analyseReplays.parse(input);
    const ctx = await this.context(spec.project);
    if (!replaysEnabled(this.env))
      return {
        project: ctx.project,
        enabled: false,
        summary: 'Session replay is not enabled on this deployment.',
      };
    const q = await this.replayQuery(ctx.project, spec);
    const { rows, total } = await listReplays(this.env.DB, ctx.project, {
      ...q,
      limit: spec.limit ?? 30,
    });
    // Cached summaries are cheap; computing one reads every chunk, so only a few are computed per call.
    const cached = await Promise.all(
      rows.map((r) => readCachedSummary<Omit<ReplaySummary, 'text'>>(this.env, ctx.project, r)),
    );
    const sessions: { session: string; stats: ReplaySummary['stats']; timeline: TimelineItem[] }[] =
      [];
    let fresh = 0;
    let skipped = 0;
    for (const [i, row] of rows.entries()) {
      let s = cached[i];
      if (!s && fresh < FRESH_SUMMARIES_PER_CALL) {
        fresh++;
        s = await this.replaySummary(ctx.project, row);
      }
      if (s) sessions.push({ session: row.session_id, stats: s.stats, timeline: s.timeline });
      else skipped++;
    }
    const a = analyseReplays(sessions);
    const withLinks = (findings: typeof a.rageClicks) =>
      findings.map((f) => ({
        ...f,
        examples: f.examples.map((e) => ({
          ...e,
          at: clock(e.t),
          link: this.replayLink(ctx.project, e.session, e.t),
        })),
      }));
    return {
      project: ctx.project,
      enabled: true,
      matching: total,
      analysed: sessions.length,
      skipped,
      totals: a.totals,
      rageClicks: withLinks(a.rageClicks),
      deadClicks: withLinks(a.deadClicks),
      errors: withLinks(a.errors),
      failedRequests: withLinks(a.failedRequests),
      consoleErrors: withLinks(a.consoleErrors),
      exitPages: withLinks(a.exitPages),
      summary: `${a.text}${skipped ? `\n\n${skipped} recent sessions were left out because they are not summarised yet (that happens about 30 minutes after a session ends, hourly). Run again later for full coverage.` : ''}${total > rows.length ? `\n\nAnalysed the ${rows.length} most recent of ${total} matching sessions.` : ''}`,
    };
  }

  async annotateReplay(input: unknown) {
    const spec = inputs.annotateReplay.parse(input);
    const ctx = await this.context(spec.project);
    const row = await this.replayRow(ctx.project, spec.session_id);
    const t = this.offset(spec.at);
    const start = await this.sessionStart(ctx.project, row);
    const note = await addNote(this.env.DB, ctx.project, row.session_id, {
      ts_ms: start + t,
      text: spec.text.trim(),
      author: spec.author?.trim() || 'agent',
    });
    return {
      project: ctx.project,
      session: row.session_id,
      note: { id: note.id, at: clock(t), text: note.text, author: note.author },
      summary: `Note added at ${clock(t)}. It shows on the session's timeline and in its transcript.`,
      dashboard: this.replayLink(ctx.project, row.session_id, t),
    };
  }

  async deleteReplayNote(input: unknown) {
    const spec = inputs.deleteReplayNote.parse(input);
    const ctx = await this.context(spec.project);
    const deleted = await deleteNote(this.env.DB, ctx.project, spec.session_id, spec.id);
    if (!deleted) throw new HttpError(404, `No note "${spec.id}" on session "${spec.session_id}"`);
    return { project: ctx.project, deleted: true, summary: 'Note deleted.' };
  }

  // ── Flags ────────────────────────────────────────────────────────────────

  async listFlags(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const flags = await listFlags(this.env.DB, ctx.project, true);
    return {
      project: ctx.project,
      flags,
      summary: `${flags.length} flag${flags.length === 1 ? '' : 's'}: ${flags.map((f) => `${f.key} (${f.enabled ? `${f.rollout}%` : 'off'})`).join(', ') || 'none'}.`,
      dashboard: this.link('flags', { project: ctx.project }),
    };
  }

  async getFlag(input: unknown) {
    const spec = inputs.flagKey.parse(input);
    const ctx = await this.context(spec.project);
    const flag = await getFlag(this.env.DB, ctx.project, spec.key);
    if (!flag) throw new HttpError(404, `No flag "${spec.key}"`);
    return { project: ctx.project, flag };
  }

  async saveFlag(input: unknown) {
    const spec = inputs.saveFlag.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, ...definition } = spec;
    const result = await saveFlag(this.env.DB, ctx.project, definition);
    return {
      project: ctx.project,
      ...result,
      summary: `${result.created ? 'Created' : 'Updated'} flag "${spec.key}"${result.changed.length && !result.created ? ` (${result.changed.join(', ')})` : ''}: ${result.flag.enabled ? `${result.flag.rollout}% rollout` : 'disabled'}. Read it with glass.flag("${spec.key}").`,
    };
  }

  async deleteFlag(input: unknown) {
    const spec = inputs.flagKey.parse(input);
    const ctx = await this.context(spec.project);
    const deleted = await deleteFlag(this.env.DB, ctx.project, spec.key);
    if (!deleted) throw new HttpError(404, `No flag "${spec.key}"`);
    return {
      project: ctx.project,
      deleted: spec.key,
      summary: `Deleted flag "${spec.key}". Remove it from your code too.`,
    };
  }

  // ── Experiments ──────────────────────────────────────────────────────────

  async listExperiments(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const experiments = await listExperiments(this.env.DB, ctx.project);
    return {
      project: ctx.project,
      experiments,
      summary: `${experiments.length} experiment${experiments.length === 1 ? '' : 's'}: ${experiments.map((e) => `${e.key} (${e.status})`).join(', ') || 'none'}.`,
      dashboard: this.link('experiments', { project: ctx.project }),
    };
  }

  async createExperiment(input: unknown) {
    const spec = inputs.createExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await createExperiment(
      this.env.DB,
      ctx.project,
      spec as CreateExperimentInput,
    );
    return {
      project: ctx.project,
      experiment,
      summary: `Created experiment "${experiment.key}" on flag "${experiment.flag}" (draft). In code, branch on glass.flag("${experiment.flag}") — it records exposures — then start it with update_experiment.`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  async experimentResults(input: unknown) {
    const spec = inputs.experimentKey.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await getExperiment(this.env.DB, ctx.project, spec.key);
    const flag = await getFlag(this.env.DB, ctx.project, experiment.flag);
    const weights = Object.fromEntries((flag?.variants ?? []).map((v) => [v.key, v.weight]));
    // Ten minutes of slack absorbs client clock correction around the start time.
    const from = (experiment.startedAt ?? experiment.createdAt) - 10 * 60_000;
    const results = await runExperiment(
      experimentSpec.parse({
        project: ctx.project,
        flag: experiment.flag,
        goal: experiment.goal,
        variants: flag?.variants?.map((v) => v.key),
        from,
        to: experiment.endedAt ?? 'now',
      }),
      {
        dialect: this.store.dialect,
        project: ctx.project,
        execute: (sql) => this.store.query(sql),
      },
      { weights },
    );
    return {
      project: ctx.project,
      experiment,
      results,
      summary: `[${experiment.status}] ${results.summary}`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  async updateExperiment(input: unknown) {
    const spec = inputs.updateExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const { experiment, flag } = await transitionExperiment(
      this.env.DB,
      ctx.project,
      spec.key,
      spec.action,
      spec.variant,
    );
    const verb = { start: 'Started', stop: 'Stopped', ship: `Shipped "${spec.variant}" for` }[
      spec.action
    ];
    return {
      project: ctx.project,
      experiment,
      flag,
      summary: `${verb} experiment "${spec.key}". Flag "${flag.key}" is now ${flag.enabled ? 'on' : 'off'}.`,
    };
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  async listProjects() {
    const projects = await listProjects(this.env.DB);
    return {
      projects,
      summary: `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.map((p) => p.id).join(', ') || 'none'}.`,
    };
  }

  async createProject(input: unknown) {
    const spec = inputs.createProject.parse(input);
    const created = await createProject(this.env.DB, {
      id: spec.id,
      name: spec.name,
      allowedOrigins: spec.allowed_origins,
    });
    await this.seedDefaultInsights(created.id);
    return {
      project: created,
      summary: `Project "${created.id}" is ready. Use data-project="${created.id}" in the snippet.`,
    };
  }

  // ── Saved insights ───────────────────────────────────────────────────────

  async listInsights(input: unknown) {
    const spec = inputs.listInsights.parse(input);
    const ctx = await this.context(spec.project);
    await this.seedDefaultInsights(ctx.project);
    const { results } = await this.env.DB.prepare(
      'SELECT key, name, description, kind, spec, created_at, updated_at FROM insights WHERE project = ? ORDER BY name COLLATE NOCASE',
    )
      .bind(ctx.project)
      .all<{
        key: string;
        name: string;
        description: string;
        kind: string;
        spec: string;
        created_at: number;
        updated_at: number;
      }>();
    const insights = results.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      kind: r.kind as 'trends' | 'funnel' | 'retention',
      spec: safeParse(r.spec),
      updatedAt: new Date(r.updated_at).toISOString(),
      dashboard: this.link(`insights/${r.key}`, { project: ctx.project }),
    }));
    return {
      project: ctx.project,
      insights,
      summary: insights.length
        ? `${insights.length} saved analysis${insights.length === 1 ? '' : 'es'}.`
        : 'No saved analyses yet.',
      dashboard: this.link('insights', { project: ctx.project }),
    };
  }

  async getInsight(input: unknown) {
    const spec = inputs.getInsight.parse(input);
    const ctx = await this.context(spec.project);
    await this.seedDefaultInsights(ctx.project);
    const row = await this.env.DB.prepare(
      'SELECT key, name, description, kind, spec, created_at, updated_at FROM insights WHERE project = ? AND key = ?',
    )
      .bind(ctx.project, spec.key)
      .first<{
        key: string;
        name: string;
        description: string;
        kind: string;
        spec: string;
        created_at: number;
        updated_at: number;
      }>();
    if (!row) throw new HttpError(404, `No saved analysis "${spec.key}"`);
    return {
      project: ctx.project,
      key: row.key,
      name: row.name,
      description: row.description,
      kind: row.kind as 'trends' | 'funnel' | 'retention',
      spec: safeParse(row.spec),
      updatedAt: new Date(row.updated_at).toISOString(),
      dashboard: this.link(`insights/${row.key}`, { project: ctx.project }),
    };
  }

  async saveInsight(input: unknown) {
    const spec = inputs.saveInsight.parse(input);
    const ctx = await this.context(spec.project);
    const key = (spec.key?.trim() || slugKey(spec.name)).slice(0, 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new HttpError(
        400,
        `Invalid insight key "${key}"`,
        'Use lowercase letters, numbers, hyphens or underscores.',
      );
    }
    if (key === 'new' || insightKind.safeParse(key).success) {
      throw new HttpError(
        400,
        `Key "${key}" is reserved`,
        'Pick another name; trends, funnel, retention and new are used by the UI.',
      );
    }
    const now = Date.now();
    const existing = await this.env.DB.prepare(
      'SELECT key FROM insights WHERE project = ? AND key = ?',
    )
      .bind(ctx.project, key)
      .first();
    const description = spec.description ?? '';
    const body = JSON.stringify(spec.spec);
    await this.env.DB.prepare(
      existing
        ? 'UPDATE insights SET name = ?, description = ?, kind = ?, spec = ?, updated_at = ? WHERE project = ? AND key = ?'
        : 'INSERT INTO insights (project, key, name, description, kind, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        ...(existing
          ? [spec.name, description, spec.kind, body, now, ctx.project, key]
          : [ctx.project, key, spec.name, description, spec.kind, body, now, now]),
      )
      .run();
    return {
      project: ctx.project,
      key,
      name: spec.name,
      description,
      kind: spec.kind,
      created: !existing,
      summary: `${existing ? 'Updated' : 'Saved'} analysis "${spec.name}".`,
      dashboard: this.link(`insights/${key}`, { project: ctx.project }),
    };
  }

  async deleteInsight(input: unknown) {
    const spec = inputs.deleteInsight.parse(input);
    const ctx = await this.context(spec.project);
    const result = await this.env.DB.prepare('DELETE FROM insights WHERE project = ? AND key = ?')
      .bind(ctx.project, spec.key)
      .run();
    if (!result.meta.changes) throw new HttpError(404, `No saved analysis "${spec.key}"`);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted analysis "${spec.key}".` };
  }

  /** Seed starter analyses once per project (new creates and empty existing projects). */
  private async seedDefaultInsights(projectId: string): Promise<void> {
    const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM insights WHERE project = ?')
      .bind(projectId)
      .first<{ n: number }>();
    if (Number(row?.n ?? 0) > 0) return;
    const now = Date.now();
    await this.env.DB.batch(
      DEFAULT_INSIGHTS.map((insight) =>
        this.env.DB.prepare(
          'INSERT OR IGNORE INTO insights (project, key, name, description, kind, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          projectId,
          insight.key,
          insight.name,
          insight.description,
          insight.kind,
          JSON.stringify(insight.spec),
          now,
          now,
        ),
      ),
    );
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function slugKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'cohort'
  );
}
