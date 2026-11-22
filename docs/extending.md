# Extending Dataflare

Dataflare is built from small registries so the common extensions are one file each. Every example here has a test pattern next to it in the repository.

## Add a query type

1. Create `packages/core/src/insights/stickiness.ts`:

   ```ts
   import { z } from 'zod/v4';
   import { eventsCte, num } from '../sql/source.ts';
   import { iso, resolveRange } from '../time.ts';
   import type { QueryContext, ResultBase } from './types.ts';

   export const stickinessSpec = z.object({
     project: z.string().optional(),
     from: z.union([z.string(), z.number()]).optional(),
     to: z.union([z.string(), z.number()]).optional(),
     event: z.string().describe('The event to measure.'),
   });

   export async function runStickiness(spec: z.infer<typeof stickinessSpec>, ctx: QueryContext): Promise<ResultBase & { days: { days: number; people: number }[] }> {
     const range = resolveRange(spec.from, spec.to, ctx.now);
     const d = ctx.dialect;
     const sql = `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [spec.event] })} …`;
     const rows = await ctx.execute(sql);
     return { kind: 'stickiness', sql: [sql], range: { from: iso(range.from), to: iso(range.to) }, summary: '…', days: rows.map((r) => ({ days: num(r.days), people: num(r.n) })) };
   }
   ```

2. Register it in `packages/core/src/insights/index.ts`:

   ```ts
   stickiness: define({ description: 'How many days people did an event.', schema: stickinessSpec, run: runStickiness }),
   ```

You now have `POST /api/query {"kind":"stickiness"}`, an MCP tool `query_stickiness` and `dataflare query stickiness --spec '…'`. For a dashboard editor, add a rail and a view for the kind in `pages/insights.ts` (see `paths-rail.ts` and `paths-view.ts`). Write tests in `packages/core/test/` that insert events with `insert()` and execute your SQL on SQLite (see `insights.test.ts`).

Rules for portable SQL: start from `eventsCte()` (it scopes to the project and range, and resolves people as `pid`); use `ts_ms` integer arithmetic or `bucketExpr()` for time; filters via `filtersSql()`; anything engine-specific goes in `Dialect`.

## Add an MCP tool

Add a method to `GlassService` (`packages/worker/src/service.ts`) that validates its input with zod and returns a plain object with a `summary`. Then add an entry to `TOOLS` in `packages/worker/src/mcp/tools.ts`:

```ts
{
  name: 'list_cohorts',
  title: 'List cohorts',
  description: 'Saved groups of people, with their definitions and sizes.',
  input: inputs.listCohorts,
  scope: 'read',
  run: (s, a) => s.listCohorts(a),
},
```

Add an HTTP route in `packages/worker/src/api.ts` and a CLI command if people will want it from a terminal. Test through `testApp()` in `packages/worker/test/app.test.ts`, which runs the real Worker on SQLite.

## Add a storage engine

Implement two interfaces:

- `Dialect` (`packages/core/src/sql/dialect.ts`): literals, JSON access, month arithmetic and table names for your engine.
- `EventStore` (`packages/worker/src/stores/types.ts`): `write(events)`, `writeIdentity(link)`, `query(sql)`, `deletePersonEvents(project, ids)`.

Then select it in `createStore()` (`packages/worker/src/app.ts`) from an environment variable, and add a provisioning step to `dataflare init` if it needs resources. Run the core insight tests against your dialect if your engine can run locally (DuckDB and ClickHouse both can).

## Add a framework snippet

Add an entry to `FRAMEWORKS` and a detection rule in `detectFramework()` (`packages/core/src/instrument.ts`). `dataflare init` and the `instrument` tool pick it up automatically.

## Enrich events at ingest

`toRows()` in `packages/worker/src/ingest.ts` is the enrichment step. Add a column through a new migration (and `EVENT_COLUMNS`, and the lake schema), or add derived values to `props`. Keep ingest fast: it runs on every request.

## Change the dashboard

Pages are functions from a route to DOM nodes (`packages/dashboard/src/pages/`), built with `h()` from `dom.ts`. Add a page to `PAGES` in `main.ts`. Wrap anything that shows numbers in `panel(…, { sql })` so "Show SQL" works.
