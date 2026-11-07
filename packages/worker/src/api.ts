/**
 * The JSON API under `/api`. Every route is a thin wrapper over GlassService;
 * agents can discover everything from `GET /api`.
 */

import { experimentSpec, filterSchema, INSIGHTS, sqlSpec } from '@dataflare/core/insights';
import { GLASS_VERSION } from '@dataflare/core/version';
import { z } from 'zod/v4';
import { requireScope, type Scope } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, Router, readJson } from './http.ts';
import { TOOLS } from './mcp/tools.ts';
import type { GlassService } from './service.ts';

const NUMERIC = new Set(['days', 'limit']);
const BOOLEAN = new Set(['with_errors', 'compare']);

/** Query string → plain object, converting the few numeric/boolean parameters. */
function params(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    out[key] = NUMERIC.has(key) ? Number(value) : BOOLEAN.has(key) ? value === 'true' : value;
  }
  return out;
}

export function apiRouter(service: GlassService, env: Env, request: Request): Router {
  const scope: Scope = requireScope(request, env, 'read');
  const admin = () => {
    if (scope !== 'admin') throw new HttpError(403, 'This action needs the admin key');
  };
  const body = () => readJson<Record<string, unknown>>(request);
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
      endpoints: {
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
        'PUT /api/flags/:key': 'Create/update a flag (admin)',
        'DELETE /api/flags/:key': 'Delete a flag (admin)',
        'GET /api/experiments': 'Experiments',
        'POST /api/experiments': 'Create an experiment (admin)',
        'GET /api/experiments/:key': 'Experiment with results',
        'POST /api/experiments/:key/start|stop|ship': 'Change experiment state (admin)',
        'GET /api/projects': 'Projects',
        'POST /api/projects': 'Create a project (admin)',
        'GET /api/instrument?event=&framework=': 'Tracking code for an event',
      },
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

  r.get('/api/projects', async () => json(await service.listProjects()));
  r.post('/api/projects', async () => {
    admin();
    return json(await service.createProject(await body()), { status: 201 });
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
