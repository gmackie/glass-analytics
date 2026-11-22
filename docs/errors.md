# Error tracking

Dataflare groups exceptions into issues, maps their stack traces back to your source, and alerts you about new ones, regressions and spikes. Issues sit next to the people they affected and the replays of the moment they happened.

## Capturing

- **Browser**: uncaught errors and unhandled promise rejections are captured automatically. Report caught ones with `glass.captureException(err, { level: 'warning', ...properties })`. See the [SDK](sdk.md#errors).
- **Server**: `captureException` in [`dataflare-node`](node-sdk.md).
- Set the release (`release` in `init`, `data-release` on the script tag) so stack traces map to the right source maps.

## Issues

At ingest, each `$exception` is parsed (Chrome, Firefox, Safari and V8 stacks) and fingerprinted. A fingerprint combines:

- the error type;
- the message, with numbers, ids and URLs stripped;
- the top three frames from your own code.

Exceptions with the same fingerprint belong to one issue, and the issue id is written onto the event (`$issue_id`), so every query can group by issue. Set `$fingerprint` in the properties to group exceptions yourself.

An issue is `active`, `resolved` or `suppressed`, and can have an assignee:

- A resolved issue that happens again becomes a **regression**.
- A suppressed issue's exceptions are dropped at ingest.
- Each issue keeps at most `errorRateLimitPerMinute` exceptions a minute (Settings, default 100), so one runaway loop can't flood the database.
- Merge issues that are the same bug under different fingerprints: new exceptions of either then join the target.

Which frames are "your code" is decided by `inAppIncludes` in Settings (path fragments such as `/assets/app-`). By default it is files served from your site's host.

## Source maps

```sh
npx dataflare-cli sourcemaps upload ./dist --release 1.4.0
```

This uploads every `.map` file under the folder (with the server or admin key) to `sourcemaps/<project>/<release>/` in your R2 bucket. When an issue is opened, its frames are mapped back to the original file, line and function, with a few lines of code around each from `sourcesContent`. Maps are read when someone looks, not at ingest, and the mapped stack is cached per issue sample. `list_sourcemaps` and the Errors page list them per release.

## Alerts

In Settings, pick a chat destination (Slack, Discord, Teams or a webhook; see [destinations](destinations.md)) and choose what to send:

- new issues;
- regressions;
- spikes: more than N exceptions in M minutes, checked every five minutes, at most one alert per window.

## Tools

The Errors page lists issues with a sparkline, people, last seen and release. Each issue's page shows the mapped stack trace and a trend, broken down by browser, OS, release and page, with the people affected and the replays that open just before the error.

| MCP tool          | Does                                                         |
| ----------------- | ------------------------------------------------------------ |
| `list_issues`     | Issues by status, newest or most frequent, with search       |
| `get_issue`       | One issue: mapped stack, trend, breakdowns, people, replays  |
| `update_issue`    | Resolve, suppress, reopen or assign                          |
| `merge_issues`    | Fold other issues into one                                   |
| `list_sourcemaps` | Uploaded source maps by release                              |
| `site_health`     | Errors over time, by issue, alongside slow and missing pages |
