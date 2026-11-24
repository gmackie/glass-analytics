# Contributing to Dataflare

Thanks for helping. This guide gets you from clone to pull request, and shows where each kind of change lives.

## Set up

You need Node 26.13+ and pnpm 12. You do **not** need a Cloudflare account to work on Dataflare.

```sh
git clone https://github.com/ISNIT0/glass-analytics && cd glass-analytics
pnpm install
pnpm build          # SDK, dashboard, Worker and CLI, about two seconds
pnpm test           # unit and integration tests
pnpm dev            # Dataflare on http://localhost:8787, a demo site on http://localhost:8788
```

`pnpm dev` runs the real Worker code on Node: D1 is a SQLite file and R2 is a folder, both in `.glass-dev/`. Open the demo site, click around, then open `http://localhost:8787/app` and sign in with `dev-admin-key`. To run on Cloudflare's actual runtime instead, use `pnpm dev:wrangler`.

| Command                     | What it does                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`            | TypeScript, strict, across every package                                                                                                |
| `pnpm lint` / `pnpm format` | oxlint lints; Biome formats (`pnpm format:check` checks formatting)                                                                     |
| `pnpm test`                 | `node:test` suites in `packages/*/test`                                                                                                 |
| `pnpm test:e2e`             | Builds, then drives the demo site in Chromium with Playwright and checks the API and dashboard (`npx playwright install chromium` once) |
| `pnpm check`                | typecheck + lint + knip + test + quality, what CI runs first                                                                            |
| `pnpm quality`              | Tests with coverage, then the coverage and complexity ratchet against `quality-baseline.json` (see AGENTS.md)                           |
| `pnpm quality:hotspots`     | The most complex, least tested code: good places to improve                                                                             |
| `pnpm knip`                 | Unused files, dependencies and exports                                                                                                  |
| `pnpm size`                 | Bundle sizes against their budgets (after `pnpm build`)                                                                                 |
| `pnpm mutation`             | Mutation testing (`--changed origin/main` for your changes)                                                                             |

Tests use Node's built-in runner and Node's TypeScript type stripping, so there is no test framework to learn: `node --test packages/core/test/insights.test.ts` runs one file.

## How the repository is laid out

```
packages/
  core/        Pure logic shared by everything: the event model, SQL dialects and
               compilers (trends, funnels, retention, web, experiments), stats,
               flag evaluation, replay summaries, framework snippets. No I/O.
  web/         The browser SDK (dataflare-web) and the replay recorder (replay.js).
  worker/      The Cloudflare Worker: ingest, API, MCP server, flags, replay storage,
               the dashboard's host. migrations/ holds the D1 schema.
  dashboard/   The dashboard: dependency-free TypeScript, bundled into the Worker.
  cli/         The `glass` CLI: init, upgrade, status, queries, and the MCP stdio bridge.
site/          The landing page (static) and its llms.txt.
docs/          User documentation.
e2e/           Browser end-to-end tests.
examples/      The demo site used by `pnpm dev` and the e2e tests.
scripts/       The build.
```

Dependencies point one way: `core` ← `web`, `worker`, `dashboard`, `cli`. `core` never imports from the others, and nothing in `core` touches the network, Cloudflare bindings or the DOM.

## Where to make common changes

**A new query type** (e.g. paths, stickiness, lifecycle). Write `packages/core/src/insights/<kind>.ts` exporting a zod schema and a `run(spec, ctx)` that compiles SQL with `eventsCte()` and shapes the rows. Register it in `packages/core/src/insights/index.ts`. That's all it takes to get `POST /api/query`, a `query_<kind>` MCP tool and `dataflare query <kind> --spec …`. Add tests in `packages/core/test/` that execute the SQL on SQLite, and a dashboard view if it needs one.

**A new MCP tool.** Add a service method in `packages/worker/src/service.ts` (validated with zod), an entry in `packages/worker/src/mcp/tools.ts`, and usually an HTTP route in `api.ts`. Tool descriptions are what agents read: say what the tool is for and when to use it.

**A new storage engine** (ClickHouse, Tinybird, DuckDB, Postgres…). Implement `Dialect` (`packages/core/src/sql/dialect.ts`, a dozen small functions) and `EventStore` (`packages/worker/src/stores/types.ts`). See [docs/extending.md](docs/extending.md).

**A framework snippet.** Add an entry to `FRAMEWORKS` and a detection rule in `packages/core/src/instrument.ts`.

**Enriching events at ingest.** `packages/worker/src/ingest.ts` is a documented pipeline (parse, admit, validate, identity, resolve, enrich, write). Add a step there with a test in `packages/worker/test/app.test.ts`.

**A schema change.** Add a new numbered file in `packages/worker/migrations/`; never edit one that has shipped. If events gain a column, the lake's stream schemas (`packages/core/src/lake.ts`) need a versioned migration too, because Pipelines streams can't be altered.

## Principles

- **Agents are first-class users.** Every capability ships as a service method that the API, MCP tools and CLI all call. Error messages say what to do next (`HttpError` takes a `hint`).
- **Show the working.** Query results include the SQL that ran and a dashboard link.
- **SQL stays portable.** Compilers use integer `ts_ms` arithmetic and the `Dialect` interface, so the SQLite tests cover the lake as well. If you need an engine-specific function, add it to `Dialect`.
- **Few dependencies.** The Worker depends on zod and nothing else; the SDK depends on nothing. Adding a runtime dependency needs a reason in the PR description.
- **Budgets.** The script-tag SDK must stay under 6 KB gzipped (`pnpm build` prints sizes). The dashboard ships inside the Worker, so keep it lean too.
- **Privacy by default.** Inputs are masked in replays, no IP addresses are stored, and nothing loads from third parties.

## Code style

oxlint lints (`pnpm lint`, rules in `.oxlintrc.json`) and Biome formats (`pnpm format`). TypeScript is strict, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly` (no enums or parameter properties, so Node can run sources directly). Import local files with their `.ts` extension. Prefer small pure functions with a doc comment that explains _why_, not _what_.

## Pull requests

1. Open an issue first for anything large, so we can agree on the approach.
2. Keep PRs focused; include tests for behaviour changes.
3. Run `pnpm check` (and `pnpm test:e2e` if you touched the SDK, ingest or dashboard).
4. Add a changeset if your change affects a published package (`glass` or `dataflare-web`): `pnpm changeset`.
5. Fill in the PR template, including how you tested it.

We squash-merge, with the PR title as the commit message.

## Releasing (maintainers)

Changesets collects changes. Releases are automatic: when a push to `main` carries a changeset, the release workflow versions the packages (`pnpm version-packages`), commits that to `main`, runs the checks, publishes `dataflare` and `dataflare-web` to npm, tags the release and creates a GitHub release from the changelog. Pushes without a changeset release nothing. `GLASS_VERSION` in `packages/core/src/version.ts` must match the CLI version (`pnpm build` fails if they drift); the dashboard and `dataflare status` compare the deployed Worker to the latest CLI on npm.

## Getting help

Ask in a GitHub Discussion or open an issue. Security problems: see [SECURITY.md](SECURITY.md). Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
