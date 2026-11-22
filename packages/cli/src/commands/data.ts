/**
 * Query commands: `dataflare query`, `dataflare sql`, `dataflare events`, `dataflare person`,
 * `dataflare replays`, `dataflare projects`. Human-readable by default, `--json` for
 * agents and scripts.
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { PathsResult } from '@dataflare/core/insights/paths';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import type { WebResult } from '@dataflare/core/insights/web';
import { call, withProject } from '../client.ts';
import { UsageError } from '../config.ts';
import { color, line, pct, printJson, table } from '../output.ts';

export type Flags = Record<string, string | boolean | undefined>;

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

function showSql(sql: string[] | undefined, flags: Flags): void {
  if (!flags.sql || !sql) return;
  line();
  for (const q of sql) line(color.dim(q));
}

type Spec = Record<string, unknown>;
type Common = { from?: string; to?: string; breakdown?: string; filters?: Spec[] };

function whereFilters(flags: Flags): Spec[] | undefined {
  if (typeof flags.where !== 'string') return undefined;
  return flags.where.split(',').map((w) => {
    const [property, value] = w.split('=');
    if (!property || value === undefined)
      throw new UsageError(`--where expects property=value pairs, got "${w}".`);
    return { property: property.trim(), value: value.trim() };
  });
}

/** A page ("/pricing", "/blog/*") or an event name, for paths. */
const point = (v: string | undefined) =>
  v ? { type: v.startsWith('/') ? 'page' : 'event', value: v } : undefined;

/** How each kind's spec comes from flags. */
const SPECS: Record<string, (flags: Flags, c: Common) => Spec> = {
  web: (_flags, c) => ({ from: c.from, to: c.to, filters: c.filters }),
  trends: (flags, c) => {
    const events = str(flags.event)?.split(',') ?? [];
    if (!events.length)
      throw new UsageError('`dataflare query trends` needs --event <name>[,<name>…]');
    return {
      ...c,
      interval: str(flags.interval),
      series: events.map((event) => ({
        event,
        math: str(flags.math),
        property: str(flags.property),
      })),
    };
  },
  funnel: (flags, c) => {
    const steps = str(flags.steps)?.split(',') ?? [];
    if (steps.length < 2) throw new UsageError('`dataflare query funnel` needs --steps a,b[,c…]');
    return {
      ...c,
      window: str(flags.window),
      steps: steps.map((event) => ({ event: event.trim() })),
    };
  },
  retention: (flags, c) => {
    const cohort = str(flags.cohort);
    if (!cohort)
      throw new UsageError(
        '`dataflare query retention` needs --cohort <event> (and optionally --return <event>)',
      );
    return {
      from: c.from,
      to: c.to,
      filters: c.filters,
      cohortEvent: { event: cohort },
      returnEvent: { event: str(flags.return) ?? cohort },
      period: str(flags.period),
      periods: flags.periods ? Number(flags.periods) : undefined,
    };
  },
  paths: (flags, c) => ({
    from: c.from,
    to: c.to,
    filters: c.filters,
    start: point(str(flags.start)),
    end: point(str(flags.end)),
    steps: flags.steps ? Number(flags.steps) : undefined,
    include: flags.events ? { events: true } : undefined,
    aggregateBy: str(flags.by),
  }),
};

/** Build a spec from flags, or take `--spec '{...}'` verbatim. */
function specFromFlags(kind: string, flags: Flags): Spec {
  if (typeof flags.spec === 'string') {
    try {
      return JSON.parse(flags.spec) as Spec;
    } catch {
      throw new UsageError('--spec is not valid JSON.');
    }
  }
  const build = SPECS[kind];
  if (!build)
    throw new UsageError(
      `Unknown query "${kind}".`,
      'Use web, trends, funnel, retention or paths (or `dataflare sql`).',
    );
  return build(flags, {
    from: str(flags.from),
    to: str(flags.to),
    breakdown: str(flags.breakdown),
    filters: whereFilters(flags),
  });
}

