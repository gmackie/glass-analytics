/**
 * Files written for coding agents by `dataflare init`, so the next agent session
 * already knows how to track events and query Dataflare:
 *
 * - AGENTS.md (and CLAUDE.md if present): a marked section, replaced on re-run
 * - .claude/skills/glass/SKILL.md: recipes, loaded when relevant
 * - .mcp.json (and .cursor/mcp.json if .cursor/ exists): the MCP server
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENT_DOCUMENTATION_GUIDE, EVENT_NAMING_GUIDE } from '@dataflare/core/instrument';
import { NPMRC_SCOPE_LINE } from '@dataflare/core/version';
import { readTextIfExists } from './config.ts';

const START = '<!-- glass:start -->';
const END = '<!-- glass:end -->';

export interface AgentFileOptions {
  root: string;
  host: string;
  project: string;
  /** The install snippet for this project's framework. */
  snippet: { file: string; code: string };
}

export function agentsSection(o: AgentFileOptions): string {
  return `${START}
## Analytics (Dataflare)

This project uses Dataflare for analytics, session replay, feature flags and A/B tests. It runs in our own Cloudflare account; deployment config is in \`.glass/\`.

- Dashboard: ${o.host}/app (print the key with \`npx @gmacko/dataflare-cli key\`)
- MCP server \`glass\` is configured in \`.mcp.json\`. Start with the \`overview\` tool, then \`list_events\` for exact event names.
- Terminal: \`npx @gmacko/dataflare-cli query web --from -7d\`, \`npx @gmacko/dataflare-cli sql "SELECT …"\`, \`npx @gmacko/dataflare-cli --help\`

Tracking (project \`${o.project}\`):
- Install (${o.snippet.file}): \`${o.snippet.code.split('\n').pop()}\`
- Custom events: \`glass.capture('signup_completed', { plan: 'pro' })\`. After login: \`glass.identify(user.id, { plan })\`.
- Consent: if the site has a cookie banner, load Dataflare with \`data-persistence="cookieless"\` and call \`glass.consent(true)\` when the visitor accepts (\`false\` on reject). Cookieless stores nothing on the device; session replay starts after consent unless you add \`data-replay-cookieless="true"\` (records without storing anything; call \`glass.consent(false)\` on load for visitors who rejected). Mention Dataflare on the privacy page.
- If the code already has an analytics helper (a \`track()\` that calls gtag, fbq or PostHog), add \`glass.capture\` inside it rather than at every call site.
- Events that mean success (signup, purchase, pledge): \`mark_event\` with role "conversion" so Reports show conversion rates per source.
- ${EVENT_NAMING_GUIDE}
- After adding an event and deploying, confirm it arrives: \`npx @gmacko/dataflare-cli events <name>\` (or MCP \`describe_event\`).
- ${EVENT_DOCUMENTATION_GUIDE}
- Prefer MCP \`define_event\` so you can set both the event description and each property's meaning in one call.
- Feature flags: \`glass.flag('key')\` returns "on", a variant key, or null; \`glass.flagPayload('key')\` its JSON payload. Create with \`npx @gmacko/dataflare-cli flags set <key> --rollout 10\`.
- Caught errors: \`glass.captureException(err)\`. Set \`data-release\` (or \`release\`) and upload source maps in the build: \`npx @gmacko/dataflare-cli sourcemaps upload ./dist --release <version>\`.
- B2B: \`glass.group('company', org.id, { name, plan })\` after login, so insights can count companies (\`aggregateBy: "company"\`).
- Backend events and flags: \`@gmacko/dataflare-node\` with the server key (\`npx @gmacko/dataflare-cli key --server\`), not the admin key.

Upgrades (the Worker version is pinned in \`.glass/config.json\`):
- \`.github/workflows/glass.yml\` deploys whatever \`.glass/\` holds when it changes on the default branch. If that file is missing, run \`npx @gmacko/dataflare-cli ci\` and add the \`CLOUDFLARE_API_TOKEN\` repository secret.
- To upgrade: \`npx @gmacko/dataflare-cli@latest upgrade\` stages the new Worker and migrations into \`.glass/\` without deploying. Commit and push (or open a PR); CI deploys. Ask before pushing if pushes also deploy the site.
- Do not deploy Dataflare from a laptop (\`dataflare upgrade --local\`, wrangler) once the workflow exists, and never commit \`.glass/credentials.json\`.
- \`dataflare upgrade\` refuses to replace a newer Worker with an older CLI. If it does, use \`@latest\`; do not pass \`--allow-downgrade\`.
${END}`;
}

