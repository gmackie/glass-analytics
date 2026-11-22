# Privacy

Dataflare runs entirely in your Cloudflare account. There is no Dataflare service: events, people, recordings and keys live in your D1 database, your R2 buckets and your Worker's secrets. Nothing is sent to the Dataflare project or to any third party, and the dashboard and SDK load no third-party resources. (The Dataflare website, which is separate from your deployment, measures itself with its own Dataflare deployment, cookieless and with session replay that stores nothing on the device, and uses the Meta Pixel to measure its own ads.)

## What is stored

| Data         | Where                     | Notes                                                                                                                                                            |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events       | D1 `events` (or the lake) | URL without query string (except UTM tags), referrer without query string, title, country/region/city from Cloudflare, browser/OS/device family, your properties |
| IP addresses | Nowhere                   | Used only in memory, to derive cookieless ids                                                                                                                    |
| People       | D1 `persons`              | The properties you send with `identify()` / `setPersonProperties()`                                                                                              |
| Device links | D1 `identities`           | Anonymous device id → your user id                                                                                                                               |
| Replays      | R2, gzipped               | rrweb recordings; deleted after 30 days by default (`GLASS_REPLAY_RETENTION_DAYS`)                                                                               |

Set `GLASS_RETENTION_DAYS` (a Worker variable, or `--retention-days` on `init`/`upgrade`) to delete events older than that many days. In lake mode the daily maintenance job applies it.

## Cookieless mode

With `persistence: 'cookieless'` (or `data-persistence="cookieless"`), the SDK stores nothing on the device. The Worker derives a visitor id from a daily-rotating secret salt, your project, the IP address and the user agent, hashes it with SHA-256, and stores only the hash. The salt changes every day, so ids can't be linked across days or reversed to an IP. Sessions are 30-minute windows of that id.

This is enough for web analytics. It is not enough for funnels across days, retention or experiments, which need a stable id; call `glass.consent(true)` once the user agrees to switch to a persistent id. Whether you need consent in your jurisdiction is a question for your own legal advice.

## Session replay

- Every input is masked (`maskAllInputs`). Set `maskAllText` to mask all text as well, or mark elements with `data-glass-mask` to mask just their text.
- Elements matching `[data-glass-block]` (configurable) aren't recorded.
- Recording is sampled; nothing is recorded unless you set a sample rate.
- In cookieless mode replay is off unless you also set `replay.cookieless` (`data-replay-cookieless="true"`). Then nothing is stored on the device either: each page load's recording is filed under the same daily-rotating visitor and session ids as its events, and the sampling decision lasts one page load. `glass.consent(false)` stops recording for the rest of the page. Recording a visitor who hasn't consented may need a legal basis such as legitimate interest where you are; describe it on your privacy page.
- Network requests are recorded as method, URL without its query string, status and timing. Headers and bodies never are. Turn it off with `network: false`.
- Console `warn` and `error` messages are recorded by default; they contain whatever your code logs. Turn it off with `console: false`.
- Notes left on a session, and its cached summary, are deleted with the session (retention, or erasing a person).

## Student mode

For products used by children (K-12), put the project in student mode. The Worker enforces it on every write, so a misconfigured snippet or SDK can't store more than the policy allows.

```sh
npx dataflare-cli projects policy <id> --audience minors \
  --event-props lesson_kind,score --person-props grade_band --retention-days 365
npx dataflare-cli projects policy <id>            # show it
npx dataflare-cli projects audit <id> --from -30d  # who read the data
```

(Or `PUT /api/projects/<id>/policy`, or the `set_project_policy` MCP tool. Setting replaces the whole policy.)

