# Roadmap

What Dataflare does today, and what's next. Items marked _good first issue_ are self-contained and a good way to start contributing.

## Shipped in 0.1

- `dataflare init` / `upgrade` / `status`, with agent files (AGENTS.md, skill, `.mcp.json`)
- Browser SDK: autocapture (pageviews incl. SPA navigation, clicks, errors, web vitals), custom events, identify, person properties, cookieless mode, consent
- Web analytics, trends, funnels, retention, raw SQL; filters and breakdowns on any event or person property
- Session replay with sampling, error-triggered buffering, console and network capture, frustration signals (rage, dead and error clicks), search, cross-session patterns, notes and text transcripts with what-was-on-screen snapshots
- Feature flags with targeting; experiments with Bayesian readout and SRM checks
- MCP server (41 tools), CLI, HTTP API, `llms.txt`
- D1 event store (default) and the lake store

## In review for the next release

On the `deepen-coverage` branch (see REVIEW.md there):

- **Group analytics**: companies or teams as well as people, in every insight, flags, experiments and revenue.
- **Trends**: rolling actives, percentiles, per-person counts, first-time, formulas, minute buckets, numeric and cohort breakdowns, trend lines, table, pie and world-map views, annotations.
- **Funnels**: strict and any-order steps, exclusions, optional steps, breakdown attribution, time to convert, conversion over time, correlation.
- **Retention**: recurring, cumulative, hourly, any event, per-breakdown tables, people behind every cell.
- **Cohorts**: behavioural conditions in nested groups, cohorts of cohorts, static lists, members and CSV.
- **Flags**: payloads, cohort and flag-dependency targeting, person or group bucketing, schedules, history, usage, bootstrap, overrides, early access, and `dataflare-node` with local evaluation.
- **Experiments**: metric kinds, secondary metrics, Bayesian or frequentist, holdouts, planning, results over time, web experiments.
- **Error tracking**: issues, source maps, alerts.
- **Revenue analytics**: currencies, Stripe, MRR and its movements.
- **Pipelines**: destinations through Cloudflare Queues, transformations, batch exports and imports.
- **Time zones** with daylight saving, and an internal-traffic filter.

## Next

- **Lake store in the EU jurisdiction**, once Basin Catalog supports jurisdiction buckets (`--lake --eu` is refused today).
- **Lake backfill:** copy older schema versions' rows into the newest table and drop the old ones, so queries stop needing the UNION.
- **Paths, stickiness and lifecycle insights.** Each is one file in `packages/core/src/insights/`. _good first issue_
- **Alerts:** threshold and anomaly alerts on any insight, via email or webhook, run from the Worker's cron (error alerts are in review above).
- **A visual editor for web experiments** (today the changes are written as selectors).
- **Mobile SDKs**, surveys and heatmaps.
- **Current person properties in lake mode:** mirror D1 `persons` to an Iceberg table (today, lake queries use the per-event snapshot).
- **URL goals:** mark a URL (not just an event) as a conversion. _good first issue_
- **Cloudflare Access** support for the dashboard, as an alternative to API keys.
- **Materialised property columns** for frequently filtered lake properties (a lake schema change; see docs/lake.md).
- **Analytics Engine accelerator** for real-time tiles at high volume.
- **`glass cost`:** estimate monthly Cloudflare spend from current volume. _good first issue_
- **Opt-in install telemetry** for the landing page's conversion funnel (off by default).
- **More framework snippets and detection:** Qwik, SolidStart, Eleventy, Hugo. _good first issue_
