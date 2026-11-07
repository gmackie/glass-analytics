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

## Deleting a person

```sh
npx dataflare-cli person <user-id> --delete
```

This deletes the person, their device links, their replays and every event from their user id and devices. In D1 mode the events go at once. Replays go a slice at a time, since each one is several R2 calls: if a person has more than one request can delete (about 100), the result says `"complete": false` and the hourly maintenance job deletes the rest, then the person and their device links. In lake mode they are queued and removed by the daily maintenance job (`dataflare lake maintain`, run by the deploy workflow), and the old data files leave R2 when their snapshots expire, within about a week; see [lake.md](lake.md#erasure-and-retention).

## EU data

`dataflare init --eu` creates the D1 database and R2 buckets in Cloudflare's EU jurisdiction. The Worker itself runs on Cloudflare's global network.

Before 0.8.1, the replay bucket's binding left out the jurisdiction, so an EU deployment's replays were written to a bucket of the same name in the default jurisdiction, which Wrangler created on deploy. `dataflare upgrade` fixes the binding and keeps the old bucket bound as `REPLAYS_LEGACY`: the Worker reads from it until the hourly job has moved every object into the EU bucket (it logs `legacyMoved` each run). Once that reaches 0, delete `legacyBucket` from `.glass/config.json`, run `dataflare upgrade` again, and delete the old bucket.
