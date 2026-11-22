/**
 * Events (the tracking plan) and raw SQL.
 */

import { api } from '../api.ts';
import { COLUMN_OPTIONS } from '../catalog.ts';
import { barList } from '../components/charts.ts';
import { type CodeToken, codeField } from '../components/code-field.ts';
import { rangeDays, rangeLabel } from '../components/date-range.ts';
import { icon } from '../components/icons.ts';
import {
  copyButton,
  empty,
  errorState,
  later,
  loading,
  pageHeader,
  panel,
  table,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, count, percent } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface EventRow {
  event: string;
  count: number;
  lastSeen: string;
  description: string;
  role: 'conversion' | 'important' | null;
  system: boolean;
}

const ROLE_NEXT = { none: 'conversion', conversion: 'important', important: 'none' } as const;

/** A button that cycles an event through conversion → important → none. Reports show key events. */
function roleButton(
  e: EventRow,
  project: string | undefined,
  repaint: () => void,
): HTMLButtonElement {
  const role = e.role ?? 'none';
  const label = role === 'conversion' ? 'Conversion' : role === 'important' ? 'Important' : 'Mark';
  const title =
    role === 'none'
      ? 'Mark as a conversion: Reports show its conversion rate overall and per source'
      : role === 'conversion'
        ? 'Conversion. Click to mark as important instead'
        : 'Important. Click to clear';
  return h(
    'button',
    {
      type: 'button',
      class: `role-toggle ${role}`,
      title,
      'aria-label': `${e.event}: ${title}`,
      onclick: async () => {
        const next = ROLE_NEXT[role];
        try {
          await api.put(`/api/events/${encodeURIComponent(e.event)}/role`, { project, role: next });
          e.role = next === 'none' ? null : next;
          repaint();
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      },
    },
    icon(role === 'important' ? 'zap' : 'flag', 13),
    label,
  );
}

interface EventDetail {
  event: string;
  sampled: number;
  lastSeen: string | null;
  description: string;
  owner: string;
  properties: {
    name: string;
    types: string[];
    coverage: number;
    examples: string[];
    description: string;
  }[];
  summary: string;
  sql: string[];
}

function eventDetail(name: string): Node[] {
  const project = scope().project;
  return [
    later(async () => {
      const e = await api.get<EventDetail>(`/api/events/${encodeURIComponent(name)}`, { project });
      const description = h('input', {
        type: 'text',
        value: e.description,
        placeholder: 'How and when this fires, e.g. Fired when payment succeeds after checkout',
      });
      const owner = h('input', { type: 'text', value: e.owner, placeholder: 'team or person' });
      const propInputs = new Map(
        e.properties.map((p) => [
          p.name,
          h('input', {
            type: 'text',
            value: p.description,
            placeholder: 'What this property means and which values to expect',
            'aria-label': `Description of ${p.name}`,
          }),
        ]),
      );
      const form = h(
        'form',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'Description'), description),
        h('label', { class: 'field' }, h('span', {}, 'Owner'), owner),
        h(
          'div',
          { class: 'form-actions' },
          h('button', { type: 'submit', class: 'primary' }, 'Save description'),
        ),
      );
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          await api.put(`/api/events/${encodeURIComponent(name)}`, {
            project,
            description: description.value,
            owner: owner.value,
            properties: Object.fromEntries(
              [...propInputs].map(([k, input]) => [k, input.value]).filter(([, v]) => v),
            ),
          });
          toast('Saved');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      });
      return [
        pageHeader(
          e.event,
          e.summary,
          copyButton(`glass.capture('${e.event}', {})`, 'Copy capture code'),
        ),
        h(
          'div',
          { class: 'grid-2' },
          panel('Definition', form),
          panel(
            'Explore',
            h(
              'ul',
              { class: 'plain' },
              h(
                'li',
                {},
                h(
                  'a',
                  {
                    href: href('insights/trends', {
                      spec: JSON.stringify({ series: [{ event: e.event }], interval: 'day' }),
                    }),
                  },
                  'Trend over time',
                ),
              ),
              h(
                'li',
                {},
                h(
                  'a',
                  {
                    href: href('insights/retention', {
                      spec: JSON.stringify({
                        cohortEvent: { event: e.event },
                        returnEvent: { event: e.event },
                        period: 'week',
                        periods: 8,
                      }),
                    }),
                  },
                  'Retention of people who did it',
                ),
              ),
            ),
          ),
        ),
        panel(
          'Properties',
          e.properties.length
            ? table(
                ['Property', 'Type', 'Present on', 'Examples', 'Meaning'],
                e.properties.map((p) => [
                  h('code', {}, p.name),
                  p.types.join(', '),
                  percent(p.coverage, 0),
                  h('span', { class: 'muted' }, p.examples.join(', ')),
                  propInputs.get(p.name)!,
                ]),
                { numeric: [2] },
              )
            : empty('No properties sent with this event.'),
          { sql: e.sql },
        ),
      ];
    }),
  ];
}

