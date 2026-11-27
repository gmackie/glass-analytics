# Dashboards and scheduled reports

**All sites** shows tracked pageviews across the projects on this Dataflare install. Pick a date range and select a path to see its contributing sites. Select a site to see that path’s referrers, or choose **Explore sessions** for the full visits that included it. Selecting a site in the project switcher shows its own path ranking. The rankings count every `$pageview`, including repeat views, and combine identical stored paths across sites. Pageviews with no recorded path count toward the total.

The same date range controls the traffic charts on **All sites** and on each site. Hourly counts use UTC for the fleet and the project’s reporting time zone for a single site. Devices are grouped by tracked pageviews. **Average session duration** measures the span of pageviews and page leaves inside the period for visits with a pageview. A single timestamp contributes zero seconds. Each session carries equal weight across the fleet. Open **Compare sessions by site** to see the underlying counts and averages.

**Human and bot traffic** counts pageviews submitted to this installation. Public submissions from recognized browsers are labeled likely human. The collector counts detected bot pageviews separately and drops them before analytics, sessions and path rankings. It keeps only the project, timestamp and a salted digest of the event ID to deduplicate retries. Historical pageviews, imports and unfamiliar clients are unclassified. The chart shows when collection began.

Open **Fleet dashboards** for the overview, traffic patterns and instrumentation coverage across this installation. The fleet overview shows each site's share of pageviews. Select a site in the donut legend to open its traffic report. The weekday and hour heatmap uses the same date range and time zone as the hourly chart. Select **Show counts** to read the exact values.

Each project starts with three editable dashboards. **Website overview** covers visitors, pageviews and journeys. **Acquisition** shows referrers, countries and tagged campaigns. **Engagement** shows sessions, devices, popular pages and journeys. Existing projects get the defaults the first time their Dashboards list opens after an upgrade. Renamed and deleted defaults stay as the owner left them.

A dashboard puts saved analyses side by side, with one date range and one set of filters for all of them, and can be sent to Slack, Discord, Teams, a webhook or email on a schedule.

## Dashboards

- **Start from a template** with Website overview, Acquisition, Engagement, Product health, Revenue or Errors. Dataflare guesses signup and purchase events from your event names and asks when it can't tell.
- **Tiles** are saved analyses (trends, funnels, retention, paths) or text (`# heading`, `**bold**`, `_italic_`, `[link](https://…)`, `- list`). A tile is 3, 4, 6 or 12 columns wide and short or tall; on a phone every tile is full width.
- **Date range and filters** on the dashboard apply to every tile. A tile can ignore them ("Ignore the dashboard filters") and run as saved.
- **Reorder** by dragging a tile's handle, or focus the handle and use the arrow keys.
- Editing an analysis updates every dashboard it is on. Removing a tile, or deleting a dashboard, leaves the analysis in Insights.
- In the insight editor, **Add to dashboard** puts a saved analysis on an existing or a new dashboard.

Agents: `list_dashboards`, `get_dashboard` (with `results: true` for each tile's headline number), `dashboard_templates`, `create_dashboard_from_template`, `save_dashboard`, `add_dashboard_tile`, `remove_dashboard_tile`, `delete_dashboard`. HTTP: `/api/dashboards…` (see `GET /api`).

## Scheduled reports

**Subscribe** on a dashboard (or `schedule_report` for an agent) sends it on a schedule:

- **Where:** any Slack, Discord, Teams or webhook channel (Settings › Notification channels), and email addresses when email is set up (below).
- **When:** every hour, day, week or month (a date, the last day, or "the first Monday"), at a time in the project's time zone. Times follow daylight saving.
- **What:** up to 20 tiles, each with its headline number, the change from the period before, and a chart. A message line can go at the top.
- **Send now** sends it immediately, to check how it looks.

Slack gets Block Kit (split into several messages past 50 blocks), Discord embeds (10 per message), Teams an Adaptive Card, and webhooks the report as JSON (`type: "dataflare.report"`, `title`, `items[]` with `value`, `delta`, `imageUrl`, `link`). Emails are HTML with the charts inline, a plain-text part, and an unsubscribe link for each address.

**How it runs.** The Worker's five-minute cron starts the reports that are due, then works out six tiles per tick, resuming on the next tick, so a 20-tile report stays inside the Workers Free plan's per-request limits. A failed send is shown on the report (`last_status`, with the reason).

**Chart images** in chat messages are links to `/report/<run>/<n>.png`. They are signed (with a key derived from the deployment's secret), expire after 90 days, are drawn by Dataflare itself (no image service) in a few milliseconds the first time they are fetched, and are then cached at the edge. They hold the chart only: axis labels, series names and numbers, no people. See [privacy](privacy.md#data-that-leaves-dataflare).

## Email

Email goes through [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/), which needs the **Workers Paid** plan and a sending domain onboarded in Cloudflare (Email Service › Email Sending; it adds the DNS records). Then:

```sh
npx dataflare-cli email enable --from reports@yourdomain.com
```

This records the sender in `.glass/config.json`. Commit and push: the deploy binds `EMAIL` with only that sender allowed, and email appears in the Subscribe and Alert dialogs. `dataflare email disable` takes it away again. Each message goes to at most 50 addresses; larger lists are split. Errors from Cloudflare (an unverified sender, a suppressed recipient, the daily quota) are shown on the report with what to do.

## Limits

- Public share links for dashboards aren't there yet.
- Reports of paths tiles carry the most common path as text, not a chart.
- A dashboard holds up to 40 tiles; a report up to 20.
