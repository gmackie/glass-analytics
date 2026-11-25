/**
 * MCP tools.
 *
 * Every tool is one declarative entry: a name, a description written for
 * agents, a zod input schema (converted to JSON Schema for `tools/list`), a
 * scope, and a handler that calls the shared GlassService. Query tools are
 * generated from the insight registry, so a new insight type automatically
 * becomes a `query_<kind>` tool.
 *
 * To add a tool: add an entry to TOOLS. See docs/extending.md.
 */

import { INSIGHTS, sqlSpec } from '@dataflare/core/insights';
import { type StagedFeature, stagePrefix } from '@dataflare/core/stages';
import { z } from 'zod/v4';
import type { Scope } from '../auth.ts';
import { type GlassService, inputs } from '../service.ts';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  /** "read" tools work with the read-only key; "admin" tools change state. */
  scope: Scope;
  run(service: GlassService, args: unknown): Promise<unknown> | unknown;
}

const projectOnly = z.object({ project: z.string().optional() });

const queryTools: ToolDefinition[] = Object.entries(INSIGHTS).map(([kind, def]) => ({
  name: `query_${kind}`,
  title: `${kind[0]!.toUpperCase()}${kind.slice(1)} query`,
  description: def.description,
  input: def.schema,
  scope: 'read',
  run: (service, args) => service.runInsight(kind, args),
}));

/** Tools for features that aren't stable yet: their descriptions say so (see core/stages.ts). */
const TOOL_STAGES: Record<string, StagedFeature> = {
  list_destination_templates: 'destinations',
  list_destinations: 'destinations',
  get_destination: 'destinations',
  save_destination: 'destinations',
  delete_destination: 'destinations',
  test_destination: 'destinations',
  retry_destination: 'destinations',
  list_transformations: 'transformations',
  save_transformation: 'transformations',
  delete_transformation: 'transformations',
  test_transformation: 'transformations',
  list_exports: 'exports',
  save_export: 'exports',
  delete_export: 'exports',
  export_runs: 'exports',
  backfill_export: 'exports',
};

const withStage = (tool: ToolDefinition): ToolDefinition => {
  const feature = TOOL_STAGES[tool.name];
  return feature ? { ...tool, description: stagePrefix(feature) + tool.description } : tool;
};