/** How each kind's result prints as tables. */
const PRINTERS: Record<string, (result: unknown) => void> = {
  web: (result) => {
    const r = result as WebResult;
    table(
      ['Metric', 'Value', 'Previous'],
      [
        ['Visitors', r.totals.visitors, r.previous?.visitors ?? 0],
        ['Pageviews', r.totals.pageviews, r.previous?.pageviews ?? 0],
        ['Sessions', r.totals.sessions, r.previous?.sessions ?? 0],
        ['Bounce rate', pct(r.totals.bounceRate), r.previous ? pct(r.previous.bounceRate) : '–'],
      ],
    );
    line();
    table(
      ['Top page', 'Visitors'],
      r.breakdowns.pages.slice(0, 8).map((p) => [p.value, p.visitors]),
    );
    line();
    table(
      ['Referrer', 'Visitors'],
      r.breakdowns.referrers.slice(0, 8).map((p) => [p.value, p.visitors]),
    );
  },
  trends: (result) => {
    const r = result as TrendsResult;
    table(
      ['Series', 'Total'],
      r.series.map((s) => [s.label, s.total]),
    );
  },
  funnel: (result) => {
    const r = result as FunnelResult;
    table(
      ['Step', 'People', 'From start', 'From previous'],
      r.steps.map((s) => [
        s.label,
        s.count,
        pct(s.conversionFromStart),
        pct(s.conversionFromPrevious),
      ]),
    );
  },
  retention: (result) => {
    const r = result as RetentionResult;
    table(
      ['Cohort', 'People', ...r.average.map((_, k) => `${r.period[0]}${k}`)],
      r.cohorts.map((c) => [
        new Date(c.start).toISOString().slice(0, 10),
        c.size,
        ...c.rates.map((x) => `${Math.round(x * 100)}%`),
      ]),
    );
  },
  paths: (result) => {
    const r = result as PathsResult;
    table(
      ['Path', 'Count'],
      r.topPaths.slice(0, 15).map((p) => [p.items.join(' → '), p.count]),
    );
  },
};

export async function query(kind: string | undefined, flags: Flags): Promise<void> {
  if (!kind)
    throw new UsageError(
      'Which query?',
      'dataflare query web|trends|funnel|retention|paths [options]; see `dataflare help query`.',
    );
  const result = await call<Spec & { summary: string; sql: string[]; dashboard: string }>(
    'POST',
    '/api/query',
    withProject({ kind, ...specFromFlags(kind, flags), project: str(flags.project) }),
  );
  if (flags.json) return printJson(result);
  line(color.bold(result.summary));
  line();
  PRINTERS[kind]?.(result);
  line();
  line(color.dim(`Open in dashboard: ${result.dashboard}`));
  showSql(result.sql, flags);
}

export async function sql(statement: string | undefined, flags: Flags): Promise<void> {
  if (!statement)
    throw new UsageError(
      'Pass a query: dataflare sql "SELECT event, COUNT(*) AS n FROM events GROUP BY event"',
    );
  const r = await call<{ columns: string[]; rows: Record<string, unknown>[]; summary: string }>(
    'POST',
    '/api/sql',
    withProject({
      query: statement,
      limit: flags.limit ? Number(flags.limit) : undefined,
      project: str(flags.project),
    }),
  );
  if (flags.json) return printJson(r);
  table(
    r.columns,
    r.rows.map((row) =>
      r.columns.map((c) =>
        typeof row[c] === 'number' ? (row[c] as number) : String(row[c] ?? ''),
      ),
    ),
  );
  line(color.dim(r.summary));
}

export async function events(name: string | undefined, flags: Flags): Promise<void> {
  const project = str(flags.project);
  if (name && typeof flags.describe === 'string') {
    const r = await call(
      'PUT',
      `/api/events/${encodeURIComponent(name)}`,
      withProject({ description: flags.describe, project }),
    );
    return flags.json ? printJson(r) : line(`Saved the description of "${name}".`);
  }
  if (name) {
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    const r = await call<{
      summary: string;
      description: string;
      properties: { name: string; types: string[]; coverage: number; examples: string[] }[];
    }>('GET', `/api/events/${encodeURIComponent(name)}${q}`);
    if (flags.json) return printJson(r);
    line(color.bold(r.summary));
    if (r.description) line(r.description);
    line();
    if (r.properties.length)
      table(
        ['Property', 'Type', 'Coverage', 'Examples'],
        r.properties.map((p) => [
          p.name,
          p.types.join('|'),
          pct(p.coverage),
          p.examples.join(', '),
        ]),
      );
    return;
  }
  const r = await call<{
    summary: string;
    events: { event: string; count: number; lastSeen: string; description: string }[];
  }>(
    'GET',
    `/api/events?days=${Number(flags.days ?? 30)}${project ? `&project=${encodeURIComponent(project)}` : ''}`,
  );
  if (flags.json) return printJson(r);
  line(color.bold(r.summary));
  line();
  table(
    ['Event', 'Count', 'Last seen', 'Description'],
    r.events.map((e) => [
      e.event,
      e.count,
      e.lastSeen.slice(0, 16).replace('T', ' '),
      e.description,
    ]),
  );
}

