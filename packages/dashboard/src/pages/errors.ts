/**
 * Error tracking: issues (exceptions grouped by fingerprint) and one issue in
 * detail — its stack trace mapped to source, trend, where and for whom it
 * happens, and replays opened just before it.
 */

import { api } from '../api.ts';
import { barList, kpiStat, lineChart, sparkline } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { selectMenu } from '../components/menu.ts';
import {
  empty,
  errorState,
  later,
  pageHeader,
  panel,
  table,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, capitalize, count, dateTime } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

type Status = 'active' | 'resolved' | 'suppressed' | 'all';

interface Issue {
  id: string;
  status: string;
  type: string;
  message: string;
  assignee: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  dropped: number;
  lastRelease: string | null;
  regressedAt: string | null;
  regressions: number;
  events?: number;
  users?: number;
  sessions?: number;
  series?: number[];
}

interface Frame {
  function: string;
  file: string;
  line: number | null;
  column: number | null;
  inApp: boolean;
  original?: {
    source: string;
    line: number;
    column: number;
    name: string | null;
    context?: { pre: string[]; line: string; post: string[] };
  };
}

interface IssueDetail {
  issue: Issue;
  merged: string[];
  fingerprints: number;
  range: { events: number; users: number; sessions: number };
  interval: string;
  buckets: number[];
  series: number[];
  sample: {
    eventId: string;
    at: string;
    url: string;
    release: string | null;
    handled: boolean;
    level: string;
    browser: string;
    os: string;
    person: string;
  } | null;
  stack: { frames: Frame[]; mapped: number };
  breakdowns: Record<string, { value: string; events: number; users: number }[]>;
  people: { person: string; events: number; lastSeen: number }[];
  occurrences: {
    session: string;
    person: string;
    at: string;
    url: string;
    release: string;
    replay: string | null;
  }[];
  summary: string;
  sql: string[];
}

/** A page URL as its path (the host is the same site). */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

const statusBadge = (i: Pick<Issue, 'status' | 'regressedAt'>) =>
  h(
    'span',
    { class: `badge status-${i.status}` },
    i.status === 'active' && i.regressedAt ? 'regressed' : i.status,
  );

function issueListControls(p: URLSearchParams, status: Status, order: string): HTMLElement {
  const set = (k: string, v: string | null) => go('errors', { ...Object.fromEntries(p), [k]: v });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search type or message',
    value: p.get('q') ?? '',
    class: 'search-input',
  });
  search.addEventListener('change', () => set('q', search.value || null));
  return h(
    'div',
    { class: 'toolbar' },
    tabs(
      [
        { value: 'active', label: 'Active' },
        { value: 'resolved', label: 'Resolved' },
        { value: 'suppressed', label: 'Suppressed' },
        { value: 'all', label: 'All' },
      ],
      status,
      (v) => set('status', v === 'active' ? null : v),
    ),
    search,
    selectMenu({
      label: 'Sort by',
      value: order,
      options: [
        { value: 'events', label: 'Most events' },
        { value: 'users', label: 'Most people' },
        { value: 'last_seen', label: 'Last seen' },
        { value: 'first_seen', label: 'Newest' },
      ],
      onChange: (v) => set('order', v === 'events' ? null : v),
    }),
  );
}

function issueRow(i: Issue): Child[] {
  const meta = [`First seen ${ago(i.firstSeen)}`, i.lastRelease, i.assignee]
    .filter(Boolean)
    .join(' · ');
  return [
    h(
      'a',
      { class: 'issue-cell', href: href(`errors/${i.id}`) },
      h('span', { class: 'issue-type' }, i.type),
      h('span', { class: 'issue-message' }, i.message || '(no message)'),
      h('span', { class: 'muted small' }, meta),
    ),
    i.series ? sparkline(i.series, { color: 'var(--bad, #e5484d)' }) : null,
    count(i.events ?? 0),
    count(i.users ?? 0),
    h('span', { class: 'nowrap' }, ago(i.lastSeen)),
    statusBadge(i),
  ];
}

function noIssues(status: Status): HTMLElement {
  const active = status === 'active';
  return empty(
    active
      ? 'Uncaught errors show up here on their own; caught ones with glass.captureException(err).'
      : 'Nothing with this status in the range.',
    null,
    { icon: 'check', title: active ? 'No errors in this range' : 'No issues' },
  );
}

