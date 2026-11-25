/**
 * The Dataflare service: every operation the HTTP API, the MCP server and the
 * dashboard can perform, in one place. Inputs are validated here (with the
 * shared zod schemas), so all three surfaces behave identically and an agent
 * gets the same answer whichever way it asks.
 */

import { alertConditionSchema, alertTargetSchema, describeCondition } from '@dataflare/core/alerts';
import {
  type CohortDefinition,
  cohortDefinitionV2,
  cohortReferences,
  compileCohort,
  describeCohort,
  normaliseCohort,
} from '@dataflare/core/cohorts';
import {
  DASHBOARD_TEMPLATES,
  guessEvents,
  type TemplateTile,
  templateTiles,
} from '@dataflare/core/dashboard-templates';
import { TEMPLATES } from '@dataflare/core/destinations/index';
import { MAX_GROUP_TYPES } from '@dataflare/core/events';
import { COHORT_PROPERTY, type CohortMembers, type Filter, toList } from '@dataflare/core/filters';
import { evaluateFlagsDetailed, type FlagDefinition, payloadsFor } from '@dataflare/core/flags';
import {
  experimentSpec,
  filterSchema,
  INSIGHTS,
  type InsightKind,
  isInsightKind,
  sqlSpec,
  webSpec,
} from '@dataflare/core/insights';
import {
  ACTOR_COMPILERS,
  type ActorSelection,
  actorSelection,
  aggregationOf,
} from '@dataflare/core/insights/actors';
import { type Definition, type FunnelStep, runCoverage } from '@dataflare/core/insights/coverage';
import { issueCounts, issueDetail, issueSeries } from '@dataflare/core/insights/errors';
import { planExperiment, runExperiment } from '@dataflare/core/insights/experiment';
import { suggestPathRules } from '@dataflare/core/insights/paths';
import { runProduct } from '@dataflare/core/insights/product';
import {
  type EventRole,
  type KeyEvent,
  runConversions,
  runHealth,
  runSources,
  SOURCE_DIMENSIONS,
  type SourceDimension,
} from '@dataflare/core/insights/report';
import { runRevenue } from '@dataflare/core/insights/revenue';
import { experimentOptions, metricSchema } from '@dataflare/core/insights/schemas';
import { runSites } from '@dataflare/core/insights/sites';
import { runTraffic } from '@dataflare/core/insights/traffic';
import { runTrafficBreakdown } from '@dataflare/core/insights/traffic-breakdown';
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
import { type ReportTile, reportTile } from '@dataflare/core/reports';
import { describeSchedule, quietHoursSchema, scheduleSchema } from '@dataflare/core/schedule';
import {
  excludeInternal,
  type ProjectSettings,
  projectSettingsSchema,
} from '@dataflare/core/settings';
import { assertSafeKey } from '@dataflare/core/sql/dialect';
import { propertyText } from '@dataflare/core/sql/filters';
import { assertReadOnlySql } from '@dataflare/core/sql/guard';
import { type Aggregation, eventsCte, num, text } from '@dataflare/core/sql/source';
import { isMinors, studentPolicySchema } from '@dataflare/core/student-policy';
import { DAY_MS, parseTime, resolveRange } from '@dataflare/core/time';
import { applyTransformations, transformationSchema } from '@dataflare/core/transformations';
import { estimateUsage } from '@dataflare/core/usage';
import {
  GLASS_VERSION,
  isNewerThan,
  UPGRADE_COMMAND,
  upgradeMessage,
} from '@dataflare/core/version';
import { z } from 'zod/v4';
import {
  alertHistory,
  checkAlert,
  deleteAlert,
  getAlert,
  listAlerts,
  saveAlert,
} from './alerts.ts';
import {
  type CohortRow,
  cohortContext,
  cohortsUsedByFlags,
  loadCohorts,
  materialise,
  membershipSql,
} from './cohorts.ts';
import {
  addTile,
  deleteDashboard,
  duplicateDashboard,
  ensureStarterDashboard,
  getDashboard,
  listDashboards,
  removeTile,
  reorderTiles,
  saveDashboard,
  tileSpec,
  updateTile,
} from './dashboards.ts';
import {
  type DestinationInput,
  deleteDestination,
  destinationActivity,
  getDestination,
  listDestinations,
  retryFailures,
  saveDestination,
  testDestination,
} from './destinations.ts';
import type { Env } from './env.ts';
import { continueErasure, ERASURE_SLICES_PER_REQUEST, startErasure } from './erasure.ts';
import {
  type CreateExperimentInput,
  createExperiment,
  deleteHoldout,
  duplicateExperiment,
  type Experiment,
  experimentsUsingHoldout,
  getExperiment,
  getHoldout,
  listExperiments,
  listHoldouts,
  saveHoldout,
  transitionExperiment,
  updateExperimentDefinition,
} from './experiments.ts';
import { backfillExport, deleteExport, exportRuns, listExports, saveExport } from './exports.ts';
import {
  cancelFlagSchedule,
  deleteFlag,
  type FlagInput,
  flagContext,
  flagDefinitions,
  flagHistory,
  getFlag,
  listFlagSchedules,
  listFlags,
  saveFlag,
  scheduleFlagChange,
} from './flags.ts';
import { HttpError } from './http.ts';
import { clearGroupTypeCache, upsertPerson } from './ingest.ts';
import { DEFAULT_INSIGHTS } from './insight-defaults.ts';
import {
  deleteSourcemaps,
  getIssueRow,
  type IssueSample,
  listIssueRows,
  listSourcemaps,
  mergeIssues,
  symbolicatedFrames,
  updateIssue,
  uploadSourcemap,
} from './issues.ts';
import { fetchLatestVersion } from './latest.ts';
import {
  createProject,
  getProject,
  listProjects,
  type Project,
  resolveProject,
  saveSettings,
} from './projects.ts';
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
import {
  deleteSubscription,
  listSubscriptions,
  type ReportContext,
  runNow,
  saveSubscription,
} from './reports.ts';
import { connectStripe, disconnectStripe, storeRates, stripeStatus } from './revenue.ts';
import type { EventStore } from './stores/types.ts';
import {
  type AuditActor,
  getPolicy,
  listAudit,
  minorsProjects,
  recordAudit,
  savePolicy,
} from './student-mode.ts';
import { filteredPageviews } from './traffic-collection.ts';
import {
  deleteTransformation,
  hashSalt,
  listTransformations,
  saveTransformation,
} from './transformations.ts';

const project = z.string().optional();
/** Most people a static cohort can hold. */
const STATIC_COHORT_LIMIT = 10_000;
/** Event-store matches feeding a replay search are capped (they are inlined into a D1 query). */
const SESSION_MATCH_LIMIT = 1000;
/** A session that hasn't uploaded anything for this long is finished, and its summary can be cached. */
const SETTLED_MS = 30 * 60_000;
/** analyse_replays computes at most this many missing summaries per call (each reads every chunk of a session). */
const FRESH_SUMMARIES_PER_CALL = 3;
const insightKind = z.enum(['trends', 'funnel', 'retention', 'paths']);

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

const filtersInput = z
  .object({
    from: z.string().optional().describe('Date range start for every tile, e.g. "-30d".'),
    to: z.string().optional(),
    filters: z.array(filterSchema).optional().describe('Filters added to every tile.'),
    filterTestAccounts: z.boolean().optional(),
  })
  .describe("The dashboard's date range and filters; a tile can ignore them.");

const channelsInput = z
  .object({
    destinations: z
      .array(z.string())
      .max(10)
      .optional()
      .describe('Ids of Slack, Discord, Teams or webhook destinations (list_destinations).'),
    emails: z
      .array(z.string().email())
      .max(200)
      .optional()
      .describe('Email addresses (needs email set up).'),
  })
  .describe('Where it goes.');

const tileInput = {
  insightKey: z.string().optional().describe('A saved analysis to show.'),
  insight: z
    .object({ name: z.string().min(1), kind: insightKind, spec: z.record(z.string(), z.unknown()) })
    .optional()
    .describe('Or a new analysis: saved, then added.'),
  text: z
    .string()
    .max(4000)
    .optional()
    .describe('Or a text tile (headings, **bold**, _italic_, links, lists).'),
  width: z
    .union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)])
    .optional()
    .describe('Columns of 12. Default 6.'),
  height: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe('1 (short, default) or 2 (tall).'),
  ignoreFilters: z
    .boolean()
    .optional()
    .describe("Don't apply the dashboard's date range and filters."),
  overrides: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Shown on this tile only, e.g. { "display": "bar" }.'),
};

const BOARD_INPUTS = {
  listDashboards: z.object({ project }),
  getDashboard: z.object({
    project,
    id: z.string(),
    results: z
      .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
      .optional()
      .describe("Also run every tile and include each one's headline numbers."),
  }),
  saveDashboard: z.object({
    project,
    id: z.string().optional().describe('Update this dashboard; omit to create one.'),
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    filters: filtersInput.optional(),
  }),
  deleteDashboard: z.object({ project, id: z.string() }),
  duplicateDashboard: z.object({ project, id: z.string(), name: z.string().min(1).max(120) }),
  addDashboardTile: z.object({ project, dashboard: z.string(), ...tileInput }),
  updateDashboardTile: z.object({ project, dashboard: z.string(), tile: z.string(), ...tileInput }),
  removeDashboardTile: z.object({ project, dashboard: z.string(), tile: z.string() }),
  reorderDashboardTiles: z.object({
    project,
    dashboard: z.string(),
    tiles: z.array(z.string()).max(60),
  }),
  dashboardTemplates: z.object({ project }),
  createDashboardFromTemplate: z.object({
    project,
    template: z.string().describe('website, product, revenue or errors (dashboard_templates).'),
    name: z.string().optional(),
    events: z
      .object({ signup: z.string().optional(), purchase: z.string().optional() })
      .optional()
      .describe('Your signup and purchase events; guessed from event names when left out.'),
  }),
  listSubscriptions: z.object({
    project,
    dashboard: z.string().optional(),
    insight: z.string().optional(),
  }),
  saveSubscription: z.object({
    project,
    id: z.string().optional().describe('Update this report; omit to create one.'),
    target: z
      .enum(['dashboard', 'insight'])
      .describe('Report on a dashboard or one saved analysis.'),
    targetId: z.string().describe('The dashboard id or analysis key.'),
    name: z.string().max(120).optional(),
    channels: channelsInput,
    schedule: scheduleSchema,
    tiles: z
      .array(z.string())
      .max(20)
      .optional()
      .describe('Dashboard tile ids to include; default the first 20.'),
    message: z.string().max(500).optional().describe('A line at the top of each report.'),
    enabled: z.boolean().optional(),
  }),
  deleteSubscription: z.object({ project, id: z.string() }),
  sendSubscriptionNow: z.object({ project, id: z.string() }),
  listAlerts: z.object({ project, insight: z.string().optional() }),
  getAlert: z.object({ project, id: z.string(), days: z.number().int().min(1).max(90).optional() }),
  saveAlert: z.object({
    project,
    id: z.string().optional().describe('Update this alert; omit to create one.'),
    name: z.string().min(1).max(120),
    insightKey: z.string().describe('The saved trends or funnel analysis to watch.'),
    target: alertTargetSchema.optional(),
    condition: alertConditionSchema,
    schedule: scheduleSchema.describe(
      'When to check, e.g. { "frequency": "hourly", "minute": 5 }.',
    ),
    ongoing: z
      .boolean()
      .optional()
      .describe('Check the period still filling up (default: the last complete one).'),
    skipWeekends: z.boolean().optional(),
    quiet: quietHoursSchema.optional(),
    channels: channelsInput,
    enabled: z.boolean().optional(),
  }),
  deleteAlert: z.object({ project, id: z.string() }),
  checkAlertNow: z.object({ project, id: z.string() }),
  capabilities: z.object({ project }),
};