/** True when CLAUDE.md pulls in AGENTS.md (`@AGENTS.md`), so it needs no copy of the section. */
export function importsAgentsMd(path: string): boolean {
  const text = readTextIfExists(path);
  return text !== undefined && /^@AGENTS\.md\s*$/m.test(text) && !text.includes(START);
}

/** Insert or replace the Dataflare section in a markdown file. */
export function upsertSection(path: string, section: string, createIfMissing: boolean): boolean {
  const existing = readTextIfExists(path);
  if (existing === undefined && !createIfMissing) return false;
  const current = existing ?? '';
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  const next = pattern.test(current)
    ? current.replace(pattern, section)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${section}\n`;
  writeFileSync(path, next);
  return true;
}

export function skillFile(o: AgentFileOptions): string {
  return `---
name: glass
description: Use when adding analytics events, answering questions about traffic, signups, conversion, retention or errors, debugging what a user did in a session, or creating feature flags and A/B tests in this project.
---

# Dataflare analytics

Dataflare is deployed at ${o.host} (project \`${o.project}\`). Prefer the \`glass\` MCP tools; the CLI (\`npx @gmacko/dataflare-cli …\`) does the same things.

## Answer a question about usage

1. \`overview\` for the period (visitors, top pages, errors, events that moved). If it (or MCP init) says an upgrade is available, tell the user; with their go-ahead, follow "Upgrade Dataflare" below.
2. \`list_events\` to get exact event names — never guess them.
3. The right query: \`query_trends\` (counts over time), \`query_funnel\` (conversion through steps), \`query_retention\` (who comes back), \`query_paths\` (where people go, step by step), \`sql\` when nothing else fits.
4. Report numbers with the dashboard link and SQL from the result.

## Add tracking

1. \`instrument\` with the event name returns the exact code for this framework.
2. ${EVENT_NAMING_GUIDE}
3. After deploying, \`describe_event\` (or \`npx @gmacko/dataflare-cli events <name>\`) confirms events arrive with the expected properties.
4. Always \`define_event\` next. ${EVENT_DOCUMENTATION_GUIDE}
5. If the event means a visitor succeeded (signup, purchase, pledge, lead), \`mark_event\` with role "conversion"; for engagement worth watching (share, search, download), role "important". Reports show conversion rates overall and per traffic source.

## First session on a project

1. \`overview\` then \`list_events\`.
2. For every name in \`undocumented\`, read the code that fires it (or ask), then \`define_event\` with how/when it fires and property meanings.
3. Do not invent funnel or trend queries against undocumented custom events until those descriptions exist.

## Debug a user problem

1. \`query_funnel\` with a breakdown (browser, device, utm_source) to find where people drop.
2. \`list_replays\` to find affected sessions: \`has: ["errors"]\` or \`["rage_clicks"]\`, a \`person\`, or \`did_event\` (the step before the drop) with \`not_event\` (the step after).
3. \`summarise_replay\` to read what happened: pages, clicks with CSS selectors, rage and dead clicks, errors with stack frames, failed requests, console errors.
4. \`replay_snapshot\` at the moment it goes wrong to see what was on screen; search the code for the clicked element's selector.
5. \`annotate_replay\` with the cause, so the next person watching the session sees it.

For "what's frustrating users?", start with \`analyse_replays\` for the period.

## Upgrade Dataflare

1. \`npx @gmacko/dataflare-cli@latest upgrade\`. With \`.github/workflows/glass.yml\` present this only stages \`.glass/\` (Worker, migrations, pinned version); nothing deploys.
2. No workflow yet? \`npx @gmacko/dataflare-cli ci\` writes it; the repo needs secret \`CLOUDFLARE_API_TOKEN\` (\`gh secret set CLOUDFLARE_API_TOKEN\`).
3. Commit \`.glass/\` and push to the default branch (or open a PR). The Dataflare workflow migrates D1 and deploys.
4. \`npx @gmacko/dataflare-cli status\` confirms the new version is live.

## Run an experiment

1. \`create_experiment\` with a goal event (creates a control/test flag).
2. In code: \`if (glass.flag('<key>') === 'test') { … }\` — reading the flag records the exposure.
3. \`update_experiment\` with \`action: "start"\`; later \`experiment_results\`; ship the winner with \`action: "ship"\`.
4. Judge it on more than one number: \`metrics\` (the first decides) and \`secondary\` guardrails such as errors or refunds (\`goal: "decrease"\`). \`plan_experiment\` says how long it needs.

## Triage errors

1. \`list_issues\` (status "active", order by events) for the period.
2. \`get_issue\` for the top one: mapped stack trace, releases, browsers, pages, people affected, and replays that open just before the error.
3. \`summarise_replay\` on one of them to see what the person did; fix the code at the mapped frame.
4. \`update_issue\` to resolve it once the fix is deployed (it reopens as a regression if it comes back), or \`merge_issues\` for duplicates.

## Revenue questions

1. \`get_settings\`: revenue needs \`revenueEvents\` (or Stripe: \`stripe_status\`). Without them, help set them up first.
2. \`query_revenue\` with \`breakdown\` ("product", "channel", "utm_campaign", "person.plan") for MRR, churn and where revenue comes from; \`aggregateBy: "company"\` for accounts.
3. For one customer: \`get_person\` (lifetime revenue) or \`get_group\`.

## Send events to another tool (alpha)

Destinations, transformations, exports and imports are alpha: their settings may change between releases, so try them on a test project or a webhook first.


1. \`list_destination_templates\`, then \`save_destination\` with the events and the template's settings (credentials are encrypted).
2. \`test_destination\` sends a sample; \`get_destination\` shows deliveries and failures, \`retry_destination\` resends failures.
3. To clean data before it is stored (drop test events, hash or redact properties), \`save_transformation\` and try it with \`test_transformation\`.
`;
}

export function upsertMcpConfig(path: string): boolean {
  let config: { mcpServers?: Record<string, unknown> } = {};
  const existing = readTextIfExists(path);
  if (existing !== undefined) {
    try {
      config = JSON.parse(existing) as typeof config;
    } catch {
      return false; // don't overwrite a file we can't parse
    }
  }
  config.mcpServers = {
    ...config.mcpServers,
    glass: { command: 'npx', args: ['-y', '@gmacko/dataflare-cli', 'mcp'] },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/**
 * Add the @gmacko scope line to the project's .npmrc so `npx @gmacko/dataflare-cli` and
 * `npm i @gmacko/dataflare-web` resolve from the ForgeGraph registry, locally and in CI
 * (DATFLR-27). Returns false when the line is already there.
 */
export function upsertNpmrc(path: string): boolean {
  const existing = readTextIfExists(path);
  if (existing?.split(/\r?\n/).some((line) => line.trim().startsWith('@gmacko:registry=')))
    return false;
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : (existing ?? '');
  writeFileSync(path, `${prefix}${NPMRC_SCOPE_LINE}\n`);
  return true;
}

/** Write all agent files. Returns the paths written, relative to root. */
export function writeAgentFiles(o: AgentFileOptions): string[] {
  const written: string[] = [];
  const section = agentsSection(o);
  if (upsertSection(join(o.root, 'AGENTS.md'), section, true)) written.push('AGENTS.md');
  // A CLAUDE.md that only imports AGENTS.md already gets the section; writing it twice duplicates it.
  if (
    !importsAgentsMd(join(o.root, 'CLAUDE.md')) &&
    upsertSection(join(o.root, 'CLAUDE.md'), section, false)
  )
    written.push('CLAUDE.md');
  const skill = join(o.root, '.claude', 'skills', 'glass', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, skillFile(o));
  written.push('.claude/skills/glass/SKILL.md');
  if (upsertMcpConfig(join(o.root, '.mcp.json'))) written.push('.mcp.json');
  if (upsertNpmrc(join(o.root, '.npmrc'))) written.push('.npmrc');
  if (existsSync(join(o.root, '.cursor')) && upsertMcpConfig(join(o.root, '.cursor', 'mcp.json')))
    written.push('.cursor/mcp.json');
  return written;
}
