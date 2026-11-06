# Dataflare app onboarding

Project: educateos-site
Deployment: https://observe.gmac.io
Framework: Plain HTML
App Worker: educateos-site
Durable Object bindings: CONTROL_PLANE, INTEREST

## Browser

For a conservative first rollout, copy browser.js to the app public assets and load it with a deferred script on approved pages only. It disables replay/flags/click/error capture, honors DNT/GPC, strips titles/referrers/query strings and groups paths into fixed screen categories. Product projects use a stored anonymous id; educateos-site uses cookieless capture. Do not install the marketing bootstrap on student, demo, intake or operator pages.

For the general SDK defaults, add this to index.html (inside <head>, on every page):

```
<script defer src="https://observe.gmac.io/s.js" data-project="educateos-site"></script>
```

The generated worker.ts capture helper also works from a Worker/DO without a service binding, using HTTPS ingest at the selected host. Pass {} as its environment for direct capture. Same-origin proxying requires a service binding and returns 503 if it is absent.

For same-origin capture on Cloudflare, review and remove these onboarding files, then rerun with --service <existing-dataflare-worker>. An ordinary rewrite proxy can break geolocation and cookieless counts.

## Correlation and verification

Use the same pseudonymous user_id (after browser identify) and session_id for browser/server person journeys. Send session correlation explicitly from the app; do not use a DO instance id as a person id. Case journeys should use a case distinct_id and journey_id property; they are separate from person journeys. Cross-app linking is opt-in, not inferred.

No replay sampling is enabled by these snippets. Apply each app's collection policy before enabling autocapture, identity linking or replay.

After merging the binding, mounting the handler and installing the snippet, deploy through your app's normal pipeline. Send a custom event and confirm it with dataflare events <event> using GLASS_API_KEY. Check browser requests to /_glass/e when using the binding. No resources were deployed by client-init.

If generated with --local, register this project by rerunning without --local before sending traffic.

CLI queries use .glass/client.json and GLASS_API_KEY; keys are never saved here.
