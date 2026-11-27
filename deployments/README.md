# Deployments

The Dataflare Workers we run, deployed by ForgeGraph (app `dataflare`) from this fork (DATFLR-7).
A merge to `main` runs CI (`.forgejo/workflows/ci.yml`). Each ForgeGraph target then builds the
Worker from source with `pnpm build` and deploys it: D1 migrations first, then `wrangler deploy`.

| Directory         | Worker                     | Cloudflare account    | Health                                                               | Store      |
| ----------------- | -------------------------- | --------------------- | -------------------------------------------------------------------- | ---------- |
| `district/`       | `glass-educateos-district` | gmacko `f84fe044…`    | `https://glass-educateos-district.educateos-demo.workers.dev/health` | D1         |
| `educateos-site/` | `glass-educateos-site`     | EducateOS `c07a7e70…` | `https://educateos.io/_glass/health`                                 | Basin lake |
| `observe/`        | `dataflare-observe`        | EducateOS `c07a7e70…` | `https://observe.gmac.io/health`                                     | Basin lake |

Each `.glass/` has:

- `wrangler.jsonc`: what ForgeGraph deploys. `main` and `migrations_dir` point at
  `packages/worker/dist/`, which `pnpm build` writes. Edit this file directly; the Dataflare CLI's
  `upgrade` is not used here, because upstream releases arrive as merges into this fork.
- `config.json`: what the CLI reads for operational commands run from the deployment directory
  (`dataflare lake maintain`, `dataflare person <id> --delete`, `dataflare sql`).
- `credentials.json` (git-ignored): the dashboard admin key, read key and salt. Copies are in
  ForgeGraph, app `dataflare`, stage `production`: `GLASS_CREDENTIALS_JSON` (educateos-site) and
  `GLASS_DISTRICT_CREDENTIALS_JSON` (district). For Observe, the read key is stored separately.
  From this checkout on a Mac, run `forge secret get OBSERVE_READ_KEY --stage production | pbcopy`,
  then paste into **Read key** in the iPhone app and connect to `https://observe.gmac.io`.

Worker secrets (`GLASS_ADMIN_KEY`, `GLASS_READ_KEY`, `GLASS_SALT_SECRET` and, on lake deployments,
the read-only `CF_API_TOKEN`) were set at install and are never synced from ForgeGraph: every
target has `syncSecrets: false`.

`node scripts/check-deployments.ts` (in CI) checks that each config points at the built bundle,
that the CLI and wrangler configs agree (including retention), and that no credential is committed.

## Observe dashboard sign-in

Sign in to Observe with Cloudflare Access. [Open the dashboard](https://observe.gmac.io/app)
The `Observe analytics dashboard` Access application protects `/app` and `/_glass/app`, including their
browser APIs. The session lasts 24 hours. The Worker checks the application's audience and the signed-in
administrator's email using Cloudflare's authenticated Worker context. To change the administrator,
update the Access policy and set `GLASS_ACCESS_ADMIN_EMAIL_SHA256` to the SHA-256 of the trimmed,
lowercase email address (UTF-8, no trailing newline).

Scripts and agents still use bearer keys on `/api` and `/mcp`. Sites send events to their existing
public collection URLs.

## Retention

`observe` keeps events for 365 days (DATFLR-16, 2026-11-22): `retentionDays` in `config.json`,
which the daily `lake-maintain` workflow applies to the Basin tables, and `GLASS_RETENTION_DAYS` in
`wrangler.jsonc`, which the usage report shows. The Worker can't delete lake rows itself.
`educateos-site` and `district` keep events for 395 days, set the same way.

## Dataflare's own usage

Observe sets `GLASS_DASHBOARD_ANALYTICS_PROJECT=dataflare` to record anonymous dashboard usage on its own Worker. Other Workers can opt in by setting this to a project they have registered locally. The dashboard uses its bundled web SDK, records named views after sign-in and strips viewed project IDs, URL parameters, referrers, titles and report contents before collection. Browser automation carries `traffic=verification`.

The Dataflare project combines web and iPhone activity with `surface=web|ios`. `app_opened` counts a dashboard document or app launch. `report_viewed` counts a successful overview or Paths result once per visit, including empty results with `has_data=false`. `path_detail_opened` distinguishes a step from a transition. The iPhone also records `worker_connection` attempts and outcomes. Use `traffic=usage` for product metrics and `mode=live` for real reports.