const trafficScope = z.object({
  project: z.string().min(1).optional().describe('One site. Omit for all registered sites.'),
  from: reportRange.from,
  to: reportRange.to,
});

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
  product: z.object({ project, from: reportRange.from, to: reportRange.to }),
  trafficBreakdown: trafficScope,
  traffic: trafficScope.extend({
    path: z
      .string()
      .min(1)
      .optional()
      .describe('Exact stored page path, including a hash route when present.'),
    limit: z.number().int().min(1).max(100).default(10),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
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
    name: z.string().min(1).describe('Human label, e.g. "Power users".'),
    description: z.string().max(500).optional(),
    definition: cohortDefinitionV2
      .optional()
      .describe(
        'Groups of conditions: property, performed (N times in a window), not_performed, performed_regularly, first_performed, stopped, started, sequence, cohort. E.g. {"groups":[{"conditions":[{"type":"performed","event":"report_created","count":{"op":"gte","value":3},"within":"30d"}]}]}.',
      ),
    filters: z
      .array(filterSchema)
      .default([])
      .describe(
        'Simple form: filters any one event in the look-back must match (instead of definition).',
      ),
    didEvent: z.string().optional().describe('Simple form: only people who did this event.'),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Simple form: look-back. Default -90d.'),
    static: z
      .boolean()
      .optional()
      .describe(
        'A fixed list of people (ids) instead of conditions, e.g. an uploaded CSV of user ids.',
      ),
    ids: z
      .array(z.string())
      .max(STATIC_COHORT_LIMIT)
      .optional()
      .describe('For static cohorts: the person ids (replaces the list).'),
  }),
  deleteCohort: z.object({ project, key: z.string() }),
  countCohort: z.object({
    project,
    definition: cohortDefinitionV2.optional(),
    filters: z.array(filterSchema).default([]),
    didEvent: z.string().optional(),
    from: z.union([z.string(), z.number()]).optional(),
  }),
  cohortMembers: z.object({
    project,
    key: z.string(),
    limit: z.coerce.number().int().min(1).max(1000).optional().describe('Default 100.'),
    offset: z.coerce.number().int().min(0).optional(),
    format: z.enum(['json', 'csv']).optional(),
  }),
  editCohortMembers: z.object({
    project,
    key: z.string(),
    add: z.array(z.string()).max(5000).optional().describe('Person ids to add.'),
    remove: z.array(z.string()).max(5000).optional().describe('Person ids to remove.'),
  }),
  duplicateCohort: z.object({
    project,
    key: z.string().describe('Cohort to copy.'),
    name: z.string().optional(),
    newKey: z.string().optional(),
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
        'Targeting rules, first match wins. Conditions: person properties ("person.plan"), group properties ("group.company.plan"), country/device/browser/os, a saved cohort ({"property":"cohort","value":"beta"}) or another flag ({"property":"flag.new-nav","value":"on"}). E.g. [{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}].',
      ),
    payloads: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe(
        'JSON payload per value: {"on": {...}} for a simple flag, or one per variant key. Read with glass.flagPayload(key). Up to 10 KB.',
      ),
    bucketBy: z
      .string()
      .nullable()
      .optional()
      .describe(
        '"device" (default: stable across login), "person" (same on every device once identified) or a group type such as "company" (a whole account shares the value).',
      ),
    earlyAccess: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        docsUrl: z.string().optional(),
        stage: z.enum(['concept', 'alpha', 'beta']),
      })
      .nullable()
      .optional()
      .describe(
        'Offer the flag as an early-access feature: people see it in glass.earlyAccessFeatures() and opt in or out with glass.optIn(key) / glass.optOut(key).',
      ),
    tags: z.array(z.string()).nullable().optional(),
    salt: z.string().optional().describe('Change to reshuffle everyone’s buckets.'),
    actor: z
      .string()
      .max(60)
      .optional()
      .describe('Who is making the change, for the flag’s history.'),
  }),
  flagHistory: z.object({
    project,
    key: z.string(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  scheduleFlag: z.object({
    project,
    key: z.string(),
    at: z
      .union([z.string(), z.number()])
      .describe('When: ISO time ("2026-11-20T09:00:00Z") or epoch ms. Must be in the future.'),
    change: z
      .object({
        enabled: z.boolean().optional(),
        rollout: z.number().min(0).max(100).optional(),
        variants: z.array(z.object({ key: z.string(), weight: z.number().min(0) })).optional(),
        rules: z.array(z.record(z.string(), z.unknown())).optional(),
        payloads: z.record(z.string(), z.unknown()).optional(),
      })
      .describe('What to change at that time, e.g. {"rollout": 50}.'),
    actor: z.string().max(60).optional(),
  }),
  flagSchedules: z.object({ project, key: z.string().optional() }),
  cancelFlagSchedule: z.object({ project, id: z.string() }),
  flagUsage: z.object({
    project,
    key: z.string(),
    from: z.union([z.string(), z.number()]).optional().describe('Default -30d.'),
    interval: z.enum(['hour', 'day', 'week']).optional(),
  }),
  evaluateFlags: z.object({
    project,
    distinct_id: z.string().describe('The device id (or user id for server-side users).'),
    user_id: z.string().optional(),
    groups: z.record(z.string(), z.string()).optional(),
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
    goal: z
      .object({
        event: z.string(),
        filters: z.array(filterSchema).optional(),
        value: z.string().optional(),
      })
      .optional()
      .describe('Simple form: a conversion event (and optional value property, e.g. revenue).'),
    metrics: z
      .array(metricSchema)
      .max(10)
      .optional()
      .describe(
        'Primary metrics (the first decides): conversion, mean (count or sum per person, winsorised), ratio, funnel, retention.',
      ),
    secondary: z
      .array(
        z.union([
          metricSchema,
          z.object({ event: z.string(), filters: z.array(filterSchema).optional() }),
        ]),
      )
      .optional()
      .describe(
        'Secondary metrics, reported but not deciding (guardrails such as errors or refunds).',
      ),
    hypothesis: z.string().optional(),
    variants: z.array(z.object({ key: z.string(), weight: z.number().min(0) })).optional(),
    holdout: z
      .string()
      .optional()
      .describe('A holdout (save_holdout) to keep people out of this experiment.'),
    transforms: z
      .record(
        z.string(),
        z.array(
          z.object({
            selector: z.string().describe('CSS selector, e.g. "#hero h1".'),
            text: z.string().optional(),
            html: z.string().optional(),
            css: z.string().optional().describe('Inline style to add, e.g. "background:#e00".'),
            attributes: z.record(z.string(), z.string()).optional(),
            hide: z.boolean().optional(),
          }),
        ),
      )
      .optional()
      .describe(
        'Web experiment: page changes per variant key, applied by the browser SDK with no code change, e.g. {"test":[{"selector":"#hero h1","text":"Ship faster"}]}.',
      ),
    ...experimentOptions,
    filterTestAccounts: z
      .boolean()
      .optional()
      .describe('Leave internal traffic out of the results.'),
  }),
  editExperiment: z.object({
    project,
    key: z.string(),
    metrics: z.array(metricSchema).max(10).optional(),
    secondary: z.array(metricSchema).max(20).optional(),
    hypothesis: z.string().optional(),
    holdout: z.string().nullable().optional(),
    ...experimentOptions,
    filterTestAccounts: z.boolean().optional(),
  }),
  experimentKey: z.object({ project, key: z.string() }),
  listExperiments: z.object({
    project,
    include_archived: z.boolean().optional().describe('Also list archived experiments.'),
  }),
  updateExperiment: z.object({
    project,
    key: z.string(),
    action: z
      .enum(['start', 'pause', 'resume', 'stop', 'ship', 'reset', 'archive', 'unarchive'])
      .describe(
        '"start" enables the flag; "pause" switches it off for everyone (results kept), "resume" switches it back on; "stop" freezes results; "ship" gives everyone the chosen variant; "reset" goes back to draft and starts counting afresh at the next start; "archive" hides it.',
      ),
    variant: z.string().optional().describe('Required for "ship": the variant everyone gets.'),
  }),
  getProjectPolicy: z.object({ project }),
  setProjectPolicy: studentPolicySchema.extend({ project }),
  auditLog: z.object({
    project,
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Start of the window, e.g. "-30d". Default -30d.'),
    limit: z.coerce.number().int().min(1).max(1000).optional().describe('Default 200.'),
  }),
  duplicateExperiment: z.object({
    project,
    key: z.string(),
    newKey: z.string().describe('Key of the copy (also its new flag).'),
  }),
  saveHoldout: z.object({
    project,
    key: z.string().describe('e.g. "q1-holdout".'),
    name: z.string().optional(),
    description: z.string().optional(),
    percentage: z
      .number()
      .min(0)
      .max(50)
      .describe('Share of people kept out of every experiment using it, e.g. 10.'),
  }),
  holdoutKey: z.object({ project, key: z.string() }),
  holdoutResults: z.object({
    project,
    key: z.string(),
    metrics: z
      .array(metricSchema)
      .max(10)
      .optional()
      .describe('Default: the first metric of each experiment using it.'),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Default: when the holdout was created.'),
  }),
  planExperiment: z.object({
    project,
    metric: metricSchema.describe('The metric to detect a change in.'),
    traffic: z
      .object({ event: z.string(), filters: z.array(filterSchema).optional() })
      .optional()
      .describe('Who could be in the experiment: people doing this event. Default $pageview.'),
    variants: z.number().int().min(2).max(10).optional(),
    mde: z
      .number()
      .min(0.001)
      .max(10)
      .optional()
      .describe('Smallest relative change worth detecting. Default 0.1.'),
    confidence: z.union([z.literal(0.9), z.literal(0.95), z.literal(0.99)]).optional(),
    exposurePercentage: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Share of that traffic in the experiment. Default 100.'),
    lookback: z.string().optional().describe('History to base it on. Default "-14d".'),
    minimumDays: z.number().min(0).optional(),
    aggregateBy: z.string().optional(),
  }),
  createProject: z.object({
    id: z.string().describe('Lowercase id, e.g. "acme-web".'),
    name: z.string().optional(),
    allowed_origins: z
      .array(z.string())
      .optional()
      .describe('Restrict browser ingest to these origins.'),
  }),
  actors: z.object({
    project,
    kind: z
      .enum(['trends', 'funnel', 'retention', 'paths'])
      .describe('The insight the number comes from.'),
    spec: z
      .record(z.string(), z.unknown())
      .describe(
        'The same query spec you ran (without kind), e.g. from the result’s dashboard link.',
      ),
    selection: actorSelection,
    limit: z.number().int().min(1).max(1000).optional().describe('Default 100.'),
    offset: z.number().int().min(0).optional(),
    format: z.enum(['json', 'csv']).optional().describe('"csv" returns the list as CSV text.'),
    saveAsCohort: z
      .object({ name: z.string().min(1), key: z.string().optional() })
      .optional()
      .describe('Save everyone in the selection (up to 10,000 people) as a static cohort.'),
  }),
  listAnnotations: z.object({
    project,
    from: z.union([z.string(), z.number()]).optional().describe('Default: all.'),
    to: z.union([z.string(), z.number()]).optional(),
    insight: z.string().optional().describe('Also include notes pinned to this saved insight.'),
  }),
  createAnnotation: z.object({
    project,
    at: z
      .union([z.string(), z.number()])
      .describe('When it happened: ISO date or time ("2026-11-03T09:00"), epoch ms, or "-2d".'),
    text: z.string().min(1).max(500).describe('What happened, e.g. "Launched pricing v2".'),
    insight: z
      .string()
      .optional()
      .describe('Pin it to one saved insight only. Default: every time chart of the project.'),
    author: z.string().max(60).optional(),
  }),
  deleteAnnotation: z.object({ project, id: z.string() }),
  saveDestination: z.object({
    project,
    id: z.string().optional().describe('Omit to create; pass to update.'),
    name: z.string().optional(),
    template: z
      .string()
      .optional()
      .describe(
        'Template id (list_destination_templates): webhook, slack, meta-capi, ga4, hubspot, mixpanel…',
      ),
    enabled: z.boolean().optional(),
    events: z
      .array(z.string())
      .optional()
      .describe('Events to send, e.g. ["signup_completed"]; ["*"] for all.'),
    filters: z
      .array(filterSchema)
      .optional()
      .describe('Only events matching these, e.g. paid plans.'),
    inputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Template inputs, e.g. {"url":"https://hooks.slack.com/…","message":"{event} by {who}"}. Secrets are encrypted and never shown; null clears one.',
      ),
  }),
  destinationId: z.object({ project, id: z.string() }),
  testDestination: z.object({
    project,
    id: z.string(),
    event: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Fields to override on the sample event.'),
  }),
  retryDestination: z.object({ project, id: z.string(), failures: z.array(z.string()).optional() }),
  saveTransformation: z.object({
    project,
    id: z.string().optional(),
    enabled: z.boolean().optional(),
    position: z.number().int().optional().describe('Order: lower runs first.'),
    rule: transformationSchema,
  }),
  transformationId: z.object({ project, id: z.string() }),
  testTransformation: z.object({
    project,
    rule: transformationSchema,
    event: z
      .object({
        event: z.string(),
        props: z.record(z.string(), z.unknown()).optional(),
        person: z.record(z.string(), z.unknown()).optional(),
        url: z.string().optional(),
        title: z.string().optional(),
      })
      .describe('A sample event to try the rule on.'),
  }),
  saveExport: z.object({
    project,
    id: z.string().optional(),
    name: z.string().optional(),
    target: z.enum(['s3', 'bigquery', 'http']).optional().describe('Required when creating.'),
    format: z.enum(['jsonl', 'csv']).optional(),
    frequency: z.enum(['hour', 'day']).optional(),
    enabled: z.boolean().optional(),
    settings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        's3: endpoint (e.g. https://<account>.r2.cloudflarestorage.com), bucket, region ("auto" for R2), prefix, accessKeyId, secretAccessKey. bigquery: projectId, dataset, table, serviceAccount (key JSON). http: url, headers. Secrets are encrypted.',
      ),
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('When creating: export events received from this time. Default now.'),
  }),
  exportId: z.object({ project, id: z.string() }),
  backfillExport: z.object({
    project,
    id: z.string(),
    from: z
      .union([z.string(), z.number()])
      .describe('Re-export everything received since, e.g. "-30d".'),
  }),
  listIssues: z.object({
    ...reportRange,
    status: z
      .enum(['active', 'resolved', 'suppressed', 'all'])
      .optional()
      .describe('Default "active" (which includes regressions).'),
    search: z.string().optional().describe('Text in the error type or message.'),
    order: z
      .enum(['last_seen', 'first_seen', 'events', 'users'])
      .optional()
      .describe('Default "events".'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 25.'),
    filterTestAccounts: z.boolean().optional(),
  }),
  getIssue: z.object({
    ...reportRange,
    id: z.string().describe('Issue id, from list_issues.'),
    filterTestAccounts: z.boolean().optional(),
  }),
  updateIssue: z.object({
    project,
    id: z.string(),
    status: z
      .enum(['active', 'resolved', 'suppressed'])
      .optional()
      .describe(
        '"resolved": if it happens again it comes back as a regression. "suppressed": new occurrences are dropped at ingest.',
      ),
    assignee: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('Who is on it (free text); null clears it.'),
  }),
  mergeIssues: z.object({
    project,
    into: z.string().describe('The issue to keep.'),
    ids: z.array(z.string()).min(1).describe('Issues to merge into it.'),
  }),
  listSourcemaps: z.object({ project, release: z.string().optional() }),
  listGroupTypes: z.object({ project }),
  setGroupType: z.object({
    project,
    type: z
      .string()
      .min(1)
      .max(60)
      .describe('Group type, e.g. "company" (at most five per project).'),
    singular: z.string().max(60).optional().describe('Display name, e.g. "Company".'),
    plural: z.string().max(60).optional().describe('e.g. "Companies".'),
  }),
  searchGroups: z.object({
    project,
    type: z.string().describe('Group type, e.g. "company".'),
    search: z.string().optional().describe('Text in the group key or its properties.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  }),
  getGroup: z.object({
    project,
    type: z.string(),
    key: z.string(),
    from: z.union([z.string(), z.number()]).optional().describe('Activity since. Default -30d.'),
    to: z.union([z.string(), z.number()]).optional(),
  }),
  setGroupProperties: z.object({
    project,
    type: z.string(),
    key: z.string(),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        'Merged into the group’s properties (null removes one). Events from now on carry them.',
      ),
  }),
  deleteGroup: z.object({ project, type: z.string(), key: z.string() }),
  connectStripe: z.object({
    project,
    webhookSecret: z
      .string()
      .optional()
      .describe('The webhook endpoint’s signing secret (whsec_…). Required the first time.'),
    apiKey: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Optional restricted key (rk_…) with read access to Customers, to look up who a customer is. null removes it.',
      ),
    personKey: z
      .string()
      .optional()
      .describe(
        'customer.metadata key holding your user id (what you pass to glass.identify). Default "dataflare_id"; "user_id" is also tried.',
      ),
    groupType: z
      .string()
      .optional()
      .describe('Report revenue per account: the group type, e.g. "company".'),
    groupKey: z
      .string()
      .optional()
      .describe('customer.metadata key holding the account id. Default: the Stripe customer id.'),
    linkByEmail: z
      .boolean()
      .optional()
      .describe(
        'Match customers without an id in their metadata to people by email (the email is not stored).',
      ),
  }),
  stripeStatus: z.object({ project }),
  importFxRates: z.object({
    rates: z
      .array(
        z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          currency: z.string().length(3),
          rate: z.number().positive(),
        }),
      )
      .max(10_000),
  }),
  deleteSourcemaps: z.object({ project, release: z.string(), path: z.string().optional() }),
  getSettings: z.object({ project }),
  suggestPathRules: z.object({ project }),
  updateSettings: z.object({
    project,
    settings: projectSettingsSchema
      .partial()
      .describe(
        'Settings to change; others keep their values. Pass null for a field (e.g. "timezone": null) to clear it.',
      ),
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
  ...BOARD_INPUTS,
};

/** Cohort key → name, so summaries name the cohorts a definition references. */
function cohortNames(cohorts: Map<string, { key: string; name: string }>): Map<string, string> {
  return new Map([...cohorts.values()].map((c) => [c.key, c.name]));
}

const actorType = (aggregation: Aggregation) =>
  aggregation === 'person' ? 'person' : aggregation === 'session' ? 'session' : 'group';

const actorNounOf = (aggregation: Aggregation) =>
  typeof aggregation === 'object'
    ? `${aggregation.group} groups`
    : aggregation === 'person'
      ? 'people'
      : 'sessions';

function actorsSummary(
  actors: { id: string; properties: Record<string, unknown> }[],
  hasMore: boolean,
  noun: string,
  offset: number,
): string {
  if (!actors.length) return `No ${noun} for that selection.`;
  const names = actors
    .slice(0, 5)
    .map((a) => (a.properties.email as string) ?? (a.properties.name as string) ?? a.id)
    .join(', ');
  return `${actors.length}${hasMore ? '+' : ''} ${noun}${offset ? ` from #${offset + 1}` : ''}. Most active: ${names}.`;
}

function personSummary(
  id: string,
  identified: boolean,
  events: number,
  replays: number,
  groups: { type: string; key: string }[],
  revenue: { orders: number; net: number; currency: string } | null,
): string {
  const parts = [
    `${identified ? 'Identified person' : 'Anonymous device'} "${id}": ${events} events in 90 days`,
    replays ? `${replays} recorded sessions` : '',
    groups.length ? `in ${groups.map((g) => `${g.type} ${g.key}`).join(', ')}` : '',
    revenue?.orders
      ? `${revenue.orders} payments worth ${revenue.net} ${revenue.currency} net`
      : '',
  ];
  return `${parts.filter(Boolean).join(', ')}.`;
}

/** Retention of a cohort's people, from the event that defines it (or pageviews). */
function cohortRetentionSpec(row: CohortRow) {
  const performed = row.definition.groups[0]?.conditions.find((c) => c.type === 'performed');
  const event =
    performed && performed.type === 'performed' && performed.event !== '*'
      ? performed.event
      : '$pageview';
  return {
    cohortEvent: { event },
    returnEvent: { event: '$pageview' },
    period: 'week',
    periods: 8,
    filters: [{ property: COHORT_PROPERTY, value: row.key }],
  };
}

function cohortsSummary(cohorts: { name: string; count: number; kind: string }[]): string {
  if (!cohorts.length) return 'No cohorts yet. Save a person filter from the People tab.';
  const list = cohorts
    .map((c) => `${c.name} (${c.count}${c.kind === 'static' ? ', static' : ''})`)
    .join(', ');
  return `${cohorts.length} cohort${cohorts.length === 1 ? '' : 's'}: ${list}.`;
}

/** A cohort key from the one given, or from the name; lowercase letters, numbers, - and _. */
function cohortKey(given: string | undefined, name: string): string {
  const key = (given?.trim() || slugKey(name)).slice(0, 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key))
    throw new HttpError(
      400,
      `Invalid cohort key "${key}"`,
      'Use lowercase letters, numbers, hyphens or underscores.',
    );
  return key;
}

function flagSummary(
  key: string,
  result: { flag: FlagDefinition; created: boolean; changed: string[] },
): string {
  const f = result.flag;
  const what = [
    f.enabled ? `${f.rollout}% rollout` : 'disabled',
    f.bucketBy && f.bucketBy !== 'device' ? `bucketed by ${f.bucketBy}` : '',
    f.payloads ? 'with payloads' : '',
    f.earlyAccess ? `early access (${f.earlyAccess.stage})` : '',
  ].filter(Boolean);
  const changed = result.changed.length && !result.created ? ` (${result.changed.join(', ')})` : '';
  const read = `glass.flag("${key}")${f.payloads ? ` and glass.flagPayload("${key}")` : ''}`;
  return `${result.created ? 'Created' : 'Updated'} flag "${key}"${changed}: ${what.join(', ')}. Read it with ${read}.`;
}

/** The fields that have a value: undefined and null go; 0 and false stay. */
function definedOnly(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
  );
}

/** A flag bucketed by a group type experiments per group; device and person are the default. */
const groupBucket = (bucketBy: string | undefined) =>
  bucketBy && bucketBy !== 'device' && bucketBy !== 'person' ? bucketBy : undefined;

type IssueTotals = Map<string, { events: number; users: number; sessions: number }>;

/** Exceptions per issue; those of merged issues count towards the issue they were merged into. */
function issueTotals(
  rows: { issue: string; events: number; users: number; sessions: number }[],
  merged: Map<string, string>,
): IssueTotals {
  const totals: IssueTotals = new Map();
  for (const c of rows) {
    const id = merged.get(c.issue) ?? c.issue;
    const t = totals.get(id) ?? { events: 0, users: 0, sessions: 0 };
    t.events += c.events;
    t.users += c.users;
    t.sessions += c.sessions;
    totals.set(id, t);
  }
  return totals;
}

type IssueOrderRow = { lastSeen: string; firstSeen: string; users: number; events: number };

const ISSUE_ORDER: Record<string, (a: IssueOrderRow, b: IssueOrderRow) => number> = {
  last_seen: (a, b) => b.lastSeen.localeCompare(a.lastSeen),
  first_seen: (a, b) => b.firstSeen.localeCompare(a.firstSeen),
  users: (a, b) => b.users - a.users || b.events - a.events,
  events: (a, b) => b.events - a.events || b.lastSeen.localeCompare(a.lastSeen),
};

