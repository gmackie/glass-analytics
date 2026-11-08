# Journey loader for observe.gmac.io

`dataflare.js` is the loader every app that reports to observe.gmac.io serves as `/dataflare.js`
(DATFLR-9). It replaces the per-app copies of the first loader, which sent pageviews only, cut
URLs to their first path segment and dropped referrers, so journeys could not be followed.

## What it sends

| Event         | Notes                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `$pageview`   | Landing and every client-side navigation. Sent immediately on landing.        |
| `$pageleave`  | With `duration_ms`, attributed to the page being left.                        |
| `$click`      | Links and buttons. Text over 40 characters or that looks personal is dropped. |
| `$exception`  | Uncaught errors, with long numbers masked.                                    |
| `$web_vitals` | LCP, CLS, INP and friends.                                                    |
| app events    | `window.dataflare.track('trip_created', { mode: 'group' })`                   |
| `$identify`   | `window.dataflare.identify(user.id, { plan })` after sign-in.                 |

URLs keep the path with id-like segments replaced by `:id` (or by the app's `routes` templates)
and keep `utm_*` parameters only. Referrers are cut to their origin. Titles are never sent.
Properties named like emails, names, phones, tokens or addresses are dropped, as is any string
containing `@` or a run of six or more digits.

## Adopting it in an app

1. Copy `dataflare.js` to the app's `public/dataflare.js` and edit only `CONFIG`:
   `project`, `exclude`, `only`, `persistence`, `identify`, `routes`.
2. Load it once from the root document:
   `<script defer src="/dataflare.js" data-enabled="true"></script>` (keep the app's kill switch).
3. Call `window.dataflare?.identify(String(user.id), { plan })` when the signed-in user is known,
   `window.dataflare?.reset()` on sign-out, and `window.dataflare?.track(name, props)` after the
   app's key actions succeed. Calls made before the SDK loads are queued.
4. Check it in production with a scripted visit: every beacon returns 204, the visit has one
   session, `$pageview` and `$pageleave` both arrive, and URLs show `:id`.

Entries in `only` and `exclude` match a path and everything under it; end an entry with `$` to
match one exact path (`'/teachers$'`).

Hash-routed apps (`/#/orders/123`) set `hashRouting: true`, so the route after `#` is recorded as
the page (`/#/orders/:id`). Without it every screen of such an app is recorded as `/`.

Use `persistence: 'cookieless'`, `identify: false` and an `only` allowlist for sites with child or
student data (playtrek, educateos-site): nothing is stored on the device and the SDK never loads
outside the listed pages.

Tests: `node --test packages/web/test/journey-loader.test.ts`.
