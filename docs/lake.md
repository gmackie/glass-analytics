# The lake store

By default Dataflare keeps events in D1, which is exact, real-time and free-plan friendly. D1 databases have a size limit, though, so for high volumes Dataflare can stream events into Apache Iceberg tables in R2 and query them with Basin SQL (Cloudflare's DataFusion engine, formerly R2 SQL):

```sh
npx dataflare-cli init --lake
```

Status: **stable** on Dataflare's side (0.8). Every read API is checked against DataFusion in CI and gives the same answers as D1; every query kind runs against production Basin SQL at 30 million events in 1–7 seconds; erasure, retention and schema changes work end to end. Cloudflare Pipelines is still in beta, so watch [its changelog](https://developers.cloudflare.com/pipelines/) for changes. Please report anything odd.

Lake mode can't be combined with `--eu`: Basin Catalog doesn't support R2 buckets in a jurisdiction yet, so `init` refuses the combination. Use the D1 store if your data must stay in the EU jurisdiction.

## What it creates

- An R2 bucket `<name>-data` with the data catalog enabled
- Two Pipelines streams, `<name>_events` and `<name>_identities` (the Worker name with `-` as `_`), with fixed schemas (`packages/core/src/lake.ts`). Stream, sink and pipeline names are unique per account, so each deployment gets its own.
- Two sinks writing Iceberg tables `glass.events` and `glass.identities` (Parquet, files rolled every 60 seconds)
- Two pipelines connecting them (`INSERT INTO <sink> SELECT * FROM <stream>`)
- Worker bindings `EVENTS_STREAM` and `IDENTITIES_STREAM`, and the API token as the `CF_API_TOKEN` secret so the Worker can query Basin SQL

D1 still holds projects, people, identity links, flags, experiments and the replay index.

## Differences from D1 mode

|                                | D1                                     | Lake                                                                   |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| Freshness                      | Immediate                              | About 1–2 minutes (file roll interval)                                 |
| Query time                     | Milliseconds                           | About 1–5 seconds per query                                            |
| EU jurisdiction (`--eu`)       | Yes                                    | Not yet (Basin Catalog limitation)                                     |
| History                        | Until D1's size limit                  | Unbounded                                                              |
| Cost                           | Included in Workers plans up to limits | R2 storage, Pipelines and Basin SQL scans                              |
| Person properties              | At event time, or current via SQL join | At event time                                                          |
| Deleting a person's events     | Immediately                            | Within a day (queued; the daily maintenance job deletes them)          |
| Retention (`--retention-days`) | Worker cron, daily                     | Maintenance job, daily                                                 |
| Other engines                  |                                        | Any Iceberg reader (DuckDB, Spark, Snowflake) can read the same tables |

## Erasure and retention

Basin SQL is read-only, so the Worker can't delete lake rows. Instead:

- `dataflare person <id> --delete` deletes the person, their device links and replays (the hourly job finishes any replays one request can't), and queues their ids in D1 (`lake_deletions`).
- `dataflare lake maintain` reads the queue and deletes those people's events and identity links with [PyIceberg](https://py.iceberg.apache.org/) through Basin Catalog, then deletes events older than `--retention-days` if set. The rows disappear from queries at once.
- The deploy workflow (`.github/workflows/glass.yml`) runs it daily at 03:17 UTC. Run it by hand from a laptop with `CLOUDFLARE_API_TOKEN` set; it needs [uv](https://docs.astral.sh/uv/).
- Deletes rewrite data files and leave the old ones in earlier snapshots. `init --lake` turns on Basin Catalog's snapshot expiration (7 days) and compaction, so erased rows leave R2 within about a week.

Each person is removed by device, person and user id in separate passes: PyIceberg keeps a row when a delete filter evaluates to NULL, so one `OR` across columns would miss anonymous rows (whose `user_id` is NULL).

## Using a narrower token

The Worker only needs to _read_ in lake mode. After `init`, you can replace its token with one that has just _Workers R2 SQL › Read_, _Workers R2 Data Catalog › Read_ and _Workers R2 Storage Bucket Item › Read_ (Cloudflare's docs list R2 storage access as well; keep it read-only, since vended credentials inherit it):

```sh
npx wrangler secret put CF_API_TOKEN --config .glass/wrangler.jsonc
```

## Schema changes

Custom properties never need a schema change: they live in the `props` JSON column. A new built-in column does, and Cloudflare constrains how: a Pipelines stream's schema can't change, and a sink can't write to a table it didn't create. So a schema change makes new tables:

- `LAKE_SCHEMA_CHANGES` in `packages/core/src/lake.ts` lists the columns each version adds; `LAKE_VERSION` follows it.
- `dataflare upgrade` (from CI) creates the new version's streams, sinks and tables (`<name>_events_v2`, `glass.events_v2`, and the same for identities) and points the Worker at them.
- Old tables keep their rows. Queries read every version through a `UNION ALL`, with NULL for columns an older version lacks (`LAKE_VERSIONS` on the Worker lists them). Your own SQL can keep saying `glass.events`: the Worker expands it to every version.
- Erasure and retention cover every version's table.
- The old pipeline is left in place; with nothing writing to its stream it costs nothing, and you can delete it in the dashboard.