/** An issue's series with the series of the issues merged into it added. */
function mergedSeries(
  series: Record<string, number[]>,
  merged: Map<string, string>,
  id: string,
): number[] {
  const out = [...(series[id] ?? [])];
  for (const [m, into] of merged) {
    if (into !== id) continue;
    series[m]?.forEach((n, i) => {
      out[i] = (out[i] ?? 0) + n;
    });
  }
  return out;
}

function issuesSummary(
  rows: {
    type: string;
    message: string;
    events: number;
    users: number;
    status: string;
    regressedAt: string | null;
  }[],
  totals: IssueTotals,
): string {
  if (!rows.length) return 'No exceptions in this range.';
  const total = [...totals.values()].reduce((n, t) => n + t.events, 0);
  const top = rows
    .slice(0, 3)
    .map(
      (r) =>
        `${r.type}: ${r.message.slice(0, 80)} (${r.events}×, ${r.users} people${r.status === 'active' && r.regressedAt ? ', regressed' : ''})`,
    )
    .join('; ');
  return `${totals.size} issue${totals.size === 1 ? '' : 's'} with ${total} exceptions in range. Top: ${top}.`;
}

/** Where it happened: the top frame of your own code (or the top frame), in source when mapped. */
function topFrame(
  frames: {
    inApp: boolean;
    file: string;
    line: number | null;
    original?: { source: string; line: number; name: string | null };
  }[],
): string {
  const top = frames.find((f) => f.inApp) ?? frames[0];
  if (!top) return 'no stack';
  if (!top.original) return `${top.file}:${top.line ?? '?'}`;
  return `${top.original.source}:${top.original.line}${top.original.name ? ` in ${top.original.name}` : ''}`;
}

function sampleView(sample: IssueSample) {
  return {
    eventId: sample.event_id,
    at: new Date(sample.ts).toISOString(),
    url: sample.url,
    release: sample.release,
    handled: sample.handled,
    level: sample.level,
    browser: sample.browser,
    os: sample.os,
    person: sample.person_id,
  };
}

export class GlassService {
  readonly env: Env;
  readonly store: EventStore;
  readonly baseUrl: string;
  /** Who is calling, for change histories: the key's scope and an optional X-Glass-Actor name. */
  actor = '';

  /** Who is calling, for the student-mode audit log. Null for internal callers (cron). */
  auditActor: AuditActor | null = null;
  private audited = new Set<string>();

  constructor(env: Env, store: EventStore, baseUrl: string) {
    this.env = env;
    this.store = store;
    this.baseUrl = baseUrl;
  }

  /** Set who is calling and what they asked for; each project is audited once per operation. */
  setActor(actor: AuditActor | null): void {
    this.auditActor = actor;
    this.audited.clear();
  }

  private async context(requested?: string): Promise<QueryContext & { settings: ProjectSettings }> {
    const project = await resolveProject(this.env.DB, requested);
    await this.audit(project);
    const settings = (await getProject(this.env.DB, project))?.settings ?? {};
    return {
      dialect: this.store.dialect,
      project,
      execute: (sql) => this.store.query(sql),
      timezone: settings.timezone,
      pathCleaning: settings.pathCleaning,
      settings,
    };
  }

  /**
   * Apply project-level options to a spec: with `filterTestAccounts`, add filters that leave out
   * the project's internal traffic (every `filters` list at the top level of the spec).
   */
  private withProjectOptions<T extends Record<string, unknown>>(
    spec: T,
    settings: ProjectSettings,
  ): T {
    if (!spec.filterTestAccounts || !settings.internalFilters?.length) return spec;
    const exclusions = excludeInternal(settings.internalFilters);
    return { ...spec, filters: [...((spec.filters as unknown[]) ?? []), ...exclusions] };
  }

  /**
   * Record a read or change of a student-mode project. Writing the record is part of the
   * request: if it fails, the request fails rather than going unrecorded.
   */
  private async audit(project: string, detail?: string): Promise<void> {
    if (!this.auditActor || this.audited.has(project)) return;
    if (!isMinors(await getPolicy(this.env.DB, project))) return;
    this.audited.add(project);
    await recordAudit(this.env.DB, project, {
      ...this.auditActor,
      detail: detail ?? this.auditActor.detail,
    });
  }

  /** Audit every student-mode project: for reads that can reach any project's rows. */
  private async auditAll(detail?: string): Promise<void> {
    if (!this.auditActor) return;
    for (const { project } of await minorsProjects(this.env.DB)) {
      if (this.audited.has(project)) continue;
      this.audited.add(project);
      await recordAudit(this.env.DB, project, {
        ...this.auditActor,
        detail: detail ?? this.auditActor.detail,
      });
    }
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

  /** Parse a spec, apply project options (internal traffic) and resolve cohort references. */
  private async prepareSpec(kind: string, input: unknown) {
    if (!isInsightKind(kind)) {
      throw new HttpError(
        400,
        `Unknown query kind "${kind}"`,
        `Use one of: ${Object.keys(INSIGHTS).join(', ')}, or the sql tool.`,
      );
    }
    const def = INSIGHTS[kind as InsightKind];
    const spec = def.schema.parse(input) as { project?: string } & Record<string, unknown>;
    const ctx = await this.context(spec.project);
    const effective: Record<string, unknown> = this.withProjectOptions(spec, ctx.settings);
    if (kind === 'revenue' && !effective.currency)
      effective.currency = ctx.settings.baseCurrency ?? 'USD';
    const breakdown = effective.breakdown;
    if (breakdown === 'cohort' || (Array.isArray(breakdown) && breakdown[0] === 'cohort')) {
      const keys = (effective.breakdownCohorts as string[] | undefined) ?? [];
      const names = await this.cohortNames(ctx.project);
      effective.cohortBreakdown = keys.map((key) => ({
        key,
        label: names.get(key) ?? key,
        filter: { property: COHORT_PROPERTY, value: key },
      }));
    }
    const resolved = await this.resolveCohorts(ctx.project, effective);
    return { def, spec, resolved, ctx };
  }

  async runInsight(kind: string, input: unknown) {
    const { def, spec, resolved, ctx } = await this.prepareSpec(kind, input);
    const run = def.run as unknown as (s: unknown, c: QueryContext) => Promise<ResultBase>;
    const result = await run(resolved, ctx);
    const annotations =
      kind === 'trends' || kind === 'web'
        ? await this.annotationsBetween(ctx.project, result.range.from, result.range.to)
        : undefined;
    return {
      ...result,
      ...(annotations?.length ? { annotations } : {}),
      project: ctx.project,
      dashboard: this.resultLink(kind, spec as Record<string, unknown>, ctx.project),
    };
  }

  /** Where a query result opens in the dashboard: each kind has its own page or editor. */
  private resultLink(kind: string, spec: Record<string, unknown>, project: string): string {
    const shared: Record<string, unknown> = { ...spec, project: undefined };
    if (kind === 'web') return this.link('reports', { project, spec: shared });
    if (kind === 'revenue')
      return this.link('revenue', {
        project,
        from: spec.from,
        to: spec.to,
        interval: spec.interval,
        breakdown: spec.breakdown,
        by: spec.aggregateBy,
      });
    if (kind === 'funnel_correlation') {
      // The correlation table sits under the funnel it explains.
      const { correlation: _c, properties: _p, exclude: _e, limit: _l, ...funnel } = shared;
      return this.link('insights/funnel', { project, spec: funnel });
    }
    return this.link(`insights/${kind}`, { project, spec: shared });
  }

  // ── Actors ───────────────────────────────────────────────────────────────

  /** The people, sessions or groups behind one number of a trends, funnel, retention or paths result. */
  async actors(input: unknown) {
    const args = inputs.actors.parse(input);
    const compile = ACTOR_COMPILERS[args.kind];
    if (!compile) throw new HttpError(400, `Listing actors is not available for ${args.kind}`);
    const { resolved, ctx } = await this.prepareSpec(args.kind, {
      ...args.spec,
      ...(args.project ? { project: args.project } : {}),
    });
    const select = (limit: number, offset: number) =>
      compile(resolved, ctx, args.selection as ActorSelection, { limit, offset });
    if (args.saveAsCohort) return this.saveActorsAsCohort(args, resolved, ctx.project, select);
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const sql = select(limit + 1, offset);
    const rows = await this.store.query(sql);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => ({ id: text(r.actor), n: num(r.n) }));
    const aggregation = aggregationOf(resolved as { aggregateBy?: string });
    const details = await this.actorDetails(
      ctx.project,
      aggregation,
      page.map((a) => a.id),
    );
    const actors = page.map((a) => ({
      id: a.id,
      type: actorType(aggregation),
      ...(typeof aggregation === 'object' ? { groupType: aggregation.group } : {}),
      events: a.n,
      properties: details.get(a.id) ?? {},
      dashboard: this.actorLink(aggregation, ctx.project, a.id),
    }));
    const result = {
      project: ctx.project,
      kind: args.kind,
      selection: args.selection,
      actors,
      offset,
      hasMore,
      sql: [sql],
      summary: actorsSummary(actors, hasMore, actorNounOf(aggregation), offset),
    };
    return args.format === 'csv' ? { ...result, csv: actorsCsv(actors) } : result;
  }

  /** Everyone behind the number, saved as a static cohort (people only, and not too many). */
  private async saveActorsAsCohort(
    args: z.infer<typeof inputs.actors>,
    resolved: unknown,
    project: string,
    select: (limit: number, offset: number) => string,
  ) {
    if (aggregationOf(resolved as { aggregateBy?: string }) !== 'person')
      throw new HttpError(
        400,
        'Only people can be saved as a cohort; this spec counts sessions or groups.',
      );
    const all = await this.store.query(select(STATIC_COHORT_LIMIT + 1, 0));
    if (all.length > STATIC_COHORT_LIMIT)
      throw new HttpError(
        400,
        `More than ${STATIC_COHORT_LIMIT.toLocaleString('en-US')} people: too many for a static cohort`,
        'Save a dynamic cohort with conditions instead.',
      );
    return this.saveCohort({
      project,
      key: args.saveAsCohort!.key,
      name: args.saveAsCohort!.name,
      description: `Saved from a ${args.kind} selection on ${new Date().toISOString().slice(0, 10)}`,
      static: true,
      ids: all.map((r) => text(r.actor)),
    });
  }

  /** Where a person, group or session opens in the dashboard. */
  private actorLink(aggregation: Aggregation, project: string, id: string): string {
    if (aggregation === 'person') return this.link(`users/${encodeURIComponent(id)}`, { project });
    if (aggregation === 'session') return this.replayLink(project, id);
    return this.link(`groups/${encodeURIComponent(aggregation.group)}/${encodeURIComponent(id)}`, {
      project,
    });
  }

  private async actorDetails(
    project: string,
    aggregation: ReturnType<typeof aggregationOf>,
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (ids.length === 0 || aggregation === 'session') return out;
    const json = JSON.stringify(ids);
    if (aggregation === 'person') {
      const { results } = await this.env.DB.prepare(
        'SELECT person_id AS id, props FROM persons WHERE project = ?1 AND person_id IN (SELECT value FROM json_each(?2))',
      )
        .bind(project, json)
        .all<{ id: string; props: string }>();
      for (const r of results) out.set(r.id, safeParse(r.props));
    } else {
      const { results } = await this.env.DB.prepare(
        'SELECT key AS id, props FROM groups WHERE project = ?1 AND type = ?2 AND key IN (SELECT value FROM json_each(?3))',
      )
        .bind(project, aggregation.group, json)
        .all<{ id: string; props: string }>();
      for (const r of results) out.set(r.id, safeParse(r.props));
    }
    return out;
  }

  private async cohortNames(project: string): Promise<Map<string, string>> {
    const { results } = await this.env.DB.prepare('SELECT key, name FROM cohorts WHERE project = ?')
      .bind(project)
      .all<{ key: string; name: string }>();
    return new Map(results.map((r) => [r.key, r.name]));
  }

  // ── Annotations ──────────────────────────────────────────────────────────

  private async annotationsBetween(project: string, from: string, to: string, insight = '') {
    const { results } = await this.env.DB.prepare(
      `SELECT id, ts_ms, text, insight, author FROM annotations
       WHERE project = ? AND ts_ms >= ? AND ts_ms < ? AND (insight = '' OR insight = ?)
       ORDER BY ts_ms LIMIT 200`,
    )
      .bind(project, Date.parse(from), Date.parse(to), insight)
      .all<{ id: string; ts_ms: number; text: string; insight: string; author: string }>();
    return results.map((r) => ({
      id: r.id,
      at: new Date(r.ts_ms).toISOString(),
      text: r.text,
      ...(r.insight ? { insight: r.insight } : {}),
      ...(r.author ? { author: r.author } : {}),
    }));
  }

  async listAnnotations(input: unknown) {
    const spec = inputs.listAnnotations.parse(input);
    const ctx = await this.context(spec.project);
    const from = spec.from === undefined ? 0 : parseTime(spec.from);
    const to = spec.to === undefined ? Date.now() + 365 * DAY_MS : parseTime(spec.to);
    const annotations = await this.annotationsBetween(
      ctx.project,
      new Date(from).toISOString(),
      new Date(to).toISOString(),
      spec.insight ?? '',
    );
    return {
      project: ctx.project,
      annotations,
      summary: annotations.length
        ? `${annotations.length} annotation${annotations.length === 1 ? '' : 's'}: ${annotations
            .slice(-5)
            .map((a) => `${a.at.slice(0, 10)} ${a.text}`)
            .join('; ')}.`
        : 'No annotations in that range.',
    };
  }

