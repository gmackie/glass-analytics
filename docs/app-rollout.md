# observe.gmac.io app support

Shared deployment URL: **https://observe.gmac.io**. The analytics Worker service name is not yet verified. Do not use the upstream isnit Worker or assume a service-binding name from the hostname.

| App                 | Local package                  | Worker                        | Integration issue | Initial collection                                  |
| ------------------- | ------------------------------ | ----------------------------- | ----------------- | --------------------------------------------------- |
| ForgeGraph          | `ForgeGraph/apps/web`          | `forgegraf` (OpenNext)        | FORGE-324         | Product screen categories, stored anonymous session |
| Kanbanger           | `kanbanger/apps/web`           | `linear-clone` (`production`) | KANBAN-65         | Product screen categories, stored anonymous session |
| educateOS marketing | `school-os/sites/educateos-io` | `educateos-site`              | SCHO-319          | Allowlisted marketing pages, cookieless             |

The shared support implementation is DATFLR-6. DATFLR-1 owns the deployment. DATFLR-2/3 own the independent education privacy/legal work. The educateOS code is presently in school-os; its destination during the T3Code migration must retain these boundaries.

## Prepare any app

```sh
# From this source checkout; this generates inspected kits without editing app repos or registering projects.
node scripts/prepare-app-integrations.ts /Volumes/dev

# In an app worktree (or pass its absolute path); no deployment/admin key needed.
dataflare client-init --dir apps/web --config wrangler.jsonc --env production \
  --host https://observe.gmac.io --project kanbanger --local
```

For ForgeGraph use `apps/web/wrangler.toml` with no named environment. For educateOS use `sites/educateos-io/wrangler.jsonc`. Config paths are relative to `--dir`. Rerunning without `--local` registers the project using `GLASS_API_KEY`, preserving existing origin restrictions. Settings are saved for subsequent reruns. `--dry-run --json` previews without network or files. Existing changed files are protected.

The committed `integrations/` kits are generated from real local configs. They contain no keys and do not prove enrollment or deployment. Refresh kits intentionally and review diffs. The ForgeGraph app inventory is available through `forge app inventory --json`; it describes registered repositories, not verified Cloudflare deployments. Use each app's own project ID and owning issue for further rollout. Do not infer fleet enrollment from these three pilots.

## Browser and Worker hooks

The conservative generated `browser.js` must be served as a local asset and loaded with `data-enabled="true"` only after activation. It loads the SDK without automatic initialization, then installs a beforeSend filter before the first capture. It captures only pageviews mapped to fixed top-level screen categories. Titles, referrers, query strings, dynamic IDs, custom properties and flags are removed. Clicks, errors, web vitals, replay and flag evaluation are disabled. DNT/GPC prevent loading the remote SDK. Unknown product routes become `other`; additional categories must be reviewed explicitly. App-specific domain events and browser/server correlation are separate instrumentation work.

The prepared ForgeGraph hook uses `NEXT_PUBLIC_DATAFLARE_ENABLED=true`; Kanbanger uses `VITE_DATAFLARE_ENABLED=true`. These are build settings: rebuild through the normal app pipeline to activate. Neither is enabled by this change. educateOS's stamp adds a disabled local script only on approved marketing paths. Changing `data-enabled` to true in that stamp and rebuilding is the explicit marketing activation. The bootstrap also rejects unknown/restricted routes at runtime, including SPA navigation. The demo promises no third-party traffic and remains excluded, as do intake, operator, registry, district and student surfaces. Cookieless records remain protected data; this is not anonymization or student privacy authorization.

Generated `worker.ts` supports direct HTTPS capture with `capture({}, event)` or an optional `DATAFLARE` service binding. Same-origin `dataflareProxy` requires the binding; it never silently falls back to an external rewrite. Once the Worker name and same-account access are verified, rerun client-init with `--service`, merge the generated services fragment into the selected environment, and mount the handler before the app router. Binding additions are not automatic and do not overwrite existing config. educateOS is in a different Cloudflare account from the proposed gmacko analytics deployment, so a same-account service binding must not be assumed.

`capture` requests a JSON acknowledgement from ingest, and rejects on zero accepted events or an older deployment without acknowledgement support. Browsers retain the existing 204 response. A successful acknowledgement means the event store accepted the write; it does not install an application outbox or promise exactly-once lake delivery. Persist IDs and timestamps with transitions, retry them unchanged, and inspect catalog/policy rejections rather than retrying invalid payloads forever.

## Live activation gates

1. Enable R2 in gmacko as recorded on DATFLR-1, finish the analytics deployment, attach `observe.gmac.io`, and verify `/health` reports the expected revision/store. The preparation probe returned HTTP 522 and `forge target list --app dataflare` returned no targets.
2. Deploy the local Dataflare fork containing journey/policy and acknowledgement changes. Upgrade the deployment's append-only migrations; do not copy only the SDK.
3. Register separate projects and approved origins; establish the reviewed capture policy/catalog. Keep all keys in ForgeGraph secrets. Deployment read/admin keys are fleet-wide, not district isolation.
4. Activate each app through its normal ForgeGraph pipeline. Verify a browser pageview and a stable-ID Worker event, absence of secrets/sensitive payloads, source freshness and the app's session Sankey. Marketing cookieless capture does not provide stable product sessions.
5. Keep owning production issues open until deployment and health evidence are recorded. No Flightdeck removal until its case-lifecycle behavior and required data have a verified replacement.
