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
  `GLASS_DISTRICT_CREDENTIALS_JSON` (district).

Worker secrets (`GLASS_ADMIN_KEY`, `GLASS_READ_KEY`, `GLASS_SALT_SECRET` and, on lake deployments,
the read-only `CF_API_TOKEN`) were set at install and are never synced from ForgeGraph: every
target has `syncSecrets: false`.

`node scripts/check-deployments.ts` (in CI) checks that each config points at the built bundle,
that the CLI and wrangler configs agree (including retention), and that no credential is committed.

## Retention

`observe` keeps events for 365 days (DATFLR-16, 2026-11-22): `retentionDays` in `config.json`,
which the daily `lake-maintain` workflow applies to the Basin tables, and `GLASS_RETENTION_DAYS` in
`wrangler.jsonc`, which the usage report shows. The Worker can't delete lake rows itself.
`educateos-site` and `district` keep events for 395 days, set the same way.