async function issueTable(p: URLSearchParams, status: Status, order: string): Promise<HTMLElement> {
  const { from, to, project } = scope();
  const r = await api.get<{ issues: Issue[]; summary: string; sql: string[] }>('/api/issues', {
    project,
    from,
    to,
    status,
    order,
    search: p.get('q'),
    limit: 100,
  });
  if (r.issues.length === 0) return noIssues(status);
  const exceptions = r.issues.reduce((n, i) => n + (i.events ?? 0), 0);
  return panel(
    `${r.issues.length} ${r.issues.length === 1 ? 'issue' : 'issues'}`,
    table(['Issue', 'Trend', 'Events', 'People', 'Last seen', 'Status'], r.issues.map(issueRow), {
      numeric: [2, 3],
      class: 'issues-table',
    }),
    { icon: 'alert', subtitle: `${count(exceptions)} exceptions in range`, sql: r.sql },
  );
}

function issueList(route: Route): HTMLElement {
  const p = route.params;
  const status = (p.get('status') ?? 'active') as Status;
  const order = p.get('order') ?? 'events';
  return h(
    'div',
    {},
    issueListControls(p, status, order),
    later(() => issueTable(p, status, order), 'Loading issues', 'table'),
  );
}

function frameRow(f: Frame): HTMLElement {
  const o = f.original;
  const where = o
    ? `${o.source}:${o.line}:${o.column}`
    : `${f.file}${f.line !== null ? `:${f.line}` : ''}${f.column !== null ? `:${f.column}` : ''}`;
  return h(
    'li',
    { class: `frame ${f.inApp ? 'in-app' : 'vendor'}` },
    h(
      'div',
      { class: 'frame-head' },
      h('code', { class: 'frame-fn' }, o?.name ?? (f.function || '(anonymous)')),
      h('span', { class: 'frame-where' }, where),
      o ? h('span', { class: 'badge', title: `${f.file}:${f.line}:${f.column}` }, 'mapped') : null,
    ),
    o?.context
      ? h(
          'pre',
          { class: 'frame-context' },
          [
            ...o.context.pre.map((l, i) => ({
              n: o.line - o.context!.pre.length + i,
              l,
              hit: false,
            })),
            { n: o.line, l: o.context.line, hit: true },
            ...o.context.post.map((l, i) => ({ n: o.line + 1 + i, l, hit: false })),
          ].map((x) =>
            h(
              'div',
              { class: x.hit ? 'hit' : '' },
              h('span', { class: 'ln' }, String(x.n)),
              x.l || ' ',
            ),
          ),
        )
      : null,
  );
}

function stackPanel(d: IssueDetail): HTMLElement {
  const frames = d.stack.frames;
  const list = h('ol', { class: 'stack' });
  let all = false;
  const paint = () => {
    const shown = all ? frames : frames.filter((f) => f.inApp);
    mount(list, (shown.length ? shown : frames).map(frameRow));
  };
  paint();
  const vendor = frames.filter((f) => !f.inApp).length;
  return panel(
    'Stack trace',
    frames.length
      ? [
          list,
          vendor && frames.some((f) => f.inApp)
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'link-button',
                  onclick: (e: Event) => {
                    all = !all;
                    (e.target as HTMLElement).textContent = all
                      ? 'Only your code'
                      : `Show ${vendor} more ${vendor === 1 ? 'frame' : 'frames'}`;
                    paint();
                  },
                },
                `Show ${vendor} more ${vendor === 1 ? 'frame' : 'frames'}`,
              )
            : null,
        ]
      : empty('This exception had no stack trace.'),
    {
      icon: 'code',
      subtitle: d.stack.mapped
        ? `${d.stack.mapped} frames mapped to source`
        : 'Minified? Upload source maps: npx dataflare-cli sourcemaps upload dist --release <version>',
    },
  );
}

