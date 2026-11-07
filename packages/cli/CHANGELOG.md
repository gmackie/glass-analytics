# dataflare-cli

## 0.8.2

### Patch Changes

- 01072c6: All sites: deployments with more than one project get an "All sites" entry at the top of the project switcher and open on it, showing each project's visitors and pageviews against the previous period, a sparkline, the last pageview and a trend (gaining, losing, steady, new, stopped). Also `GET /api/sites` and the `compare_sites` MCP tool. One-project deployments are unchanged (#8, thanks @robertdoneill).
- 629737c: Since 0.8.1, the CLI runs the wrangler installed with it instead of downloading the newest wrangler 4.x through `npx` on every deploy. The lookup always failed because wrangler's `exports` don't include `bin/wrangler.js` (#5, thanks @robertdoneill).
- 629737c: Your own SQL (`POST /api/sql`, the MCP `sql` tool, `dataflare sql`) can no longer hide a second, writing statement from the read-only guard, which accepts the read key. The guard now tokenizes the query in one pass the way SQLite does, so a `/*` or `--` inside a string, a quote inside a `[bracketed]` identifier, or a `$name(...)` parameter can't make it misread where a string ends (#3, thanks @robertdoneill; the one-pass scan shipped in 0.8.1, the bracket and parameter cases are new). As a backstop, a read-only query that changes the D1 database now fails with an error instead of returning normally.
- 01072c6: An install made with `init --no-replay` keeps session replay off: `dataflare upgrade` no longer creates its R2 bucket, which also stopped upgrades failing on tokens without R2 permission. Installs from before this release can record the choice once with `dataflare upgrade --no-replay`; on an install that already has a replay bucket it refuses rather than strand the replays (#9, thanks @robertdoneill).
- 629737c: Since 0.8.1, a Worker deployed on your own domain with `init --route` is no longer also reachable at its workers.dev address, which let traffic to `/e`, `/r` and `/f` skip the zone's WAF and rate limits (#4, thanks @robertdoneill). **If anything still sends to your workers.dev host** (a server-side SDK, a hard-coded snippet), point it at your route before upgrading to 0.8.1 or later: the upgrade turns workers.dev off and those requests will get a 404.

## 0.8.1

### Patch Changes

- 133e7be: Fixes for five failures reported in #2:
  - **D1's 100-parameter limit.** Ingesting a batch that touches more than 98 known people, and erasing a person with more than 32 device links, no longer fails. Person updates go 90 at a time, and erasure passes its ids as one JSON parameter.
  - **Erasure that finishes.** A person's replays are deleted 50 sessions per slice with one D1 batch each, instead of two queries per session, which could pass D1's per-invocation limit. A request does two slices, and the hourly job finishes anything left. The person and their device links are deleted last, so `"complete": true` means everything is gone. A failure part way leaves the rows that let the next run finish. Retention uses the same bounded slices.
  - **Retried replay uploads count once.** A chunk whose response was lost and is sent again no longer doubles the session's chunk, byte, page, click and error counts.
  - **EU replay buckets.** The `REPLAYS` binding now names its jurisdiction. Before, an EU deployment's Worker wrote replays to a default-jurisdiction bucket of the same name that Wrangler created on deploy, so replays were stored outside the EU. `dataflare upgrade` switches to the EU bucket and keeps the old one bound as `REPLAYS_LEGACY`: replays still read from it, and the hourly job moves its objects across. See [privacy.md](docs/privacy.md#eu-data) for removing it afterwards.
  - **Routes on multi-label domains.** The generated route no longer guesses the zone from the hostname's last two labels (`co.uk` for `analytics.example.co.uk`). Wrangler now resolves the zone by trying each parent domain against your account's zones, which also handles delegated subzones.

## 0.8.0

### Minor Changes

- 859debb: The lake store leaves beta. Schema changes now have an upgrade path: a new version gets its own streams and tables (Cloudflare can't alter a stream or share a table between sinks), and queries, your own SQL and erasure read every version through a UNION ALL. The web report and overview count visitors in two exact steps instead of COUNT(DISTINCT), which Basin SQL rejected at tens of millions of events; every query kind now runs at 30 million events in 1–7 seconds.

## 0.7.0

### Minor Changes

- 1e69d38: Lake mode can erase people and apply retention. `dataflare person <id> --delete` queues the person's events, and the new `dataflare lake maintain` deletes them (and events past `--retention-days`) with PyIceberg through Basin Catalog; lake deployments' workflow runs it daily. `init --lake` turns on snapshot expiration and compaction so deleted rows leave R2 within a week. Every read API is now checked against DataFusion in CI, and ranked lists (top pages, referrers, events) break ties by name, so D1 and the lake order them the same.

## 0.6.3

### Patch Changes

- fdea56f: Lake mode works against production Cloudflare. Queries no longer fail with "Illegal invocation" in the Worker; `init --lake` lists Pipelines resources through the API (Wrangler's list output isn't JSON) and names streams, sinks and pipelines after the deployment, so a second lake deployment in one account gets its own instead of silently reusing the first's; and `--lake --eu` is refused up front, since Basin Catalog doesn't support jurisdiction buckets yet.

## 0.6.2

### Patch Changes

- c901828: Fix `npx dataflare-cli` doing nothing: the CLI only started when its bin was named `glass`, and npm links it as `dataflare`. It now compares real paths, so it runs under any bin name.

## 0.6.1

### Patch Changes

- cf728a9: The CLI is published as `dataflare-cli` (npm rejected `dataflare` as too close to an existing package): `npx dataflare-cli init`, `npx dataflare-cli@latest upgrade`. Installed globally, the command is still `dataflare`. Deploy workflows and `.mcp.json` written by the CLI use `dataflare-cli`, and `/health` checks `dataflare-cli` on npm for new versions.

## 0.6.0

### Minor Changes

- 8393cf8: Glass is now Dataflare, at https://dataflare.dev. The CLI is published as `dataflare` (`npx dataflare init`, `npx dataflare@latest upgrade`) and the browser SDK as `dataflare-web`; the `@glassanalytics/cli` and `@glassanalytics/web` packages get no new versions. Nothing changes in your snippet or deployment: `window.glass`, the `data-glass-*` attributes, the `/_glass` route, `.glass/` and the `GLASS_*` settings all stay, and the SDK still exports `Glass` as an alias of the renamed `Dataflare` class. `dataflare upgrade` rewrites a deploy workflow generated before the rename so CI installs `dataflare` instead of `@glassanalytics/cli`.

## 0.5.0

### Minor Changes

- 19736d1: Session replay can record cookieless visitors. Add `data-replay-cookieless="true"` (or `replay: { cookieless: true }`) and visitors who haven't consented are recorded too, still with nothing stored on the device: the Worker files each page load's recording under the same daily-rotating visitor and session ids as its events, so the replay joins the visit. `glass.consent(false)` now stops replay for the rest of the page even if the recorder was still loading, and `consent(true)` restarts a cookieless recording under the stored session.

## 0.4.0

### Minor Changes

- 88f0a3a: Reports you can explore, key events and a cost page. Mark events as conversions or important (Events page, or the new `mark_event` MCP tool) and Reports show their rates, overall and per source. Marketing adds channels (search, social, paid, email, AI assistants, referral, direct) and a source table with conversion and bounce. Health adds errors over time, sessions affected, likely 404 pages, the slowest pages and replay frustration. Clicking any source, campaign, page, country or device opens a full report for that segment; source and page segments keep whole visits (new `session.<property>` filters). New Usage & cost page (and `usage_and_cost` tool) projects what Glass adds to the Cloudflare bill and recommends ways to cut it. Copyable agent prompts on Reports and in Insights' "New analysis" menu. New MCP tools `query_sources` and `site_health`. Run `glass upgrade` to apply migration 0005.

  Onboarding fixes from rolling Glass out to ten sites: deployments are named `glass-<project>` by default (a shared `glass` name made a second site take over the first site's Worker); `--route acme.com` is enough (no shell-sensitive `*`), and `--no-route` removes one; `--retention-days` on init and upgrade; init retries while new Worker secrets propagate instead of failing with "GLASS_ADMIN_KEY is not set"; wrangler failures show the actual error; a CLAUDE.md that imports AGENTS.md no longer gets a duplicate Glass section; init and the agent instructions explain cookie banners (cookieless until `glass.consent(true)`), mirroring an existing analytics helper, and loading from the Worker URL on Vercel or Netlify.

## 0.3.0

### Minor Changes

- 1449c31: Session replay becomes a debugging tool. Recordings now include console warnings and errors, network requests (method, URL without query string, status, timing) and client-side navigation; `data-glass-mask` masks an element's text. Transcripts label clicks on content rendered after load, add CSS selectors, dead clicks, clicks followed by errors, stack frames, failed requests and console errors. New MCP tools `replay_snapshot`, `analyse_replays`, `annotate_replay` and `delete_replay_note`; `list_replays` can filter by signals, visited URL, events that did or did not happen, cohorts and text. The dashboard gets a full player (timeline markers, speed, skip inactivity, fullscreen, deep links, notes) and a Patterns page. Run `glass upgrade` to apply migration 0004 and switch the maintenance cron to hourly.
