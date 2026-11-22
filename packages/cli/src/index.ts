/**
 * The `glass` CLI.
 *
 *   npx dataflare-cli init              deploy into your Cloudflare account
 *   npx dataflare-cli query web         ask questions from the terminal
 *   npx dataflare-cli mcp               stdio MCP server for coding agents
 *
 * Every command accepts --json for machine-readable output.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GLASS_VERSION } from '@dataflare/core/version';
import { clientInit } from './commands/client-init.ts';
import { events, group, groups, person, projects, query, replays, sql } from './commands/data.ts';
import { email } from './commands/email.ts';
import { experiments, flags as flagCommands } from './commands/flags.ts';
import { importEvents } from './commands/import.ts';
import { init } from './commands/init.ts';
import { lakeMaintain } from './commands/lake.ts';
import { mcpBridge } from './commands/mcp.ts';
import { sourcemaps } from './commands/sourcemaps.ts';
import { revenueRates, stripeImport } from './commands/stripe.ts';
import { ci, key, status, upgrade } from './commands/upgrade.ts';
import { UsageError } from './config.ts';
import { color, fail, line } from './output.ts';
import { warnIfOutdated } from './upgrade-check.ts';

const HELP = `${color.bold('dataflare')} ${GLASS_VERSION}: agent-first analytics in your own Cloudflare account

${color.bold('Set up')}
  dataflare init                 Deploy Dataflare and wire it into this project
    --token <token>                Cloudflare API token (or CLOUDFLARE_API_TOKEN)
    --account <id>                 Cloudflare account id (or CLOUDFLARE_ACCOUNT_ID)
    --project <id>                 Project id (default: package.json name)
    --name <name>                  Worker and resource name (default: glass)
    --route <host>                 Also serve from your domain at /_glass, e.g. --route acme.com
    --no-route                     Remove the route set by an earlier init
    --retention-days <n>           Delete events older than n days (default: keep)
    --lake                         Store events in Iceberg on R2 (Pipelines + Basin SQL)
    --eu                           Keep data in the EU jurisdiction
    --no-replay                    Skip session replay storage
    --no-agent-files               Don't write AGENTS.md, SKILL.md or .mcp.json
    --no-ci                        Don't write .github/workflows/glass.yml
    --dry-run                      Show what would be created
  dataflare client-init          Connect this app repo to an existing Dataflare deployment
    --host <url>                  Existing Dataflare HTTPS URL (or GLASS_HOST)
    --project <id>                App project id (default: package.json name)
    --service <worker>            Generate same-origin Worker/DO service-binding integration
    --frontend-only               Pages/static site: browser snippet and registration only
                                   (auto for pages_build_output_dir, Jekyll, Hugo, plain HTML)
    --static-dir <dir>            Directory served at the site root, for dataflare.js
    --origins <a,b>               Allowed browser origins (default: Jekyll url or CNAME)
    --dry-run                     Preview files without registering or writing
                                   Set GLASS_API_KEY for project registration; never saved
  dataflare upgrade              Move to this CLI's version of Dataflare and migrate
                                   With .github/workflows/glass.yml: stage into .glass/ only;
                                   commit and push, and CI deploys it
    --ci                           Deploy as CI (no prompts; default when CI=true)
    --local                        Deploy from here even though a CI workflow exists
    --allow-downgrade              Replace a newer deployed Worker with this older one
    --retention-days <n>           Delete events older than n days (0 keeps them)
    --no-replay                    Turn session replay off; upgrades stop creating its bucket
  dataflare ci [--branch main]   Write the workflow that deploys Dataflare from CI
    --secret <name>                Repo secret with the Cloudflare token (default CLOUDFLARE_API_TOKEN)
  dataflare status               Check the deployment end to end
  dataflare lake maintain        Lake mode: erase queued people, apply retention (CI runs it daily)
  dataflare email enable --from reports@acme.com   Email reports and alerts (Cloudflare Email Sending, Workers Paid)
  dataflare email disable
  dataflare key [--read|--server] Print the dashboard URL and an API key (admin, read-only, or for servers)

${color.bold('Ask questions')}
  dataflare query web [--from -7d]
  dataflare query trends --event signup_completed [--math unique_persons] [--interval week] [--breakdown browser]
  dataflare query funnel --steps '$pageview,signup_started,signup_completed' [--window 1d] [--breakdown utm_source]
  dataflare query retention --cohort signup_completed [--return '$pageview'] [--period week]
  dataflare query paths [--start /pricing] [--end signup_completed] [--steps 5] [--events] [--by session]
  dataflare query <kind> --spec '<json>'   Any spec; see GET /api/schema
    common: --from, --to, --where prop=value[,…], --project, --sql (print SQL)
  dataflare sql "SELECT …"       Read-only SQL against your events
  dataflare events [name]        Tracked events, or one event's properties
    --describe "<text>"            How/when the event fires (document custom events)
  dataflare groups [type] [--search text]
                                 Group types, or the groups of a type (companies, workspaces…)
  dataflare group <type> <key> [--delete]
                                 A group's properties and members, or erase it
  dataflare person <id> [--delete]   One person's properties and events (or erase them)
  dataflare replays [--errors] [--rage] [--url /checkout] [--not purchase] [--search text] [--sort most_frustrated]
                                 Find recorded sessions
  dataflare replays summary <id> [--full]   A session as a text transcript
  dataflare replays snapshot <id> --at 01:24   What was on screen at a moment
  dataflare replays note <id> --at 00:14 --text "…"   Pin a finding to a moment
  dataflare replays analyse [--from -7d]   Patterns: rage/dead clicks, errors, failing requests

${color.bold('Flags and experiments')}
  dataflare flags [list]
  dataflare flags set <key> [--rollout 25] [--variants control:50,test:50] [--enable|--disable] [--rules '<json>']
  dataflare flags delete <key>
  dataflare experiments [list]
  dataflare experiments create <key> --goal <event> [--flag <key>] [--hypothesis "…"]
  dataflare experiments start|stop <key>
  dataflare experiments ship <key> <variant>
  dataflare experiments results <key>

${color.bold('Agents')}
  dataflare import <file> [--preset posthog|mixpanel|amplitude|segment|ga4] [--format ndjson|json|csv] [--dry-run]
                                 (alpha) Import a history of events, keeping their timestamps
  dataflare sourcemaps upload <dir> --release <version> [--url-prefix /assets]
                                 Upload a build's source maps for error tracking (also: list, delete)
  dataflare stripe import --api-key rk_… [--since 2024-01-01]
                                 Import Stripe revenue history (invoices, charges, refunds, subscriptions)
  dataflare revenue rates [--since 2024-01-01]
                                 Load older ECB exchange rates, for imported revenue in other currencies
  dataflare mcp                  MCP server over stdio (what .mcp.json runs)

Environment: GLASS_HOST, GLASS_API_KEY and GLASS_PROJECT override .glass/ settings.
Docs: https://github.com/ISNIT0/glass-analytics`;

// Every option must be declared: undeclared options would parse as booleans and lose their values.
const STRING_OPTIONS = [
  'host',
  'service',
  'static-dir',
  'origins',
  'token',
  'account',
  'project',
  'name',
  'route',
  'branch',
  'secret',
  'from',
  'to',
  'event',
  'math',
  'property',
  'interval',
  'breakdown',
  'steps',
  'window',
  'cohort',
  'return',
  'period',
  'periods',
  'spec',
  'where',
  'start',
  'end',
  'by',
  'limit',
  'days',
  'describe',
  'person',
  'rollout',
  'variants',
  'rules',
  'description',
  'goal',
  'flag',
  'value',
  'hypothesis',
  'variant',
  'retention-days',
  'format',
  'preset',
  'release',
  'url-prefix',
  'api-key',
  'since',
  'person-key',
  'search',
  'group-type',
  'group-key',
];
const BOOLEAN_OPTIONS = [
  'json',
  'events',
  'lake',
  'eu',
  'no-replay',
  'no-route',
  'no-agent-files',
  'no-ci',
  'ci',
  'local',
  'allow-downgrade',
  'dry-run',
  'frontend-only',
  'read',
  'server',
  'sql',
  'errors',
  'enable',
  'disable',
  'delete',
];

type Flags = Record<string, string | boolean | undefined>;

/** A parsed command line: the flags, and the words after the command. */
interface Invocation {
  flags: Flags;
  sub?: string;
  arg?: string;
  rest: string[];
}