  async createAnnotation(input: unknown) {
    const spec = inputs.createAnnotation.parse(input);
    const ctx = await this.context(spec.project);
    const ts = parseTime(spec.at);
    const id = crypto.randomUUID().slice(0, 12);
    await this.env.DB.prepare(
      'INSERT INTO annotations (project, id, ts_ms, text, insight, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(ctx.project, id, ts, spec.text, spec.insight ?? '', spec.author ?? '', Date.now())
      .run();
    return {
      project: ctx.project,
      id,
      at: new Date(ts).toISOString(),
      text: spec.text,
      summary: `Annotated ${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC: "${spec.text}".`,
    };
  }

  async deleteAnnotation(input: unknown) {
    const spec = inputs.deleteAnnotation.parse(input);
    const ctx = await this.context(spec.project);
    const res = await this.env.DB.prepare('DELETE FROM annotations WHERE project = ? AND id = ?')
      .bind(ctx.project, spec.id)
      .run();
    if (!res.meta.changes) throw new HttpError(404, `No annotation "${spec.id}"`);
    return { project: ctx.project, deleted: spec.id, summary: 'Annotation deleted.' };
  }

  async sql(input: unknown) {
    const spec = sqlSpec.parse(input);
    // SQL can read any project's rows whatever `project` says, so every student project is audited.
    await this.auditAll(spec.query);
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
    await this.auditAll();
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

  private async trafficScope(project?: string) {
    if (project) {
      const ctx = await this.context(project);
      return { projects: [ctx.project], ctx };
    }
    await this.auditAll();
    return {
      projects: (await listProjects(this.env.DB)).map((p) => p.id),
      ctx: { dialect: this.store.dialect, execute: (sql: string) => this.store.query(sql) },
    };
  }

  async instrumentationCoverage(input: unknown) {
    const spec = trafficScope.parse(input);
    const { projects, ctx } = await this.trafficScope(spec.project);
    const statement = spec.project
      ? this.env.DB.prepare(
          'SELECT project,event,role,description FROM event_definitions WHERE project = ?',
        ).bind(spec.project)
      : this.env.DB.prepare('SELECT project,event,role,description FROM event_definitions');
    const sql = `SELECT DISTINCT insights.project, insights.name, json_extract(step.value, '$.event') AS event
      FROM insights, json_each(insights.spec, '$.steps') AS step
      WHERE insights.kind = 'funnel' AND json_type(step.value, '$.event') = 'text'`;
    const funnels = spec.project
      ? this.env.DB.prepare(sql + ' AND insights.project = ?').bind(spec.project)
      : this.env.DB.prepare(sql);
    const [definitions, steps] = await Promise.all([
      statement.all<Definition>(),
      funnels.all<FunnelStep>(),
    ]);
    return { projects: await runCoverage(spec, projects, definitions.results, ctx, steps.results) };
  }

  async product(input: unknown) {
    const spec = inputs.product.parse(input);
    const ctx = await this.context(spec.project);
    return runProduct(
      resolveRange(spec.from ?? '-30d', spec.to),
      await this.keyEvents(ctx.project),
      ctx,
    );
  }

  async trafficBreakdown(input: unknown) {
    const spec = inputs.trafficBreakdown.parse(input);
    const { projects, ctx } = await this.trafficScope(spec.project);
    const range = resolveRange(spec.from, spec.to);
    const filtered = await filteredPageviews(this.env.DB, projects, range);
    return {
      ...(await runTrafficBreakdown(range, projects, ctx, filtered)),
      dashboard: this.link('sites', spec),
    };
  }

  async traffic(input: unknown) {
    const spec = inputs.traffic.parse(input);
    const { projects, ctx } = await this.trafficScope(spec.project);
    const result = await runTraffic(spec, spec.project ?? projects, ctx);
    return {
      ...result,
      dashboard: this.link('sites', {
        project: spec.project,
        path: spec.path,
        from: spec.from,
        to: spec.to,
        offset: spec.offset,
      }),
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
        revenue: await this.revenueConfigured(ctx.project, ctx.settings),
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
    // Issue names and status for the top issues (error tracking).
    const { issues: known, merged } = r.topIssues.length
      ? await listIssueRows(this.env, ctx.project, { status: 'all' })
      : { issues: [], merged: new Map<string, string>() };
    const byId = new Map(known.map((i) => [i.id, i]));
    const folded = new Map<string, { errors: number; visitors: number }>();
    for (const t of r.topIssues) {
      const id = merged.get(t.issue) ?? t.issue;
      const f = folded.get(id) ?? { errors: 0, visitors: 0 };
      f.errors += t.errors;
      f.visitors += t.visitors;
      folded.set(id, f);
    }
    const topIssues = [...folded]
      .map(([id, f]) => {
        const i = byId.get(id);
        return {
          id,
          type: i?.type ?? '',
          message: i?.message ?? '',
          status: i?.status ?? 'active',
          regressed: Boolean(i?.regressedAt),
          ...f,
          link: this.link(`errors/${id}`, { project: ctx.project }),
        };
      })
      .sort((a, b) => b.errors - a.errors);
    const { topIssues: _, ...rest } = r;
    const issueLine = topIssues.length
      ? ` Top issue: ${topIssues[0]!.type}: ${topIssues[0]!.message.slice(0, 100)} (${topIssues[0]!.errors}×); get_issue has its stack.`
      : '';
    return {
      project: ctx.project,
      ...rest,
      topIssues,
      summary: `${r.summary}${issueLine}`,
      replays: frustration,
    };
  }

  // ── Usage and cost ──────────────────────────────────────────────────────

  /** What this deployment adds to the Cloudflare bill, projected to a month, with ways to cut it. */
  /** Recorded sessions per project since a time (none when replays are off). */
  private async replaysSince(since: number) {
    type Row = { project: string; sessions: number; chunks: number; bytes: number };
    if (!replaysEnabled(this.env)) return { results: [] as Row[] };
    return this.env.DB.prepare(
      'SELECT project, COUNT(*) AS sessions, SUM(chunks) AS chunks, SUM(bytes) AS bytes FROM replays WHERE started_at >= ? GROUP BY project',
    )
      .bind(since)
      .all<Row>();
  }

  private async replayBytes() {
    if (!replaysEnabled(this.env)) return { bytes: 0 };
    return this.env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM replays').first<{
      bytes: number;
    }>();
  }

  /** Events stored in D1 (the lake doesn't count them here). */
  private async storedEvents() {
    if (this.store.kind !== 'd1') return { n: 0 };
    return this.env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
  }

  async usage(input: unknown) {
    const spec = inputs.usage.parse(input ?? {});
    const days = spec.days ?? 7;
    const since = Date.now() - days * DAY_MS;
    const d = this.store.dialect;
    const PV = "'$pageview'";
    const [perProject, topEvents, replayRows, storedReplays, storedEvents, sizeProbe, deliveries] =
      await Promise.all([
        this.store.query(`SELECT project, COUNT(*) AS n, SUM(CASE WHEN event = ${PV} THEN 1 ELSE 0 END) AS pv, COUNT(DISTINCT session_id) AS sessions
FROM ${d.table('events')} WHERE ts_ms >= ${since} GROUP BY project`),
        this.store.query(
          `SELECT event, COUNT(*) AS n FROM ${d.table('events')} WHERE ts_ms >= ${since} GROUP BY event ORDER BY n DESC, event ASC LIMIT 10`,
        ),
        this.replaysSince(since),
        this.replayBytes(),
        this.storedEvents(),
        this.env.DB.prepare('SELECT 1 AS one').run(),
        this.env.DB.prepare(
          'SELECT COALESCE(SUM(delivered + failed + skipped), 0) AS n FROM destination_stats WHERE hour >= ?',
        )
          .bind(since)
          .first<{ n: number }>(),
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
      deliveries: { messages: Number(deliveries?.n ?? 0), queue: Boolean(this.env.DELIVERIES) },
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

  /** Lifetime revenue (two years) of a person or device, when the project records revenue. */
  private async lifetimeRevenue(
    ctx: { project: string; settings: ProjectSettings },
    id: string,
    now: number,
  ) {
    if (!(await this.revenueConfigured(ctx.project, ctx.settings))) return null;
    const d = this.store.dialect;
    const rev = d.jsonNumber('props', ['$revenue_base']);
    const revSql = `WITH ${eventsCte(d, {
      project: ctx.project,
      from: now - 730 * DAY_MS,
      to: now + 60_000,
      filters: [{ property: 'props.$revenue_base', op: 'is_set' }],
    })}
SELECT SUM(r) AS net, SUM(CASE WHEN r > 0 THEN r ELSE 0 END) AS gross, SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END) AS orders,
  MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts
FROM (SELECT ts_ms, ${rev} AS r FROM ev WHERE pid = ${d.str(id)} OR distinct_id = ${d.str(id)}) x`;
    const [r] = await this.store.query(revSql);
    const at = (v: unknown) => (v ? new Date(num(v)).toISOString() : null);
    return {
      net: Math.round(num(r?.net) * 100) / 100,
      gross: Math.round(num(r?.gross) * 100) / 100,
      orders: num(r?.orders),
      firstAt: at(r?.first_ts),
      lastAt: at(r?.last_ts),
      currency: ctx.settings.baseCurrency ?? 'USD',
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
    const revenue = await this.lifetimeRevenue(ctx, id, now);
    // The groups (companies, teams…) their events in the last 90 days were part of.
    const groups = await this.personGroups(ctx.project, id, now);
    return {
      project: ctx.project,
      id,
      identified: Boolean(person),
      properties: person ? (JSON.parse(person.props) as Record<string, unknown>) : {},
      groups: groups.list,
      firstSeen: person ? new Date(person.first_seen).toISOString() : (events.at(-1)?.time ?? null),
      lastSeen: person ? new Date(person.last_seen).toISOString() : (events[0]?.time ?? null),
      devices: devices.results.map((r) => r.distinct_id),
      ...(revenue ? { revenue } : {}),
      recentEvents: events,
      replays: replays.map((r) => ({
        session: r.session_id,
        started: new Date(r.started_at).toISOString(),
        errors: r.errors,
        url: r.start_url,
      })),
      summary: personSummary(
        id,
        Boolean(person),
        events.length,
        replays.length,
        groups.list,
        revenue,
      ),
      sql: [sql, ...groups.sql],
      dashboard: this.link(`users/${encodeURIComponent(id)}`, { project: ctx.project }),
    };
  }

  /** Groups a person's events named in the last 90 days, newest first, with each group's name. */
  private async personGroups(project: string, id: string, now: number) {
    const { results: types } = await this.env.DB.prepare(
      'SELECT type FROM group_types WHERE project = ? ORDER BY idx',
    )
      .bind(project)
      .all<{ type: string }>();
    if (!types.length) return { list: [], sql: [] };
    const d = this.store.dialect;
    const who = `(pid = ${d.str(id)} OR distinct_id = ${d.str(id)})`;
    const sql = `WITH ${eventsCte(d, { project, from: now - 90 * DAY_MS, to: now + 60_000 })}
${types
  .map(({ type }) => {
    const key = d.jsonText('props', ['$groups', type]);
    return `SELECT ${d.str(type)} AS type, ${key} AS group_key, MAX(ts_ms) AS last_ts FROM ev WHERE ${who} AND ${key} IS NOT NULL GROUP BY ${key}`;
  })
  .join('\nUNION ALL\n')}`;
    const rows = (await this.store.query(sql))
      .map((r) => ({ type: text(r.type), key: text(r.group_key), last: num(r.last_ts) }))
      .filter((r) => r.key)
      .sort((a, b) => b.last - a.last)
      .slice(0, 20);
    const names = new Map<string, Record<string, unknown>>();
    if (rows.length) {
      const { results } = await this.env.DB.prepare(
        `SELECT type, key, props FROM groups WHERE project = ? AND (${rows.map(() => '(type = ? AND key = ?)').join(' OR ')})`,
      )
        .bind(project, ...rows.flatMap((r) => [r.type, r.key]))
        .all<{ type: string; key: string; props: string }>();
      for (const r of results) names.set(`${r.type}\u0000${r.key}`, safeParse(r.props));
    }
    return {
      list: rows.map((r) => {
        const props = names.get(`${r.type}\u0000${r.key}`) ?? {};
        return {
          type: r.type,
          key: r.key,
          name: typeof props.name === 'string' ? props.name : null,
          properties: props,
          lastSeen: new Date(r.last).toISOString(),
          link: this.link(`groups/${encodeURIComponent(r.type)}/${encodeURIComponent(r.key)}`, {
            project,
          }),
        };
      }),
      sql: [sql],
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

  /** A cohort definition from v2 `definition` or the v1 fields (filters, didEvent, from). */
  private definitionFrom(spec: {
    definition?: CohortDefinition;
    filters?: unknown[];
    didEvent?: string;
    from?: string | number;
  }): CohortDefinition {
    if (spec.definition) return spec.definition;
    return normaliseCohort({
      filters: spec.filters ?? [],
      didEvent: spec.didEvent,
      from: spec.from,
    });
  }

  private async countMembers(sql: string): Promise<number> {
    return num((await this.store.query(`SELECT COUNT(*) AS n FROM (${sql}) m`))[0]?.n);
  }

  /** How many distinct people match a cohort definition right now. */
  async countCohort(input: unknown) {
    const spec = inputs.countCohort.parse(input);
    const ctx = await this.context(spec.project);
    const definition = this.definitionFrom(spec);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const cctx = await cohortContext(
      this.env,
      this.store,
      ctx.project,
      cohorts,
      cohortReferences(definition),
    );
    const sql = compileCohort(definition, cctx);
    const count = await this.countMembers(sql);
    return {
      project: ctx.project,
      count,
      description: describeCohort(definition, cohortNames(cohorts)),
      summary: `${count} ${count === 1 ? 'person' : 'people'} match: ${describeCohort(definition, cohortNames(cohorts))}.`,
      sql: [sql],
    };
  }

  async listCohorts(input: unknown) {
    const spec = inputs.listCohorts.parse(input);
    const ctx = await this.context(spec.project);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const usedByFlags = cohortsUsedByFlags(await listFlags(this.env.DB, ctx.project, true));
    const cctx = await cohortContext(this.env, this.store, ctx.project, cohorts, [
      ...cohorts.keys(),
    ]);
    const out = [];
    for (const row of cohorts.values()) {
      const { count, sql } = await this.cohortCount(ctx.project, row, cctx);
      out.push({
        key: row.key,
        name: row.name,
        description: row.description,
        kind: row.kind,
        definition: row.kind === 'static' ? null : row.definition,
        summary:
          row.kind === 'static'
            ? 'Static list of people'
            : describeCohort(row.definition, cohortNames(cohorts)),
        count,
        usedByFlags: usedByFlags.has(row.key),
        refreshedAt: row.refreshedAt ? new Date(row.refreshedAt).toISOString() : null,
        updatedAt: new Date(row.updatedAt).toISOString(),
        sql: [sql],
        retention: this.link('insights/retention', {
          project: ctx.project,
          spec: cohortRetentionSpec(row),
        }),
      });
    }
    return {
      project: ctx.project,
      cohorts: out,
      summary: cohortsSummary(out),
      dashboard: this.link('users', { project: ctx.project }),
    };
  }

  /** How many people a cohort has now: its stored list, or its conditions run as SQL. */
  private async cohortCount(
    project: string,
    row: CohortRow,
    cctx: Awaited<ReturnType<typeof cohortContext>>,
  ) {
    if (row.kind !== 'static') {
      const sql = membershipSql(row, cctx);
      return { sql, count: await this.countMembers(sql) };
    }
    const sql = `SELECT COUNT(*) AS n FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static'`;
    const r = await this.env.DB.prepare(sql).bind(project, row.key).first<{ n: number }>();
    return { sql, count: Number(r?.n ?? 0) };
  }

  async saveCohort(input: unknown) {
    const spec = inputs.saveCohort.parse(input);
    const ctx = await this.context(spec.project);
    const key = cohortKey(spec.key, spec.name);
    const isStatic = spec.static ?? false;
    const definition = isStatic ? null : this.definitionFrom(spec);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const existing = cohorts.get(key);
    const now = Date.now();
    const sql = definition
      ? await this.compileNewCohort(ctx.project, cohorts, key, spec, definition, now)
      : '';
    await this.env.DB.prepare(
      `INSERT INTO cohorts (project, key, name, definition, kind, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, key) DO UPDATE SET name = excluded.name, definition = excluded.definition,
         kind = excluded.kind, description = excluded.description, updated_at = excluded.updated_at, refreshed_at = NULL`,
    )
      .bind(
        ctx.project,
        key,
        spec.name,
        JSON.stringify(definition ?? {}),
        isStatic ? 'static' : 'dynamic',
        spec.description ?? '',
        existing?.createdAt ?? now,
        now,
      )
      .run();
    await this.syncMembers(ctx.project, key, isStatic, spec.ids, existing);
    if (definition) await this.materialiseIfFlagged(ctx.project, key);
    const count = isStatic
      ? await this.staticCount(ctx.project, key)
      : await this.countMembers(sql);
    const described = definition ? `: ${describeCohort(definition, cohortNames(cohorts))}` : '';
    return {
      project: ctx.project,
      key,
      name: spec.name,
      kind: isStatic ? 'static' : 'dynamic',
      created: !existing,
      count,
      summary: `${existing ? 'Updated' : 'Created'} ${isStatic ? 'static ' : ''}cohort "${spec.name}" (${count} people)${described}.`,
      sql: sql ? [sql] : [],
      dashboard: this.link('users', { project: ctx.project, cohort: key }),
    };
  }

  /** Compile against the saved cohorts with this one in place, so loops through it are caught. */
  private async compileNewCohort(
    project: string,
    cohorts: Map<string, CohortRow>,
    key: string,
    spec: { name: string; description?: string },
    definition: CohortDefinition,
    now: number,
  ): Promise<string> {
    cohorts.set(key, {
      key,
      name: spec.name,
      description: spec.description ?? '',
      kind: 'dynamic',
      definition,
      createdAt: now,
      updatedAt: now,
      refreshedAt: null,
    });
    const cctx = await cohortContext(this.env, this.store, project, cohorts, [key]);
    try {
      return compileCohort(definition, cctx, [key]);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  /** A static cohort's list replaced; a cohort that stops being static loses its list. */
  private async syncMembers(
    project: string,
    key: string,
    isStatic: boolean,
    ids: string[] | undefined,
    existing: CohortRow | undefined,
  ) {
    if (isStatic && ids) await this.replaceStaticMembers(project, key, ids);
    if (isStatic || existing?.kind !== 'static') return;
    await this.env.DB.prepare(
      "DELETE FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static'",
    )
      .bind(project, key)
      .run();
  }

  /** A cohort a flag targets needs its membership worked out before /f can use it. */
  private async materialiseIfFlagged(project: string, key: string): Promise<void> {
    if (!cohortsUsedByFlags(await listFlags(this.env.DB, project, true)).has(key)) return;
    const fresh = await loadCohorts(this.env.DB, project);
    await materialise(this.env, this.store, project, fresh.get(key)!, fresh);
  }

  private async staticCount(project: string, key: string): Promise<number> {
    const r = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static'",
    )
      .bind(project, key)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  private async replaceStaticMembers(project: string, key: string, ids: string[]): Promise<void> {
    const db = this.env.DB;
    const now = Date.now();
    const unique = [...new Set(ids.map(String).filter(Boolean))];
    const statements = [
      db
        .prepare(
          "DELETE FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static'",
        )
        .bind(project, key),
    ];
    for (let i = 0; i < unique.length; i += 2000) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO cohort_members (project, cohort, person_id, source, added_at)
             SELECT ?1, ?2, value, 'static', ?3 FROM json_each(?4)`,
          )
          .bind(project, key, now, JSON.stringify(unique.slice(i, i + 2000))),
      );
    }
    await db.batch(statements);
  }

  /** Add or remove people from a static cohort. */
  async editCohortMembers(input: unknown) {
    const spec = inputs.editCohortMembers.parse(input);
    const ctx = await this.context(spec.project);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const row = cohorts.get(spec.key);
    if (!row) throw new HttpError(404, `No cohort "${spec.key}"`);
    if (row.kind !== 'static')
      throw new HttpError(
        400,
        `Cohort "${spec.key}" is dynamic: its members come from its conditions`,
        'Duplicate it as a static cohort to edit the list.',
      );
    const db = this.env.DB;
    const statements = [];
    const now = Date.now();
    if (spec.add?.length) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO cohort_members (project, cohort, person_id, source, added_at)
             SELECT ?1, ?2, value, 'static', ?3 FROM json_each(?4)`,
          )
          .bind(ctx.project, spec.key, now, JSON.stringify(spec.add)),
      );
    }
    if (spec.remove?.length) {
      statements.push(
        db
          .prepare(
            "DELETE FROM cohort_members WHERE project = ?1 AND cohort = ?2 AND source = 'static' AND person_id IN (SELECT value FROM json_each(?3))",
          )
          .bind(ctx.project, spec.key, JSON.stringify(spec.remove)),
      );
    }
    if (statements.length) await db.batch(statements);
    const r = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static'",
      )
      .bind(ctx.project, spec.key)
      .first<{ n: number }>();
    const count = Number(r?.n ?? 0);
    return {
      project: ctx.project,
      key: spec.key,
      count,
      summary: `Cohort "${row.name}" now has ${count} people.`,
    };
  }

  /** People in a saved cohort, with their properties. */
  async cohortMembers(input: unknown) {
    const spec = inputs.cohortMembers.parse(input);
    const ctx = await this.context(spec.project);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const row = cohorts.get(spec.key);
    if (!row) throw new HttpError(404, `No cohort "${spec.key}"`);
    const limit = spec.limit ?? 100;
    const offset = spec.offset ?? 0;
    const cctx = await cohortContext(this.env, this.store, ctx.project, cohorts, [spec.key]);
    const sql = `SELECT DISTINCT m.pid AS pid FROM (${membershipSql(row, cctx)}) m ORDER BY m.pid LIMIT ${limit + 1} OFFSET ${offset}`;
    const ids =
      row.kind === 'static' && this.store.kind !== 'd1'
        ? (
            await this.env.DB.prepare(
              "SELECT person_id AS pid FROM cohort_members WHERE project = ? AND cohort = ? AND source = 'static' ORDER BY person_id LIMIT ? OFFSET ?",
            )
              .bind(ctx.project, spec.key, limit + 1, offset)
              .all<{ pid: string }>()
          ).results.map((r) => r.pid)
        : (await this.store.query(sql)).map((r) => text(r.pid));
    const hasMore = ids.length > limit;
    const page = ids.slice(0, limit);
    const details = await this.actorDetails(ctx.project, 'person', page);
    const people = page.map((id) => ({
      id,
      type: 'person',
      events: 0,
      properties: details.get(id) ?? {},
      dashboard: this.link(`users/${encodeURIComponent(id)}`, { project: ctx.project }),
    }));
    const result = {
      project: ctx.project,
      key: spec.key,
      name: row.name,
      people,
      offset,
      hasMore,
      sql: [sql],
      summary: `${people.length}${hasMore ? '+' : ''} people in "${row.name}"${offset ? ` from #${offset + 1}` : ''}.`,
    };
    return spec.format === 'csv' ? { ...result, csv: actorsCsv(people) } : result;
  }

  /** Copy a cohort as a static list of who is in it now. */
  async duplicateCohort(input: unknown) {
    const spec = inputs.duplicateCohort.parse(input);
    const ctx = await this.context(spec.project);
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const row = cohorts.get(spec.key);
    if (!row) throw new HttpError(404, `No cohort "${spec.key}"`);
    const cctx = await cohortContext(this.env, this.store, ctx.project, cohorts, [spec.key]);
    const ids = (
      await this.store.query(
        `SELECT DISTINCT m.pid AS pid FROM (${membershipSql(row, cctx)}) m LIMIT ${STATIC_COHORT_LIMIT + 1}`,
      )
    ).map((r) => text(r.pid));
    if (ids.length > STATIC_COHORT_LIMIT) {
      throw new HttpError(
        400,
        `"${row.name}" has more than ${STATIC_COHORT_LIMIT.toLocaleString('en-US')} people, too many for a static cohort`,
      );
    }
    return this.saveCohort({
      project: ctx.project,
      key: spec.newKey,
      name: spec.name ?? `${row.name} (static copy)`,
      description: `Copy of "${row.name}" on ${new Date().toISOString().slice(0, 10)}`,
      static: true,
      ids,
    });
  }

  async deleteCohort(input: unknown) {
    const spec = inputs.deleteCohort.parse(input);
    const ctx = await this.context(spec.project);
    if (cohortsUsedByFlags(await listFlags(this.env.DB, ctx.project, true)).has(spec.key)) {
      throw new HttpError(
        409,
        `Cohort "${spec.key}" is used by a feature flag`,
        'Remove it from the flag’s targeting first.',
      );
    }
    const cohorts = await loadCohorts(this.env.DB, ctx.project);
    const users = [...cohorts.values()].filter(
      (c) =>
        c.key !== spec.key &&
        c.kind === 'dynamic' &&
        cohortReferences(c.definition).includes(spec.key),
    );
    if (users.length) {
      throw new HttpError(
        409,
        `Cohort "${spec.key}" is used by ${users.map((c) => `"${c.name}"`).join(', ')}`,
        'Change those cohorts first.',
      );
    }
    const result = await this.env.DB.prepare('DELETE FROM cohorts WHERE project = ? AND key = ?')
      .bind(ctx.project, spec.key)
      .run();
    if (!result.meta.changes) throw new HttpError(404, `No cohort "${spec.key}"`);
    await this.env.DB.prepare('DELETE FROM cohort_members WHERE project = ? AND cohort = ?')
      .bind(ctx.project, spec.key)
      .run();
    return { project: ctx.project, deleted: spec.key, summary: `Deleted cohort "${spec.key}".` };
  }

  /**
   * Attach compiled membership to every `cohort` filter in a query spec, so core
   * can filter by it without reading the cohorts table. Returns a copy.
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
    const cohorts = await loadCohorts(this.env.DB, project);
    const keys = [...new Set(refs.flatMap((f) => toList(f.value)))];
    for (const key of keys) {
      if (!cohorts.has(key)) {
        throw new HttpError(
          400,
          `No cohort "${key}" in project "${project}"`,
          cohorts.size
            ? `Saved cohorts: ${[...cohorts.keys()].join(', ')}.`
            : 'Save one with save_cohort or from the People tab first.',
        );
      }
    }
    const cctx = await cohortContext(this.env, this.store, project, cohorts, keys);
    for (const f of refs) {
      f.cohorts = {};
      for (const key of toList(f.value)) {
        const members: CohortMembers = {
          project,
          from: 0,
          to: 0,
          filters: [],
          sql: membershipSql(cohorts.get(key)!, cctx),
        };
        f.cohorts[key] = members;
      }
    }
    return copy;
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
    const { project: _, actor, ...definition } = spec;
    const result = await saveFlag(
      this.env.DB,
      ctx.project,
      definition as FlagInput,
      actor ?? this.actor,
    );
    // A flag that now targets a dynamic cohort needs its membership before /f can use it.
    for (const key of cohortsUsedByFlags([result.flag]))
      await this.readyCohortForFlag(ctx.project, spec.key, key);
    return { project: ctx.project, ...result, summary: flagSummary(spec.key, result) };
  }

  private async readyCohortForFlag(project: string, flag: string, key: string): Promise<void> {
    const cohorts = await loadCohorts(this.env.DB, project);
    const row = cohorts.get(key);
    if (!row)
      throw new HttpError(400, `Flag "${flag}" targets cohort "${key}", which doesn't exist`);
    if (row.kind === 'dynamic' && !row.refreshedAt)
      await materialise(this.env, this.store, project, row, cohorts);
  }

  async deleteFlag(input: unknown) {
    const spec = inputs.flagKey.parse(input);
    const ctx = await this.context(spec.project);
    const deleted = await deleteFlag(this.env.DB, ctx.project, spec.key, this.actor);
    if (!deleted) throw new HttpError(404, `No flag "${spec.key}"`);
    return {
      project: ctx.project,
      deleted: spec.key,
      summary: `Deleted flag "${spec.key}". Remove it from your code too.`,
    };
  }

  async flagHistory(input: unknown) {
    const spec = inputs.flagHistory.parse(input);
    const ctx = await this.context(spec.project);
    const history = await flagHistory(this.env.DB, ctx.project, spec.key, spec.limit);
    return {
      project: ctx.project,
      key: spec.key,
      history,
      summary: history.length
        ? `${history.length} change${history.length === 1 ? '' : 's'} to "${spec.key}"; latest ${history[0]!.at.slice(0, 16).replace('T', ' ')}: ${history[0]!.action}${history[0]!.changed.length ? ` (${history[0]!.changed.join(', ')})` : ''}${history[0]!.actor ? ` by ${history[0]!.actor}` : ''}.`
        : `No recorded changes to "${spec.key}".`,
    };
  }

  async scheduleFlag(input: unknown) {
    const spec = inputs.scheduleFlag.parse(input);
    const ctx = await this.context(spec.project);
    const at = typeof spec.at === 'number' ? spec.at : Date.parse(spec.at);
    if (!Number.isFinite(at)) throw new HttpError(400, `Can't read "${spec.at}" as a time`);
    if (at <= Date.now())
      throw new HttpError(
        400,
        'Schedule a change in the future',
        'To change it now, use save_flag.',
      );
    const schedule = await scheduleFlagChange(
      this.env.DB,
      ctx.project,
      spec.key,
      at,
      spec.change,
      spec.actor ?? this.actor,
    );
    return {
      project: ctx.project,
      schedule,
      summary: `Scheduled ${Object.entries(spec.change)
        .map(([k, v]) => `${k} → ${JSON.stringify(v)}`)
        .join(
          ', ',
        )} for "${spec.key}" at ${schedule.runAt}. Changes apply within five minutes of that time.`,
    };
  }

  async flagSchedules(input: unknown) {
    const spec = inputs.flagSchedules.parse(input);
    const ctx = await this.context(spec.project);
    const schedules = await listFlagSchedules(this.env.DB, ctx.project, spec.key);
    const pending = schedules.filter((s) => s.status === 'pending');
    return {
      project: ctx.project,
      schedules,
      summary: `${pending.length} pending scheduled change${pending.length === 1 ? '' : 's'}${pending[0] ? `; next: "${pending.at(-1)!.flag}" at ${pending.at(-1)!.runAt}` : ''}.`,
    };
  }

  async cancelFlagSchedule(input: unknown) {
    const spec = inputs.cancelFlagSchedule.parse(input);
    const ctx = await this.context(spec.project);
    if (!(await cancelFlagSchedule(this.env.DB, ctx.project, spec.id)))
      throw new HttpError(404, `No pending scheduled change "${spec.id}"`);
    return { project: ctx.project, cancelled: spec.id, summary: 'Scheduled change cancelled.' };
  }

  /** Exposures to a flag over time, by value: who has actually seen it. */
  async flagUsage(input: unknown) {
    const spec = inputs.flagUsage.parse(input);
    const ctx = await this.context(spec.project);
    const flag = await getFlag(this.env.DB, ctx.project, spec.key);
    if (!flag) throw new HttpError(404, `No flag "${spec.key}"`);
    const result = await this.runInsight('trends', {
      project: ctx.project,
      series: [
        { event: '$exposure', label: 'Exposures' },
        { event: '$exposure', math: 'unique_persons', label: 'People' },
      ],
      filters: [{ property: 'flag', value: spec.key }],
      breakdown: 'variant',
      from: spec.from ?? '-30d',
      interval: spec.interval ?? 'day',
    });
    const people = (
      result as unknown as {
        series: { label: string; breakdown: string | null; total: number; seriesIndex: number }[];
      }
    ).series.filter((s) => s.seriesIndex === 1);
    return {
      ...result,
      flag,
      summary: people.length
        ? `"${spec.key}" was seen by ${people.map((s) => `${s.total} (${s.breakdown})`).join(', ')} people since ${String(spec.from ?? '-30d')}.`
        : `No one has been exposed to "${spec.key}" yet: read it with glass.flag("${spec.key}") where it is used.`,
    };
  }

  /** What a user gets: every flag's value, payload and the reason. For debugging targeting. */
  async evaluateFlags(input: unknown) {
    const spec = inputs.evaluateFlags.parse(input);
    const ctx = await this.context(spec.project);
    const flags = await listFlags(this.env.DB, ctx.project, true);
    const fctx = await flagContext(
      this.env.DB,
      ctx.project,
      spec.distinct_id,
      spec.user_id ?? null,
      undefined,
      cohortsUsedByFlags(flags).size > 0,
      spec.groups ?? {},
      true,
    );
    const results = evaluateFlagsDetailed(flags, fctx);
    const values = Object.fromEntries(
      Object.entries(results)
        .filter(([, r]) => r.value !== null)
        .map(([k, r]) => [k, r.value as string]),
    );
    return {
      project: ctx.project,
      flags: values,
      payloads: payloadsFor(flags, values),
      reasons: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.reason])),
      person: fctx.person,
      cohorts: fctx.cohorts ?? [],
      summary:
        Object.entries(results)
          .map(([k, r]) => `${k}: ${r.value ?? 'off'} (${r.reason})`)
          .join('; ') || 'No flags.',
    };
  }

  /** Flag definitions for local evaluation in a backend (server key). */
  async flagDefinitions(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    return flagDefinitions(this.env, ctx.project);
  }

  // ── Experiments ──────────────────────────────────────────────────────────

  async listExperiments(input: unknown) {
    const spec = inputs.listExperiments.parse(input);
    const ctx = await this.context(spec.project);
    const experiments = await listExperiments(this.env.DB, ctx.project, spec.include_archived);
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
    const { project: _, ...rest } = spec;
    const experiment = await createExperiment(
      this.env.DB,
      ctx.project,
      rest as CreateExperimentInput,
      this.actor,
    );
    return {
      project: ctx.project,
      experiment,
      summary: `Created experiment "${experiment.key}" on flag "${experiment.flag}" (draft)${spec.transforms ? ', a web experiment: the browser SDK applies each variant’s page changes' : ''}. In code, branch on glass.flag("${experiment.flag}") — it records exposures — then start it with update_experiment.`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  async editExperiment(input: unknown) {
    const spec = inputs.editExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, key, ...changes } = spec;
    const experiment = await updateExperimentDefinition(
      this.env.DB,
      ctx.project,
      key,
      changes as Parameters<typeof updateExperimentDefinition>[3],
      this.actor,
    );
    return { project: ctx.project, experiment, summary: `Updated experiment "${key}".` };
  }

  /** The readout spec for a stored experiment: its metrics and options, over its run so far. */
  private async experimentSpecFor(
    project: string,
    experiment: Experiment,
    settings: ProjectSettings,
  ) {
    const flag = await getFlag(this.env.DB, project, experiment.flag);
    const weights = Object.fromEntries((flag?.variants ?? []).map((v) => [v.key, v.weight]));
    // Ten minutes of slack absorbs client clock correction around the start time.
    const from = (experiment.startedAt ?? experiment.createdAt) - 10 * 60_000;
    const filters =
      experiment.filterTestAccounts && settings.internalFilters?.length
        ? excludeInternal(settings.internalFilters)
        : undefined;
    const spec = experimentSpec.parse({
      project,
      flag: experiment.flag,
      ...definedOnly({
        goal: experiment.goal ?? undefined,
        metrics: experiment.metrics.length ? experiment.metrics : undefined,
        secondary: experiment.secondary.length ? experiment.secondary : undefined,
        filters,
        engine: experiment.engine,
        confidence: experiment.confidence,
        exposure: experiment.exposure,
        minimumDays: experiment.minimumDays,
        minimumExposures: experiment.minimumExposures,
        mde: experiment.mde,
        aggregateBy: groupBucket(flag?.bucketBy),
      }),
      variants: flag?.variants?.map((v) => v.key),
      from,
      to: experiment.endedAt ?? 'now',
    });
    return { spec, weights };
  }

  async experimentResults(input: unknown) {
    const spec = inputs.experimentKey.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await getExperiment(this.env.DB, ctx.project, spec.key);
    const { spec: readout, weights } = await this.experimentSpecFor(
      ctx.project,
      experiment,
      ctx.settings,
    );
    const results = await runExperiment(await this.resolveCohorts(ctx.project, readout), ctx, {
      weights,
      startedAt: experiment.startedAt,
    });
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
      this.actor,
    );
    const verb = {
      start: 'Started',
      pause: 'Paused',
      resume: 'Resumed',
      stop: 'Stopped',
      ship: `Shipped "${spec.variant}" for`,
      reset: 'Reset',
      archive: 'Archived',
      unarchive: 'Unarchived',
    }[spec.action];
    return {
      project: ctx.project,
      experiment,
      flag,
      summary: `${verb} experiment "${spec.key}". Flag "${flag.key}" is now ${flag.enabled ? 'on' : 'off'}.`,
    };
  }

  async duplicateExperiment(input: unknown) {
    const spec = inputs.duplicateExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await duplicateExperiment(
      this.env.DB,
      ctx.project,
      spec.key,
      spec.newKey,
      this.actor,
    );
    return {
      project: ctx.project,
      experiment,
      summary: `Copied "${spec.key}" as "${spec.newKey}" (draft, on a new flag "${experiment.flag}").`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  /** How long an experiment would need to detect a change in a metric. */
  async planExperiment(input: unknown) {
    const spec = inputs.planExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const plan = await planExperiment(
      await this.resolveCohorts(ctx.project, spec as Parameters<typeof planExperiment>[0]),
      ctx,
    );
    return { project: ctx.project, ...plan };
  }

  // ── Holdouts ─────────────────────────────────────────────────────────────

  async listHoldouts(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const holdouts = await listHoldouts(this.env.DB, ctx.project);
    const out = [];
    for (const h of holdouts) {
      const using = await experimentsUsingHoldout(this.env.DB, ctx.project, h.key);
      out.push({ ...h, experiments: using.map((e) => ({ key: e.key, status: e.status })) });
    }
    return {
      project: ctx.project,
      holdouts: out,
      summary: out.length
        ? `${out
            .map(
              (h) =>
                `${h.name}: ${h.percentage}% held out of ${h.experiments.length} experiment${h.experiments.length === 1 ? '' : 's'}`,
            )
            .join('; ')}.`
        : 'No holdouts. Create one with save_holdout, then pass holdout when creating experiments.',
    };
  }

  async saveHoldout(input: unknown) {
    const spec = inputs.saveHoldout.parse(input);
    const ctx = await this.context(spec.project);
    const holdout = await saveHoldout(this.env.DB, ctx.project, spec, this.actor);
    return {
      project: ctx.project,
      holdout,
      summary: `Holdout "${holdout.name}" keeps ${holdout.percentage}% of people out of the experiments that use it; they get the value "holdout" (treat it as the default experience).`,
    };
  }

  async deleteHoldout(input: unknown) {
    const spec = inputs.holdoutKey.parse(input);
    const ctx = await this.context(spec.project);
    await deleteHoldout(this.env.DB, ctx.project, spec.key);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted holdout "${spec.key}".` };
  }

  /** The combined effect of a holdout's experiments: everyone exposed vs the people held out. */
  async holdoutResults(input: unknown) {
    const spec = inputs.holdoutResults.parse(input);
    const ctx = await this.context(spec.project);
    const holdout = await getHoldout(this.env.DB, ctx.project, spec.key);
    const experiments = await experimentsUsingHoldout(this.env.DB, ctx.project, spec.key);
    if (!experiments.length)
      throw new HttpError(400, `No experiments use holdout "${spec.key}" yet`);
    const metrics =
      spec.metrics ??
      experiments.flatMap((e) => {
        if (e.metrics[0]) return [e.metrics[0]];
        return e.goal
          ? [{ kind: 'conversion' as const, event: e.goal.event, filters: e.goal.filters as never }]
          : [];
      });
    const readout = {
      ...experimentSpec.parse({
        project: ctx.project,
        flag: experiments[0]!.flag,
        metrics: metrics.slice(0, 10),
        // Ten minutes of slack absorbs client clock correction, as for experiments.
        from: spec.from ?? holdout.createdAt - 10 * 60_000,
        minimumDays: 0,
        minimumExposures: 0,
      }),
      holdoutFlags: experiments.map((e) => e.flag),
    };
    const results = await runExperiment(readout as never, ctx, {
      weights: { holdout: holdout.percentage, experiments: 100 - holdout.percentage },
      timeline: false,
    });
    return {
      project: ctx.project,
      holdout,
      experiments: experiments.map((e) => ({ key: e.key, status: e.status })),
      results,
      summary: `Holdout "${holdout.name}" (control) vs everyone in ${experiments.length} experiment${experiments.length === 1 ? '' : 's'}: ${results.summary}`,
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
    await ensureStarterDashboard(this.env.DB, created.id);
    return {
      project: created,
      summary: `Project "${created.id}" is ready. Use data-project="${created.id}" in the snippet.`,
    };
  }

  // ── Student mode ─────────────────────────────────────────────────────────

  async getProjectPolicy(input: unknown) {
    const spec = inputs.getProjectPolicy.parse(input ?? {});
    const project = await resolveProject(this.env.DB, spec.project);
    const policy = await getPolicy(this.env.DB, project);
    return {
      project,
      policy: policy ?? studentPolicySchema.parse({ audience: 'general' }),
      summary: isMinors(policy)
        ? `Student mode is on for "${project}": pseudonymous ids only, ${policy.event_properties.length} event and ${policy.person_properties.length} person properties allowed, replay ${policy.replay}${policy.retention_days ? `, events kept ${policy.retention_days} days` : ''}. Reads are audited.`
        : `Student mode is off for "${project}"; the deployment's normal collection applies.`,
    };
  }

  async setProjectPolicy(input: unknown) {
    const { project: requested, ...rest } = inputs.setProjectPolicy.parse(input ?? {});
    const project = await resolveProject(this.env.DB, requested);
    const policy = studentPolicySchema.parse(rest);
    if (isMinors(policy) && policy.retention_days && this.store.kind !== 'd1')
      throw new HttpError(
        400,
        'Per-project retention_days needs the D1 event store',
        'Lake deployments apply one retention to every project: set it with `dataflare upgrade --retention-days`, and leave retention_days out.',
      );
    const before = await getPolicy(this.env.DB, project);
    // Turning student mode on or off is itself recorded, whichever way it goes.
    if (isMinors(before) || isMinors(policy)) {
      const who = this.auditActor ?? {
        surface: 'api' as const,
        scope: 'admin' as const,
        actor: 'internal',
        operation: 'set_project_policy',
      };
      await recordAudit(this.env.DB, project, {
        ...who,
        operation: 'set_project_policy',
        detail: JSON.stringify(policy),
      });
    }
    await savePolicy(this.env.DB, project, policy, this.auditActor?.actor ?? 'internal');
    return { ...(await this.getProjectPolicy({ project })), project };
  }

  async auditLog(input: unknown) {
    const spec = inputs.auditLog.parse(input ?? {});
    const project = await resolveProject(this.env.DB, spec.project);
    const range = resolveRange(spec.from ?? '-30d', undefined);
    const limit = spec.limit ?? 200;
    const entries = await listAudit(this.env.DB, project, range.from, limit);
    const policy = await getPolicy(this.env.DB, project);
    return {
      project,
      entries,
      summary: isMinors(policy)
        ? `${entries.length} audited access${entries.length === 1 ? '' : 'es'} to "${project}"${entries.length === limit ? ` (limit ${limit} reached)` : ''}.`
        : `"${project}" isn't in student mode, so its reads aren't audited (${entries.length} older entries).`,
    };
  }

  // ── Destinations ─────────────────────────────────────────────────────────

  listDestinationTemplates() {
    const templates = Object.values(TEMPLATES).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      inputs: t.inputs,
      ...(t.defaultEvents ? { defaultEvents: t.defaultEvents } : {}),
    }));
    return {
      templates,
      summary: `${templates.length} destination templates: ${templates.map((t) => t.name).join(', ')}.`,
    };
  }

  async listDestinations(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const destinations = await listDestinations(this.env, ctx.project);
    const queue = this.env.DELIVERIES
      ? 'Cloudflare Queues'
      : 'the five-minute outbox (no queue bound)';
    return {
      project: ctx.project,
      destinations,
      delivery: this.env.DELIVERIES ? 'queue' : 'outbox',
      summary: destinations.length
        ? `${destinations.length} destination${destinations.length === 1 ? '' : 's'}: ${destinations.map((d) => `${d.name} (${d.template}${d.enabled ? '' : ', off'})`).join(', ')}. Delivered through ${queue}.`
        : 'No destinations. Add one with save_destination (list_destination_templates shows what is available).',
      dashboard: this.link('data/destinations', { project: ctx.project }),
    };
  }

  async getDestination(input: unknown) {
    const spec = inputs.destinationId.parse(input);
    const ctx = await this.context(spec.project);
    const destination = await getDestination(this.env, ctx.project, spec.id);
    const activity = await destinationActivity(this.env.DB, ctx.project, spec.id);
    return {
      project: ctx.project,
      destination,
      activity,
      summary: `${destination.name}: ${activity.totals.delivered} delivered, ${activity.totals.failed} failed, ${activity.totals.skipped} skipped in ${activity.hours}h; ${activity.pending} waiting.`,
    };
  }

  async saveDestination(input: unknown) {
    const spec = inputs.saveDestination.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, ...rest } = spec;
    const destination = await saveDestination(this.env, ctx.project, rest as DestinationInput);
    return {
      project: ctx.project,
      destination,
      summary: `Saved destination "${destination.name}" (${destination.template}): ${destination.enabled ? 'on' : 'off'}, sending ${destination.match.events?.join(', ') || 'its default events'}. Try it with test_destination.`,
    };
  }