export function eventsPage(route: Route): Node[] {
  if (route.rest[0]) return eventDetail(route.rest[0]);
  const sc = scope();
  const project = sc.project;
  const days = rangeDays(sc.from, sc.to);
  const show =
    route.params.get('show') === 'custom'
      ? 'custom'
      : route.params.get('show') === 'system'
        ? 'system'
        : 'all';
  let query = '';
  const holder = h('div', {});
  let rows: EventRow[] = [];
  const paint = () => {
    const q = query.trim().toLowerCase();
    const shown = rows.filter(
      (e) =>
        (show === 'all' || (show === 'system') === e.system) &&
        (!q || `${e.event} ${e.description}`.toLowerCase().includes(q)),
    );
    const max = Math.max(1, ...rows.map((e) => e.count));
    mount(
      holder,
      shown.length
        ? table(
            ['Event', 'Key event', 'Volume', 'Last seen', 'Description'],
            shown.map((e) => [
              h(
                'a',
                { class: 'event-link', href: href(`events/${encodeURIComponent(e.event)}`) },
                h('span', { class: `event-pill ${e.system ? 'system' : ''}` }, e.event),
              ),
              e.event === '$pageview' || e.event.startsWith('$web')
                ? h('span', {})
                : roleButton(e, project, paint),
              h(
                'div',
                { class: 'volume' },
                h(
                  'span',
                  { class: 'volume-bar' },
                  h('span', { style: `width:${(e.count / max) * 100}%` }),
                ),
                h('span', { class: 'num' }, count(e.count)),
              ),
              h('span', { class: 'muted' }, ago(e.lastSeen)),
              e.system
                ? h('span', { class: 'muted' }, h('span', { class: 'badge' }, 'Built in'))
                : e.description
                  ? h('span', { class: 'cell-clip', title: e.description }, e.description)
                  : h(
                      'a',
                      {
                        class: 'muted undocumented',
                        href: href(`events/${encodeURIComponent(e.event)}`),
                      },
                      icon('alert', 13),
                      'Add a description',
                    ),
            ]),
            { class: 'events-table' },
          )
        : empty(query ? `No events match “${query}”.` : 'No events of this kind.', undefined, {
            icon: 'search',
          }),
    );
  };
  const search = h('input', {
    type: 'search',
    placeholder: 'Search events',
    'aria-label': 'Search events',
  });
  search.addEventListener('input', () => {
    query = search.value;
    paint();
  });
  return [
    pageHeader(
      'Events',
      `Everything tracked in ${rangeLabel(sc.from, sc.to).toLowerCase()}. Describe custom events and their properties (agents read them before they query), and mark the ones that mean success as conversions: Reports show their rates.`,
    ),
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'search-field' }, icon('search', 15), search),
      tabs(
        [
          { value: 'all', label: 'All' },
          { value: 'custom', label: 'Custom' },
          { value: 'system', label: 'Built in' },
        ],
        show,
        (v) => go('events', { show: v === 'all' ? null : v }),
      ),
    ),
    later(
      async () => {
        const r = await api.get<{ events: EventRow[]; undocumented: string[] }>('/api/events', {
          project,
          days,
        });
        if (r.events.length === 0)
          return empty(
            'Install the snippet or call glass.capture() and events appear here.',
            undefined,
            { icon: 'events', title: 'No events yet' },
          );
        rows = r.events;
        paint();
        return [
          r.undocumented.length
            ? h(
                'div',
                { class: 'notice' },
                icon('alert', 16),
                h(
                  'span',
                  {},
                  `${r.undocumented.length} custom event${r.undocumented.length === 1 ? ' has' : 's have'} no description yet. Open each one and say when it fires and what its properties mean.`,
                ),
              )
            : null,
          panel(`${rows.length} events`, holder, { icon: 'events', class: 'flush' }),
        ];
      },
      'Loading events',
      'table',
    ),
  ];
}

const SQL_KEYWORDS = new Set(
  'SELECT FROM WHERE AND OR NOT GROUP BY ORDER LIMIT OFFSET AS ON JOIN LEFT INNER OUTER WITH CASE WHEN THEN ELSE END IN IS NULL LIKE DISTINCT HAVING DESC ASC UNION ALL COUNT SUM AVG MIN MAX COALESCE CAST BETWEEN EXISTS OVER PARTITION'.split(
    ' ',
  ),
);

/** Minimal SQL highlighting: strings, comments, numbers and keywords. */
function sqlTokens(sql: string): CodeToken[] {
  const out: CodeToken[] = [];
  const token =
    /('(?:[^']|'')*'?)|(--[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
  for (const m of sql.matchAll(token)) {
    if (m[1]) out.push({ text: m[1], cls: 't-str' });
    else if (m[2]) out.push({ text: m[2], cls: 't-com' });
    else if (m[3]) out.push({ text: m[3], cls: 't-num' });
    else if (m[4])
      out.push({ text: m[4], cls: SQL_KEYWORDS.has(m[4].toUpperCase()) ? 't-kw' : undefined });
    else out.push({ text: m[5]! });
  }
  return out;
}

