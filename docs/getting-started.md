# Getting started

Dataflare deploys into your Cloudflare account with one command. You need a Cloudflare account and Node 20+.

## 1. Create an API token

At [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens), create a custom token with:

| Permission                                                                        | Why                             |
| --------------------------------------------------------------------------------- | ------------------------------- |
| Account › Workers Scripts › Edit                                                  | Deploy the Dataflare Worker     |
| Account › D1 › Edit                                                               | Create and migrate the database |
| Account › Workers R2 Storage › Edit                                               | Store session replays           |
| Account › Account Settings › Read                                                 | Find your account               |
| Zone › Workers Routes › Edit                                                      | Only with `--route`             |
| Account › Pipelines › Edit, Workers R2 Data Catalog › Edit, Workers R2 SQL › Read | Only with `--lake`              |

The token is used by the CLI on your machine. It is not stored by Dataflare, except in lake mode, where it becomes a Worker secret so the Worker can query Basin SQL. (Use a separate read-only token there if you prefer; see [lake.md](lake.md).)

## 2. Run `dataflare init`

From your project's root:

```sh
CLOUDFLARE_API_TOKEN=… npx dataflare-cli init
```

It will:

1. Create a D1 database (`glass`) and an R2 bucket for replays (`glass-replays`). If R2 isn't enabled on your account yet, replay is skipped; enable R2 in the dashboard and run `dataflare upgrade` later.
2. Deploy the Dataflare Worker to `https://glass.<your-subdomain>.workers.dev`, apply migrations, and set its secrets (two API keys and a salt).
3. Create a project named after your `package.json` (override with `--project`).
4. Send a test event and check it arrived.
5. Print the install snippet for your framework, and write files for your coding agent: `AGENTS.md` (and `CLAUDE.md` if you have one), `.claude/skills/glass/SKILL.md` and `.mcp.json`.
6. Write `.github/workflows/glass.yml`, so later upgrades deploy from CI rather than from your machine (see [Upgrading](#upgrading)).

It also creates `.glass/` in your project. Commit it (`config.json`, `wrangler.jsonc`, `worker.js`, `migrations/`); `credentials.json` holds your keys and is git-ignored automatically.

Useful flags:

| Flag                   |                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`            | Show what would be created, change nothing                                                                                                   |
| `--account <id>`       | Choose the account non-interactively                                                                                                         |
| `--project <id>`       | Project id (lowercase letters, digits, `-`, `_`)                                                                                             |
| `--eu`                 | Create the database and buckets in the EU jurisdiction                                                                                       |
| `--route acme.com`     | Also serve Dataflare from your own domain at `/_glass` (first-party, so ad blockers don't block it). Needs the domain on Cloudflare, proxied |
| `--no-route`           | Remove a route set by an earlier init                                                                                                        |
| `--retention-days <n>` | Delete events older than n days (also on `dataflare upgrade`)                                                                                |
| `--lake`               | Store events in Iceberg on R2 instead of D1 (for high volume; not with --eu)                                                                 |
| `--no-replay`          | Skip replay storage                                                                                                                          |
| `--no-agent-files`     | Don't write AGENTS.md, SKILL.md or .mcp.json                                                                                                 |
| `--no-ci`              | Don't write `.github/workflows/glass.yml`                                                                                                    |
| `--json`               | Machine-readable output                                                                                                                      |

`dataflare init` is safe to re-run: it finds existing resources and keeps your keys.

Each deployment is named after its project (`glass-<project>`: Worker, D1 database, replay bucket), so several sites can each have their own Dataflare in one Cloudflare account. Pass `--name` to choose another.

**Sites not on Cloudflare** (Vercel, Netlify): load the snippet straight from the Worker's URL. A rewrite or proxy from your own domain makes every visitor look like the proxy's server, which breaks countries and cookieless visitor counts.

**Cookie banners:** load Dataflare with `data-persistence="cookieless"` (it stores nothing on the device, so it can run before consent) and call `glass.consent(true)` when the visitor accepts, `glass.consent(false)` when they reject. Cross-day visitor ids and session replay start after consent; add `data-replay-cookieless="true"` to record visitors who haven't chosen yet, still storing nothing on the device. Add Dataflare to your privacy page.

Already have a shared Dataflare deployment? Use [`dataflare client-init`](client-init.md) in each app repo to register it and generate browser and Worker/DO integration files.

## 3. Add the snippet

The script tag works everywhere and needs no build step:

```html
<script defer src="https://glass.<you>.workers.dev/s.js" data-project="my-app"></script>
```

| Framework            | Where                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Next.js              | `app/layout.tsx`: `<Script src="…/s.js" data-project="my-app" strategy="afterInteractive" />` from `next/script` |
| Astro                | `src/layouts/Layout.astro`, with `is:inline` on the script tag                                                   |
| SvelteKit            | `src/app.html`                                                                                                   |
| Nuxt                 | `app.head.script` in `nuxt.config.ts`                                                                            |
| Remix / React Router | `app/root.tsx`                                                                                                   |
| Vite apps            | `npm i dataflare-web`, then `glass.init({ host, project })` in `main.ts`                                         |
| Server-side          | `POST <host>/e`; see [sdk.md](sdk.md#server-side-events)                                                         |

## 4. Track what matters

Pageviews, clicks on links and buttons, JavaScript errors and web vitals are captured automatically. Add the events that describe your product:

```js
glass.capture('signup_completed', { plan: 'pro' });
glass.identify(user.id, { plan: user.plan, company_size: 12 }); // after login or signup
```

Without JavaScript:

```html
<button data-glass-event="pricing_cta_clicked" data-glass-prop-plan="pro">Start trial</button>
```

Name events `object_action` in snake_case and past tense. Put details in properties, and never send emails, names or other personal data.

Document every custom event once it is shipping — agents and teammates need to know **how and when** it fires, and **what each property means**:

```sh
npx dataflare-cli events signup_completed --describe "Fired when the user finishes signup after email verification."
```

Prefer the MCP `define_event` tool so you can set property meanings in the same call (`plan` → chosen plan id, etc.). `list_events` returns an `undocumented` list; clear it before building funnels or trends on those events.

## 5. Look at the data

- **Dashboard:** `https://glass.<you>.workers.dev/app`. Sign in with the key from `npx dataflare-cli key`. Share a view-only dashboard with `npx dataflare-cli key --read`.
- **Your agent:** with `.mcp.json` in place, ask "what were our top traffic sources this week?". See [agents.md](agents.md).
- **Terminal:** `npx dataflare-cli query web --from -7d`, `npx dataflare-cli events`, `npx dataflare-cli --help`.

## Upgrading

Init is the only deploy that has to run on your machine. After that, the Dataflare version is pinned in `.glass/config.json` and `.github/workflows/glass.yml` deploys whatever `.glass/` holds when it changes on your default branch.

One-time setup, right after init (agents should do this as part of init):

1. Add a repository secret `CLOUDFLARE_API_TOKEN` holding a Cloudflare API token with the same scopes as init: `gh secret set CLOUDFLARE_API_TOKEN`.
2. Commit `.glass/` and `.github/workflows/glass.yml` and push. (`credentials.json` stays git-ignored; the Worker's keys were set by init and survive every deploy.)

To upgrade:

```sh
npx dataflare-cli@latest upgrade   # stages the new Worker, migrations and version into .glass/; deploys nothing
git add .glass && git commit -m "Upgrade Dataflare" && git push   # or open a PR; CI migrates and deploys
```

In CI, the workflow runs `npx dataflare-cli@<pinned version> upgrade --ci`, which applies migrations and redeploys without prompts or local credentials.

- No workflow yet (installed before this existed, or with `--no-ci`)? `npx dataflare-cli ci` writes it. Options: `--branch`, `--secret`. A workflow you have edited by hand (without the generated header) is left alone.
- No GitHub Actions? Without the workflow, `dataflare upgrade` deploys directly, as before. `dataflare upgrade --local` forces a direct deploy even when the workflow exists; use it only in emergencies, since the repo then no longer matches what is live.
- `dataflare upgrade` refuses to replace a newer Worker with an older one (for example a stale `npx` cache). Use `@latest`. `--allow-downgrade` overrides this.

You'll also be told when an upgrade is available: the dashboard shows a banner after login, `dataflare status` (and other CLI commands) print a reminder, and MCP/`overview` include `upgradeAvailable` so agents can ask you to run the command above.

## Removing Dataflare

Delete the Worker, the D1 database and the R2 buckets from the Cloudflare dashboard (they're all named after `--name`, `glass` by default), then delete `.glass/` and the Dataflare section of `AGENTS.md`.