  async deleteDestination(input: unknown) {
    const spec = inputs.destinationId.parse(input);
    const ctx = await this.context(spec.project);
    await deleteDestination(this.env, ctx.project, spec.id);
    return { project: ctx.project, deleted: spec.id, summary: 'Destination deleted.' };
  }

  async testDestination(input: unknown) {
    const spec = inputs.testDestination.parse(input);
    const ctx = await this.context(spec.project);
    const result = await testDestination(this.env, ctx.project, spec.id, spec.event as never);
    return {
      project: ctx.project,
      ...result,
      summary: result.ok
        ? result.skipped
          ? `The template skipped the sample "${result.event.event}" event (e.g. it isn't in the event map).`
          : `Sent a sample "${result.event.event}" event: OK.`
        : `The test send failed: ${result.error}.`,
    };
  }

  async retryDestination(input: unknown) {
    const spec = inputs.retryDestination.parse(input);
    const ctx = await this.context(spec.project);
    const n = await retryFailures(this.env, ctx.project, spec.id, spec.failures);
    return {
      project: ctx.project,
      retried: n,
      summary: `Queued ${n} failed deliveries for another try.`,
    };
  }

  // ── Transformations ──────────────────────────────────────────────────────

  async listTransformations(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const transformations = await listTransformations(this.env, ctx.project, true);
    return {
      project: ctx.project,
      transformations,
      summary: transformations.length
        ? transformations
            .map(
              (t) =>
                `${t.position}. ${t.rule.name ?? t.rule.kind}${t.enabled ? '' : ' (off)'}: ${t.applied} applied`,
            )
            .join('; ')
        : 'No transformations: events are stored as sent.',
    };
  }