function actions(d: IssueDetail): HTMLElement {
  const project = scope().project;
  const update = async (body: Record<string, unknown>, message: string) => {
    try {
      await api.patch(`/api/issues/${encodeURIComponent(d.issue.id)}`, { project, ...body });
      toast(message);
      go(`errors/${d.issue.id}`, { t: String(Date.now()) });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const assignee = h('input', {
    type: 'text',
    placeholder: 'Assignee',
    value: d.issue.assignee ?? '',
    class: 'assignee',
  });
  assignee.addEventListener('change', () =>
    update(
      { assignee: assignee.value.trim() || null },
      assignee.value ? `Assigned to ${assignee.value}` : 'Unassigned',
    ),
  );
  return h(
    'div',
    { class: 'page-actions' },
    assignee,
    d.issue.status === 'resolved' || d.issue.status === 'suppressed'
      ? h(
          'button',
          { type: 'button', onclick: () => update({ status: 'active' }, 'Reopened') },
          'Reopen',
        )
      : [
          h(
            'button',
            {
              type: 'button',
              class: 'primary',
              onclick: () =>
                update({ status: 'resolved' }, 'Resolved: it comes back if it happens again'),
            },
            icon('check', 15),
            'Resolve',
          ),
          h(
            'button',
            {
              type: 'button',
              onclick: () =>
                update({ status: 'suppressed' }, 'Suppressed: new occurrences are dropped'),
            },
            'Suppress',
          ),
        ],
  );
}

function mergePanel(d: IssueDetail): HTMLElement {
  const input = h('input', { type: 'text', placeholder: 'Issue ids, comma separated' });
  const out = h('div', {});
  const form = h(
    'form',
    { class: 'inline-form merge-form row' },
    input,
    h('button', { type: 'submit' }, 'Merge into this issue'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = input.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!ids.length) return;
    try {
      await api.post(`/api/issues/${encodeURIComponent(d.issue.id)}/merge`, {
        project: scope().project,
        ids,
      });
      toast(`Merged ${ids.length} into this issue`);
      go(`errors/${d.issue.id}`, { t: String(Date.now()) });
    } catch (err) {
      mount(out, errorState(err));
    }
  });
  return panel(
    'Merge',
    [
      h(
        'p',
        { class: 'muted' },
        'Same bug under another fingerprint? Merge it here; new exceptions of either join this issue.',
      ),
      form,
      out,
      d.merged.length
        ? h('p', { class: 'muted small' }, `Merged in: ${d.merged.join(', ')}`)
        : null,
    ],
    { icon: 'layers' },
  );
}

const BREAKDOWN_NAMES: [string, string][] = [
  ['path', 'Page'],
  ['browser', 'Browser'],
  ['os', 'OS'],
  ['release', 'Release'],
  ['device', 'Device'],
  ['country', 'Country'],
  ['handled', 'Handled'],
];

function issueStatusStat(issue: IssueDetail['issue']): HTMLElement {
  const regressed = issue.status === 'active' && issue.regressedAt;
  const note = issue.regressedAt
    ? `Regressed ${ago(issue.regressedAt)}`
    : issue.assignee
      ? `Assigned to ${issue.assignee}`
      : null;
  return kpiStat('Status', regressed ? 'Regressed' : capitalize(issue.status), note);
}

function issueStats(d: IssueDetail): HTMLElement {
  return h(
    'div',
    { class: 'stats stats-panel' },
    kpiStat('Events in range', count(d.range.events)),
    kpiStat('People', count(d.range.users)),
    kpiStat('Sessions', count(d.range.sessions)),
    kpiStat(
      'All time',
      count(d.issue.occurrences),
      d.issue.dropped ? `${count(d.issue.dropped)} dropped` : null,
    ),
    kpiStat('First seen', ago(d.issue.firstSeen), dateTime(d.issue.firstSeen)),
    issueStatusStat(d.issue),
  );
}

function samplePanel(sample: NonNullable<IssueDetail['sample']>): HTMLElement {
  const rows: [string, Child][] = [
    ['When', dateTime(sample.at)],
    ['Page', sample.url],
    ['Release', sample.release ?? '—'],
    ['Browser / OS', `${sample.browser} · ${sample.os}`],
    ['Handled', sample.handled ? 'Yes (captureException)' : 'No (uncaught)'],
    ['Person', h('a', { href: href(`users/${encodeURIComponent(sample.person)}`) }, sample.person)],
  ];
  return panel(
    'Latest occurrence',
    table(
      ['', ''],
      rows.map(([k, v]) => [h('span', { class: 'kv-key' }, k), v]),
      { class: 'kv-table' },
    ),
    { icon: 'clock' },
  );
}

/** Dimensions with one value are a sentence, not a panel each. */
function singleValueSentence(d: IssueDetail): HTMLElement | null {
  const single = BREAKDOWN_NAMES.filter(([k]) => d.breakdowns[k]?.length === 1);
  if (!single.length) return null;
  const phrase = ([k, label]: [string, string]): Child => {
    const value = d.breakdowns[k]![0]!.value;
    if (k === 'handled')
      return h(
        'span',
        { class: 'breakdown-value' },
        value === 'true' ? 'all handled' : 'all uncaught',
      );
    return [
      `${label === 'OS' ? label : label.toLowerCase()} `,
      h('span', { class: 'breakdown-value' }, value),
    ];
  };
  return h(
    'p',
    { class: 'breakdown-summary' },
    'Every exception in range: ',
    single.map((x, i) => [i ? ' · ' : '', phrase(x)]),
  );
}

function breakdownPanels(d: IssueDetail): HTMLElement {
  const many = BREAKDOWN_NAMES.filter(([k]) => (d.breakdowns[k]?.length ?? 0) > 1);
  const grid = many.length >= 3 ? 'grid-3' : many.length === 2 ? 'grid-2' : '';
  return h(
    'div',
    { class: grid },
    many.map(([k, label]) =>
      panel(
        label,
        barList(
          d.breakdowns[k]!.map((b) => ({ label: b.value, value: b.events, secondary: b.users })),
          [label, 'Events', 'People'],
        ),
        {},
      ),
    ),
  );
}

function replayCell(replay: string | null): HTMLElement {
  if (!replay) return h('span', { class: 'muted nowrap' }, 'No replay');
  return h(
    'a',
    { class: 'nowrap', href: replay.slice(replay.indexOf('#')) },
    icon('play', 14),
    'Watch',
  );
}

function peopleAndSessions(d: IssueDetail): HTMLElement {
  const people = d.people.length
    ? table(
        ['Person', 'Events', 'Last'],
        d.people.map((p) => [
          h('a', { href: href(`users/${encodeURIComponent(p.person)}`) }, p.person),
          count(p.events),
          h('span', { class: 'nowrap' }, ago(p.lastSeen)),
        ]),
        { numeric: [1] },
      )
    : empty('No one in this range.');
  const sessions = d.occurrences.length
    ? table(
        ['When', 'Page', 'Replay'],
        d.occurrences.map((o) => [
          h('span', { class: 'nowrap' }, dateTime(o.at)),
          h('span', { class: 'truncate', title: o.url }, pathOf(o.url)),
          replayCell(o.replay),
        ]),
      )
    : empty('No sessions in this range.');
  return h(
    'div',
    { class: 'grid-2' },
    panel('People affected', people, { icon: 'users' }),
    panel('Sessions', sessions, {
      icon: 'replay',
      subtitle: 'Replays open five seconds before the error',
    }),
  );
}

async function issueView(id: string): Promise<Child[]> {
  const { from, to, project } = scope();
  const d = await api.get<IssueDetail>(`/api/issues/${encodeURIComponent(id)}`, {
    project,
    from,
    to,
  });
  return [
    pageHeader(`${d.issue.type}`, d.issue.message || '(no message)', actions(d)),
    issueStats(d),
    panel(
      'Over time',
      lineChart(d.buckets, [{ label: 'Exceptions', values: d.series }], d.interval, {
        type: 'bar',
        height: 180,
      }),
      { icon: 'insights', subtitle: d.summary, sql: d.sql },
    ),
    stackPanel(d),
    d.sample ? samplePanel(d.sample) : null,
    singleValueSentence(d),
    breakdownPanels(d),
    peopleAndSessions(d),
    mergePanel(d),
  ];
}

function issueDetail(id: string): Child[] {
  return [later(() => issueView(id), 'Loading issue')];
}

function sourcemapsPanel(): HTMLElement {
  return later(async () => {
    const r = await api.get<{
      sourcemaps: { release: string; path: string; bytes: number; uploadedAt: string }[];
      summary: string;
    }>('/api/sourcemaps', { project: scope().project });
    return panel(
      'Source maps',
      r.sourcemaps.length
        ? table(
            ['Release', 'File', 'Size', 'Uploaded'],
            r.sourcemaps
              .slice(0, 20)
              .map((m) => [
                m.release,
                h('code', {}, m.path),
                `${count(m.bytes / 1024)} KB`,
                ago(m.uploadedAt),
              ]),
          )
        : h(
            'div',
            {},
            h(
              'p',
              { class: 'muted' },
              'Map minified stack traces back to your code: upload source maps in CI after each build.',
            ),
            h(
              'pre',
              { class: 'code-inline' },
              'npx dataflare-cli sourcemaps upload dist --release "$GITHUB_SHA"',
            ),
            h(
              'p',
              { class: 'muted small' },
              'Pass the same release to glass.init({ release }) or data-release on the script tag.',
            ),
          ),
      { icon: 'code', subtitle: r.summary },
    );
  });
}

export function errorsPage(route: Route): Node[] {
  const id = route.rest[0];
  if (id) return issueDetail(id) as Node[];
  return [pageHeader('Errors', undefined), issueList(route), sourcemapsPanel()];
}