const ALL_TOOLS: ToolDefinition[] = [
  {
    name: 'overview',
    title: 'Analytics overview',
    description:
      'Start here. Visitors, pageviews, sessions and bounce rate for a period vs the previous one, top pages, referrers and errors, the most frequent events and the events that changed most.',
    input: inputs.overview,
    scope: 'read',
    run: (s, a) => s.overview(a),
  },
  {
    name: 'compare_sites',
    title: 'Compare sites',
    description:
      'Every project (site) side by side for one period: visitors and pageviews vs the previous period, a trend per site (up, down, steady, quiet, new, stopped, none) and a visitors series. Use it to find which sites are gaining or losing traffic, or have stopped sending pageviews. Then call overview with that project for detail.',
    input: inputs.sites,
    scope: 'read',
    run: (s, a) => s.sites(a),
  },
  {
    name: 'pageview_traffic',
    title: 'Explore pageviews',
    description:
      'Get pageviews over time and paths ranked by views across all registered sites or one project. Pass an exact path to see contributing sites, then pass project and path for referrers. Use offset and limit to page through the ranking.',
    input: inputs.traffic,
    scope: 'read',
    run: (s, a) => s.traffic(a),
  },
  {
    name: 'traffic_breakdown',
    title: 'Traffic breakdown',
    description:
      'Compare hourly pageviews, device mix, likely human, detected bot and unclassified pageviews, and session duration across registered sites or one project. Fleet hours use UTC, site hours use the project time zone. Filtered bots are measured from collectionStarted.',
    input: inputs.trafficBreakdown,
    scope: 'read',
    run: (s, a) => s.trafficBreakdown(a),
  },
  {
    name: 'product_adoption',
    title: 'Product adoption',
    description:
      'Rank marked custom actions by adopters for one project and date range. Repeat share counts adopters returning on another project-local date.',
    input: inputs.product,
    scope: 'read',
    run: (s, a) => s.product(a),
  },
  ...queryTools,
  {
    name: 'sql',
    title: 'SQL query',
    description:
      'Run one read-only SELECT against the event store when no query tool fits. Columns: id, project, event, ts_ms (epoch ms), distinct_id, user_id, person_id, session_id, url, host, path, referrer_host, title, utm_*, country, region, city, device, browser, os, flags (JSON), props (JSON), person_props (JSON). Always filter on project and ts_ms.',
    input: sqlSpec,
    scope: 'read',
    run: (s, a) => s.sql(a),
  },
  {
    name: 'list_events',
    title: 'List tracked events',
    description:
      'Every event name seen recently with counts, last-seen time and documentation status. Use before querying to get exact names. Clear the undocumented list with define_event before relying on custom events in funnels or trends.',
    input: inputs.listEvents,
    scope: 'read',
    run: (s, a) => s.listEvents(a),
  },
  {
    name: 'describe_event',
    title: 'Describe an event',
    description:
      'Properties sent with an event (sampled from recent events): types, coverage and example values, plus any saved documentation. Use after shipping capture, then define_event.',
    input: inputs.describeEvent,
    scope: 'read',
    run: (s, a) => s.describeEvent(a),
  },
  {
    name: 'define_event',
    title: 'Document an event',
    description:
      'Required after adding a custom event. Save a how/when description (which user action or code path fires it), owner, and a meaning for each property so future agents and teammates can query it safely.',
    input: inputs.defineEvent,
    scope: 'admin',
    run: (s, a) => s.defineEvent(a),
  },
  {
    name: 'instrument',
    title: 'Get tracking code',
    description:
      'The exact code to install Dataflare and capture a named event in a given framework, plus naming warnings. After deploy, describe_event then define_event with how/when and property meanings.',
    input: inputs.instrument,
    scope: 'read',
    run: (s, a) => s.instrument(a),
  },
  {
    name: 'property_values',
    title: 'List property values',
    description:
      'Most common values of a property with event and people counts, optionally on one event or containing some text. Use before filtering so the value you filter on actually exists. property "cohort" lists saved cohort keys.',
    input: inputs.propertyValues,
    scope: 'read',
    run: (s, a) => s.propertyValues(a),
  },
  {
    name: 'list_person_properties',
    title: 'List person properties',
    description:
      'Person property names (sampled from recently active people) with types and example values. Filter on them as "person.<name>".',
    input: inputs.listPersonProperties,
    scope: 'read',
    run: (s, a) => s.listPersonProperties(a),
  },
  {
    name: 'search_persons',
    title: 'Search people',
    description:
      'Identified people (most recently active first) plus counts of identified people and anonymous devices active in the look-back window. Optionally filter by id or property value.',
    input: inputs.searchPersons,
    scope: 'read',
    run: (s, a) => s.searchPersons(a),
  },
  {
    name: 'get_person',
    title: 'Get a person',
    description: "A person's properties, devices, last 100 events and recorded sessions.",
    input: inputs.getPerson,
    scope: 'read',
    run: (s, a) => s.getPerson(a),
  },
  {
    name: 'list_insights',
    title: 'List saved analyses',
    description:
      'Saved trends/funnel/retention analyses on the Insights tab. New projects are seeded with DAU, WAU, MAU, pageviews and retention defaults.',
    input: inputs.listInsights,
    scope: 'read',
    run: (s, a) => s.listInsights(a),
  },
  {
    name: 'get_insight',
    title: 'Get a saved analysis',
    description: 'One saved analysis by key, including its query spec.',
    input: inputs.getInsight,
    scope: 'read',
    run: (s, a) => s.getInsight(a),
  },
  {
    name: 'save_insight',
    title: 'Save an analysis',
    description:
      'Create or update a named trends/funnel/retention analysis with a title and description.',
    input: inputs.saveInsight,
    scope: 'admin',
    run: (s, a) => s.saveInsight(a),
  },
  {
    name: 'delete_insight',
    title: 'Delete a saved analysis',
    description: 'Remove a saved analysis from the Insights tab.',
    input: inputs.deleteInsight,
    scope: 'admin',
    run: (s, a) => s.deleteInsight(a),
  },
  {
    name: 'list_cohorts',
    title: 'List cohorts',
    description:
      'Saved person cohorts with live membership counts. Filter any query to a cohort with {"property":"cohort","value":"<key>"} (op "neq" to exclude it).',
    input: inputs.listCohorts,
    scope: 'read',
    run: (s, a) => s.listCohorts(a),
  },
  {
    name: 'save_cohort',
    title: 'Save a cohort',
    description:
      'Create or update a named cohort. Either a definition of condition groups (person properties; performed an event N times in a window; did not; did it regularly; first did it; stopped or started doing it; did A then B; in or not in another cohort), the simple form (filters + didEvent), or static: true with a list of person ids. Returns the live membership count.',
    input: inputs.saveCohort,
    scope: 'admin',
    run: (s, a) => s.saveCohort(a),
  },
  {
    name: 'count_cohort',
    title: 'Count a cohort',
    description:
      'How many people match a cohort definition (or filters + didEvent) without saving it.',
    input: inputs.countCohort,
    scope: 'read',
    run: (s, a) => s.countCohort(a),
  },
  {
    name: 'cohort_members',
    title: 'List cohort members',
    description: 'The people in a saved cohort, with their properties; format "csv" exports them.',
    input: inputs.cohortMembers,
    scope: 'read',
    run: (s, a) => s.cohortMembers(a),
  },
  {
    name: 'edit_cohort_members',
    title: 'Edit a static cohort',
    description: 'Add or remove person ids from a static cohort.',
    input: inputs.editCohortMembers,
    scope: 'admin',
    run: (s, a) => s.editCohortMembers(a),
  },
  {
    name: 'duplicate_cohort',
    title: 'Freeze a cohort',
    description:
      'Copy a cohort as a static list of who is in it right now (e.g. to email or to keep a holdout).',
    input: inputs.duplicateCohort,
    scope: 'admin',
    run: (s, a) => s.duplicateCohort(a),
  },
  {
    name: 'delete_cohort',
    title: 'Delete a cohort',
    description: 'Remove a saved cohort definition.',
    input: inputs.deleteCohort,
    scope: 'admin',
    run: (s, a) => s.deleteCohort(a),
  },
  {
    name: 'mark_event',
    title: 'Mark a key event',
    description:
      'Mark an event as a "conversion" (a goal the site exists for: signup, purchase, pledge, lead) or "important" (worth watching: share, search, download), or "none" to clear it. The Reports pages then show its count and rate, conversion rates per traffic source and campaign, and overview includes it. Mark conversions right after instrumenting them.',
    input: inputs.markEvent,
    scope: 'admin',
    run: (s, a) => s.markEvent(a),
  },
  {
    name: 'query_sources',
    title: 'Traffic sources and conversion',
    description:
      'Visitors grouped by channel (Organic search, Social, Paid, Email, AI assistants, Referral, Direct), referrer, UTM source/medium/campaign, landing page, country or device, attributed to their first visit in the range, with how many converted (did a conversion event) and bounced. Use it to judge which campaigns and channels work.',
    input: inputs.reportSources,
    scope: 'read',
    run: (s, a) => s.reportSources(a),
  },
  {
    name: 'site_health',
    title: 'Site health',
    description:
      'Errors over time and the share of sessions they affect, the top error issues (open one with get_issue), pages where errors happen, pages that look like "not found" pages (with where visitors came from), the slowest pages by LCP, and frustration signals from replays. Start here to find what is broken.',
    input: inputs.reportHealth,
    scope: 'read',
    run: (s, a) => s.reportHealth(a),
  },
  {
    name: 'usage_and_cost',
    title: 'Usage and cost',
    description:
      'What this Dataflare deployment adds to the Cloudflare bill: events, requests, D1 writes and storage, replay storage, projected per month and priced against Workers Paid allowances, with recommendations (replay sampling, the lake store, retention, noisy events) and a prompt for each.',
    input: inputs.usage,
    scope: 'read',
    run: (s, a) => s.usage(a),
  },
  {
    name: 'list_replays',
    title: 'Find session replays',
    description:
      'Find recorded sessions. Filter by person, signals (errors, rage_clicks, dead_clicks, console_errors, failed_requests, frustration), visited URL, events that did or did not happen (did_event / not_event: "reached checkout but never purchased"), event or cohort filters, length or text (clicked element, error message). Sort by newest, longest, most_errors or most_frustrated.',
    input: inputs.listReplays,
    scope: 'read',
    run: (s, a) => s.listReplays(a),
  },
  {
    name: 'summarise_replay',
    title: 'Read a session replay',
    description:
      'A transcript of a recorded session: pages, clicks with element labels and CSS selectors (grep them in the code), rage and dead clicks, inputs, custom events, errors with stack frames, failed or slow requests, console errors, idle gaps and notes. Highlights link to each moment in the player. Use it to "watch" a broken session.',
    input: inputs.replay,
    scope: 'read',
    run: (s, a) => s.summariseReplay(a),
  },
  {
    name: 'replay_snapshot',
    title: 'What was on screen',
    description:
      'The page as the user saw it at one moment of a session, as text: URL, viewport, headings, links, buttons (and whether disabled), form fields with masked values, dialogs and alerts. Use a time from the summarise_replay transcript, e.g. the second before an error or a rage click.',
    input: inputs.replaySnapshot,
    scope: 'read',
    run: (s, a) => s.replaySnapshot(a),
  },
  {
    name: 'analyse_replays',
    title: 'Patterns across replays',
    description:
      'What is frustrating users across many sessions: the most rage-clicked and dead-clicked elements (with selectors), the most common errors, failing requests and console errors, and the last page of sessions that hit problems. Each finding has example sessions with links. Takes the same filters as list_replays.',
    input: inputs.analyseReplays,
    scope: 'read',
    run: (s, a) => s.analyseReplays(a),
  },
  {
    name: 'annotate_replay',
    title: 'Leave a note on a replay',
    description:
      'Pin a finding to a moment of a session ("00:14 Pay stays disabled: email validation fails silently"). Notes show on the player timeline for people and in the transcript for agents.',
    input: inputs.annotateReplay,
    scope: 'admin',
    run: (s, a) => s.annotateReplay(a),
  },
  {
    name: 'delete_replay_note',
    title: 'Delete a replay note',
    description: 'Remove a note from a session, by the id summarise_replay lists.',
    input: inputs.deleteReplayNote,
    scope: 'admin',
    run: (s, a) => s.deleteReplayNote(a),
  },
  {
    name: 'list_flags',
    title: 'List feature flags',
    description: 'All feature flags with rollout, variants and targeting rules.',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listFlags(a),
  },
  {
    name: 'save_flag',
    title: 'Create or update a flag',
    description:
      'Create a flag or change its rollout, variants, targeting rules (person/group properties, cohorts, other flags), payloads, bucketing (device, person or group) or early-access offer. Fields you omit keep their current values; null clears one. Read it in code with glass.flag(key) ("on", a variant key, or null) and glass.flagPayload(key).',
    input: inputs.saveFlag,
    scope: 'admin',
    run: (s, a) => s.saveFlag(a),
  },
  {
    name: 'delete_flag',
    title: 'Delete a flag',
    description: 'Delete a flag. Remove it from code first.',
    input: inputs.flagKey,
    scope: 'admin',
    run: (s, a) => s.deleteFlag(a),
  },
  {
    name: 'evaluate_flags',
    title: 'Which flags a user gets',
    description:
      'Every flag’s value and payload for one user (device id, optional user id and groups), with the reason (rule matched, rollout, opted in, disabled…). Use it to debug targeting.',
    input: inputs.evaluateFlags,
    scope: 'read',
    run: (s, a) => s.evaluateFlags(a),
  },
  {
    name: 'flag_usage',
    title: 'Flag exposures',
    description:
      'How many times, and by how many people, each value of a flag was seen, over time.',
    input: inputs.flagUsage,
    scope: 'read',
    run: (s, a) => s.flagUsage(a),
  },
  {
    name: 'flag_history',
    title: 'Flag history',
    description:
      'Every change to a flag: when, by whom (key scope and X-Glass-Actor) and which fields changed.',
    input: inputs.flagHistory,
    scope: 'read',
    run: (s, a) => s.flagHistory(a),
  },
  {
    name: 'schedule_flag_change',
    title: 'Schedule a flag change',
    description:
      'Change a flag at a future time, e.g. roll out to 50% on Monday 09:00 UTC, or switch a promotion off at midnight: {"key":"promo","at":"2026-11-30T00:00:00Z","change":{"enabled":false}}.',
    input: inputs.scheduleFlag,
    scope: 'admin',
    run: (s, a) => s.scheduleFlag(a),
  },
  {
    name: 'list_flag_schedules',
    title: 'Scheduled flag changes',
    description: 'Pending and past scheduled changes, optionally for one flag.',
    input: inputs.flagSchedules,
    scope: 'read',
    run: (s, a) => s.flagSchedules(a),
  },
  {
    name: 'cancel_flag_schedule',
    title: 'Cancel a scheduled change',
    description: 'Cancel a pending scheduled flag change by id.',
    input: inputs.cancelFlagSchedule,
    scope: 'admin',
    run: (s, a) => s.cancelFlagSchedule(a),
  },
  {
    name: 'list_experiments',
    title: 'List experiments',
    description: 'All A/B tests with their status (include_archived for archived ones).',
    input: inputs.listExperiments,
    scope: 'read',
    run: (s, a) => s.listExperiments(a),
  },
  {
    name: 'create_experiment',
    title: 'Create an experiment',
    description:
      'Create an A/B test (draft). Measure it with a goal event or metrics: conversion, mean (count or sum per person, winsorised), ratio (e.g. revenue per order), funnel or retention, plus secondary metrics as guardrails. Choose engine (bayesian/frequentist), confidence, a holdout, or page changes per variant (transforms) for a no-code web experiment. Creates a control/test flag unless you pass one. Then branch on glass.flag(flag) in code (not needed for web experiments) and start it with update_experiment. Use plan_experiment first to see how long it needs.',
    input: inputs.createExperiment,
    scope: 'admin',
    run: (s, a) => s.createExperiment(a),
  },
  {
    name: 'experiment_results',
    title: 'Experiment results',
    description:
      'Per-variant results for every metric: value with interval, probability to beat control and to be best (Bayesian) or p-value (frequentist), lift interval; sample ratio mismatch check; status (winner, no_winner_yet, too_early, srm); a daily timeline; and days still needed.',
    input: inputs.experimentKey,
    scope: 'read',
    run: (s, a) => s.experimentResults(a),
  },
  {
    name: 'update_experiment',
    title: 'Start, stop or ship an experiment',
    description:
      '"start" enables the flag; "pause" switches it off for everyone (results kept) and "resume" back on; "stop" freezes results; "ship" gives everyone the chosen variant; "reset" returns to draft and counts afresh from the next start; "archive"/"unarchive".',
    input: inputs.updateExperiment,
    scope: 'admin',
    run: (s, a) => s.updateExperiment(a),
  },
  {
    name: 'list_actors',
    title: 'Who is behind a number',
    description:
      'List the people (or sessions, or groups when the spec has aggregateBy) behind one number of a trends, funnel, retention or paths result: a trends point (selection {series, bucket, breakdown}), a funnel step ({step, status: "converted"|"dropped"}), a retention cell ({cohort, period}), or a paths step ({node}), link ({node, target}) or drop-off ({node, dropOff: true}). Pass the same spec you queried. Each has properties and a link; format "csv" exports the list.',
    input: inputs.actors.omit({ saveAsCohort: true }),
    scope: 'read',
    run: (s, a) => s.actors({ ...(a as object), saveAsCohort: undefined }),
  },
  {
    name: 'save_actors_as_cohort',
    title: 'Save a selection as a cohort',
    description:
      'Save everyone behind a number (the same kind, spec and selection as list_actors, up to 10,000 people) as a static cohort, e.g. "people who dropped off at checkout last week".',
    input: inputs.actors.required({ saveAsCohort: true }),
    scope: 'admin',
    run: (s, a) => s.actors(a),
  },
  {
    name: 'list_annotations',
    title: 'List annotations',
    description:
      'Notes pinned to moments on time charts (launches, outages, campaigns), so a spike or dip can be explained. Trends and web results include those in their range.',
    input: inputs.listAnnotations,
    scope: 'read',
    run: (s, a) => s.listAnnotations(a),
  },
  {
    name: 'create_annotation',
    title: 'Annotate a moment',
    description:
      'Pin a note to a moment ("2026-11-03": "Launched pricing v2"). It shows on every time chart of the project, or only on one saved insight.',
    input: inputs.createAnnotation,
    scope: 'admin',
    run: (s, a) => s.createAnnotation(a),
  },
  {
    name: 'delete_annotation',
    title: 'Delete an annotation',
    description: 'Remove an annotation by id (list_annotations shows ids).',
    input: inputs.deleteAnnotation,
    scope: 'admin',
    run: (s, a) => s.deleteAnnotation(a),
  },
  {
    name: 'list_group_types',
    title: 'List group types',
    description:
      'Group types in use (company, workspace…, at most five), with how many groups each has. Group analytics: aggregateBy a type in trends, funnels, retention, experiments and revenue; filter with "group.<type>" or "group.<type>.<property>".',
    input: inputs.listGroupTypes,
    scope: 'read',
    run: (s, a) => s.listGroupTypes(a),
  },
  {
    name: 'set_group_type',
    title: 'Add or name a group type',
    description: 'Add a group type before any events use it, or give it display names.',
    input: inputs.setGroupType,
    scope: 'admin',
    run: (s, a) => s.setGroupType(a),
  },
  {
    name: 'search_groups',
    title: 'Search groups',
    description:
      'Groups of a type (e.g. companies), searchable by key or property, most recently active first.',
    input: inputs.searchGroups,
    scope: 'read',
    run: (s, a) => s.searchGroups(a),
  },
  {
    name: 'get_group',
    title: 'Group detail',
    description:
      'One group: its properties, events, people and sessions in the range, top events, most active members, recent events and (when revenue is set up) its revenue and MRR.',
    input: inputs.getGroup,
    scope: 'read',
    run: (s, a) => s.getGroup(a),
  },
  {
    name: 'set_group_properties',
    title: 'Set group properties',
    description:
      'Set or remove properties of a group (e.g. plan, industry); events from now on carry them.',
    input: inputs.setGroupProperties,
    scope: 'admin',
    run: (s, a) => s.setGroupProperties(a),
  },
  {
    name: 'delete_group',
    title: 'Delete a group',
    description:
      'Erase a group: its properties, and its key on stored events (the events stay with their people). Immediate on D1; the lake job does it in lake mode.',
    input: inputs.deleteGroup,
    scope: 'admin',
    run: (s, a) => s.deleteGroup(a),
  },
  {
    name: 'connect_stripe',
    title: 'Connect Stripe',
    description:
      'Record revenue from Stripe: paid invoices, one-off charges, refunds and subscription changes (for MRR) arrive through a signed webhook. Pass the webhook signing secret; optionally a restricted key (customers: read) and how customers map to people (metadata key, or email) and accounts (group type). Returns the webhook URL to add in Stripe and the events it should send.',
    input: inputs.connectStripe,
    scope: 'admin',
    run: (s, a) => s.connectStripe(a),
  },
  {
    name: 'stripe_status',
    title: 'Stripe status',
    description:
      'Whether Stripe is connected, the webhook URL, webhooks received, and how many customers are linked to people.',
    input: inputs.stripeStatus,
    scope: 'read',
    run: (s, a) => s.stripeStatus(a),
  },
  {
    name: 'disconnect_stripe',
    title: 'Disconnect Stripe',
    description: 'Stop recording revenue from Stripe (revenue already recorded stays).',
    input: inputs.stripeStatus,
    scope: 'admin',
    run: (s, a) => s.disconnectStripe(a),
  },
  {
    name: 'list_issues',
    title: 'List error issues',
    description:
      'Error tracking: exceptions grouped into issues (same type, message pattern and top in-app frames), with exceptions, people and sessions in the range, a series, status (active, resolved, suppressed) and regressions. Start here for "what is breaking?".',
    input: inputs.listIssues,
    scope: 'read',
    run: (s, a) => s.listIssues(a),
  },
  {
    name: 'get_issue',
    title: 'Error issue detail',
    description:
      'One issue: the latest stack trace mapped to source (when source maps were uploaded), its trend, breakdowns by browser, OS, device, country, page, release and handled/unhandled, the people affected, and replay links opened just before the error.',
    input: inputs.getIssue,
    scope: 'read',
    run: (s, a) => s.getIssue(a),
  },
  {
    name: 'update_issue',
    title: 'Resolve, suppress or assign an issue',
    description:
      'Set an issue’s status (resolved issues that recur come back as regressions; suppressed issues are dropped at ingest) or its assignee.',
    input: inputs.updateIssue,
    scope: 'admin',
    run: (s, a) => s.updateIssue(a),
  },
  {
    name: 'merge_issues',
    title: 'Merge issues',
    description:
      'Merge issues that are the same bug into one; new exceptions with any of their fingerprints join it.',
    input: inputs.mergeIssues,
    scope: 'admin',
    run: (s, a) => s.mergeIssues(a),
  },
  {
    name: 'list_sourcemaps',
    title: 'List source maps',
    description: 'Source maps uploaded for error tracking, by release and file.',
    input: inputs.listSourcemaps,
    scope: 'read',
    run: (s, a) => s.listSourcemaps(a),
  },
  {
    name: 'list_destination_templates',
    title: 'Destination templates',
    description:
      'Tools Dataflare can forward events to as they arrive (webhook, Slack, Discord, Teams, Meta Conversions API, GA4, TikTok, Customer.io, Loops, HubSpot, Mixpanel, Amplitude, PostHog, Zapier, Make, n8n), with the inputs each needs.',
    input: z.object({}),
    scope: 'read',
    run: (s) => s.listDestinationTemplates(),
  },
  {
    name: 'list_destinations',
    title: 'List destinations',
    description: 'Configured destinations and how deliveries are made (queue or outbox).',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listDestinations(a),
  },
  {
    name: 'get_destination',
    title: 'Destination health',
    description:
      'A destination with deliveries, failures and skips per hour (48h), waiting deliveries and recent failures with their errors.',
    input: inputs.destinationId,
    scope: 'read',
    run: (s, a) => s.getDestination(a),
  },
  {
    name: 'save_destination',
    title: 'Create or change a destination',
    description:
      'Forward events to another tool: a template, the events to send (["*"] for all), optional filters, and the template inputs (secrets are encrypted and never shown). E.g. send signups and purchases to the Meta Conversions API with an event map, or post signups to Slack.',
    input: inputs.saveDestination,
    scope: 'admin',
    run: (s, a) => s.saveDestination(a),
  },
  {
    name: 'delete_destination',
    title: 'Delete a destination',
    description: 'Stop forwarding and delete a destination with its logs.',
    input: inputs.destinationId,
    scope: 'admin',
    run: (s, a) => s.deleteDestination(a),
  },
  {
    name: 'test_destination',
    title: 'Test a destination',
    description:
      'Send a sample event (or one you describe) through a destination now and report the response.',
    input: inputs.testDestination,
    scope: 'admin',
    run: (s, a) => s.testDestination(a),
  },
  {
    name: 'retry_destination',
    title: 'Retry failed deliveries',
    description: 'Queue a destination’s failed deliveries (all, or some ids) for another try.',
    input: inputs.retryDestination,
    scope: 'admin',
    run: (s, a) => s.retryDestination(a),
  },
  {
    name: 'list_transformations',
    title: 'List transformations',
    description: 'Rules applied to events at ingest, in order, with how many events each changed.',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listTransformations(a),
  },
  {
    name: 'save_transformation',
    title: 'Add or change a transformation',
    description:
      'A rule applied to events at ingest, before they are stored or forwarded: drop_event, drop_properties, rename_property, set_property, hash_properties (salted SHA-256), redact (emails, phone numbers, card numbers, IPs or custom patterns). Optionally limited to events and filters. Use test_transformation first.',
    input: inputs.saveTransformation,
    scope: 'admin',
    run: (s, a) => s.saveTransformation(a),
  },
  {
    name: 'delete_transformation',
    title: 'Delete a transformation',
    description: 'Remove a rule; events from then on are stored as sent.',
    input: inputs.transformationId,
    scope: 'admin',
    run: (s, a) => s.deleteTransformation(a),
  },
  {
    name: 'test_transformation',
    title: 'Try a transformation',
    description: 'Apply a rule to a sample event without saving it, and show the result.',
    input: inputs.testTransformation,
    scope: 'read',
    run: (s, a) => s.testTransformation(a),
  },
  {
    name: 'list_exports',
    title: 'List batch exports',
    description: 'Batch exports (S3/R2, BigQuery, HTTP) with how far each has got.',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listExports(a),
  },
  {
    name: 'save_export',
    title: 'Create or change a batch export',
    description:
      'Send events to a warehouse every hour or day: gzipped JSONL/CSV files to S3 or R2 (any S3-compatible store), rows to a BigQuery table, or NDJSON to an HTTP endpoint. Credentials are encrypted.',
    input: inputs.saveExport,
    scope: 'admin',
    run: (s, a) => s.saveExport(a),
  },
  {
    name: 'delete_export',
    title: 'Delete a batch export',
    description: 'Stop and delete a batch export.',
    input: inputs.exportId,
    scope: 'admin',
    run: (s, a) => s.deleteExport(a),
  },
  {
    name: 'export_runs',
    title: 'Batch export runs',
    description: 'Recent runs of an export: window, rows, files, bytes and errors.',
    input: inputs.exportId,
    scope: 'read',
    run: (s, a) => s.exportRuns(a),
  },
  {
    name: 'backfill_export',
    title: 'Backfill a batch export',
    description: 'Re-export everything received since a time (e.g. "-30d").',
    input: inputs.backfillExport,
    scope: 'admin',
    run: (s, a) => s.backfillExport(a),
  },
  {
    name: 'list_dashboards',
    title: 'Dashboards',
    description: "The project's dashboards, with how many tiles each has.",
    input: inputs.listDashboards,
    scope: 'read',
    run: (s, a) => s.listDashboards(a),
  },
  {
    name: 'get_dashboard',
    title: 'A dashboard',
    description:
      "A dashboard's tiles (saved analyses and text), its date range and filters, and with results: true, each tile's headline number and change.",
    input: inputs.getDashboard,
    scope: 'read',
    run: (s, a) => s.getDashboard(a),
  },
  {
    name: 'dashboard_templates',
    title: 'Starter dashboards',
    description:
      'Starter dashboards (website overview, product health, revenue, errors) and the signup and purchase events they would use here.',
    input: inputs.dashboardTemplates,
    scope: 'read',
    run: (s, a) => s.dashboardTemplates(a),
  },
  {
    name: 'create_dashboard_from_template',
    title: 'Create a dashboard from a template',
    description:
      'Create a dashboard from a template: its analyses are saved and laid out. Pass events { signup, purchase } when the guesses are wrong.',
    input: inputs.createDashboardFromTemplate,
    scope: 'admin',
    run: (s, a) => s.createDashboardFromTemplate(a),
  },
  {
    name: 'save_dashboard',
    title: 'Create or change a dashboard',
    description:
      "Create a dashboard ({ name }) or change one ({ id, name, description, filters: { from, to, filters, filterTestAccounts } }); the filters apply to every tile that doesn't ignore them.",
    input: inputs.saveDashboard,
    scope: 'admin',
    run: (s, a) => s.saveDashboard(a),
  },
  {
    name: 'add_dashboard_tile',
    title: 'Add a tile to a dashboard',
    description:
      'Add a saved analysis ({ insightKey }), a new one ({ insight: { name, kind, spec } }, saved first) or text ({ text }) to a dashboard. width 3, 4, 6 or 12 columns; height 1 or 2.',
    input: inputs.addDashboardTile,
    scope: 'admin',
    run: (s, a) => s.addDashboardTile(a),
  },
  {
    name: 'remove_dashboard_tile',
    title: 'Remove a dashboard tile',
    description: 'Remove a tile from a dashboard; the analysis stays.',
    input: inputs.removeDashboardTile,
    scope: 'admin',
    run: (s, a) => s.removeDashboardTile(a),
  },
  {
    name: 'delete_dashboard',
    title: 'Delete a dashboard',
    description: 'Delete a dashboard and its scheduled reports; its analyses stay.',
    input: inputs.deleteDashboard,
    scope: 'admin',
    run: (s, a) => s.deleteDashboard(a),
  },
  {
    name: 'list_reports',
    title: 'Scheduled reports',
    description:
      'Scheduled reports of dashboards and analyses: where they go, when, and how the last one went.',
    input: inputs.listSubscriptions,
    scope: 'read',
    run: (s, a) => s.listSubscriptions(a),
  },
  {
    name: 'schedule_report',
    title: 'Schedule a report',
    description:
      'Send a dashboard (or one analysis) to Slack, Discord, Teams, a webhook or email on a schedule, with a chart per tile. E.g. { target: "dashboard", targetId, channels: { destinations: [id] }, schedule: { frequency: "weekly", weekday: "mon", time: "09:00" } }. Channels are destinations (list_destinations); email needs it set up (capabilities).',
    input: inputs.saveSubscription,
    scope: 'admin',
    run: (s, a) => s.saveSubscription(a),
  },
  {
    name: 'send_report_now',
    title: 'Send a report now',
    description: 'Compute and send a scheduled report now, e.g. to check how it looks.',
    input: inputs.sendSubscriptionNow,
    scope: 'admin',
    run: (s, a) => s.sendSubscriptionNow(a),
  },
  {
    name: 'delete_report',
    title: 'Delete a scheduled report',
    description: 'Stop and delete a scheduled report.',
    input: inputs.deleteSubscription,
    scope: 'admin',
    run: (s, a) => s.deleteSubscription(a),
  },
  {
    name: 'list_alerts',
    title: 'Alerts',
    description:
      'Alerts on saved analyses, with their state (ok, firing, errored, disabled) and last value.',
    input: inputs.listAlerts,
    scope: 'read',
    run: (s, a) => s.listAlerts(a),
  },
  {
    name: 'get_alert',
    title: 'An alert and its history',
    description: 'An alert with every check in the last days (value, breakdown, whether it fired).',
    input: inputs.getAlert,
    scope: 'read',
    run: (s, a) => s.getAlert(a),
  },
  {
    name: 'save_alert',
    title: 'Create or change an alert',
    description:
      'Alert on a saved trends series or funnel step: { name, insightKey, condition: { type: "value", above: 1000 } | { type: "decrease", by: 20, unit: "percent" }, schedule: { frequency: "hourly" }, channels }. Every breakdown value is checked; it notifies when it starts firing and when it resolves. Quiet hours and skipWeekends skip checks.',
    input: inputs.saveAlert,
    scope: 'admin',
    run: (s, a) => s.saveAlert(a),
  },
  {
    name: 'check_alert',
    title: 'Check an alert now',
    description: 'Check an alert now; it notifies only if its state changes.',
    input: inputs.checkAlertNow,
    scope: 'admin',
    run: (s, a) => s.checkAlertNow(a),
  },
  {
    name: 'delete_alert',
    title: 'Delete an alert',
    description: 'Delete an alert and its history.',
    input: inputs.deleteAlert,
    scope: 'admin',
    run: (s, a) => s.deleteAlert(a),
  },
  {
    name: 'capabilities',
    title: 'What this deployment can do',
    description:
      'Whether email is set up for reports and alerts (and its sender), whether replay is on, and the event store.',
    input: inputs.capabilities,
    scope: 'read',
    run: (s, a) => s.capabilities(a),
  },
  {
    name: 'suggest_path_rules',
    title: 'Suggest path cleaning rules',
    description:
      'Path cleaning rules for page paths with ids in them ("/users/42" and "/users/7" → "/users/:id"), from the last 30 days, with how many paths each merges. Save the ones you want with update_settings (pathCleaning); paths queries then show each as one step.',
    input: inputs.suggestPathRules,
    scope: 'read',
    run: (s, a) => s.suggestPathRules(a),
  },
  {
    name: 'get_settings',
    title: 'Project settings',
    description:
      "The project's settings: IANA time zone for reports, internal-traffic filters (used when a query sets filterTestAccounts: true), base currency and revenue events, error tracking options.",
    input: inputs.getSettings,
    scope: 'read',
    run: (s, a) => s.getSettings(a),
  },
  {
    name: 'update_settings',
    title: 'Change project settings',
    description:
      'Change some project settings; the rest keep their values (null clears one). E.g. {"settings":{"timezone":"Europe/London","internalFilters":[{"property":"person.email","op":"contains","value":"@acme.com"}]}}.',
    input: inputs.updateSettings,
    scope: 'admin',
    run: (s, a) => s.updateSettings(a),
  },
  {
    name: 'edit_experiment',
    title: 'Change an experiment',
    description:
      'Change an experiment’s metrics, secondary metrics, engine, confidence, minimum runtime or holdout.',
    input: inputs.editExperiment,
    scope: 'admin',
    run: (s, a) => s.editExperiment(a),
  },
  {
    name: 'duplicate_experiment',
    title: 'Copy an experiment',
    description:
      'Copy an experiment (metrics, options and variants, on a new flag) as a new draft.',
    input: inputs.duplicateExperiment,
    scope: 'admin',
    run: (s, a) => s.duplicateExperiment(a),
  },
  {
    name: 'plan_experiment',
    title: 'How long an experiment needs',
    description:
      'Running-time calculator: the metric’s current baseline among recent traffic, people needed per variant to detect a relative change (mde, default 10%) at the confidence level, and the days that takes at the recent rate of new people.',
    input: inputs.planExperiment,
    scope: 'read',
    run: (s, a) => s.planExperiment(a),
  },
  {
    name: 'list_holdouts',
    title: 'List holdouts',
    description:
      'Holdouts (people kept out of a set of experiments) and the experiments using each.',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listHoldouts(a),
  },
  {
    name: 'save_holdout',
    title: 'Create or change a holdout',
    description:
      'Keep a share of people (e.g. 10%) out of every experiment that uses this holdout, to measure the combined effect of what ships. People held out get the value "holdout".',
    input: inputs.saveHoldout,
    scope: 'admin',
    run: (s, a) => s.saveHoldout(a),
  },
  {
    name: 'delete_holdout',
    title: 'Delete a holdout',
    description: 'Delete a holdout no running experiment uses.',
    input: inputs.holdoutKey,
    scope: 'admin',
    run: (s, a) => s.deleteHoldout(a),
  },
  {
    name: 'holdout_results',
    title: 'Holdout results',
    description:
      'Everyone exposed to a holdout’s experiments vs the people held out, on the experiments’ metrics (or ones you pass): the combined effect of shipping them.',
    input: inputs.holdoutResults,
    scope: 'read',
    run: (s, a) => s.holdoutResults(a),
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Projects (sites or apps) in this Dataflare install.',
    input: z.object({}),
    scope: 'read',
    run: (s) => s.listProjects(),
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description: 'Add a project for another site or app.',
    input: inputs.createProject,
    scope: 'admin',
    run: (s, a) => s.createProject(a),
  },
  {
    name: 'get_project_policy',
    title: 'Get a project’s student-mode policy',
    description:
      'Whether a project is in student mode (audience "minors") and what it allows: the pseudonym format for user ids, allowed event and person properties, replay and retention. Check this before adding tracking to a K-12 product.',
    input: inputs.getProjectPolicy,
    scope: 'read',
    run: (s, a) => s.getProjectPolicy(a),
  },
  {
    name: 'set_project_policy',
    title: 'Set a project’s student-mode policy',
    description:
      'Turn student mode on ({"audience":"minors"}) or off for a project. In student mode the server keeps only pseudonymous ids and allow-listed properties, refuses replay unless replay is "scrubbed", and audits every read. Replaces the whole policy, so send every field you want to keep.',
    input: inputs.setProjectPolicy,
    scope: 'admin',
    run: (s, a) => s.setProjectPolicy(a),
  },
  {
    name: 'audit_log',
    title: 'Student-mode audit log',
    description:
      'Who read or changed a student-mode project’s data: time, surface (api/mcp), key scope, Access email when present, the operation and its SQL or arguments.',
    input: inputs.auditLog,
    scope: 'admin',
    run: (s, a) => s.auditLog(a),
  },
];

export const TOOLS: ToolDefinition[] = ALL_TOOLS.map(withStage);

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