const yes = (v: unknown) => (v === true ? true : undefined);
const no = (v: unknown) => (v ? false : undefined);
const num = (v: unknown) => (v === undefined || v === false ? undefined : Number(v));

const runInit = ({ flags }: Invocation) =>
  init({
    token: str(flags.token),
    account: str(flags.account),
    project: str(flags.project),
    name: str(flags.name),
    route: str(flags.route),
    noRoute: Boolean(flags['no-route']),
    // Given and not empty: 0 is a valid answer (keep events forever).
    retentionDays: flags['retention-days'] ? Number(flags['retention-days']) : undefined,
    lake: yes(flags.lake),
    eu: yes(flags.eu),
    replay: no(flags['no-replay']),
    agentFiles: no(flags['no-agent-files']),
    ci: no(flags['no-ci']),
    dryRun: Boolean(flags['dry-run']),
    json: Boolean(flags.json),
  });

const runUpgrade = ({ flags }: Invocation) =>
  upgrade({
    token: str(flags.token),
    json: Boolean(flags.json),
    ci: yes(flags.ci),
    local: Boolean(flags.local),
    allowDowngrade: Boolean(flags['allow-downgrade']),
    retentionDays: num(flags['retention-days']),
    replay: no(flags['no-replay']),
  });

const runStripe = ({ flags, sub }: Invocation) => {
  if (sub !== 'import')
    throw new UsageError('Usage: dataflare stripe import --api-key rk_… [--since 2024-01-01]');
  return stripeImport({
    apiKey: str(flags['api-key']),
    since: str(flags.since),
    project: str(flags.project),
    personKey: str(flags['person-key']),
    groupType: str(flags['group-type']),
    groupKey: str(flags['group-key']),
    json: Boolean(flags.json),
    dryRun: Boolean(flags['dry-run']),
  });
};

