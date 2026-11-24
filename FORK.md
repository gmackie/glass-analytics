# This fork's packages

Upstream publishes `dataflare-cli`, `dataflare-web` and `dataflare-node` to npm. This fork
(gmackie/glass-analytics) never publishes those names. Its builds are
`@gmacko/dataflare-cli`, `@gmacko/dataflare-web` and `@gmacko/dataflare-node` on the private
ForgeGraph registry, `https://npm.forgegraf.com/` (DATFLR-27).

Using them:

```sh
# once per project (dataflare init and client-init add it for you)
echo '@gmacko:registry=https://npm.forgegraf.com/' >> .npmrc

npx @gmacko/dataflare-cli init
npm i @gmacko/dataflare-web
```

The registry serves `@gmacko/*` locally, never from npmjs, and anyone can read it. Publishing
needs a ForgeGraph registry token.

Releasing (`.forgejo/workflows/release.yml`):

1. Add a changeset with your change (`pnpm changeset`).
2. Open a version PR: `pnpm version-packages`, then commit and merge it.
3. On that push to main, the Release workflow builds, runs typecheck and tests, and publishes all
   three packages with the `FG_REGISTRY_TOKEN` Forgejo secret. It then pushes the
   `@gmacko/dataflare-*@<version>` tags. Each package's `publishConfig.registry` pins
   npm.forgegraf.com, and the workflow refuses to publish anything that isn't `@gmacko/*`.

Upgrade checks (`/health`, the dashboard, `upgrade`) read the latest version from
`https://npm.forgegraf.com/@gmacko%2fdataflare-cli/latest`.

Upstream's docs and site still say `dataflare-cli`. They are left unchanged so upstream merges
stay clean, so read `dataflare-cli` there as `@gmacko/dataflare-cli`.