| Data                  | In student mode                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device and session id | Always the cookieless daily ids; ids the browser sends are ignored                                                                                                                                                     |
| User id               | Only a pseudonym matching `pseudonym_pattern` (default: a keyed HMAC, 64 hex or 43 base64url characters). Anything with `@` or spaces is refused whatever the pattern says. `identify()` with anything else is dropped |
| URL                   | Path only: no query string or fragment; numeric, UUID, hex and token segments become `:id`, and segments with `@`, phone numbers or SSNs become `:redacted`                                                            |
| Referrer, title       | Referrer reduced to its origin; titles are never stored                                                                                                                                                                |
| Location              | Country only (no region or city)                                                                                                                                                                                       |
| Event properties      | Only names in `event_properties`. Dataflare's own events keep fixed safe fields (`$click`: tag, href path, outbound; `$exception`: type only; no click text or error messages)                                         |
| Person properties     | Only names in `person_properties`                                                                                                                                                                                      |
| Any kept value        | Must be a number, boolean or a string of up to 100 characters that doesn't look like an email, phone number or SSN; otherwise it's dropped                                                                             |
| Session replay        | `replay: "off"` (the default) refuses uploads. `replay: "scrubbed"` stores them with every text node, input value and non-layout attribute masked by the Worker, images and console/network records removed            |
| Retention             | `retention_days` deletes the project's events, people and device links after that many days (D1 store; lake deployments use the deployment-wide setting). `replay_retention_days` caps replays                         |
| Reads                 | Every API, dashboard and MCP read of the project, and every SQL query (SQL can reach any project), is recorded in `audit_log` with the time, key scope, Cloudflare Access email when present, operation and SQL text   |

Student mode is a set of technical controls, not a compliance determination. Whether your use is covered by COPPA's school-authorization basis, FERPA's school-official exception or state student-privacy laws depends on your agreements with the school or district; get legal advice before turning replay on.

## Deleting a person

```sh
npx dataflare-cli person <user-id> --delete
```

This deletes the person, their device links, their replays and every event from their user id and devices. In D1 mode the events go at once. Replays go a slice at a time, since each one is several R2 calls: if a person has more than one request can delete (about 100), the result says `"complete": false` and the hourly maintenance job deletes the rest, then the person and their device links. In lake mode they are queued and removed by the daily maintenance job (`dataflare lake maintain`, run by the deploy workflow), and the old data files leave R2 when their snapshots expire, within about a week; see [lake.md](lake.md#erasure-and-retention).

## Deleting a group

```sh
npx dataflare-cli group company <key> --delete
```

This deletes the group's row and removes its key and property snapshot from every event (the events stay with their people). In lake mode it is queued like a person's erasure.

## Data that leaves Dataflare

Nothing is sent to a third party unless you set it up:

- **Destinations** forward events as they arrive to the tools you configure (Slack, Meta Conversions API, GA4, HubSpot, a webhook…). Each sends only the events and fields its mapping names. Ad platforms get email and phone hashed with SHA-256 first, as they require. Credentials are encrypted in D1 with a key only the Worker holds (`GLASS_ENCRYPTION_KEY`). See [destinations](destinations.md).
- **Batch exports** write events to your own S3, R2, BigQuery or HTTPS endpoint.
- **Error alerts** go to the chat destination you pick.
- **Scheduled reports and alerts** go to the channels and email addresses you pick. The chart images in chat messages are public links, signed and expiring after 90 days, that show the chart only (labels and numbers, no people). See [dashboards](dashboards.md).

## Payments, imports and source maps

- **Stripe**: webhook events become revenue events. To link a customer to a person, Dataflare reads a metadata key you name, or, if you turn it on, matches the customer's email to a person's: the email is hashed for matching and never stored. The restricted API key, if you give one, is encrypted like destination credentials.
- **Imports** (`dataflare import`, or Pipelines › Imports) keep the original timestamps and are subject to the same retention and erasure as everything else.
- **Source maps** are stored in your R2 bucket, used only to map stack traces back to your code, and listed (and deleted) per release.
- **Transformations** run before anything is stored: they can drop events, remove properties, hash them, or redact emails and phone numbers in text.

## EU data

`dataflare init --eu` creates the D1 database and R2 buckets in Cloudflare's EU jurisdiction. The Worker itself runs on Cloudflare's global network.

Before 0.8.1, the replay bucket's binding left out the jurisdiction, so an EU deployment's replays were written to a bucket of the same name in the default jurisdiction, which Wrangler created on deploy. `dataflare upgrade` fixes the binding and keeps the old bucket bound as `REPLAYS_LEGACY`: the Worker reads from it until the hourly job has moved every object into the EU bucket (it logs `legacyMoved` each run). Once that reaches 0, delete `legacyBucket` from `.glass/config.json`, run `dataflare upgrade` again, and delete the old bucket.