export async function person(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) throw new UsageError('Pass a person id: dataflare person <user-id>');
  const q = str(flags.project) ? `?project=${encodeURIComponent(str(flags.project)!)}` : '';
  if (flags.delete) {
    const r = await call<{ summary: string }>(
      'DELETE',
      `/api/persons/${encodeURIComponent(id)}${q}`,
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  const r = await call<{
    summary: string;
    properties: Record<string, unknown>;
    recentEvents: { time: string; event: string; path: string }[];
  }>('GET', `/api/persons/${encodeURIComponent(id)}${q}`);
  if (flags.json) return printJson(r);
  line(color.bold(r.summary));
  for (const [k, v] of Object.entries(r.properties)) line(`  ${k}: ${JSON.stringify(v)}`);
  line();
  table(
    ['Time', 'Event', 'Page'],
    r.recentEvents
      .slice(0, 25)
      .map((e) => [e.time.slice(0, 19).replace('T', ' '), e.event, e.path]),
  );
}

/** `dataflare groups [type] [--search x]`: group types, or the groups of one type. */
export async function groups(type: string | undefined, flags: Flags): Promise<void> {
  const params = new URLSearchParams();
  if (str(flags.project)) params.set('project', str(flags.project)!);
  if (!type) {
    const r = await call<{ summary: string; types: { type: string; groups: number }[] }>(
      'GET',
      `/api/groups/types${params.size ? `?${params}` : ''}`,
    );
    if (flags.json) return printJson(r);
    line(r.summary);
    if (r.types.length)
      table(
        ['Type', 'Groups'],
        r.types.map((t) => [t.type, String(t.groups)]),
      );
    return;
  }
  params.set('type', type);
  if (str(flags.search)) params.set('search', str(flags.search)!);
  const r = await call<{
    summary: string;
    groups: { key: string; lastSeen: string; properties: Record<string, unknown> }[];
  }>('GET', `/api/groups?${params}`);
  if (flags.json) return printJson(r);
  line(r.summary);
  if (r.groups.length) {
    table(
      ['Key', 'Last seen', 'Properties'],
      r.groups.map((g) => [
        g.key,
        g.lastSeen.slice(0, 16).replace('T', ' '),
        JSON.stringify(g.properties).slice(0, 60),
      ]),
    );
  }
}

/** `dataflare group <type> <key> [--delete]`: one group, or erase it. */
export async function group(
  type: string | undefined,
  key: string | undefined,
  flags: Flags,
): Promise<void> {
  if (!type || !key) throw new UsageError('Usage: dataflare group <type> <key> [--delete]');
  const q = str(flags.project) ? `?project=${encodeURIComponent(str(flags.project)!)}` : '';
  const path = `/api/groups/${encodeURIComponent(type)}/${encodeURIComponent(key)}${q}`;
  if (flags.delete) {
    const r = await call<{ summary: string }>('DELETE', path);
    return flags.json ? printJson(r) : line(r.summary);
  }
  const r = await call<{
    summary: string;
    properties: Record<string, unknown>;
    members: { person: string; events: number; lastSeen: string }[];
  }>('GET', path);
  if (flags.json) return printJson(r);
  line(color.bold(r.summary));
  for (const [k, v] of Object.entries(r.properties)) line(`  ${k}: ${JSON.stringify(v)}`);
  if (r.members.length) {
    line();
    table(
      ['Member', 'Events', 'Last seen'],
      r.members.map((m) => [m.person, String(m.events), m.lastSeen.slice(0, 16).replace('T', ' ')]),
    );
  }
}

export async function replays(
  sub: string | undefined,
  arg: string | undefined,
  flags: Flags,
): Promise<void> {
  const project = str(flags.project);
  const q = (extra: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ project, ...extra })) if (v) params.set(k, v);
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const session = (usage: string) => {
    if (!arg) throw new UsageError(`Pass a session id: ${usage}`);
    return encodeURIComponent(arg);
  };
  if (sub === 'summary' || sub === 'show') {
    const r = await call<{ transcript: string }>(
      'GET',
      `/api/replays/${session('dataflare replays summary <session>')}/summary${q({ detail: flags.full ? 'full' : undefined })}`,
    );
    return flags.json ? printJson(r) : line(r.transcript);
  }
  if (sub === 'snapshot') {
    const at = str(flags.at);
    if (!at)
      throw new UsageError(
        'Pass a time: dataflare replays snapshot <session> --at 01:24',
        'Times are mm:ss from the start of the transcript.',
      );
    const r = await call<{ summary: string; screen: string }>(
      'GET',
      `/api/replays/${session('dataflare replays snapshot <session> --at 01:24')}/snapshot${q({ at })}`,
    );
    if (flags.json) return printJson(r);
    line(color.bold(r.summary));
    line();
    return line(r.screen);
  }
  if (sub === 'note') {
    const at = str(flags.at);
    const text = str(flags.text);
    if (!at || !text)
      throw new UsageError(
        'Pass a time and text: dataflare replays note <session> --at 00:14 --text "…"',
      );
    const r = await call<{ summary: string }>(
      'POST',
      `/api/replays/${session('dataflare replays note <session> --at 00:14 --text "…"')}/notes${q()}`,
      { at, text, author: str(flags.author) },
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  const filters = {
    from: str(flags.from),
    to: str(flags.to),
    person: str(flags.person),
    search: str(flags.search),
    url: str(flags.url),
    did_event: str(flags.did),
    not_event: str(flags.not),
    has:
      [
        str(flags.has),
        flags.errors ? 'errors' : undefined,
        flags.rage ? 'rage_clicks' : undefined,
        flags.dead ? 'dead_clicks' : undefined,
      ]
        .filter(Boolean)
        .join(',') || undefined,
    limit: str(flags.limit),
  };
  if (sub === 'analyse' || sub === 'analyze' || sub === 'patterns') {
    const r = await call<{ summary: string }>('GET', `/api/replays/analyse${q(filters)}`);
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub)
    throw new UsageError(
      `Unknown replays command "${sub}"`,
      'Use: dataflare replays [summary|snapshot|note|analyse].',
    );
  const r = await call<{
    summary: string;
    replays: {
      session: string;
      started: string;
      person: string;
      durationSeconds: number;
      errors: number;
      rageClicks: number;
      failedRequests: number;
      url: string;
    }[];
  }>('GET', `/api/replays${q({ ...filters, sort: str(flags.sort) })}`);
  if (flags.json) return printJson(r);
  line(color.bold(r.summary));
  line();
  table(
    ['Session', 'Started', 'Person', 'Seconds', 'Errors', 'Rage', 'Failed req', 'First page'],
    r.replays.map((x) => [
      x.session,
      x.started.slice(0, 16).replace('T', ' '),
      x.person,
      x.durationSeconds,
      x.errors,
      x.rageClicks,
      x.failedRequests,
      x.url,
    ]),
  );
}

export async function projects(
  sub: string | undefined,
  arg: string | undefined,
  flags: Flags,
): Promise<void> {
  if (sub === 'add') {
    if (!arg) throw new UsageError('Pass an id: dataflare projects add <id>');
    const r = await call<{ summary: string }>('POST', '/api/projects', {
      id: arg,
      name: str(flags.name),
    });
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub === 'policy') {
    if (!arg)
      throw new UsageError(
        'Pass an id: dataflare projects policy <id> [--audience minors|general]',
        'Options: --event-props a,b --person-props c --replay off|scrubbed --retention-days N --replay-retention-days N --pseudonym-pattern <regex>. Setting replaces the whole policy.',
      );
    const path = `/api/projects/${encodeURIComponent(arg)}/policy`;
    const audience = str(flags.audience);
    if (!audience) {
      const r = await call<{ summary: string }>('GET', path);
      return flags.json ? printJson(r) : line(r.summary);
    }
    const list = (v: string | boolean | undefined) =>
      str(v)
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const int = (v: string | boolean | undefined) => (str(v) ? Number(str(v)) : undefined);
    const r = await call<{ summary: string }>('PUT', path, {
      audience,
      pseudonym_pattern: str(flags['pseudonym-pattern']),
      event_properties: list(flags['event-props']),
      person_properties: list(flags['person-props']),
      replay: str(flags.replay),
      retention_days: int(flags['retention-days']),
      replay_retention_days: int(flags['replay-retention-days']),
    });
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub === 'audit') {
    if (!arg) throw new UsageError('Pass an id: dataflare projects audit <id> [--from -30d]');
    const q = new URLSearchParams({ from: str(flags.from) ?? '-30d' });
    const r = await call<{
      summary: string;
      entries: { ts: number; actor: string; surface: string; operation: string; detail: string }[];
    }>('GET', `/api/projects/${encodeURIComponent(arg)}/audit?${q}`);
    if (flags.json) return printJson(r);
    line(r.summary);
    table(
      ['When', 'Who', 'Via', 'Operation', 'Detail'],
      r.entries.map((e) => [
        new Date(e.ts).toISOString(),
        e.actor,
        e.surface,
        e.operation,
        e.detail.slice(0, 60),
      ]),
    );
    return;
  }
  const r = await call<{ projects: { id: string; name: string }[] }>('GET', '/api/projects');
  if (flags.json) return printJson(r);
  table(
    ['Project', 'Name'],
    r.projects.map((p) => [p.id, p.name]),
  );
}
