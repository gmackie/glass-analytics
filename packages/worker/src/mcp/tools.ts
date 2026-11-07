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

export const TOOLS: ToolDefinition[] = [
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
      'Create or update a named person cohort from filters (and optional didEvent). Returns the live membership count.',
    input: inputs.saveCohort,
    scope: 'admin',
    run: (s, a) => s.saveCohort(a),
  },
  {
    name: 'count_cohort',
    title: 'Count a cohort',
    description: 'How many distinct people match filters (and optional didEvent) without saving.',
    input: inputs.countCohort,
    scope: 'read',
    run: (s, a) => s.countCohort(a),
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
      'Errors over time and the share of sessions they affect, pages where errors happen, pages that look like "not found" pages (with where visitors came from), the slowest pages by LCP, and frustration signals from replays. Start here to find what is broken.',
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
      'Create a flag or change its rollout, variants or targeting. Fields you omit keep their current values. Read it in code with glass.flag(key), which returns "on", a variant key, or null.',
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
    name: 'list_experiments',
    title: 'List experiments',
    description: 'All A/B tests with their status.',
    input: projectOnly,
    scope: 'read',
    run: (s, a) => s.listExperiments(a),
  },
  {
    name: 'create_experiment',
    title: 'Create an experiment',
    description:
      'Create an A/B test (draft) with a goal event. Creates a control/test flag unless you pass an existing multivariate flag. Then branch on glass.flag(flag) in code and start it with update_experiment.',
    input: inputs.createExperiment,
    scope: 'admin',
    run: (s, a) => s.createExperiment(a),
  },
  {
    name: 'experiment_results',
    title: 'Experiment results',
    description:
      'Per-variant exposures, conversions and rates, probability to beat control, lift interval, sample ratio mismatch check, winner and days to significance.',
    input: inputs.experimentKey,
    scope: 'read',
    run: (s, a) => s.experimentResults(a),
  },
  {
    name: 'update_experiment',
    title: 'Start, stop or ship an experiment',
    description:
      '"start" enables the flag; "stop" freezes results; "ship" gives everyone the chosen variant.',
    input: inputs.updateExperiment,
    scope: 'admin',
    run: (s, a) => s.updateExperiment(a),
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
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
