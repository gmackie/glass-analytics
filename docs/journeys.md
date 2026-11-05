# Local journeys and collection controls

Start the local demo with `pnpm dev` (dashboard/Worker on :8787, demo on :8788, admin key `dev-admin-key`). Select Journeys in Insights and choose a date range of at most seven days. Capture a few demo events, then run the analysis. The Sankey includes a transition table, keyboard descriptions and SVG export. Journeys can be saved and queried through the API, MCP and CLI.

```sh
dataflare query journeys --from -1d --event signup_completed --json
```

The API accepts a flat body on `POST /api/query`:

```json
{
  "kind": "journeys",
  "project": "acme",
  "from": "-1d",
  "anchor": { "event": "signup_completed" },
  "direction": "backward",
  "node": "event",
  "maxDuration": "1h",
  "maxSteps": 6,
  "maxLabels": 8
}
```

Journeys count sessions grouped by resolved person and session ID. Cohort filters select sessions without hiding their other steps. The first matching anchor is used; backward paths read from the anchor toward earlier events. With page nodes, the anchor may be a custom event while visible steps are page views. Repeats may be collapsed. Other nodes preserve session counts at each layer, including loops. These are observed paths, with no causal interpretation.

Anchor ranges are limited to seven days, context to 24 hours per anchor, and candidates to 50,000 rows. Exceeding the row limit returns an error rather than a partial graph. Context can extend outside the anchor date range. Results include source freshness and the observation cutoff. Observed end/start means no more eligible events were seen within the bounded context; it does not prove abandonment or completion. Recent sessions show observation pending. Step and duration limits are explicit terminal nodes. Identical source IDs deduplicate; conflicting IDs fail the query.

## Collection policy

Validate a catalog offline with `dataflare catalog --file examples/policies/catalog.json`. Set a policy using an admin connection and `dataflare policy set --file examples/policies/aggregate.json --project acme`; inspect it with `dataflare policy get --project acme`. API GET/PUT `/api/capture-policy` and MCP `get_capture_policy`/`set_capture_policy` expose the same operation. Revisions must increase; an identical revision is idempotent. Invalid stored policies fail closed.

Profiles:

- `standard`: existing collection, optionally restricting custom events/properties through a catalog. Built-in events remain enabled.
- `disabled`: rejects event collection and disables replay and flag requests.
- `aggregate`: allows catalogued custom events only; strips URL, referrer, identity, flags and request geography/device enrichment, uses a secret-derived per-event ID and rounds time to a UTC day. Identity linking and person snapshots are skipped. Replay, flags and session journeys are disabled.

Aggregate currently stores minimized per-event records, not pre-aggregated anonymous statistics. Numeric values and even bounded categories require review for sensitive information. It is not a FERPA/COPPA compliance claim. Existing historical records are not erased when a policy changes.

`Dataflare.optOut()` discards queued analytics/replay, aborts pending fetches, clears instance identity and prevents further capture or flag reloads for that instance. Already delivered requests or beacons cannot be recalled. This preference is not persisted: the host app must avoid initialization on later pages until authorized. `consent(false)` still allows cookieless analytics; it is not a collection stop.

## Remaining rollout work

The local `client-init` browser/Worker/DO fragments still need explicit app hook-up and same-origin route configuration. No Cloudflare resources or ForgeGraph apps have been enrolled here. Durable outboxes, fleet inventory, trusted server provenance, scoped project/district authorization, retention/erasure and suppression remain future work. Deployment-wide read/admin keys are not tenant isolation. Student traffic must wait for the separate educateOS boundary and privacy workstream.

Flightdeck remains in place. Case lifecycle semantics (pause/block, censoring and tombstones) require their own migration; session journeys do not replace those semantics. The original delivery plan is retained in `docs/plans/` as a proposal; this document records the implemented local slice and its remaining gates.
