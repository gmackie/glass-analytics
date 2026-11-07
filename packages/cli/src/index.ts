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
import { events, person, projects, query, replays, sql } from './commands/data.ts';
import { experiments, flags as flagCommands } from './commands/flags.ts';
import { init } from './commands/init.ts';
import { lakeMaintain } from './commands/lake.ts';
import { mcpBridge } from './commands/mcp.ts';
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
  dataflare key [--read]         Print the dashboard URL and API key

${color.bold('Ask questions')}
  dataflare query web [--from -7d]
  dataflare query trends --event signup_completed [--math unique_persons] [--interval week] [--breakdown browser]
  dataflare query funnel --steps '$pageview,signup_started,signup_completed' [--window 1d] [--breakdown utm_source]
  dataflare query retention --cohort signup_completed [--return '$pageview'] [--period week]
  dataflare query <kind> --spec '<json>'   Any spec; see GET /api/schema
    common: --from, --to, --where prop=value[,…], --project, --sql (print SQL)
  dataflare sql "SELECT …"       Read-only SQL against your events
  dataflare events [name]        Tracked events, or one event's properties
    --describe "<text>"            How/when the event fires (document custom events)
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
  dataflare mcp                  MCP server over stdio (what .mcp.json runs)

Environment: GLASS_HOST, GLASS_API_KEY and GLASS_PROJECT override .glass/ settings.
Docs: https://github.com/ISNIT0/glass-analytics`;

// Every option must be declared: undeclared options would parse as booleans and lose their values.
const STRING_OPTIONS = [
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
];
const BOOLEAN_OPTIONS = [
  'json',
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
  'read',
  'sql',
  'errors',
  'enable',
  'disable',
  'delete',
];

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
  const flags = values as Record<string, string | boolean | undefined>;
  const [command, sub, arg, ...rest] = positionals;

  if (flags.version) return line(GLASS_VERSION);
  if (!command || command === 'help' || (flags.help && !command)) return line(HELP);

  // Surface an outdated Worker before the real command (skip setup/status/mcp noise).
  const skipUpgradeWarn = new Set([
    'init',
    'upgrade',
    'deploy',
    'ci',
    'status',
    'doctor',
    'mcp',
    'key',
  ]);
  if (command && !skipUpgradeWarn.has(command)) {
    await warnIfOutdated({ json: Boolean(flags.json) });
  }

  switch (command) {
    case 'init':
      return init({
        token: str(flags.token),
        account: str(flags.account),
        project: str(flags.project),
        name: str(flags.name),
        route: str(flags.route),
        noRoute: Boolean(flags['no-route']),
        retentionDays: flags['retention-days'] ? Number(flags['retention-days']) : undefined,
        lake: flags.lake === true ? true : undefined,
        eu: flags.eu === true ? true : undefined,
        replay: flags['no-replay'] ? false : undefined,
        agentFiles: flags['no-agent-files'] ? false : undefined,
        ci: flags['no-ci'] ? false : undefined,
        dryRun: Boolean(flags['dry-run']),
        json: Boolean(flags.json),
      });
    case 'upgrade':
    case 'deploy':
      return upgrade({
        token: str(flags.token),
        json: Boolean(flags.json),
        ci: flags.ci === true ? true : undefined,
        local: Boolean(flags.local),
        allowDowngrade: Boolean(flags['allow-downgrade']),
        retentionDays:
          flags['retention-days'] !== undefined ? Number(flags['retention-days']) : undefined,
        replay: flags['no-replay'] ? false : undefined,
      });
    case 'ci':
      return ci({
        branch: str(flags.branch),
        secret: str(flags.secret),
        json: Boolean(flags.json),
      });
    case 'status':
    case 'doctor':
      return status({ json: Boolean(flags.json) });
    case 'key':
      return key({ read: Boolean(flags.read), json: Boolean(flags.json) });
    case 'query':
      return query(sub, flags);
    case 'sql':
      return sql(sub, flags);
    case 'events':
      return events(sub, flags);
    case 'person':
    case 'persons':
      return person(sub, flags);
    case 'replays':
      return replays(sub, arg, flags);
    case 'projects':
      return projects(sub, arg, flags);
    case 'flags':
      return flagCommands(sub, arg, flags);
    case 'experiments':
      return experiments(sub, arg, rest, flags);
    case 'lake':
      if (sub !== 'maintain')
        throw new UsageError('Unknown lake command.', 'Run `dataflare lake maintain`.');
      return lakeMaintain({
        token: str(flags.token),
        json: Boolean(flags.json),
        dryRun: Boolean(flags['dry-run']),
      });
    case 'mcp':
      return mcpBridge();
    default:
      throw new UsageError(
        `Unknown command "${command}".`,
        'Run `dataflare help` for the list of commands.',
      );
  }
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