  async saveTransformation(input: unknown) {
    const spec = inputs.saveTransformation.parse(input);
    const ctx = await this.context(spec.project);
    const t = await saveTransformation(this.env, ctx.project, spec);
    return {
      project: ctx.project,
      transformation: t,
      summary: `Saved ${t.rule.kind} rule${t.rule.name ? ` "${t.rule.name}"` : ''} (position ${t.position}); it applies to events from now on.`,
    };
  }

  async deleteTransformation(input: unknown) {
    const spec = inputs.transformationId.parse(input);
    const ctx = await this.context(spec.project);
    await deleteTransformation(this.env, ctx.project, spec.id);
    return { project: ctx.project, deleted: spec.id, summary: 'Transformation deleted.' };
  }

  /** Try a rule on a sample event without saving it. */
  async testTransformation(input: unknown) {
    const spec = inputs.testTransformation.parse(input);
    const ctx = await this.context(spec.project);
    const now = Date.now();
    const row = {
      id: 'sample',
      project: ctx.project,
      event: spec.event.event,
      ts_ms: now,
      distinct_id: 'd',
      user_id: null,
      person_id: 'd',
      session_id: 's',
      url: spec.event.url ?? '',
      host: '',
      path: '',
      referrer: '',
      referrer_host: '',
      title: spec.event.title ?? '',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_term: '',
      utm_content: '',
      country: '',
      region: '',
      city: '',
      device: '',
      browser: '',
      os: '',
      flags: '{}',
      props: JSON.stringify(spec.event.props ?? {}),
      person_props: JSON.stringify(spec.event.person ?? {}),
      lib: '',
      received_ms: now,
    };
    const result = await applyTransformations([row], [spec.rule], hashSalt(this.env, ctx.project));
    const after = result.rows[0];
    return {
      project: ctx.project,
      dropped: !after,
      after: after
        ? {
            props: JSON.parse(after.props),
            person: JSON.parse(after.person_props),
            url: after.url,
            title: after.title,
          }
        : null,
      summary: !after
        ? 'The rule drops this event.'
        : result.counts[0]
          ? 'The rule changes this event.'
          : 'The rule leaves this event as it is.',
    };
  }

  // ── Batch exports ────────────────────────────────────────────────────────

  async listExports(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const exports = await listExports(this.env, ctx.project);
    return {
      project: ctx.project,
      exports,
      summary: exports.length
        ? exports
            .map(
              (e) =>
                `${e.name} (${e.target}, ${e.frequency}, ${e.enabled ? 'on' : 'off'}) up to ${e.watermark}`,
            )
            .join('; ')
        : 'No batch exports. Add one with save_export (S3/R2, BigQuery or an HTTP endpoint).',
    };
  }