const EVENT_COLUMNS: { name: string; type: string; description: string }[] = [
  { name: 'event', type: 'text', description: 'Event name, e.g. $pageview.' },
  { name: 'ts_ms', type: 'int', description: 'Timestamp, epoch milliseconds.' },
  { name: 'project', type: 'text', description: 'Project id. Always filter on it.' },
  ...COLUMN_OPTIONS.map((c) => ({ name: c.name, type: 'text', description: c.description })),
  { name: 'props', type: 'json', description: "Event properties. json_extract(props, '$.plan')." },
  { name: 'person_props', type: 'json', description: 'Person properties when the event arrived.' },
  { name: 'flags', type: 'json', description: 'Flag variants active at the time.' },
];

export function sqlPage(route: Route): Node[] {
  const project = scope().project;
  const initial =
    route.params.get('query') ??
    `SELECT event, COUNT(*) AS n\nFROM events\nWHERE project = '${project ?? 'default'}'\n  AND ts_ms >= ${Date.now() - 7 * 86_400_000}\nGROUP BY event\nORDER BY n DESC`;
  const sqlField = codeField({
    value: initial,
    label: 'SQL query',
    tokenize: sqlTokens,
    className: 'code-sql',
    rows: 12,
    onKeyDown: (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault();
      void run();
      return true;
    },
  });
  const editor = sqlField.input;
  const insert = (text: string) => sqlField.insert(text);
  const output = h('div', {});
  let view: 'table' | 'chart' = 'table';
  const run = async () => {
    mount(output, loading('Running', 'table'));
    const started = performance.now();
    try {
      const r = await api.post<{
        columns: string[];
        rows: Record<string, unknown>[];
        summary: string;
      }>('/api/sql', { project, query: editor.value });
      const ms = Math.round(performance.now() - started);
      const numericCol = r.columns.find(
        (c, i) =>
          i > 0 &&
          r.rows.length > 0 &&
          r.rows.every((row) => typeof row[c] === 'number' || row[c] === null),
      );
      const paint = () => {
        const body: Child = !r.rows.length
          ? empty('The query returned no rows.', undefined, { icon: 'table' })
          : view === 'chart' && numericCol
            ? barList(
                r.rows.slice(0, 50).map((row) => ({
                  label: String(row[r.columns[0]!] ?? 'null'),
                  value: Number(row[numericCol] ?? 0),
                })),
                [r.columns[0]!, numericCol],
                { limit: 20 },
              )
            : table(
                r.columns,
                r.rows.map((row) =>
                  r.columns.map((c) =>
                    row[c] === null
                      ? h('span', { class: 'muted' }, 'null')
                      : typeof row[c] === 'number'
                        ? h('span', { class: 'num' }, String(row[c]))
                        : String(row[c]),
                  ),
                ),
              );
        mount(
          output,
          panel(`${count(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}`, body, {
            icon: 'table',
            subtitle: `${r.summary} · ${ms} ms`,
            class: 'flush',
            actions: [
              numericCol
                ? tabs(
                    [
                      { value: 'table', label: 'Table', icon: 'table' },
                      { value: 'chart', label: 'Chart', icon: 'barChart' },
                    ],
                    view,
                    (v) => {
                      view = v as 'table' | 'chart';
                      paint();
                    },
                    'tabs-small',
                  )
                : null,
              copyButton(
                () =>
                  [
                    r.columns.join(','),
                    ...r.rows.map((row) =>
                      r.columns.map((c) => JSON.stringify(row[c] ?? '')).join(','),
                    ),
                  ].join('\n'),
                'CSV',
              ),
            ],
          }),
        );
      };
      paint();
      // replaceState (not go()) so the shareable URL updates without a hashchange remount that would wipe these results.
      const params = new URLSearchParams(route.params);
      params.set('query', editor.value);
      history.replaceState(null, '', `#/sql?${params}`);
    } catch (err) {
      mount(output, errorState(err));
    }
  };
  const schema = h(
    'aside',
    { class: 'schema' },
    h('div', { class: 'schema-head' }, icon('database', 15), h('strong', {}, 'events')),
    h('p', { class: 'muted small' }, 'Click a column to insert it.'),
    h(
      'ul',
      { class: 'schema-list' },
      EVENT_COLUMNS.map((c) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'schema-col',
              title: c.description,
              onclick: () => insert(c.name),
            },
            h('code', {}, c.name),
            h('span', { class: 'schema-type' }, c.type),
          ),
        ),
      ),
    ),
  );
  return [
    pageHeader(
      'SQL',
      'One read-only SELECT against your events. Timestamps are epoch milliseconds in ts_ms.',
    ),
    h(
      'div',
      { class: 'sql-layout' },
      schema,
      h(
        'div',
        { class: 'sql-main' },
        panel(
          'Query',
          [
            sqlField.el,
            h(
              'div',
              { class: 'form-actions' },
              h(
                'button',
                { type: 'button', class: 'primary', onclick: () => void run() },
                icon('play', 13),
                'Run query',
              ),
              h('span', { class: 'muted small' }, h('kbd', {}, '⌘'), ' + ', h('kbd', {}, 'Enter')),
            ),
          ],
          { icon: 'code' },
        ),
        output,
      ),
    ),
  ];
}
