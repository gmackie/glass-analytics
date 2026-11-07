# Agents: MCP, CLI and HTTP

Everything in Dataflare is available to agents in three equivalent ways. They call the same service, so results match exactly.

## MCP

`dataflare init` adds this to `.mcp.json`, which Claude Code, Cursor and other MCP clients read:

```json
{ "mcpServers": { "glass": { "command": "npx", "args": ["-y", "dataflare-cli", "mcp"] } } }
```

`dataflare mcp` is a small stdio bridge that forwards to your Worker's `/mcp` endpoint with the key from `.glass/credentials.json`, so no secret goes into the config file. Clients that support remote servers can connect directly instead:

```sh
claude mcp add --transport http glass https://glass.<you>.workers.dev/mcp --header "Authorization: Bearer $GLASS_API_KEY"
```

Use the read-only key (`npx dataflare-cli key --read`) for agents that shouldn't change flags or experiments; write tools then return a clear error.

### Tools

| Tool                                                                               |                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `overview`                                                                         | Start here: headline stats vs the previous period, top pages, referrers, errors, frequent events and the events that moved most                                                                                                                  |
| `compare_sites`                                                                    | Every project side by side: visitors and pageviews vs the previous period and a trend per site (gaining, losing, stopped, new). With several sites, start here                                                                                   |
| `query_web`                                                                        | The full web analytics view                                                                                                                                                                                                                      |
| `query_trends`                                                                     | Counts, unique people, sums or averages over time, with breakdowns                                                                                                                                                                               |
| `query_funnel`                                                                     | Conversion through ordered steps within a window, with breakdowns                                                                                                                                                                                |
| `query_retention`                                                                  | Cohort retention by day, week or month                                                                                                                                                                                                           |
| `sql`                                                                              | One read-only SELECT against the event store                                                                                                                                                                                                     |
| `list_events`                                                                      | Event names, counts and documentation status (`undocumented` lists custom events still missing a description)                                                                                                                                    |
| `describe_event`                                                                   | Properties sent with an event: types, coverage, examples                                                                                                                                                                                         |
| `define_event`                                                                     | Document how/when an event fires and what each property means                                                                                                                                                                                    |
| `mark_event`                                                                       | Mark an event as a `conversion` (signup, purchase, pledge) or `important`; Reports and `overview` then show its count and rate, and conversion rates per source                                                                                  |
| `query_sources`                                                                    | Visitors by channel, referrer, UTM source/medium/campaign, landing page, country or device (first touch in the range), with conversions and bounce                                                                                               |
| `site_health`                                                                      | Errors over time and the share of sessions they hit, pages where errors happen, likely 404 pages, the slowest pages by LCP, replay frustration                                                                                                   |
| `usage_and_cost`                                                                   | What Dataflare adds to the Cloudflare bill per month, with recommendations (replay sampling, lake store, retention, noisy events) and a prompt for each                                                                                          |
| `instrument`                                                                       | The exact code to track an event in a framework                                                                                                                                                                                                  |
| `search_persons`, `get_person`                                                     | Identified people plus anonymous device counts; one person's properties, devices, events and replays                                                                                                                                             |
| `property_values`, `list_person_properties`                                        | Top values of a property (with event and people counts) and the person property names, so filters use values that exist                                                                                                                          |
| `list_cohorts`, `save_cohort`, `count_cohort`, `delete_cohort`                     | Saved person filters (and optional did-event) with live membership counts. Filter any query to a cohort with `{"property":"cohort","value":"<key>"}`                                                                                             |
| `list_replays`                                                                     | Find recorded sessions: by person, signals (`errors`, `rage_clicks`, `dead_clicks`, `console_errors`, `failed_requests`), visited `url`, `did_event` / `not_event`, event or cohort `filters`, text `search`; sort by `most_frustrated` and more |
| `summarise_replay`                                                                 | A session as a transcript: pages, clicks with labels and CSS selectors, rage and dead clicks, errors with stack frames, failed requests, console errors, notes. Highlights link to each moment                                                   |
| `replay_snapshot`                                                                  | What was on screen at a moment (`at: "01:24"`), as text: headings, links, buttons (and whether disabled), masked form fields, dialogs                                                                                                            |
| `analyse_replays`                                                                  | Patterns across sessions: most rage- and dead-clicked elements, common errors, failing requests, where frustrated sessions end; each with example links                                                                                          |
| `annotate_replay`, `delete_replay_note`                                            | Pin a finding to a moment of a session; it shows on the player timeline and in the transcript                                                                                                                                                    |
| `list_flags`, `save_flag`, `delete_flag`                                           | Feature flags                                                                                                                                                                                                                                    |
| `list_experiments`, `create_experiment`, `experiment_results`, `update_experiment` | A/B tests: create, start, read, stop, ship                                                                                                                                                                                                       |
| `list_projects`, `create_project`                                                  | Projects                                                                                                                                                                                                                                         |

