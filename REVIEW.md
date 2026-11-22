# deepen-coverage: review notes (delete before merging)

Branch `deepen-coverage`, off `origin/main` (0.8.4). Nothing pushed, released or deployed.
Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test` (lake conformance needs `uv`).

## Done (one commit each)

- **Foundations**: `/api/import` (keeps old timestamps; public `/e` still clamps to 7 days),
  per-key props truncation, server key (derived from the admin key; `dataflare key --server`),
  project settings (migration 0008), DST-aware IANA time zones, `filterTestAccounts`,
  5-minute cron + task registry, group storage (`$groups`, `$groupidentify`, migration 0009),
  `aggregateBy` (person / session / group), safe formula parser.
- **Trends**: dau/wau/mau, first_time, unique_groups, min/max/median/p75–p99 (1% sketch),
  per-actor count stats, multi-event series, formulas, cumulative/smoothing/trend line,
  compare, numeric bins, cohort breakdowns, minute interval, display options; `list_actors`
  drill-down (+CSV), annotations (migration 0010).
- **Funnels**: best attempt per actor, ordered/strict/unordered, exclusions, optional steps,
  breakdown attribution, median times, time-to-convert and trends views, drill-down,
  `funnel_correlation`.
- **Retention**: recurring, cumulative, breakdowns, hourly, any event, simple mean, drill-down.
- **Cohorts**: behavioural condition groups, nested cohorts, static cohorts, members/CSV,
  freeze, save selection as cohort, flag targeting via materialised membership (migration 0011).
- **Flags + dataflare-node**: payloads, `flag.<key>` dependencies, bucketBy person/group,
  early access, bootstrap/overrides, debug reasons, history + schedules (migration 0012),
  usage, local-evaluation definitions; Node SDK with local evaluation checked against `/f`.
- **Experiments**: metric kinds conversion/mean/ratio/funnel/retention, Bayesian +
  frequentist, probability to be best, winsorising, minimum runtime/exposures, timeline,
  secondary metrics computed (old `goal` form still works); lifecycle pause/resume/reset/
  archive/duplicate, holdouts (migration 0013; flags return `"holdout"`, which the SDKs treat
  as off), `plan_experiment` running-time calculator, web-experiment transforms applied by the
  SDK. Stats checked against SciPy reference values.
- **Destinations, transformations, exports, import**: 16 destination templates (webhook, Slack,
  Discord, Teams, Meta CAPI, GA4, TikTok, Customer.io, Loops, HubSpot, Mixpanel, Amplitude,
  PostHog, Zapier, Make, n8n) delivered through Cloudflare Queues with a D1 outbox fallback,
  backoff, failure logs, retry and test sends; AES-GCM encrypted secrets; ingest
  transformations (drop event, drop/rename/set/hash properties, redact); hourly/daily batch
  exports to S3/R2 (SigV4), BigQuery and HTTP NDJSON with backfill (migration 0014);
  `dataflare import` with PostHog/Mixpanel/Amplitude/Segment/GA4 presets; `init`/`upgrade`
  create the queue and its dead-letter queue and fall back to the outbox when the token can't;
  queue operations in `usage_and_cost`. Exports are checked against DataFusion in the lake
  conformance suite.

- **Error tracking**: `captureException` and `release` in both SDKs (`data-release` on the
  script tag); Chrome/V8, Firefox and Safari stack parsing; fingerprints from type, message
  with variable parts removed, and top three in-app frames (bundle hashes and minified names
  ignored, `$fingerprint` overrides); issues in D1 with `$issue_id` on every exception (so the
  lake groups by issue too); resolve/suppress/assign/merge, regressions, a per-issue minute
  limit; alerts for new issues, regressions and spikes through a destination; source map
  upload (`dataflare sourcemaps upload`, `PUT /api/sourcemaps`, server key allowed) with an
  in-house VLQ decoder checked against esbuild, symbolication at read time with code context;
  `list_issues`, `get_issue`, `update_issue`, `merge_issues`, `list_sourcemaps`;
  `site_health` lists top issues (migration 0015). Issue reads are checked against DataFusion.

- **Revenue**: revenue events (settings) and Stripe events are normalised at ingest to
  `$revenue_base` in the base currency with the day's ECB rates (fetched by maintenance; older
  ones with `dataflare revenue rates`), plus `$subscription_id`/`$mrr` for recurring revenue.
  Stripe: signed webhook `POST /hooks/stripe/<project>` (invoices, one-off charges, refunds,
  subscription changes; payments keyed on the Stripe object so retries and imports
  de-duplicate), customers linked to people by metadata or email (email not stored), accounts
  via a group type; `connect_stripe`/`stripe_status`; `dataflare stripe import` for history.
  New `revenue` kind (`query_revenue`): gross, refunds, net, orders, customers, ARPU, MRR/ARR
  with new/expansion/contraction/churned/reactivated, revenue and customer churn, LTV, by
  product, first-touch channel/UTM or any property, top customers or accounts. Sources report
  adds revenue per first touch; person detail adds lifetime revenue (migration 0016). Revenue
  reads are checked against DataFusion.

- **Dashboard** (Phase 10). Every page added or deepened was checked in screenshots: light,
  dark and 390 px mobile, plus empty-project states. `scripts/ui-smoke.ts` (run it with an
  output folder) fails on console errors, HTTP errors and cards closer than 8 px.
  - New pages: Errors (and issue), Revenue, Groups (and group), Pipelines (destinations,
    transformations, exports, imports), Settings › project settings and Stripe.
  - Insights:
    - every trends maths, formulas, compare, cumulative and smoothing;
    - eight displays (line, area, bar, number, bars by total, table, pie, world map);
    - trend line, log scale, 100% stack and value labels;
    - minute buckets, cohort and numeric-range breakdowns, notes on charts;
    - the internal-traffic toggle and "count by";
    - funnel order, exclusions, optional steps, attribution, views and correlation;
    - retention type, hours, any event, per-breakdown tabs, and people behind every cell.
  - People: the cohort editor (all condition kinds, nested groups, static lists from paste or
    CSV, members, CSV, duplicate), and a person's groups and lifetime revenue.
  - Flags: payloads, targeting, schedules, history, usage and early access.
  - Experiments: metric editors, engine and confidence, holdouts, planning, web-experiment
    changes, lifecycle actions, all-metrics table and timeline.
- **Docs**: queries, sdk, experiments, privacy, architecture, agents (97 tools), ROADMAP; new
  errors, revenue, destinations and node-sdk pages; llms.txt and the agent skill.
- **Site**: comparison pages and README; Plausible and Umami facts re-checked on 2026-11-18;
  screenshots and public demo regenerated (`pnpm site:assets`), with revenue, groups and a
  behavioural cohort in the demo data.
- **Checks**:
  - `pnpm test`: 475 tests, including 112 lake-conformance checks against DataFusion.
  - `pnpm test:e2e`: 13 tests, including payloads, web experiments, overrides, bootstrap,
    early access and captureException in a real browser.
  - Coverage: 94.0% of lines, 79.0% of branches.
  - MCP smoke: 24 new tools called over `/mcp` against the demo data, all fine.
  - Upgrade dry run on a copy of yourtypeis's `.glass/` (dummy credentials, nothing
    deployed): stages 0.8.3 → 0.8.4 with migrations 0006–0017. The only difference from
    main's staging is the cron (`17 * * * *` → `*/5 * * * *`).

## Commits

```
e9926f5 Coverage review: CRM templates, CLI data and flag commands, and a fix
68d228a Site and README: the new depth, and current Umami and Plausible facts
d4991a3 Docs for everything on the branch
1fd278d e2e: SDK features in a real browser
41d4607 Notice variants through a colour variable, without new icon selectors
7f98835 Pipelines: an Imports tab that imports files from the browser
4b01123 Insights: every display, notes on charts, cohort and numeric breakdowns, correlation
4e5f69c Fix missing gaps between cards, and check for them on every page
93b7236 People: full cohort editor, members, and a person's groups and revenue
5d3f6d6 Experiments at full depth in the dashboard; steadier lift numbers
a80ce5c Rich editors for configuration; flags at full depth in the dashboard
236e42b Dashboard: errors, revenue, groups, pipelines, settings, deeper insights
e573d82 Group tools, group erasure, and group analytics on the lake
1dfee5b Revenue analytics: currencies, Stripe and MRR
6acd5e8 Error tracking: issues, alerts and source maps
4c28a88 Destinations, transformations, batch exports and import
06a0bce Experiments: stored metrics, full lifecycle, holdouts, planning, web experiments
21a27d8 Experiments core: metric kinds, both engines, probability to be best
3966f88 Feature flags at PostHog depth, and the dataflare-node server SDK
f21868b Cohorts at PostHog depth
44d64cf Retention at PostHog depth
6a29ce0 Funnels at PostHog depth, and funnel correlation
547e4f1 Trends at PostHog depth, drill-down to actors, annotations
77e8a8c Foundations: import, server key, project settings, time zones, groups, 5-minute cron
```

## Known limits

- Web experiments have no visual editor: changes are CSS selectors plus text, HTML, style or
  attributes.
- The world map is Natural Earth 1:110m. Countries too small for it (Singapore, Malta…) are
  listed under the map, not drawn.
- Minute buckets only for ranges up to two days. Numeric-range breakdowns are offered only
  for properties the catalog has seen as numbers.
- Funnel correlation runs on demand (a button), since it reads every event of everyone in the
  funnel.
- Imports in the browser take files up to 50 MB; bigger ones go through the CLI.
- Not in scope: paths, stickiness, lifecycle, heatmaps, multi-chart dashboards, alerts on any
  insight, surveys, users/RBAC/SSO, mobile SDKs.

## Decisions to confirm

- Groups live in `props.$groups` / `props.$group_props` rather than new columns, so no lake
  schema version is needed.
- Static cohorts in lake mode are inlined (up to 10,000 people) instead of a new Pipelines stream.
- Server and encryption keys are derived from existing secrets (CI upgrades can't add secrets).
- Cohorts may now reference other cohorts (loop-checked), reversing the 2026-11-04 decision.
- Script-tag SDK grew to about 5.9 KB gzipped; README and sdk.md now say "about 6 KB".
- Destination work per invocation is capped for the Free plan's 50 subrequests: queue batches
  of 25, 20 outbox deliveries per 5-minute tick, 10 export requests per tick (2,000 rows a page).
- A failing after-write hook (e.g. the queue is over quota) logs and moves on: the events are
  already stored, so `/e` still succeeds and the delivery goes to the outbox.
- Phone numbers for ad platforms drop a "(0)" and "00" prefix; Meta gets digits, TikTok E.164
  with "+"; an optional `phoneCountryCode` input fixes national numbers.
- Error fingerprints are computed at ingest from unsymbolicated frames (symbolicating at ingest
  would not fit the Free plan's 10 ms CPU), so frames are keyed on file (hash stripped) and
  function name (minified names ignored). Two builds can still split an issue when the
  top frames' real names change; merging covers that.
- The per-issue rate limit is counted per Worker isolate (free, approximate), not globally.
- An exception that happened before its issue was resolved (a late batch) doesn't reopen it.
- MRR comes from subscription state (Stripe subscription events, or payments of a revenue event
  with `subscriptionProperty`, where no payment within 35/370 days counts as churned). Trials
  are not MRR. Stripe plan changes older than Stripe's 30 days of events can't be imported.
- Subscription state is read from 400 days before the range (a yearly plan renews within it).
- BigQuery uses streaming inserts (`insertAll`), not load jobs: simpler, and rows dedupe on the
  event id for about a minute; a load-job path would need a GCS bucket.
- The world map's outlines are generated data (`scripts/world-map.ts` → `world-paths.ts`,
  12.6 KB gzipped, excluded from Biome).
- Notes on charts are project-wide unless pinned to one saved insight.
- Upgrades keep `workers_dev` and route rewriting exactly as main does today; the dry run shows
  main's staging turns `workers_dev` off and drops the route's `zone_name` for yourtypeis.
  Worth checking against the live config before the next upgrade, but it isn't from this
  branch.