const runRevenue = ({ flags, sub }: Invocation) => {
  if (sub !== 'rates') throw new UsageError('Usage: dataflare revenue rates [--since 2024-01-01]');
  return revenueRates({ since: str(flags.since), json: Boolean(flags.json) });
};

const runLake = ({ flags, sub }: Invocation) => {
  if (sub !== 'maintain')
    throw new UsageError('Unknown lake command.', 'Run `dataflare lake maintain`.');
  return lakeMaintain({
    token: str(flags.token),
    json: Boolean(flags.json),
    dryRun: Boolean(flags['dry-run']),
  });
};

const runClientInit = ({ flags }: Invocation) =>
  clientInit({
    host: str(flags.host),
    project: str(flags.project),
    service: str(flags.service),
    frontendOnly: Boolean(flags['frontend-only']),
    staticDir: str(flags['static-dir']),
    origins: str(flags.origins),
    dryRun: Boolean(flags['dry-run']),
    json: Boolean(flags.json),
  });

const COMMANDS: Record<string, (c: Invocation) => Promise<void> | void> = {
  'client-init': runClientInit,
  init: runInit,
  upgrade: runUpgrade,
  deploy: runUpgrade,
  ci: ({ flags }) =>
    ci({ branch: str(flags.branch), secret: str(flags.secret), json: Boolean(flags.json) }),
  status: ({ flags }) => status({ json: Boolean(flags.json) }),
  doctor: ({ flags }) => status({ json: Boolean(flags.json) }),
  import: ({ flags, sub }) =>
    importEvents(sub, {
      format: str(flags.format),
      preset: str(flags.preset),
      project: str(flags.project),
      json: Boolean(flags.json),
      dryRun: Boolean(flags['dry-run']),
    }),
  stripe: runStripe,
  revenue: runRevenue,
  sourcemaps: ({ flags, sub, arg }) =>
    sourcemaps(sub, arg, {
      release: str(flags.release),
      urlPrefix: str(flags['url-prefix']),
      project: str(flags.project),
      json: Boolean(flags.json),
      dryRun: Boolean(flags['dry-run']),
    }),
  key: ({ flags }) =>
    key({ read: Boolean(flags.read), server: Boolean(flags.server), json: Boolean(flags.json) }),
  query: ({ flags, sub }) => query(sub, flags),
  sql: ({ flags, sub }) => sql(sub, flags),
  events: ({ flags, sub }) => events(sub, flags),
  person: ({ flags, sub }) => person(sub, flags),
  persons: ({ flags, sub }) => person(sub, flags),
  groups: ({ flags, sub }) => groups(sub, flags),
  group: ({ flags, sub, arg }) => group(sub, arg, flags),
  replays: ({ flags, sub, arg }) => replays(sub, arg, flags),
  projects: ({ flags, sub, arg }) => projects(sub, arg, flags),
  flags: ({ flags, sub, arg }) => flagCommands(sub, arg, flags),
  experiments: ({ flags, sub, arg, rest }) => experiments(sub, arg, rest, flags),
  lake: runLake,
  email: ({ flags, sub }) => email(sub, flags),
  mcp: () => mcpBridge(),
};

/** Commands that don't warn about an outdated Worker first (setup, status and the MCP bridge). */
const SKIP_UPGRADE_WARNING = new Set([
  'client-init',
  'init',
  'upgrade',
  'email',
  'deploy',
  'ci',
  'status',
  'doctor',
  'mcp',
  'key',
]);

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      ...Object.fromEntries(STRING_OPTIONS.map((o) => [o, { type: 'string' as const }])),
      ...Object.fromEntries(BOOLEAN_OPTIONS.map((o) => [o, { type: 'boolean' as const }])),
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const flags = values as Flags;
  const [command, sub, arg, ...rest] = positionals;
  if (flags.version) return line(GLASS_VERSION);
  if (!command || command === 'help' || flags.help) return line(HELP);
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run)
    throw new UsageError(
      `Unknown command "${command}".`,
      'Run `dataflare help` for the list of commands.',
    );
  // Surface an outdated Worker before the real command.
  if (!SKIP_UPGRADE_WARNING.has(command)) await warnIfOutdated({ json: Boolean(flags.json) });
  return run({ flags, sub, arg, rest });
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Run when executed directly (the published bin, or `node packages/cli/src/index.ts`).
// npm links the bin under its own name (`dataflare`), so compare real paths, not names.
let invoked = process.argv[1] ?? '';
try {
  invoked = realpathSync(invoked);
} catch {
  // Not a file (e.g. `node -e`): leave it as is.
}
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof UsageError) {
      fail(err.message);
      if (err.hint) process.stderr.write(`  ${err.hint}\n`);
    } else {
      fail(err instanceof Error ? err.message : String(err));
      if (process.env.GLASS_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  });
}
