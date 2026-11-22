# Destinations, transformations, exports and imports

Pipelines (in the dashboard, and the matching MCP tools) move events in and out of Dataflare: forward them as they arrive, clean them before they're stored, export them in bulk to a warehouse, and import history from other tools.

Status: **alpha**. Everything here works and is tested, but settings, payloads and APIs may change between releases without a migration. Try a destination on a test project, or point it at a webhook, before sending to a production tool. (Not to be confused with Cloudflare Pipelines, the service behind the [lake](lake.md).)

## Destinations

A destination sends matching events to another service as they arrive. Templates:

| Kind              | Templates                                                   |
| ----------------- | ----------------------------------------------------------- |
| Chat and alerts   | Slack, Discord, Microsoft Teams                             |
| Ad platforms      | Meta Conversions API, Google Analytics 4, TikTok Events API |
| CRM and messaging | HubSpot, Customer.io, Loops                                 |
| Product analytics | PostHog, Mixpanel, Amplitude                                |
| Automation        | A webhook, Zapier, Make, n8n                                |

Each destination has:

- the events it sends (or all of them), plus optional filters;
- its template's settings (URLs, ids and tokens), with values filled from the event, such as `{event.props.plan}` or `{person.email}`.

Ad platforms get email and phone hashed with SHA-256, and the event id as their deduplication key, so a browser pixel and the server don't double count: `glass.capture()` returns the id to pass to the pixel. HubSpot and Customer.io also receive group (company) updates.

**Delivery.** After an event is stored, Dataflare puts a message for each matching destination on a Cloudflare Queue. Queues work on the Free plan (10,000 operations a day). The queue consumer sends it and retries with backoff. Failures are kept with the response, and you can retry them from the destination's page. Without a queue (no permission when upgrading, or over the quota), messages wait in D1 and go out every five minutes. Each destination shows deliveries and failures per hour, and a "Send a test event" button. Credentials are encrypted in D1 and never shown again.

## Transformations

Transformations run at ingest, before an event is stored or sent anywhere, in order:

- drop events that match filters;
- remove, rename or set properties;
- hash a property (salted SHA-256);
- redact emails and phone numbers in text.

"Try it" runs a transformation on a sample event and shows the result.

## Batch exports

An export sends the events received in each closed hour or day to:

- **S3-compatible storage**, including R2: gzipped JSON lines or CSV, one file per run. Snowflake, Databricks and Spark can read these, or the [lake](lake.md)'s Iceberg tables.
- **BigQuery**: rows streamed into a table, with a service account.
- **HTTPS**: JSON lines posted to your endpoint.

Runs pick up where the last one stopped, so a failed run is retried at the next tick, and you can backfill a range. Each run is listed with its row count and status.

## Imports

Bring history from another tool, with its timestamps:

- **Dashboard**: Pipelines › Imports reads a file in the browser (JSON lines, a JSON array or CSV, up to 50 MB), previews it and uploads it.
- **CLI**: for bigger files, `npx dataflare-cli import export.ndjson --preset posthog` streams them.

Presets: `posthog`, `mixpanel`, `amplitude`, `segment`, `ga4` (the BigQuery export) and `raw` (Dataflare's own shape). Each record gets a stable id, so importing the same file twice doesn't double count. Imports aren't sent to destinations.
