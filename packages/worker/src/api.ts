/**
 * The JSON API under `/api`. Every route is a thin wrapper over GlassService;
 * agents can discover everything from `GET /api`.
 */

import { experimentSpec, filterSchema, INSIGHTS, sqlSpec } from '@dataflare/core/insights';
import { type StagedFeature, stagePrefix } from '@dataflare/core/stages';
import { GLASS_VERSION } from '@dataflare/core/version';
import { z } from 'zod/v4';
import { authenticate, type Scope } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, Router, readJson } from './http.ts';
import { handleImport } from './ingest.ts';
import { TOOLS } from './mcp/tools.ts';
import type { GlassService } from './service.ts';
import { actorFromRequest } from './student-mode.ts';

const NUMERIC = new Set(['days', 'limit']);
const BOOLEAN = new Set(['with_errors', 'compare', 'include_archived']);

/** Query string → plain object, converting the few numeric/boolean parameters. */
function params(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    out[key] = NUMERIC.has(key) ? Number(value) : BOOLEAN.has(key) ? value === 'true' : value;
  }
  return out;
}

/** Paths the server key may call (its whole job: imports, flag definitions, source maps). */
const SERVER_PATHS = [
  /^\/api\/import\/?$/,
  /^\/api\/flags\/definitions\/?$/,
  /^\/api\/sourcemaps(\/|$)/,
];

/** Endpoints of features that aren't stable yet, and which feature each belongs to. */
const ENDPOINT_STAGES: [RegExp, StagedFeature][] = [
  [/ \/api\/destinations\b/, 'destinations'],
  [/ \/api\/transformations\b/, 'transformations'],
  [/ \/api\/exports\b/, 'exports'],
  [/^POST \/api\/import$/, 'imports'],
];

/** The API index with "(alpha) " in front of every endpoint of an alpha feature. */
function withStages(endpoints: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(endpoints).map(([route, text]) => {
      const feature = ENDPOINT_STAGES.find(([re]) => re.test(route))?.[1];
      return [route, feature ? stagePrefix(feature) + text : text];
    }),
  );
}

/** The key's scope, or an error that says what's wrong with the request's key. */
async function authorize(request: Request, env: Env): Promise<Scope> {
  if (!env.GLASS_ADMIN_KEY)
    throw new HttpError(
      503,
      'GLASS_ADMIN_KEY is not set on this Worker',
      'Run `dataflare upgrade` or set it with `wrangler secret put GLASS_ADMIN_KEY`.',
    );
  const scope = await authenticate(request, env);
  if (!scope)
    throw new HttpError(
      401,
      'Missing or invalid API key',
      'Send "Authorization: Bearer <key>". Keys are in .glass/credentials.json; run `dataflare key`.',
    );
  const path = new URL(request.url).pathname.replace(/^\/_glass/, '');
  if (scope === 'server' && !SERVER_PATHS.some((re) => re.test(path)))
    throw new HttpError(
      403,
      'The server key only imports events, reads flag definitions and uploads source maps',
      'Use the read key (`dataflare key --read`) to query, or the admin key to change things.',
    );
  return scope;
}

/** Who changed something, for flag history: the agent's name when it sends one, and the key. */
function actorLabel(request: Request, scope: Scope): string {
  const name = request.headers.get('X-Glass-Actor')?.slice(0, 60);
  return name ? `${name} (${scope} key)` : `${scope} key`;
}