Every result includes a `summary` sentence, the `sql` that ran, and a `dashboard` link to the same view. Tool input schemas are generated from the same zod schemas the API validates with, so the descriptions agents see are always current.

### Recipes

- **"First look at this project."** `overview` → `list_events`. If `upgradeAvailable` is set (also on `/health` and in MCP initialize instructions), tell the user. With their go-ahead, run `npx dataflare-cli@latest upgrade`, which stages `.glass/` when `.github/workflows/glass.yml` exists, then commit and push so CI deploys it. Don't deploy Dataflare from a laptop. For every name in `undocumented`, find the capture site in code (or ask), then `define_event` with a how/when description and property meanings before building queries on those events.
- **"Why did X drop?"** `overview` → `query_funnel` with `breakdown: "browser"` (or `utm_source`, `device`) → `list_replays` with `did_event` (the step before) and `not_event` (the step after), `sort: "most_frustrated"` → `summarise_replay` → `replay_snapshot` at the moment it goes wrong → grep the selector in the code → `annotate_replay` with what you found.
- **"What's annoying users?"** `analyse_replays` for the period → open the top findings' example links with `summarise_replay`.
- **"Add tracking for Y."** `instrument` with the event name → add the code → deploy → `describe_event` to confirm it arrives → `define_event` with how/when it fires and what each property means → if it means success (a signup, purchase, pledge), `mark_event` with role `conversion`.
- **"Which campaigns work?"** `query_sources` with `dimension: "utm_campaign"` and `"channel"`. Filter anything to whole visits from a source with `{"property":"session.utm_source","value":"google"}`.
- **"Test Z."** `create_experiment` with a goal → branch on `glass.flag(key)` in code → `update_experiment` with `start` → later `experiment_results` → `update_experiment` with `ship`.

## CLI

All commands accept `--json`. In a project set up with `dataflare init` they need no configuration; elsewhere set `GLASS_HOST`, `GLASS_API_KEY` and optionally `GLASS_PROJECT`.

```sh
npx dataflare-cli query web --from -7d
npx dataflare-cli query trends --event signup_completed --math unique_persons --interval week --breakdown utm_source
npx dataflare-cli query funnel --steps '$pageview,signup_started,signup_completed' --window 1d --where 'device=mobile'
npx dataflare-cli query retention --cohort signup_completed --return '$pageview' --period week
npx dataflare-cli query funnel --spec '{"steps":[{"event":"a"},{"event":"b"}],"from":"-90d"}' --sql
npx dataflare-cli sql "SELECT path, COUNT(*) AS n FROM events WHERE event = '\$pageview' GROUP BY path ORDER BY n DESC LIMIT 10"
npx dataflare-cli events signup_completed
npx dataflare-cli replays --errors --url /checkout --not purchase
npx dataflare-cli replays summary <session-id>
npx dataflare-cli replays snapshot <session-id> --at 01:24
npx dataflare-cli replays analyse --from -7d
npx dataflare-cli flags set new-checkout --variants control:50,test:50
npx dataflare-cli experiments create checkout-v2 --goal purchase_completed
```

## HTTP

`GET /api` on your Worker lists every endpoint, `GET /api/schema` returns JSON Schemas for every query spec, and `GET /llms.txt` has these instructions with your real URLs. Authenticate with `Authorization: Bearer <key>`.

```sh
curl -s https://glass.<you>.workers.dev/api/query \
  -H "Authorization: Bearer $GLASS_API_KEY" \
  -d '{"kind":"funnel","steps":[{"event":"$pageview"},{"event":"signup_completed"}],"from":"-30d","breakdown":"utm_source"}'
```

Errors are JSON with an `error` message and, where useful, a `hint` saying how to fix it.
