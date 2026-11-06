# Onboard an app to an existing Dataflare deployment

Run `dataflare init` once in the repository that owns the analytics deployment.
Run `dataflare client-init` in each app repository that sends events to it.
Apps can share one deployment in your Cloudflare account while keeping separate
project ids. This command does not deploy Workers or create databases or buckets.

```sh
# Preview locally: no credentials, network API calls or file writes.
npx dataflare-cli client-init --host https://analytics.example.com \
  --project my-app --service glass-analytics --dry-run --json

# Register and generate onboarding files using GLASS_API_KEY from your environment.
npx dataflare-cli client-init --host https://analytics.example.com \
  --project my-app --service glass-analytics
```

In a terminal, missing host and project settings are prompted for. The project
id defaults to the package name. If a root Wrangler config exists, the wizard
reads JSON, JSONC or TOML using Wrangler, reports its Worker and Durable Object
bindings, and offers an optional Dataflare service name. Noninteractive callers
can supply flags; omitting `--service` generates direct browser capture setup.
The service is the existing analytics Worker's name, not the app Worker's name.
The binding must reference a Worker in the app's Cloudflare account.

The command writes:

- `.glass/client.json`: public deployment URL, app project id and optional service name.
- `.glass/client/README.md`: framework-specific browser setup, integration and verification steps.
- With `--service`, `.glass/client/worker.ts`: a dependency-free capture helper and same-origin handler.
- With `--service`, `.glass/client/binding.json`: the Wrangler service-binding fragment to merge.

Review and commit these files. Merge the binding into the app's Wrangler config,
mount `dataflareProxy` before the app router, and add the browser snippet. Existing
bindings and entrypoints are not rewritten. Add the binding separately to named
Wrangler environments. Use the app's normal CI/deployment workflow to roll out.
Without a service binding, the browser sends directly to the analytics URL.

Rerunning with the same inputs is safe: existing project names and origin
restrictions are preserved. Changed generated files are never overwritten.
To reconnect or change capture mode, review and remove the generated onboarding
files first. Keep deployment and client repositories separate: `client-init`
refuses deployment repos, and `init` refuses client repos.

## Workers and Durable Objects

Import `capture` from the generated helper in the app's Worker or DO. Pass the
same `DATAFLARE` service binding through the environment. It sends public ingest
requests; it needs no admin key at runtime. The proxy forwards only `/s.js`,
`/replay.js`, `/e`, `/r` and `/f` under `/_glass`. It strips app cookies and
Authorization headers and does not forward `/api`, `/mcp` or dashboard paths.

Choose event identity explicitly:

- Person journeys: use the same pseudonymous user id as browser `identify`, and
  pass the session id explicitly when session-level correlation is needed.
- Case journeys: use a case id as `distinct_id` and include a `journey_id` property.
  A Durable Object instance is not automatically a person.
- Cross-app identity linking must be an explicit application decision.

For best-effort Worker telemetry, use `ctx.waitUntil(capture(env, event))`. In a DO,
await capture or use the DO's execution context. For required delivery, use an
application outbox and persist the event's `id` and `ts` with the transition;
reuse them on retries. The helper does not install an outbox or make delivery
transactional. D1 deduplicates matching event ids; do not assume exactly-once
lake ingestion. Timestamp retention and ingest age limits still apply.

After rollout, verify events arrive with `dataflare events <event>` and inspect
same-origin browser requests. The service-binding handler preserves incoming
Cloudflare request metadata and visitor headers; verify geolocation and
cookieless counts on Cloudflare before relying on them. Arbitrary external
rewrite proxies are not equivalent.

## Credentials and collection policies

Set `GLASS_API_KEY` for registration and CLI/API/MCP queries. It is never written
to the generated files. `GLASS_HOST` and `GLASS_PROJECT` override client settings
for subsequent CLI queries. Browser capture and Worker capture use the public
ingest surface. Project origin restrictions do not authenticate server senders.

The generated browser setup does not enable replay sampling. Review autocapture,
identity and collection settings for each app before rollout. educateOS privacy
controls and Sankey journey queries are separate capabilities; this command
only sets up event capture and correlation.

## Monorepos and offline preparation

Use `--dir apps/web --config wrangler.jsonc --env production` to select an app and its actual deploy environment. Paths for `--config` are relative to `--dir`; unknown environments are rejected. Use `--local` to write onboarding files without credentials or remote registration, then rerun without it when the deployment is ready. The selected config/environment are saved for reruns. `--dry-run` remains fully read-only. TanStack Start gets a root-document snippet.

The wizard also generates browser.js for a conservative opt-in rollout and worker.ts even without a service binding (direct HTTPS capture). Load browser.js as a local script with `data-enabled="true"` only on approved pages. It defaults off, honors DNT/GPC, sends only fixed page categories and excludes replay, flags and text capture. Worker capture now requires a JSON ingest acknowledgement; upgrade the analytics Worker before using that helper. See [app rollout](app-rollout.md) for our observe.gmac.io kits, activation settings, privacy boundaries and production gates.