/** A result as a CSV download when it has one (?format=csv), JSON otherwise. */
function csvOrJson(result: object, filename: string): Response {
  const csv = (result as { csv?: string }).csv;
  if (csv === undefined) return json(result);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** 304 when the client already has this version. */
function withEtag(req: Request, defs: { etag: string }): Response {
  if (req.headers.get('If-None-Match') === defs.etag)
    return new Response(null, { status: 304, headers: { ETag: defs.etag } });
  return json(defs, { headers: { ETag: defs.etag, 'Cache-Control': 'no-cache' } });
}

export async function apiRouter(
  service: GlassService,
  env: Env,
  request: Request,
  now = Date.now(),
): Promise<Router> {
  const scope = await authorize(request, env);
  service.actor = actorLabel(request, scope);
  const admin = () => {
    if (scope !== 'admin') throw new HttpError(403, 'This action needs the admin key');
  };
  /** Server-side writes: the server key or the admin key. */
  const server = () => {
    if (scope !== 'admin' && scope !== 'server')
      throw new HttpError(
        403,
        'This action needs the server or admin key',
        'Run `dataflare key --server`.',
      );
  };
  const body = () => readJson<Record<string, unknown>>(request);
  const url = new URL(request.url);
  service.setActor({
    ...actorFromRequest(
      request,
      scope,
      'api',
      `${request.method} ${url.pathname.replace(/^\/_glass/, '')}`,
    ),
    detail: url.search.slice(1),
  });
  const r = new Router();

  r.get('/api', () =>
    json({
      name: 'Dataflare',
      version: GLASS_VERSION,
      scope,
      store: service.store.kind,
      docs: `${service.baseUrl}/llms.txt`,
      schemas: `${service.baseUrl}/api/schema`,
      mcp: `${service.baseUrl}/mcp`,
      health: `${service.baseUrl}/health`,
      endpoints: withStages({
        'GET /health': 'Deployment version, latest release, upgradeAvailable',
        'GET /api/overview?from=-30d':
          'Headline stats and movers (includes upgrade notice when outdated)',
        'GET /api/sites?from=-30d':
          'Every project side by side: visitors, pageviews and trend vs the previous period',
        'POST /api/query': `Run an insight: { "kind": ${Object.keys(INSIGHTS)
          .map((k) => `"${k}"`)
          .join(' | ')}, ...spec }`,
        'POST /api/sql': 'Read-only SQL: { "query": "SELECT ..." }',
        'GET /api/events': 'Tracked events',
        'GET /api/events/:name': 'Properties of an event',
        'PUT /api/events/:name': 'Document an event (admin)',
        'GET /api/properties/values?property=&event=&query=':
          'Most common values of a property (filter typeahead)',
        'GET /api/person-properties': 'Person property names with types and examples',
        'GET /api/persons?query=': 'Search identified people (includes anonymous device count)',
        'GET /api/persons/:id': 'One person with events and replays',
        'PATCH /api/persons/:id': 'Set person properties (admin)',
        'DELETE /api/persons/:id': 'Erase a person (admin)',
        'GET /api/cohorts': 'Saved person cohorts with live counts',
        'POST /api/cohorts': 'Create or update a cohort (admin)',
        'POST /api/cohorts/count': 'Count people matching a cohort definition',
        'DELETE /api/cohorts/:key': 'Delete a cohort (admin)',
        'GET /api/cohorts/:key/members?format=csv': 'People in a cohort (CSV with format=csv)',
        'PATCH /api/cohorts/:key/members':
          'Add or remove people of a static cohort: { "add": [...], "remove": [...] } (admin)',
        'POST /api/cohorts/:key/duplicate':
          'Copy a cohort as a static list of its current members (admin)',
        'GET /api/insights': 'Saved analyses (seeded with DAU/WAU/retention defaults)',
        'GET /api/insights/:key': 'One saved analysis',
        'POST /api/insights': 'Create or update a saved analysis (admin)',
        'DELETE /api/insights/:key': 'Delete a saved analysis (admin)',
        'PUT /api/events/:name/role':
          'Mark an event as a conversion or important: { "role": "conversion" | "important" | "none" } (admin)',
        'POST /api/reports/conversions':
          'Key events: counts, converting visitors and rates vs the previous period',
        'POST /api/reports/sources':
          'Visitors by channel, referrer, campaign or landing page (first touch) with conversion rates: { "dimension": "channel" }',
        'POST /api/reports/health':
          'Errors over time, sessions affected, likely 404 pages and the slowest pages',
        'GET /api/usage':
          'What Dataflare adds to the Cloudflare bill, projected per month, with ways to cut it',
        'GET /api/replays?has=rage_clicks&url=/checkout&not_event=purchase&sort=most_frustrated':
          'Find recorded sessions',
        'GET /api/replays/analyse?from=-7d':
          'Patterns across sessions: rage/dead clicks, errors, failing requests',
        'GET /api/replays/:session/summary?format=json':
          'Transcript of a session (json adds the structured timeline)',
        'GET /api/replays/:session/snapshot?at=01:24': 'What was on screen at a moment, as text',
        'GET /api/replays/:session/events': 'Raw rrweb events',
        'POST /api/replays/:session/notes':
          'Leave a note at a moment: { "at": "00:14", "text": "…" } (admin)',
        'DELETE /api/replays/:session/notes/:id': 'Delete a note (admin)',
        'GET /api/flags': 'Feature flags',
        'GET /api/flags/definitions':
          'Flag definitions and targeted cohort members for local evaluation (server key; ETag)',
        'POST /api/flags/evaluate':
          'Every flag for one user, with payloads and reasons: { distinct_id, user_id?, groups? }',
        'GET /api/flags/:key/history': 'Changes to a flag: who, when, what',
        'GET /api/flags/:key/usage?from=-30d': 'Exposures to a flag over time by value',
        'POST /api/flags/:key/schedule':
          'Change a flag later: { "at": "2026-11-20T09:00Z", "change": { "rollout": 50 } } (admin)',
        'GET /api/flags/schedules?key=': 'Scheduled flag changes',
        'DELETE /api/flags/schedules/:id': 'Cancel a scheduled change (admin)',
        'PUT /api/flags/:key': 'Create/update a flag (admin)',
        'DELETE /api/flags/:key': 'Delete a flag (admin)',
        'GET /api/experiments': 'Experiments',
        'POST /api/experiments': 'Create an experiment (admin)',
        'GET /api/experiments/:key': 'Experiment with results',
        'POST /api/experiments/:key/start|pause|resume|stop|ship|reset|archive|unarchive':
          'Change experiment state (admin)',
        'PATCH /api/experiments/:key': 'Change metrics, engine, confidence or holdout (admin)',
        'POST /api/experiments/:key/duplicate':
          'Copy an experiment as a new draft: { "newKey": "…" } (admin)',
        'POST /api/experiments/plan':
          'How long to detect a change: { metric, mde?, variants?, traffic? }',
        'GET /api/holdouts': 'Holdouts and the experiments using them',
        'PUT /api/holdouts/:key': 'Create or update a holdout: { "percentage": 10 } (admin)',
        'DELETE /api/holdouts/:key': 'Delete an unused holdout (admin)',
        'GET /api/holdouts/:key/results':
          'Everyone in the holdout’s experiments vs the people held out',
        'POST /api/import':
          'Import events with their own timestamps (server or admin key): { project, events: [...] }, up to 1,000 per request',
        'GET /api/settings':
          'Project settings: time zone, internal-traffic filters, currency, revenue events',
        'PATCH /api/settings': 'Change project settings (admin)',
        'POST /api/actors':
          'The people/sessions/groups behind a number: { kind, spec, selection: { series, bucket } | { step, status } | { cohort, period } }; ?format=csv for CSV; saveAsCohort: { name } saves them (admin)',
        'GET /api/paths/suggest-rules': 'Path cleaning rules for page paths with ids in them',
        'GET /api/capabilities':
          'What this deployment can do: email for reports and alerts, replay, store',
        'GET /api/dashboards': 'Dashboards',
        'GET /api/dashboards/templates':
          'Starter dashboards, with the signup and purchase events they would use',
        'POST /api/dashboards/from-template':
          'Create a dashboard from a template: { template, events? } (admin)',
        'GET /api/dashboards/:id?results=true':
          "A dashboard with its tiles (and each tile's headline numbers)",
        'POST /api/dashboards': 'Create a dashboard: { name, description?, filters? } (admin)',
        'PUT /api/dashboards/:id': 'Rename it or change its date range and filters (admin)',
        'DELETE /api/dashboards/:id':
          'Delete a dashboard and its reports; the analyses stay (admin)',
        'POST /api/dashboards/:id/duplicate': 'Copy a dashboard: { name } (admin)',
        'POST /api/dashboards/:id/tiles':
          'Add a tile: { insightKey } or { insight: { name, kind, spec } } or { text }, width 3|4|6|12, height 1|2 (admin)',
        'PUT /api/dashboards/:id/tiles/:tile':
          'Resize, change text, ignore the dashboard filters (admin)',
        'DELETE /api/dashboards/:id/tiles/:tile': 'Remove a tile (admin)',
        'PUT /api/dashboards/:id/order': 'Reorder tiles: { tiles: [ids] } (admin)',
        'GET /api/subscriptions?dashboard=|insight=': 'Scheduled reports',
        'POST /api/subscriptions':
          'Schedule a report of a dashboard or analysis to channels and email: { target, targetId, channels, schedule } (admin)',
        'PUT /api/subscriptions/:id': 'Change a report (admin)',
        'DELETE /api/subscriptions/:id': 'Delete a report (admin)',
        'POST /api/subscriptions/:id/send': 'Send a report now (admin)',
        'GET /api/alerts?insight=': 'Alerts',
        'GET /api/alerts/:id?days=': 'An alert with its recent checks',
        'POST /api/alerts':
          'Alert on a saved trends or funnel analysis: { name, insightKey, condition, schedule, channels } (admin)',
        'PUT /api/alerts/:id': 'Change an alert (admin)',
        'DELETE /api/alerts/:id': 'Delete an alert (admin)',
        'POST /api/alerts/:id/check': 'Check an alert now, notifying on a change of state (admin)',
        'GET /api/annotations?from=&to=': 'Notes pinned to moments on time charts',
        'POST /api/annotations':
          'Pin a note: { "at": "2026-11-03", "text": "Launched v2" } (admin)',
        'DELETE /api/annotations/:id': 'Delete an annotation (admin)',
        'GET /api/destinations/templates':
          'What events can be forwarded to: Slack, webhooks, Meta CAPI, GA4, CRMs…',
        'GET /api/destinations': 'Destinations',
        'POST /api/destinations':
          'Create a destination: { template, events, filters, inputs } (admin)',
        'GET /api/destinations/:id': 'A destination with deliveries per hour and recent failures',
        'PUT /api/destinations/:id': 'Change a destination (admin)',
        'DELETE /api/destinations/:id': 'Delete a destination (admin)',
        'POST /api/destinations/:id/test': 'Send a sample event now (admin)',
        'POST /api/destinations/:id/retry': 'Retry failed deliveries (admin)',
        'GET /api/transformations': 'Rules applied to events at ingest',
        'POST /api/transformations':
          'Add a rule: drop events, drop/rename/set/hash properties, redact personal data (admin)',
        'PUT /api/transformations/:id': 'Change a rule (admin)',
        'DELETE /api/transformations/:id': 'Delete a rule (admin)',
        'POST /api/transformations/test': 'Try a rule on a sample event',
        'GET /api/exports': 'Batch exports (S3/R2, BigQuery, HTTP)',
        'POST /api/exports': 'Create a batch export (admin)',
        'PUT /api/exports/:id': 'Change an export (admin)',
        'DELETE /api/exports/:id': 'Delete an export (admin)',
        'GET /api/exports/:id/runs': 'Recent export runs',
        'POST /api/exports/:id/backfill': 'Re-export from a time: { "from": "-30d" } (admin)',
        'GET /api/issues': 'Error tracking: issues with counts, people and a series for the range',
        'GET /api/issues/:id':
          'An issue: symbolicated stack, trend, breakdowns, people, replays at the moment',
        'PATCH /api/issues/:id': 'Resolve, suppress, reopen or assign an issue (admin)',
        'POST /api/issues/:id/merge': 'Merge issues into this one: { "ids": [...] } (admin)',
        'PUT /api/sourcemaps?release=&path=':
          'Upload a source map for a minified file (server or admin key)',
        'GET /api/sourcemaps?release=': 'Uploaded source maps',
        'DELETE /api/sourcemaps?release=&path=':
          "Delete a release's source maps (server or admin key)",
        'GET /api/groups/types': 'Group types (company, workspace…) with how many groups each has',
        'PUT /api/groups/types/:type': 'Add a group type or name it: { singular, plural } (admin)',
        'GET /api/groups?type=&search=': 'Groups of a type, most recently active first',
        'GET /api/groups/:type/:key':
          'A group: properties, activity, members, recent events, revenue',
        'PATCH /api/groups/:type/:key': 'Set group properties: { properties } (admin)',
        'DELETE /api/groups/:type/:key': 'Delete a group and remove it from its events (admin)',
        'GET /api/stripe': 'Stripe connection: webhook URL, events received, customers linked',
        'POST /api/stripe':
          'Connect Stripe: { webhookSecret, apiKey?, personKey?, groupType?, groupKey?, linkByEmail? } (admin)',
        'DELETE /api/stripe': 'Disconnect Stripe (admin)',
        'POST /api/fx-rates': 'Store exchange rates (what `dataflare revenue rates` sends) (admin)',
        'POST /hooks/stripe/:project': 'Stripe webhook endpoint (signed by Stripe; no API key)',
        'GET /api/projects': 'Projects',
        'POST /api/projects': 'Create a project (admin)',
        'GET /api/projects/:id/policy': 'Student-mode privacy policy of a project',
        'PUT /api/projects/:id/policy':
          'Turn student mode on or off: { "audience": "minors", "event_properties": [...], "person_properties": [...], "replay": "off" } (admin)',
        'GET /api/projects/:id/audit?from=-30d':
          'Who read a student-mode project’s data, when and how (admin)',
        'GET /api/instrument?event=&framework=': 'Tracking code for an event',
      }),
      tools: TOOLS.map((t) => t.name),
    }),
  );

  r.get('/api/schema', () =>
    json({
      filter: z.toJSONSchema(filterSchema, { io: 'input' }),
      sql: z.toJSONSchema(sqlSpec, { io: 'input' }),
      experiment: z.toJSONSchema(experimentSpec, { io: 'input' }),
      insights: Object.fromEntries(
        Object.entries(INSIGHTS).map(([kind, def]) => [
          kind,
          { description: def.description, schema: z.toJSONSchema(def.schema, { io: 'input' }) },
        ]),
      ),
    }),
  );

  r.post('/api/import', async () => {
    server();
    return json(await handleImport(request, env, service.store, now, { base: service.baseUrl }));
  });

  r.post('/api/actors', async ({ url }) => {
    const input = { ...params(url), ...(await body()) };
    if (input.saveAsCohort) admin();
    const result = await service.actors(input);
    return csvOrJson(result, `${result.kind}-actors.csv`);
  });

  r.get('/api/annotations', async ({ url }) => json(await service.listAnnotations(params(url))));
  r.post('/api/annotations', async ({ url }) => {
    admin();
    return json(await service.createAnnotation({ ...params(url), ...(await body()) }), {
      status: 201,
    });
  });
  r.delete('/api/annotations/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteAnnotation({ ...params(url), id: p.id }));
  });

  r.get('/api/destinations/templates', () => json(service.listDestinationTemplates()));
  r.get('/api/destinations', async ({ url }) => json(await service.listDestinations(params(url))));
  r.post('/api/destinations', async ({ url }) => {
    admin();
    return json(await service.saveDestination({ ...params(url), ...(await body()) }), {
      status: 201,
    });
  });
  r.get('/api/destinations/:id', async ({ url, params: p }) =>
    json(await service.getDestination({ ...params(url), id: p.id })),
  );
  r.put('/api/destinations/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.saveDestination({ ...params(url), ...(await body()), id: p.id }));
  });
  r.delete('/api/destinations/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteDestination({ ...params(url), id: p.id }));
  });
  r.post('/api/destinations/:id/test', async ({ url, params: p }) => {
    admin();
    return json(await service.testDestination({ ...params(url), ...(await body()), id: p.id }));
  });
  r.post('/api/destinations/:id/retry', async ({ url, params: p }) => {
    admin();
    return json(await service.retryDestination({ ...params(url), ...(await body()), id: p.id }));
  });

  r.get('/api/transformations', async ({ url }) =>
    json(await service.listTransformations(params(url))),
  );
  r.post('/api/transformations/test', async ({ url }) =>
    json(await service.testTransformation({ ...params(url), ...(await body()) })),
  );
  r.post('/api/transformations', async ({ url }) => {
    admin();
    return json(await service.saveTransformation({ ...params(url), ...(await body()) }), {
      status: 201,
    });
  });
  r.put('/api/transformations/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.saveTransformation({ ...params(url), ...(await body()), id: p.id }));
  });
  r.delete('/api/transformations/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteTransformation({ ...params(url), id: p.id }));
  });

  r.get('/api/exports', async ({ url }) => json(await service.listExports(params(url))));
  r.post('/api/exports', async ({ url }) => {
    admin();
    return json(await service.saveExport({ ...params(url), ...(await body()) }), { status: 201 });
  });
  r.put('/api/exports/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.saveExport({ ...params(url), ...(await body()), id: p.id }));
  });
  r.delete('/api/exports/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteExport({ ...params(url), id: p.id }));
  });
  r.get('/api/exports/:id/runs', async ({ url, params: p }) =>
    json(await service.exportRuns({ ...params(url), id: p.id })),
  );
  r.post('/api/exports/:id/backfill', async ({ url, params: p }) => {
    admin();
    return json(await service.backfillExport({ ...params(url), ...(await body()), id: p.id }));
  });

  r.get('/api/issues', async ({ url }) => json(await service.listIssues(params(url))));
  r.get('/api/issues/:id', async ({ url, params: p }) =>
    json(await service.getIssue({ ...params(url), id: p.id })),
  );
  r.patch('/api/issues/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.updateIssue({ ...params(url), ...(await body()), id: p.id }));
  });
  r.post('/api/issues/:id/merge', async ({ url, params: p }) => {
    admin();
    return json(await service.mergeIssues({ ...params(url), ...(await body()), into: p.id }));
  });
  // Source maps: the raw map as the body, `release` and `path` (the minified file's served path)
  // in the query. The server key can upload, so a CI job doesn't need the admin key.
  r.put('/api/sourcemaps', async ({ url }) => {
    server();
    const q = params(url);
    const text = await request.text();
    return json(
      await service.uploadSourcemap(
        q.project as string | undefined,
        String(q.release ?? ''),
        String(q.path ?? ''),
        text,
      ),
      {
        status: 201,
      },
    );
  });
  r.get('/api/sourcemaps', async ({ url }) => json(await service.listSourcemaps(params(url))));
  r.delete('/api/sourcemaps', async ({ url }) => {
    server();
    return json(await service.deleteSourcemaps(params(url)));
  });

  r.get('/api/groups/types', async ({ url }) => json(await service.listGroupTypes(params(url))));
  r.put('/api/groups/types/:type', async ({ url, params: p }) => {
    admin();
    return json(await service.setGroupType({ ...params(url), ...(await body()), type: p.type }));
  });
  r.get('/api/groups', async ({ url }) => json(await service.searchGroups(params(url))));
  r.get('/api/groups/:type/:key', async ({ url, params: p }) =>
    json(await service.getGroup({ ...params(url), type: p.type, key: p.key })),
  );
  r.patch('/api/groups/:type/:key', async ({ url, params: p }) => {
    admin();
    return json(
      await service.setGroupProperties({
        ...params(url),
        ...(await body()),
        type: p.type,
        key: p.key,
      }),
    );
  });
  r.delete('/api/groups/:type/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteGroup({ ...params(url), type: p.type, key: p.key }));
  });

  r.get('/api/stripe', async ({ url }) => json(await service.stripeStatus(params(url))));
  r.post('/api/stripe', async ({ url }) => {
    admin();
    return json(await service.connectStripe({ ...params(url), ...(await body()) }));
  });
  r.delete('/api/stripe', async ({ url }) => {
    admin();
    return json(await service.disconnectStripe(params(url)));
  });
  r.post('/api/fx-rates', async () => {
    admin();
    return json(await service.importFxRates(await readJson(request, 5_000_000)));
  });

  r.get('/api/settings', async ({ url }) => json(await service.getSettings(params(url))));
  r.get('/api/paths/suggest-rules', async ({ url }) =>
    json(await service.suggestPathRules(params(url))),
  );
  r.patch('/api/settings', async ({ url }) => {
    admin();
    return json(await service.updateSettings({ ...params(url), ...(await body()) }));
  });

  r.get('/api/projects', async () => json(await service.listProjects()));
  r.post('/api/projects', async () => {
    admin();
    return json(await service.createProject(await body()), { status: 201 });
  });

  r.get('/api/projects/:id/policy', async ({ params: p }) =>
    json(await service.getProjectPolicy({ project: p.id })),
  );
  r.put('/api/projects/:id/policy', async ({ params: p }) => {
    admin();
    return json(await service.setProjectPolicy({ ...(await body()), project: p.id }));
  });
  r.get('/api/projects/:id/audit', async ({ url, params: p }) => {
    admin();
    return json(await service.auditLog({ ...params(url), project: p.id }));
  });

  r.get('/api/overview', async ({ url }) => json(await service.overview(params(url))));
  r.get('/api/sites', async ({ url }) => json(await service.sites(params(url))));
  r.post('/api/query', async () => {
    const { kind, ...spec } = await body();
    return json(await service.runInsight(String(kind ?? ''), spec));
  });
  r.post('/api/sql', async () => json(await service.sql(await body())));

  r.get('/api/events', async ({ url }) => json(await service.listEvents(params(url))));
  r.get('/api/events/:name', async ({ url, params: p }) =>
    json(await service.describeEvent({ ...params(url), event: p.name })),
  );
  r.put('/api/events/:name', async ({ params: p }) => {
    admin();
    return json(await service.defineEvent({ ...(await body()), event: p.name }));
  });

  r.get('/api/properties/values', async ({ url }) =>
    json(await service.propertyValues(params(url))),
  );
  r.get('/api/person-properties', async ({ url }) =>
    json(await service.listPersonProperties(params(url))),
  );

  r.get('/api/persons', async ({ url }) => json(await service.searchPersons(params(url))));
  r.get('/api/persons/:id', async ({ url, params: p }) =>
    json(await service.getPerson({ ...params(url), person_id: p.id })),
  );
  r.patch('/api/persons/:id', async ({ params: p }) => {
    admin();
    const b = await body();
    return json(
      await service.setPersonProperties({
        project: b.project,
        person_id: p.id,
        properties: b.properties ?? b,
      }),
    );
  });
  r.delete('/api/persons/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.deletePerson({ ...params(url), person_id: p.id }));
  });

  r.get('/api/cohorts', async ({ url }) => json(await service.listCohorts(params(url))));
  r.post('/api/cohorts/count', async () => json(await service.countCohort(await body())));
  r.post('/api/cohorts', async () => {
    admin();
    return json(await service.saveCohort(await body()), { status: 201 });
  });
  r.delete('/api/cohorts/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteCohort({ ...params(url), key: p.key }));
  });
  r.get('/api/cohorts/:key/members', async ({ url, params: p }) => {
    const result = await service.cohortMembers({ ...params(url), key: p.key });
    return csvOrJson(result, `cohort-${p.key}.csv`);
  });
  r.patch('/api/cohorts/:key/members', async ({ url, params: p }) => {
    admin();
    return json(await service.editCohortMembers({ ...params(url), ...(await body()), key: p.key }));
  });
  r.post('/api/cohorts/:key/duplicate', async ({ url, params: p }) => {
    admin();
    return json(await service.duplicateCohort({ ...params(url), ...(await body()), key: p.key }), {
      status: 201,
    });
  });

  r.get('/api/insights', async ({ url }) => json(await service.listInsights(params(url))));
  r.get('/api/insights/:key', async ({ url, params: p }) =>
    json(await service.getInsight({ ...params(url), key: p.key })),
  );
  r.post('/api/insights', async () => {
    admin();
    return json(await service.saveInsight(await body()), { status: 201 });
  });
  r.delete('/api/insights/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteInsight({ ...params(url), key: p.key }));
  });

  // Dashboards, scheduled reports and alerts.
  const read = (path: string, run: (input: Record<string, unknown>) => Promise<unknown>) =>
    r.get(path, async ({ url, params: p }) => json(await run({ ...params(url), ...p })));
  const write = (
    method: 'post' | 'put' | 'delete',
    path: string,
    run: (input: Record<string, unknown>) => Promise<unknown>,
    status = 200,
  ) =>
    r[method](path, async ({ url, params: p }) => {
      admin();
      const input = method === 'delete' ? {} : ((await body()) as Record<string, unknown>);
      return json(await run({ ...params(url), ...input, ...p }), { status });
    });
  read('/api/capabilities', (i) => service.capabilities(i));
  read('/api/dashboards', (i) => service.listDashboards(i));
  read('/api/dashboards/templates', (i) => service.dashboardTemplates(i));
  read('/api/dashboards/:id', (i) => service.getDashboard(i));
  write('post', '/api/dashboards', (i) => service.saveDashboard(i), 201);
  write(
    'post',
    '/api/dashboards/from-template',
    (i) => service.createDashboardFromTemplate(i),
    201,
  );
  write('put', '/api/dashboards/:id', (i) => service.saveDashboard(i));
  write('delete', '/api/dashboards/:id', (i) => service.deleteDashboard(i));
  write('post', '/api/dashboards/:id/duplicate', (i) => service.duplicateDashboard(i), 201);
  write('post', '/api/dashboards/:dashboard/tiles', (i) => service.addDashboardTile(i), 201);
  write('put', '/api/dashboards/:dashboard/order', (i) => service.reorderDashboardTiles(i));
  write('put', '/api/dashboards/:dashboard/tiles/:tile', (i) => service.updateDashboardTile(i));
  write('delete', '/api/dashboards/:dashboard/tiles/:tile', (i) => service.removeDashboardTile(i));
  read('/api/subscriptions', (i) => service.listSubscriptions(i));
  write('post', '/api/subscriptions', (i) => service.saveSubscription(i), 201);
  write('put', '/api/subscriptions/:id', (i) => service.saveSubscription(i));
  write('delete', '/api/subscriptions/:id', (i) => service.deleteSubscription(i));
  write('post', '/api/subscriptions/:id/send', (i) => service.sendSubscriptionNow(i));
  read('/api/alerts', (i) => service.listAlerts(i));
  read('/api/alerts/:id', (i) => service.getAlert(i));
  write('post', '/api/alerts', (i) => service.saveAlert(i), 201);
  write('put', '/api/alerts/:id', (i) => service.saveAlert(i));
  write('delete', '/api/alerts/:id', (i) => service.deleteAlert(i));
  write('post', '/api/alerts/:id/check', (i) => service.checkAlertNow(i));

  r.put('/api/events/:name/role', async ({ url, params: p }) => {
    admin();
    return json(await service.markEvent({ ...params(url), ...(await body()), event: p.name }));
  });
  r.post('/api/reports/conversions', async ({ url }) =>
    json(await service.reportConversions({ ...params(url), ...(await body()) })),
  );
  r.post('/api/reports/sources', async ({ url }) =>
    json(await service.reportSources({ ...params(url), ...(await body()) })),
  );
  r.post('/api/reports/health', async ({ url }) =>
    json(await service.reportHealth({ ...params(url), ...(await body()) })),
  );
  r.get('/api/usage', async ({ url }) => json(await service.usage(params(url))));

  r.get('/api/replays', async ({ url }) => json(await service.listReplays(params(url))));
  r.get('/api/replays/analyse', async ({ url }) => json(await service.analyseReplays(params(url))));
  r.get('/api/replays/:id/summary', async ({ url, params: p }) =>
    json(await service.summariseReplay({ ...params(url), session_id: p.id })),
  );
  r.get('/api/replays/:id/events', async ({ url, params: p }) =>
    json(await service.replayEvents({ ...params(url), session_id: p.id })),
  );
  r.get('/api/replays/:id/snapshot', async ({ url, params: p }) =>
    json(await service.replaySnapshot({ ...params(url), session_id: p.id })),
  );
  r.post('/api/replays/:id/notes', async ({ url, params: p }) => {
    admin();
    return json(
      await service.annotateReplay({ ...params(url), ...(await body()), session_id: p.id }),
      { status: 201 },
    );
  });
  r.delete('/api/replays/:id/notes/:note', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteReplayNote({ ...params(url), session_id: p.id, id: p.note }));
  });

  r.get('/api/flags', async ({ url }) => json(await service.listFlags(params(url))));
  r.get('/api/flags/definitions', async ({ url, request: req }) => {
    server();
    return withEtag(req, await service.flagDefinitions(params(url)));
  });
  r.get('/api/flags/schedules', async ({ url }) => json(await service.flagSchedules(params(url))));
  r.delete('/api/flags/schedules/:id', async ({ url, params: p }) => {
    admin();
    return json(await service.cancelFlagSchedule({ ...params(url), id: p.id }));
  });
  r.post('/api/flags/evaluate', async ({ url }) =>
    json(await service.evaluateFlags({ ...params(url), ...(await body()) })),
  );
  r.get('/api/flags/:key/history', async ({ url, params: p }) =>
    json(await service.flagHistory({ ...params(url), key: p.key })),
  );
  r.get('/api/flags/:key/usage', async ({ url, params: p }) =>
    json(await service.flagUsage({ ...params(url), key: p.key })),
  );
  r.post('/api/flags/:key/schedule', async ({ url, params: p }) => {
    admin();
    return json(await service.scheduleFlag({ ...params(url), ...(await body()), key: p.key }), {
      status: 201,
    });
  });
  r.get('/api/flags/:key', async ({ url, params: p }) =>
    json(await service.getFlag({ ...params(url), key: p.key })),
  );
  r.put('/api/flags/:key', async ({ params: p }) => {
    admin();
    return json(await service.saveFlag({ ...(await body()), key: p.key }));
  });
  r.delete('/api/flags/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteFlag({ ...params(url), key: p.key }));
  });

  r.get('/api/experiments', async ({ url }) => json(await service.listExperiments(params(url))));
  r.post('/api/experiments', async () => {
    admin();
    return json(await service.createExperiment(await body()), { status: 201 });
  });
  r.post('/api/experiments/plan', async ({ url }) =>
    json(await service.planExperiment({ ...params(url), ...(await body()) })),
  );
  r.patch('/api/experiments/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.editExperiment({ ...params(url), ...(await body()), key: p.key }));
  });
  r.post('/api/experiments/:key/duplicate', async ({ url, params: p }) => {
    admin();
    return json(
      await service.duplicateExperiment({ ...params(url), ...(await body()), key: p.key }),
      { status: 201 },
    );
  });
  r.get('/api/holdouts', async ({ url }) => json(await service.listHoldouts(params(url))));
  r.put('/api/holdouts/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.saveHoldout({ ...params(url), ...(await body()), key: p.key }));
  });
  r.delete('/api/holdouts/:key', async ({ url, params: p }) => {
    admin();
    return json(await service.deleteHoldout({ ...params(url), key: p.key }));
  });
  r.get('/api/holdouts/:key/results', async ({ url, params: p }) =>
    json(await service.holdoutResults({ ...params(url), key: p.key })),
  );
  r.get('/api/experiments/:key', async ({ url, params: p }) =>
    json(await service.experimentResults({ ...params(url), key: p.key })),
  );
  r.post('/api/experiments/:key/:action', async ({ url, params: p }) => {
    admin();
    const b = await body();
    return json(
      await service.updateExperiment({ ...params(url), ...b, key: p.key, action: p.action }),
    );
  });

  r.get('/api/instrument', ({ url }) => json(service.instrument(params(url))));
  return r;
}