  async saveExport(input: unknown) {
    const spec = inputs.saveExport.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, from, ...rest } = spec;
    const saved = await saveExport(this.env, ctx.project, {
      ...rest,
      ...(from !== undefined ? { from: parseTime(from) } : {}),
    });
    return {
      project: ctx.project,
      export: saved,
      summary: `Saved ${saved.target} export "${saved.name}": every ${saved.frequency}, events received since ${saved.watermark}. Files appear after the first full ${saved.frequency}.`,
    };
  }

  async deleteExport(input: unknown) {
    const spec = inputs.exportId.parse(input);
    const ctx = await this.context(spec.project);
    await deleteExport(this.env, ctx.project, spec.id);
    return { project: ctx.project, deleted: spec.id, summary: 'Export deleted.' };
  }

  async exportRuns(input: unknown) {
    const spec = inputs.exportId.parse(input);
    const ctx = await this.context(spec.project);
    const runs = await exportRuns(this.env, ctx.project, spec.id);
    return {
      project: ctx.project,
      runs,
      summary: runs.length
        ? `Last run: ${runs[0]!.status}, ${runs[0]!.rows} rows in ${runs[0]!.files} files${runs[0]!.error ? ` (${runs[0]!.error})` : ''}.`
        : 'No runs yet.',
    };
  }

  async backfillExport(input: unknown) {
    const spec = inputs.backfillExport.parse(input);
    const ctx = await this.context(spec.project);
    const from = parseTime(spec.from);
    await backfillExport(this.env, ctx.project, spec.id, from);
    return {
      project: ctx.project,
      summary: `The export will re-send everything received since ${new Date(from).toISOString()}, a few thousand rows every five minutes.`,
    };
  }

  // ── Error tracking ───────────────────────────────────────────────────────

  /** Issues (exceptions grouped by fingerprint) with counts and a series for the range. */
  async listIssues(input: unknown) {
    const spec = inputs.listIssues.parse(input);
    const { ctx, filters } = await this.reportContext(
      this.withProjectOptions(spec, (await this.context(spec.project)).settings),
    );
    const range = { from: spec.from ?? '-14d', to: spec.to, filters };
    const { issues, merged } = await listIssueRows(this.env, ctx.project, {
      status: spec.status,
      search: spec.search,
    });
    const counts = await issueCounts(range, ctx);
    const totals = issueTotals(counts.rows, merged);
    const rows = issues
      .filter((i) => totals.has(i.id))
      .map((i) => ({ ...i, ...totals.get(i.id)! }))
      .sort(ISSUE_ORDER[spec.order ?? 'events'] ?? ISSUE_ORDER.events!)
      .slice(0, spec.limit ?? 25);
    const ids = rows.map((r) => r.id);
    const withMerged = [
      ...ids,
      ...[...merged].filter(([, into]) => ids.includes(into)).map(([id]) => id),
    ];
    const series = await issueSeries(range, ctx, withMerged);
    return {
      project: ctx.project,
      interval: series.interval,
      buckets: series.buckets,
      issues: rows.map((r) => ({
        ...r,
        series: mergedSeries(series.series, merged, r.id),
        link: this.link(`errors/${r.id}`, { project: ctx.project }),
      })),
      summary: issuesSummary(rows, totals),
      sql: [counts.sql, series.sql],
      dashboard: this.link('errors', { project: ctx.project }),
    };
  }

  /** One issue: its symbolicated stack, trend, where and for whom it happens, and replays at the moment. */
  /** When each session's replay started, for sessions that were recorded. */
  private async replayStarts(project: string, sessions: string[]): Promise<Map<string, number>> {
    if (!replaysEnabled(this.env) || !sessions.length) return new Map();
    const { results } = await this.env.DB.prepare(
      'SELECT session_id, started_at FROM replays WHERE project = ?1 AND session_id IN (SELECT value FROM json_each(?2))',
    )
      .bind(project, JSON.stringify(sessions))
      .all<{ session_id: string; started_at: number }>();
    return new Map(results.map((r) => [r.session_id, r.started_at]));
  }

  /** The replay of an occurrence's session, opened a few seconds before the error. */
  private replayAt(
    project: string,
    o: { session: string; ts: number },
    started: number | undefined,
  ): string | null {
    return started === undefined
      ? null
      : this.replayLink(project, o.session, Math.max(0, o.ts - started - 5000));
  }

  async getIssue(input: unknown) {
    const spec = inputs.getIssue.parse(input);
    const settings = (await this.context(spec.project)).settings;
    const { ctx, filters } = await this.reportContext(this.withProjectOptions(spec, settings));
    const range = { from: spec.from ?? '-14d', to: spec.to, filters };
    const row = await getIssueRow(this.env, ctx.project, spec.id);
    const ids = [row.issue.id, ...row.merged];
    const [counts, series, detail] = await Promise.all([
      issueCounts(range, ctx, ids),
      issueSeries(range, ctx, ids),
      issueDetail(range, ctx, ids),
    ]);
    const stack = row.sample
      ? await symbolicatedFrames(
          this.env,
          ctx.project,
          row.issue.id,
          row.sample,
          row.symbolicated,
          settings.inAppIncludes,
        )
      : { frames: [], mapped: 0 };
    const summed = series.buckets.map((_, i) =>
      ids.reduce((n, id) => n + (series.series[id]?.[i] ?? 0), 0),
    );
    const replays = await this.replayStarts(
      ctx.project,
      detail.occurrences.map((o) => o.session),
    );
    const events = counts.rows.reduce((n, c) => n + c.events, 0);
    const users = counts.rows.reduce((n, c) => n + c.users, 0);
    const where = topFrame(stack.frames);
    return {
      project: ctx.project,
      issue: row.issue,
      merged: row.merged,
      fingerprints: row.fingerprints,
      range: { events, users, sessions: counts.rows.reduce((n, c) => n + c.sessions, 0) },
      interval: series.interval,
      buckets: series.buckets,
      series: summed,
      sample: row.sample ? sampleView(row.sample) : null,
      stack: { frames: stack.frames, mapped: stack.mapped },
      breakdowns: detail.breakdowns,
      people: detail.people,
      occurrences: detail.occurrences.map((o) => ({
        ...o,
        at: new Date(o.ts).toISOString(),
        replay: this.replayAt(ctx.project, o, replays.get(o.session)),
      })),
      summary: `${row.issue.type}: ${row.issue.message.slice(0, 160)} — ${row.issue.status}${row.issue.regressedAt ? ' (regressed)' : ''}, ${events} exceptions from ${users} people in range, ${row.issue.occurrences} in all since ${row.issue.firstSeen.slice(0, 10)}. Top frame: ${where}${stack.mapped ? ` (${stack.mapped} frames mapped with source maps)` : ''}.`,
      sql: [counts.sql, series.sql, ...detail.sql],
      dashboard: this.link(`errors/${row.issue.id}`, { project: ctx.project }),
    };
  }

  async updateIssue(input: unknown) {
    const spec = inputs.updateIssue.parse(input);
    const ctx = await this.context(spec.project);
    const issue = await updateIssue(this.env, ctx.project, spec.id, {
      status: spec.status,
      assignee: spec.assignee,
    });
    return {
      project: ctx.project,
      issue,
      summary: `${issue.type}: ${issue.message.slice(0, 80)} is ${issue.status}${issue.assignee ? `, assigned to ${issue.assignee}` : ''}.${issue.status === 'suppressed' ? ' New occurrences are dropped at ingest.' : issue.status === 'resolved' ? ' If it happens again it comes back as a regression.' : ''}`,
    };
  }

  async mergeIssues(input: unknown) {
    const spec = inputs.mergeIssues.parse(input);
    const ctx = await this.context(spec.project);
    const issue = await mergeIssues(this.env, ctx.project, spec.into, spec.ids);
    return {
      project: ctx.project,
      issue,
      summary: `Merged ${spec.ids.length} issue${spec.ids.length === 1 ? '' : 's'} into ${issue.id}: ${issue.occurrences} occurrences in all. New exceptions with their fingerprints join it.`,
    };
  }

  async uploadSourcemap(project: string | undefined, release: string, path: string, text: string) {
    const ctx = await this.context(project);
    const r = await uploadSourcemap(this.env, ctx.project, release, path, text);
    return {
      project: ctx.project,
      ...r,
      summary: `Stored the source map for ${r.path} (release ${r.release}, ${r.sources} sources).`,
    };
  }

  async listSourcemaps(input: unknown) {
    const spec = inputs.listSourcemaps.parse(input);
    const ctx = await this.context(spec.project);
    const maps = await listSourcemaps(this.env, ctx.project, spec.release);
    const releases = [...new Set(maps.map((m) => m.release))];
    return {
      project: ctx.project,
      sourcemaps: maps,
      summary: maps.length
        ? `${maps.length} source maps across ${releases.length} release${releases.length === 1 ? '' : 's'} (latest ${releases[0]}).`
        : 'No source maps uploaded. Upload them with `npx @gmacko/dataflare-cli sourcemaps upload <dir> --release <version>`.',
    };
  }

  async deleteSourcemaps(input: unknown) {
    const spec = inputs.deleteSourcemaps.parse(input);
    const ctx = await this.context(spec.project);
    const n = await deleteSourcemaps(this.env, ctx.project, spec.release, spec.path);
    return {
      project: ctx.project,
      deleted: n,
      summary: `Deleted ${n} source map${n === 1 ? '' : 's'}.`,
    };
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  async listGroupTypes(input: unknown) {
    const ctx = await this.context(inputs.listGroupTypes.parse(input).project);
    const { results } = await this.env.DB.prepare(
      `SELECT t.type, t.idx, t.name_singular, t.name_plural,
         (SELECT COUNT(*) FROM groups g WHERE g.project = t.project AND g.type = t.type) AS n
       FROM group_types t WHERE t.project = ? ORDER BY t.idx`,
    )
      .bind(ctx.project)
      .all<{ type: string; idx: number; name_singular: string; name_plural: string; n: number }>();
    // English plurals for the default names: company → companies, address → addresses.
    const plural = (t: string) =>
      /[^aeiou]y$/i.test(t)
        ? `${t.slice(0, -1)}ies`
        : /(s|x|z|ch|sh)$/i.test(t)
          ? `${t}es`
          : `${t}s`;
    const types = results.map((r) => ({
      type: r.type,
      index: r.idx,
      singular: r.name_singular || r.type,
      plural: r.name_plural || plural(r.type),
      groups: r.n,
    }));
    return {
      project: ctx.project,
      types,
      max: MAX_GROUP_TYPES,
      summary: types.length
        ? `Group types: ${types.map((t) => `${t.type} (${t.groups})`).join(', ')}.`
        : 'No group types yet. They appear when the SDK calls glass.group(type, key) (or set_group_type adds one).',
      dashboard: this.link('groups', { project: ctx.project }),
    };
  }

  async setGroupType(input: unknown) {
    const spec = inputs.setGroupType.parse(input);
    const ctx = await this.context(spec.project);
    assertSafeKey(spec.type);
    const db = this.env.DB;
    const existing = await db
      .prepare('SELECT type FROM group_types WHERE project = ? AND type = ?')
      .bind(ctx.project, spec.type)
      .first();
    if (!existing) {
      const res = await db
        .prepare(
          `INSERT INTO group_types (project, type, idx, created_at)
           SELECT ?1, ?2, (SELECT COALESCE(MAX(idx) + 1, 0) FROM group_types WHERE project = ?1), ?3
           WHERE (SELECT COUNT(*) FROM group_types WHERE project = ?1) < ${MAX_GROUP_TYPES}`,
        )
        .bind(ctx.project, spec.type, Date.now())
        .run();
      if (!res.meta.changes)
        throw new HttpError(409, `A project has at most ${MAX_GROUP_TYPES} group types`);
    }
    await db
      .prepare(
        'UPDATE group_types SET name_singular = COALESCE(?, name_singular), name_plural = COALESCE(?, name_plural) WHERE project = ? AND type = ?',
      )
      .bind(spec.singular ?? null, spec.plural ?? null, ctx.project, spec.type)
      .run();
    clearGroupTypeCache();
    return this.listGroupTypes({ project: ctx.project });
  }

  async searchGroups(input: unknown) {
    const spec = inputs.searchGroups.parse(input);
    const ctx = await this.context(spec.project);
    const { results } = await this.env.DB.prepare(
      `SELECT key, props, first_seen, last_seen FROM groups
       WHERE project = ?1 AND type = ?2 AND (?3 = '' OR instr(lower(key || ' ' || props), lower(?3)) > 0)
       ORDER BY last_seen DESC LIMIT ?4`,
    )
      .bind(ctx.project, spec.type, spec.search ?? '', spec.limit ?? 50)
      .all<{ key: string; props: string; first_seen: number; last_seen: number }>();
    const groups = results.map((r) => ({
      key: r.key,
      properties: safeParse(r.props),
      firstSeen: new Date(r.first_seen).toISOString(),
      lastSeen: new Date(r.last_seen).toISOString(),
      link: this.link(`groups/${encodeURIComponent(spec.type)}/${encodeURIComponent(r.key)}`, {
        project: ctx.project,
      }),
    }));
    return {
      project: ctx.project,
      type: spec.type,
      groups,
      summary: groups.length
        ? `${groups.length} ${spec.type} groups${spec.search ? ` matching "${spec.search}"` : ''}, most recently active first.`
        : `No ${spec.type} groups${spec.search ? ` matching "${spec.search}"` : ''}.`,
    };
  }

  /** A group: its properties, who in it is active and doing what, and (with revenue) what it pays. */
  async getGroup(input: unknown) {
    const spec = inputs.getGroup.parse(input);
    const ctx = await this.context(spec.project);
    assertSafeKey(spec.type);
    const row = await this.env.DB.prepare(
      'SELECT props, first_seen, last_seen FROM groups WHERE project = ? AND type = ? AND key = ?',
    )
      .bind(ctx.project, spec.type, spec.key)
      .first<{ props: string; first_seen: number; last_seen: number }>();
    const d = this.store.dialect;
    const range = resolveRange(spec.from ?? '-30d', spec.to);
    const filters = [{ property: `group.${spec.type}`, value: spec.key }] as Filter[];
    const cte = eventsCte(d, { project: ctx.project, ...range, filters });
    // Bookkeeping events (setting group or person properties) aren't activity.
    const active = "event NOT IN ('$groupidentify', '$identify', '$set')";
    const sql = {
      totals: `WITH ${cte}\nSELECT COUNT(*) AS n, COUNT(DISTINCT pid) AS people, COUNT(DISTINCT session_id) AS sessions FROM ev WHERE ${active}`,
      events: `WITH ${cte}\nSELECT event, COUNT(*) AS n FROM ev WHERE ${active} GROUP BY event ORDER BY n DESC, event ASC LIMIT 10`,
      members: `WITH ${cte}\nSELECT pid, COUNT(*) AS n, MAX(ts_ms) AS last_ts FROM ev WHERE ${active} GROUP BY pid ORDER BY n DESC, last_ts DESC LIMIT 20`,
      recent: `WITH ${cte}\nSELECT event, ts_ms, pid, path FROM ev WHERE ${active} ORDER BY ts_ms DESC LIMIT 20`,
    };
    const [totals, events, members, recent] = await Promise.all(
      Object.values(sql).map((q) => this.store.query(q)),
    );
    if (!row && num(totals![0]?.n) === 0) {
      throw new HttpError(
        404,
        `No ${spec.type} "${spec.key}" in project "${ctx.project}"`,
        'search_groups lists them.',
      );
    }
    let revenue: { net: number; mrr: number; currency: string } | null = null;
    if (await this.revenueConfigured(ctx.project, ctx.settings)) {
      const r = await runRevenue(
        {
          from: spec.from ?? '-30d',
          to: spec.to,
          filters,
          currency: ctx.settings.baseCurrency ?? 'USD',
        },
        {
          dialect: d,
          project: ctx.project,
          execute: (q) => this.store.query(q),
          timezone: ctx.settings.timezone,
        },
      );
      revenue = { net: r.totals.net, mrr: r.totals.mrr, currency: r.currency };
    }
    const t = totals![0] ?? {};
    return {
      project: ctx.project,
      type: spec.type,
      key: spec.key,
      properties: row ? safeParse(row.props) : {},
      firstSeen: row ? new Date(row.first_seen).toISOString() : null,
      lastSeen: row ? new Date(row.last_seen).toISOString() : null,
      activity: { events: num(t.n), people: num(t.people), sessions: num(t.sessions) },
      topEvents: events!.map((r) => ({ event: text(r.event), count: num(r.n) })),
      members: members!.map((r) => ({
        person: text(r.pid),
        events: num(r.n),
        lastSeen: new Date(num(r.last_ts)).toISOString(),
        link: this.link(`users/${encodeURIComponent(text(r.pid))}`, { project: ctx.project }),
      })),
      recentEvents: recent!.map((r) => ({
        event: text(r.event),
        time: new Date(num(r.ts_ms)).toISOString(),
        person: text(r.pid),
        path: text(r.path),
      })),
      ...(revenue ? { revenue } : {}),
      summary: `${spec.type} "${spec.key}": ${num(t.n)} events from ${num(t.people)} people in range${revenue ? `, ${revenue.net} ${revenue.currency} net revenue, MRR ${revenue.mrr}` : ''}.`,
      sql: Object.values(sql),
      dashboard: this.link(
        `groups/${encodeURIComponent(spec.type)}/${encodeURIComponent(spec.key)}`,
        { project: ctx.project },
      ),
    };
  }

  async setGroupProperties(input: unknown) {
    const spec = inputs.setGroupProperties.parse(input);
    const ctx = await this.context(spec.project);
    const row = await this.env.DB.prepare(
      'SELECT props FROM groups WHERE project = ? AND type = ? AND key = ?',
    )
      .bind(ctx.project, spec.type, spec.key)
      .first<{ props: string }>();
    const props = row ? (safeParse(row.props) as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(spec.properties)) {
      if (v === null) delete props[k];
      else props[k] = v;
    }
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO groups (project, type, key, props, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, type, key) DO UPDATE SET props = excluded.props`,
    )
      .bind(ctx.project, spec.type, spec.key, JSON.stringify(props), now, now)
      .run();
    return {
      project: ctx.project,
      type: spec.type,
      key: spec.key,
      properties: props,
      summary: `Updated ${spec.type} "${spec.key}": events from now on carry these properties.`,
    };
  }

  /** Erase a group: its row and properties, and its key and snapshots on stored events. */
  async deleteGroup(input: unknown) {
    const spec = inputs.deleteGroup.parse(input);
    const ctx = await this.context(spec.project);
    assertSafeKey(spec.type);
    const res = await this.env.DB.prepare(
      'DELETE FROM groups WHERE project = ? AND type = ? AND key = ?',
    )
      .bind(ctx.project, spec.type, spec.key)
      .run();
    const events = await this.store.deleteGroupData(ctx.project, spec.type, spec.key);
    return {
      project: ctx.project,
      deleted: Boolean(res.meta.changes),
      events,
      summary:
        events === 'deleted'
          ? `Deleted ${spec.type} "${spec.key}" and removed it from its events (the events stay with their people).`
          : `Deleted ${spec.type} "${spec.key}". Its events lose it when the lake maintenance job next runs (\`dataflare lake maintain\`, daily in CI).`,
    };
  }

  // ── Revenue ──────────────────────────────────────────────────────────────

  /** Whether a project records revenue (revenue events set, or Stripe connected). */
  private async revenueConfigured(project: string, settings: ProjectSettings): Promise<boolean> {
    if (settings.revenueEvents?.length) return true;
    const row = await this.env.DB.prepare('SELECT 1 AS yes FROM stripe_accounts WHERE project = ?')
      .bind(project)
      .first();
    return Boolean(row);
  }

  async connectStripe(input: unknown) {
    const spec = inputs.connectStripe.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, ...rest } = spec;
    const status = await connectStripe(this.env, ctx.project, rest, this.baseUrl);
    return {
      project: ctx.project,
      ...status,
      summary: `Stripe is connected. In Stripe, the webhook endpoint ${status.webhookUrl} should send: ${status.events.join(', ')}. Backfill history with \`npx @gmacko/dataflare-cli stripe import --api-key rk_…\`.`,
    };
  }

  async stripeStatus(input: unknown) {
    const ctx = await this.context(inputs.stripeStatus.parse(input).project);
    const status = await stripeStatus(this.env, ctx.project, this.baseUrl);
    return {
      project: ctx.project,
      ...status,
      summary: status.connected
        ? `Stripe connected: ${status.received} webhooks received${status.lastEventAt ? `, the last at ${status.lastEventAt}` : ''}; ${status.customers?.linked ?? 0} of ${status.customers?.known ?? 0} known customers linked to people.`
        : `Stripe is not connected. Add a webhook endpoint at ${status.webhookUrl} in Stripe, then call connect_stripe with its signing secret.`,
    };
  }

  async disconnectStripe(input: unknown) {
    const ctx = await this.context(inputs.stripeStatus.parse(input).project);
    await disconnectStripe(this.env, ctx.project);
    return {
      project: ctx.project,
      summary: 'Stripe disconnected. Revenue events already recorded stay.',
    };
  }

  /** Exchange rates from the CLI (`dataflare revenue rates`), for history older than the Worker fetched. */
  async importFxRates(input: unknown) {
    const spec = inputs.importFxRates.parse(input);
    const n = await storeRates(this.env, spec.rates);
    const span = await this.env.DB.prepare(
      'SELECT MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT day) AS days FROM fx_rates',
    ).first<{
      first: string;
      last: string;
      days: number;
    }>();
    return {
      stored: n,
      rates: span,
      summary: `Stored ${n} rates; exchange rates now cover ${span?.first} to ${span?.last} (${span?.days} days).`,
    };
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  private settingsView(p: Project) {
    const s = p.settings;
    return {
      project: p.id,
      settings: s,
      summary: `${[
        `Time zone ${s.timezone ?? 'UTC (default)'}`,
        s.internalFilters?.length
          ? `${s.internalFilters.length} internal-traffic filter${s.internalFilters.length === 1 ? '' : 's'} (applied with filterTestAccounts: true)`
          : 'no internal-traffic filters',
        `base currency ${s.baseCurrency ?? 'USD (default)'}`,
        s.revenueEvents?.length
          ? `revenue from ${s.revenueEvents.map((r) => r.event).join(', ')}`
          : 'no revenue events',
        s.pathCleaning?.length
          ? `${s.pathCleaning.length} path cleaning rule${s.pathCleaning.length === 1 ? '' : 's'}`
          : 'no path cleaning rules',
      ].join('; ')}.`,
      dashboard: this.link('settings', { project: p.id }),
    };
  }

  /** Path cleaning rules for paths with ids in them, from the last 30 days of page views. */
  async suggestPathRules(input: unknown) {
    const spec = inputs.suggestPathRules.parse(input);
    const ctx = await this.context(spec.project);
    const d = ctx.dialect;
    const since = Date.now() - 30 * DAY_MS;
    const rows = await ctx.execute(`SELECT path, COUNT(*) AS views FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND event = '$pageview' AND ts_ms >= ${d.num(since)}
GROUP BY path ORDER BY views DESC, path LIMIT 2000`);
    const existing = new Set((ctx.settings.pathCleaning ?? []).map((r) => r.match));
    const suggestions = suggestPathRules(
      rows.map((r) => ({ path: String(r.path ?? ''), views: Number(r.views ?? 0) })),
    ).filter((s) => !existing.has(s.match));
    return {
      project: ctx.project,
      suggestions,
      summary: suggestions.length
        ? `${suggestions.length} rule${suggestions.length === 1 ? '' : 's'} would merge paths with ids: ${suggestions
            .slice(0, 3)
            .map((s) => `${s.match} → ${s.alias} (${s.paths} paths)`)
            .join(', ')}. Add them with update_settings (pathCleaning).`
        : 'No paths with ids to merge in the last 30 days.',
      dashboard: this.link('settings', { project: ctx.project }),
    };
  }

  async getSettings(input: unknown) {
    const spec = inputs.getSettings.parse(input);
    const id = await resolveProject(this.env.DB, spec.project);
    return this.settingsView((await getProject(this.env.DB, id))!);
  }

  async updateSettings(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    // Accept { settings: {...} } or the fields at the top level, and null as "clear".
    const fields = (raw.settings ??
      Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'project'))) as Record<
      string,
      unknown
    >;
    const cleared = Object.entries(fields)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const spec = inputs.updateSettings.parse({
      project: raw.project,
      settings: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)),
    });
    const id = await resolveProject(this.env.DB, spec.project);
    const current = (await getProject(this.env.DB, id))!.settings;
    const next: Record<string, unknown> = { ...current, ...spec.settings };
    for (const key of cleared) delete next[key];
    if (typeof next.baseCurrency === 'string') next.baseCurrency = next.baseCurrency.toUpperCase();
    const saved = await saveSettings(this.env.DB, id, projectSettingsSchema.parse(next));
    const view = this.settingsView(saved);
    return { ...view, summary: `Saved. ${view.summary}` };
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
      kind: r.kind as 'trends' | 'funnel' | 'retention' | 'paths',
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
      kind: row.kind as 'trends' | 'funnel' | 'retention' | 'paths',
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
        'Pick another name; trends, funnel, retention, paths and new are used by the UI.',
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

  // ── Dashboards, reports and alerts ─────────────────────────────────────

  /** What reports and alerts need: run a query as this service, the project zone, links. */
  reportRunner(fetcher?: typeof fetch): ReportContext {
    return {
      env: this.env,
      base: this.baseUrl,
      fetcher,
      query: async (project, kind, spec) => this.runInsight(kind, { ...spec, project }),
      timezone: async (project) =>
        (await getProject(this.env.DB, project))?.settings.timezone ?? 'UTC',
    };
  }

  async capabilities(input: unknown) {
    const { project: requested } = BOARD_INPUTS.capabilities.parse(input);
    const ctx = await this.context(requested);
    const email = Boolean(this.env.EMAIL && this.env.GLASS_EMAIL_FROM);
    return {
      project: ctx.project,
      email,
      emailFrom: email ? this.env.GLASS_EMAIL_FROM : null,
      replay: replaysEnabled(this.env),
      store: this.store.kind,
      summary: email
        ? `Reports and alerts can go to chat channels and email (from ${this.env.GLASS_EMAIL_FROM}).`
        : 'Reports and alerts can go to chat channels; email is not set up (`dataflare email enable`).',
    };
  }

  async listDashboards(input: unknown) {
    const ctx = await this.context(BOARD_INPUTS.listDashboards.parse(input).project);
    await this.seedDefaultInsights(ctx.project);
    await ensureStarterDashboard(this.env.DB, ctx.project);
    const dashboards = await listDashboards(this.env.DB, ctx.project);
    return {
      project: ctx.project,
      dashboards: dashboards.map((d) => ({
        ...d,
        dashboard: this.link(`dashboards/${d.id}`, { project: ctx.project }),
      })),
      summary: dashboards.length
        ? `${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'}: ${dashboards.map((d) => d.name).join(', ')}.`
        : 'No dashboards yet. Start one from a template (dashboard_templates) or with save_dashboard.',
      dashboard: this.link('dashboards', { project: ctx.project }),
    };
  }

  async getDashboard(input: unknown) {
    const spec = BOARD_INPUTS.getDashboard.parse(input);
    const ctx = await this.context(spec.project);
    const d = await getDashboard(this.env.DB, ctx.project, spec.id);
    const tiles = d.tiles.map((t) => ({
      ...t,
      ...(t.insight ? { runSpec: tileSpec(t.insight.spec, d.filters, t.ignoreFilters) } : {}),
    }));
    const results = spec.results ? await this.tileSummaries(ctx.project, tiles) : undefined;
    return {
      project: ctx.project,
      ...d,
      tiles,
      ...(results ? { results } : {}),
      summary: `${d.name}: ${d.tiles.length} tile${d.tiles.length === 1 ? '' : 's'}.${results ? ` ${results.map((r) => `${r.title}: ${r.value ?? r.note ?? '–'}`).join('; ')}.` : ''}`,
      dashboard: this.link(`dashboards/${d.id}`, { project: ctx.project }),
    };
  }

  /** Each insight tile's headline numbers, for agents. */
  private async tileSummaries(
    project: string,
    tiles: { insight?: { name: string; kind: string } | null; runSpec?: Record<string, unknown> }[],
  ) {
    const out: ReportTile[] = [];
    for (const t of tiles) {
      if (!t.insight || !t.runSpec) continue;
      try {
        const spec = t.insight.kind === 'trends' ? { ...t.runSpec, compare: true } : t.runSpec;
        const r = await this.runInsight(t.insight.kind, { ...spec, project });
        out.push({ ...reportTile(t.insight.name, t.insight.kind, r), chart: null });
      } catch (err) {
        out.push({
          title: t.insight.name,
          note: err instanceof Error ? err.message : String(err),
          chart: null,
        });
      }
    }
    return out;
  }

  async saveDashboard(input: unknown) {
    const spec = BOARD_INPUTS.saveDashboard.parse(input);
    const ctx = await this.context(spec.project);
    const r = await saveDashboard(this.env.DB, ctx.project, spec, Date.now());
    return {
      project: ctx.project,
      ...r,
      summary: `${r.created ? 'Created' : 'Updated'} dashboard "${spec.name}".`,
      dashboard: this.link(`dashboards/${r.id}`, { project: ctx.project }),
    };
  }

  async deleteDashboard(input: unknown) {
    const spec = BOARD_INPUTS.deleteDashboard.parse(input);
    const ctx = await this.context(spec.project);
    await deleteDashboard(this.env.DB, ctx.project, spec.id);
    return {
      project: ctx.project,
      deleted: spec.id,
      summary: `Deleted the dashboard and its reports (the analyses stay).`,
    };
  }

  async duplicateDashboard(input: unknown) {
    const spec = BOARD_INPUTS.duplicateDashboard.parse(input);
    const ctx = await this.context(spec.project);
    const r = await duplicateDashboard(this.env.DB, ctx.project, spec.id, spec.name, Date.now());
    return {
      project: ctx.project,
      ...r,
      summary: `Copied to "${spec.name}".`,
      dashboard: this.link(`dashboards/${r.id}`, { project: ctx.project }),
    };
  }

  /** A tile's analysis: the key given, or a new analysis saved first. */
  private async tileInsightKey(
    project: string,
    spec: {
      insightKey?: string;
      insight?: { name: string; kind: string; spec: Record<string, unknown> };
    },
  ) {
    if (spec.insightKey || !spec.insight) return spec.insightKey;
    const saved = await this.saveInsight({
      project,
      ...spec.insight,
      key: await this.freeInsightKey(project, spec.insight.name),
    });
    return saved.key;
  }

  /** A key for a new analysis that doesn't overwrite an existing one. */
  private async freeInsightKey(project: string, name: string): Promise<string> {
    const base = slugKey(name).slice(0, 56) || 'analysis';
    for (let n = 1; n < 100; n++) {
      const key = n === 1 ? base : `${base}-${n}`;
      const taken = await this.env.DB.prepare(
        'SELECT 1 FROM insights WHERE project = ? AND key = ?',
      )
        .bind(project, key)
        .first();
      if (!taken && key !== 'new' && !insightKind.safeParse(key).success) return key;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  async addDashboardTile(input: unknown) {
    const spec = BOARD_INPUTS.addDashboardTile.parse(input);
    const ctx = await this.context(spec.project);
    const insightKey = await this.tileInsightKey(ctx.project, spec);
    const tile = await addTile(
      this.env.DB,
      ctx.project,
      spec.dashboard,
      { ...spec, insightKey, kind: insightKey ? 'insight' : 'text' },
      Date.now(),
    );
    return {
      project: ctx.project,
      tile,
      summary: 'Added the tile.',
      dashboard: this.link(`dashboards/${spec.dashboard}`, { project: ctx.project }),
    };
  }

  async updateDashboardTile(input: unknown) {
    const spec = BOARD_INPUTS.updateDashboardTile.parse(input);
    const ctx = await this.context(spec.project);
    await updateTile(this.env.DB, ctx.project, spec.dashboard, spec.tile, spec, Date.now());
    return { project: ctx.project, summary: 'Updated the tile.' };
  }

  async removeDashboardTile(input: unknown) {
    const spec = BOARD_INPUTS.removeDashboardTile.parse(input);
    const ctx = await this.context(spec.project);
    await removeTile(this.env.DB, ctx.project, spec.dashboard, spec.tile, Date.now());
    return { project: ctx.project, summary: 'Removed the tile (the analysis stays).' };
  }

  async reorderDashboardTiles(input: unknown) {
    const spec = BOARD_INPUTS.reorderDashboardTiles.parse(input);
    const ctx = await this.context(spec.project);
    await reorderTiles(this.env.DB, ctx.project, spec.dashboard, spec.tiles, Date.now());
    return { project: ctx.project, summary: 'Saved the order.' };
  }

  /** The starter dashboards, with the events they would use here. */
  async dashboardTemplates(input: unknown) {
    const ctx = await this.context(BOARD_INPUTS.dashboardTemplates.parse(input).project);
    const events = guessEvents(await this.eventNamesByVolume(ctx.project));
    return {
      project: ctx.project,
      events,
      templates: DASHBOARD_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        needs: t.needs,
      })),
      summary: `Templates: ${DASHBOARD_TEMPLATES.map((t) => t.name).join(', ')}. Guessed signup: ${events.signup ?? 'none'}; purchase: ${events.purchase ?? 'none'}.`,
    };
  }

  private async eventNamesByVolume(project: string): Promise<string[]> {
    const d = this.store.dialect;
    const rows = await this.store.query(
      `SELECT event, COUNT(*) AS n FROM ${d.table('events')} WHERE project = ${d.str(project)} AND ts_ms >= ${d.num(Date.now() - 30 * DAY_MS)} GROUP BY event ORDER BY n DESC LIMIT 200`,
    );
    return rows.map((r) => String(r.event));
  }

  async createDashboardFromTemplate(input: unknown) {
    const spec = BOARD_INPUTS.createDashboardFromTemplate.parse(input);
    const ctx = await this.context(spec.project);
    // Events given (and not blank) win over the guesses.
    const given = Object.fromEntries(Object.entries(spec.events ?? {}).filter(([, v]) => v));
    const events = { ...guessEvents(await this.eventNamesByVolume(ctx.project)), ...given };
    let tiles: TemplateTile[];
    try {
      tiles = templateTiles(spec.template, events);
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
        'Pass events: { signup, purchase }.',
      );
    }
    const template = DASHBOARD_TEMPLATES.find((t) => t.id === spec.template)!;
    const now = Date.now();
    const d = await saveDashboard(
      this.env.DB,
      ctx.project,
      { name: spec.name ?? template.name, description: template.description },
      now,
    );
    for (const t of tiles) {
      const insightKey = t.insight
        ? await this.tileInsightKey(ctx.project, { insight: t.insight })
        : undefined;
      await addTile(
        this.env.DB,
        ctx.project,
        d.id,
        {
          insightKey,
          text: t.text,
          width: t.width,
          height: t.height,
          kind: insightKey ? 'insight' : 'text',
        },
        now,
      );
    }
    return {
      project: ctx.project,
      id: d.id,
      summary: `Created "${spec.name ?? template.name}" with ${tiles.length} tiles.`,
      dashboard: this.link(`dashboards/${d.id}`, { project: ctx.project }),
    };
  }

  async listSubscriptions(input: unknown) {
    const spec = BOARD_INPUTS.listSubscriptions.parse(input);
    const ctx = await this.context(spec.project);
    const target = spec.dashboard
      ? { kind: 'dashboard', id: spec.dashboard }
      : spec.insight
        ? { kind: 'insight', id: spec.insight }
        : undefined;
    const subscriptions = (await listSubscriptions(this.env.DB, ctx.project, target)).map((s) => ({
      ...s,
      when: describeSchedule(s.schedule),
      nextRun: new Date(s.nextRunAt).toISOString(),
    }));
    return {
      project: ctx.project,
      subscriptions,
      summary: subscriptions.length
        ? subscriptions
            .map(
              (s) =>
                `${s.name || s.targetId}: ${s.when}${s.lastStatus === 'failed' ? ` (last failed: ${s.lastError})` : ''}`,
            )
            .join('; ')
        : 'No scheduled reports.',
    };
  }

  async saveSubscription(input: unknown) {
    const spec = BOARD_INPUTS.saveSubscription.parse(input);
    const ctx = await this.context(spec.project);
    const r = await saveSubscription(this.reportRunner(), ctx.project, spec, Date.now());
    return {
      project: ctx.project,
      ...r,
      nextRun: new Date(r.nextRunAt).toISOString(),
      summary: `${r.created ? 'Scheduled' : 'Updated'}: ${r.when}. Next: ${new Date(r.nextRunAt).toISOString()}.`,
    };
  }

  async deleteSubscription(input: unknown) {
    const spec = BOARD_INPUTS.deleteSubscription.parse(input);
    const ctx = await this.context(spec.project);
    await deleteSubscription(this.env.DB, ctx.project, spec.id);
    return { project: ctx.project, summary: 'Deleted the report.' };
  }

  async sendSubscriptionNow(input: unknown, fetcher?: typeof fetch) {
    const spec = BOARD_INPUTS.sendSubscriptionNow.parse(input);
    const ctx = await this.context(spec.project);
    const r = await runNow(this.reportRunner(fetcher), ctx.project, spec.id, Date.now());
    return {
      project: ctx.project,
      ...r,
      summary: r.status === 'sent' ? 'Sent.' : `Not sent: ${r.error}`,
    };
  }

  async listAlerts(input: unknown) {
    const spec = BOARD_INPUTS.listAlerts.parse(input);
    const ctx = await this.context(spec.project);
    const alerts = await listAlerts(this.env.DB, ctx.project, spec.insight);
    return {
      project: ctx.project,
      alerts: alerts.map((a) => ({
        ...a,
        when: describeSchedule(a.checks.schedule),
        condition: a.condition,
        describe: describeCondition(a.condition),
      })),
      summary: alerts.length
        ? alerts
            .map(
              (a) => `${a.name}: ${a.state}${a.lastValue !== null ? ` (last ${a.lastValue})` : ''}`,
            )
            .join('; ')
        : 'No alerts.',
    };
  }

  async getAlert(input: unknown) {
    const spec = BOARD_INPUTS.getAlert.parse(input);
    const ctx = await this.context(spec.project);
    const a = await getAlert(this.env.DB, ctx.project, spec.id);
    const history = await alertHistory(
      this.env.DB,
      ctx.project,
      spec.id,
      Date.now(),
      spec.days ?? 30,
    );
    return {
      project: ctx.project,
      ...a,
      history,
      summary: `${a.name}: ${a.state}, ${describeCondition(a.condition)}, ${describeSchedule(a.checks.schedule).toLowerCase()}. ${history.length} checks in ${spec.days ?? 30} days, ${history.filter((h) => h.fired).length} fired.`,
    };
  }

  async saveAlert(input: unknown) {
    const spec = BOARD_INPUTS.saveAlert.parse(input);
    const ctx = await this.context(spec.project);
    const checks = {
      schedule: spec.schedule,
      ongoing: spec.ongoing,
      skipWeekends: spec.skipWeekends,
      quiet: spec.quiet,
    };
    const r = await saveAlert(this.reportRunner(), ctx.project, { ...spec, checks }, Date.now());
    return {
      project: ctx.project,
      ...r,
      nextCheck: new Date(r.nextCheckAt).toISOString(),
      summary: `${r.created ? 'Created' : 'Updated'} alert "${spec.name}": ${describeCondition(spec.condition)}, ${describeSchedule(spec.schedule).toLowerCase()}.`,
    };
  }

  async deleteAlert(input: unknown) {
    const spec = BOARD_INPUTS.deleteAlert.parse(input);
    const ctx = await this.context(spec.project);
    await deleteAlert(this.env.DB, ctx.project, spec.id);
    return { project: ctx.project, summary: 'Deleted the alert.' };
  }

  async checkAlertNow(input: unknown, fetcher?: typeof fetch) {
    const spec = BOARD_INPUTS.checkAlertNow.parse(input);
    const ctx = await this.context(spec.project);
    const a = await getAlert(this.env.DB, ctx.project, spec.id);
    const r = await checkAlert(this.reportRunner(fetcher), ctx.project, a, Date.now());
    const value = r.evaluation?.value;
    return {
      project: ctx.project,
      ...r,
      summary: r.evaluation
        ? `${a.name}: ${r.state}${value !== null && value !== undefined ? `, value ${value}` : ''}${r.notified ? ` (sent: ${r.notified})` : ''}.${r.evaluation.note ? ` ${r.evaluation.note}` : ''}`
        : `${a.name}: ${r.state}: ${r.errors.join('; ')}`,
    };
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

/** Actors as CSV: id, type, events, then each property that appears. */
function actorsCsv(
  actors: { id: string; type: string; events: number; properties: Record<string, unknown> }[],
): string {
  const keys = [...new Set(actors.flatMap((a) => Object.keys(a.properties)))].slice(0, 50);
  const cell = (v: unknown) => {
    const s =
      v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = ['id', 'type', 'events', ...keys].map(cell).join(',');
  const lines = actors.map((a) =>
    [a.id, a.type, a.events, ...keys.map((k) => a.properties[k])].map(cell).join(','),
  );
  return [header, ...lines].join('\n');
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
