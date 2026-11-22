/**
 * People: identified users, anonymous device counts, and saved cohorts.
 */

import { api } from '../api.ts';
import { invalidateValues } from '../catalog.ts';
import {
  type CohortDefinition,
  cohortEditor,
  completeDefinition,
  emptyDefinition,
} from '../components/cohort-editor.ts';
import { icon } from '../components/icons.ts';
import { modal } from '../components/menu.ts';
import {
  avatar,
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
import { ago, count, dateTime, hue, initials, money } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface PersonSummary {
  id: string;
  properties: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

interface PeopleStats {
  identified: number;
  anonymousDevices: number;
  days: number;
}

interface Cohort {
  key: string;
  name: string;
  description?: string | null;
  kind: 'dynamic' | 'static';
  definition: CohortDefinition | null;
  summary: string;
  count: number;
  usedByFlags?: boolean;
  retention: string;
}

interface Person {
  id: string;
  identified: boolean;
  properties: Record<string, unknown>;
  firstSeen: string | null;
  lastSeen: string | null;
  devices: string[];
  recentEvents: {
    event: string;
    time: string;
    path: string;
    session: string;
    properties: Record<string, unknown>;
  }[];
  replays: { session: string; started: string; errors: number; url: string }[];
  groups?: { type: string; key: string; name: string | null; lastSeen: string }[];
  revenue?: {
    net: number;
    gross: number;
    orders: number;
    firstAt: string | null;
    lastAt: string | null;
    currency: string;
  };
  summary: string;
  sql: string[];
}

const preview = (props: Record<string, unknown>) =>
  Object.entries(props)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');

function peopleKpis(stats: PeopleStats): HTMLElement {
  const total = stats.identified + stats.anonymousDevices;
  const share = total ? stats.identified / total : 0;
  return h(
    'dl',
    { class: 'kpis kpis-3' },
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Identified people'),
      h('dd', {}, count(stats.identified)),
      h('div', { class: 'kpi-note muted small' }, 'Called glass.identify()'),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, `Anonymous devices (${stats.days}d)`),
      h('dd', {}, count(stats.anonymousDevices)),
      h('div', { class: 'kpi-note muted small' }, 'Visited without signing in'),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Identified share'),
      h('dd', {}, total ? `${Math.round(share * 100)}%` : '–'),
      h(
        'div',
        { class: 'meter', 'aria-hidden': 'true' },
        h('span', { style: `width:${share * 100}%` }),
      ),
    ),
  );
}

interface Member {
  id: string;
  properties: Record<string, unknown>;
}

/** Person ids from pasted text or an uploaded CSV: an id column if there's a header, else the first. */
function parseIds(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cells = (line: string) =>
    line.split(',').map((c) =>
      c
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim(),
    );
  let ids: string[];
  if (lines.length > 1 && lines.some((l) => l.includes(','))) {
    const head = cells(lines[0]!).map((c) => c.toLowerCase());
    const col = head.findIndex((c) =>
      ['id', 'person_id', 'distinct_id', 'user_id', 'person', 'user'].includes(c),
    );
    ids = (col >= 0 ? lines.slice(1) : lines).map((l) => cells(l)[Math.max(col, 0)] ?? '');
  } else {
    ids = lines.flatMap(cells);
    if (/^(id|person_id|distinct_id|user_id)$/i.test(ids[0] ?? '')) ids.shift();
  }
  return [...new Set(ids.filter(Boolean))];
}

function membersModal(c: Cohort, project: string | undefined, onChanged: () => void): void {
  const body = h('div', { class: 'members' });
  const people: Member[] = [];
  let offset = 0;
  let hasMore = false;
  const load = async (reset = false) => {
    if (reset) {
      people.length = 0;
      offset = 0;
    }
    const r = await api.get<{ people: Member[]; hasMore: boolean }>(
      `/api/cohorts/${encodeURIComponent(c.key)}/members`,
      { project, limit: 50, offset },
    );
    people.push(...r.people);
    offset += r.people.length;
    hasMore = r.hasMore;
    paint();
  };
  const edit = async (change: { add?: string[]; remove?: string[] }, done: string) => {
    try {
      await api.patch(`/api/cohorts/${encodeURIComponent(c.key)}/members`, {
        project,
        ...change,
      });
      toast(done);
      onChanged();
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const adder = (() => {
    if (c.kind !== 'static') return null;
    const input = h('input', {
      type: 'text',
      placeholder: 'Add people by id, comma-separated',
      'aria-label': 'Person ids to add',
    });
    const form = h(
      'form',
      { class: 'row members-add' },
      input,
      h('button', { type: 'submit' }, icon('plus', 14), 'Add'),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ids = parseIds(input.value);
      if (!ids.length) return;
      void edit({ add: ids }, `Added ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`);
      input.value = '';
    });
    return form;
  })();
  const paint = () => {
    const keys = topKeys(people as PersonSummary[], 4)
      .filter((k) => k !== 'name' && k !== 'email')
      .slice(0, 2);
    mount(
      body,
      h(
        'p',
        { class: 'muted small' },
        c.kind === 'static'
          ? `A fixed list of ${count(c.count)} ${c.count === 1 ? 'person' : 'people'}.`
          : `Everyone who ${c.summary} (${count(c.count)} now).`,
      ),
      adder,
      people.length
        ? table(
            ['Person', ...keys, ''],
            people.map((m) => [
              personCell(m.id, m.properties),
              ...keys.map((k) => h('span', { class: 'cell-clip' }, show(m.properties[k]) || '–')),
              c.kind === 'static'
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'ghost small',
                      onclick: () => void edit({ remove: [m.id] }, `Removed ${m.id}`),
                    },
                    'Remove',
                  )
                : '',
            ]),
            { class: 'members-table' },
          )
        : empty(
            c.kind === 'static'
              ? 'Nobody in this list yet. Add ids above.'
              : 'Nobody matches right now.',
          ),
      hasMore
        ? h(
            'button',
            { type: 'button', class: 'ghost small members-more', onclick: () => void load() },
            'Load more',
          )
        : null,
    );
  };
  mount(body, loading('Loading people', 'table'));
  const close = modal({
    title: c.name,
    width: 720,
    body,
    actions: [
      h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            try {
              await api.download(
                `/api/cohorts/${encodeURIComponent(c.key)}/members`,
                { project, format: 'csv', limit: 1000 },
                `cohort-${c.key}.csv`,
              );
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), 'error');
            }
          },
        },
        icon('arrowDown', 14),
        'Download CSV',
      ),
      h('button', { type: 'button', class: 'primary', onclick: () => close() }, 'Done'),
    ],
  });
  void load().catch((err) => mount(body, errorState(err)));
}

function cohortTable(
  cohorts: Cohort[],
  project: string | undefined,
  onEdit: (c: Cohort) => void,
  refresh: () => void,
): HTMLElement {
  return table(
    ['Cohort', 'Who', 'People', ''],
    cohorts.map((c) => [
      h(
        'div',
        { class: 'cohort-name' },
        h('strong', {}, c.name),
        h(
          'span',
          { class: 'cohort-badges' },
          c.kind === 'static' ? h('span', { class: 'badge' }, 'Static list') : null,
          c.usedByFlags ? h('span', { class: 'badge' }, 'Used by flags') : null,
        ),
        c.description ? h('span', { class: 'muted small' }, c.description) : null,
      ),
      h(
        'span',
        { class: 'muted cohort-summary' },
        c.kind === 'static' ? 'Uploaded or saved list of people' : c.summary,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'link-button count-link',
          title: 'See the people',
          onclick: () => membersModal(c, project, refresh),
        },
        count(c.count),
      ),
      h(
        'span',
        { class: 'row-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            onclick: () => membersModal(c, project, refresh),
          },
          'People',
        ),
        h('button', { type: 'button', class: 'ghost small', onclick: () => onEdit(c) }, 'Edit'),
        h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            title: 'Save today’s members as a static list',
            onclick: async () => {
              try {
                const r = await api.post<{ name: string; count: number }>(
                  `/api/cohorts/${encodeURIComponent(c.key)}/duplicate`,
                  { project, name: `${c.name} (copy)` },
                );
                toast(`Saved "${r.name}": ${count(r.count)} people`);
                invalidateValues('cohort');
                refresh();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
              }
            },
          },
          'Duplicate',
        ),
        c.kind === 'static'
          ? null
          : h('a', { class: 'button ghost small', href: c.retention }, 'Retention'),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': `Delete ${c.name}`,
            title: 'Delete',
            onclick: async () => {
              if (!confirm(`Delete cohort “${c.name}”?`)) return;
              try {
                await api.delete(`/api/cohorts/${encodeURIComponent(c.key)}`, { project });
                toast(`Deleted ${c.name}`);
                invalidateValues('cohort');
                refresh();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
              }
            },
          },
          icon('trash', 14),
        ),
      ),
    ]),
    { numeric: [2], class: 'cohorts-table' },
  );
}

function staticEstimate(n: number, editing: Cohort | null): string {
  if (!editing) return `${count(n)} ${n === 1 ? 'person' : 'people'}.`;
  if (!n) return `Leave empty to keep the current ${count(editing.count)} people.`;
  return `${count(n)} ${n === 1 ? 'id replaces' : 'ids replace'} the current ${count(editing.count)}.`;
}

/** Counts who matches a definition as it's edited, debounced; stale answers are dropped. */
function liveCount(def: CohortDefinition, project: string | undefined, out: HTMLElement) {
  let req = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (id: number) => {
    const definition = completeDefinition(def);
    if (!definition) {
      out.textContent = 'Pick an event or property to see how many people match.';
      return;
    }
    out.textContent = 'Counting…';
    let text: string;
    try {
      const r = await api.post<{ count: number }>('/api/cohorts/count', { project, definition });
      text = `${count(r.count)} ${r.count === 1 ? 'person matches' : 'people match'} right now.`;
    } catch (err) {
      text = err instanceof Error ? err.message : 'Could not count this definition yet.';
    }
    if (id === req) out.textContent = text;
  };
  return {
    cancel: () => clearTimeout(timer),
    schedule: () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(++req), 300);
    },
  };
}

function staticListEditor(
  ids: HTMLTextAreaElement,
  editing: Cohort | null,
  onChange: () => void,
): HTMLElement {
  const upload = h('input', {
    type: 'file',
    accept: '.csv,.txt,text/csv,text/plain',
    class: 'visually-hidden',
  });
  upload.addEventListener('change', async () => {
    const file = upload.files?.[0];
    if (!file) return;
    ids.value = await file.text();
    onChange();
  });
  const hint =
    editing?.kind === 'static'
      ? 'Replaces the list. To add or remove a few people, use People in the list above.'
      : 'Up to 10,000 people. Use the ids you pass to glass.identify().';
  return h(
    'div',
    { class: 'stack tight' },
    ids,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'button ghost small' }, icon('arrowUp', 14), 'Upload a CSV', upload),
      h('span', { class: 'muted small' }, hint),
    ),
  );
}

/** The request body for a cohort, or a message saying what's missing. */
function cohortBody(
  kind: 'dynamic' | 'static',
  base: Record<string, unknown>,
  ids: string,
  def: CohortDefinition,
  editing: Cohort | null,
): Record<string, unknown> | string {
  if (kind === 'static') {
    const list = parseIds(ids);
    if (!list.length && editing?.kind !== 'static') return 'Add at least one person id';
    return { ...base, static: true, ...(list.length ? { ids: list } : {}) };
  }
  const definition = completeDefinition(def);
  if (!definition) return 'Add a condition: pick an event, a property or a cohort';
  return { ...base, definition };
}

function cohortForm(
  cohorts: Cohort[],
  editing: Cohort | null,
  project: string | undefined,
  onSaved: () => void,
  onCancel: () => void,
): HTMLElement {
  const name = h('input', {
    type: 'text',
    value: editing?.name ?? '',
    placeholder: 'e.g. Power users',
    required: true,
  });
  const description = h('input', {
    type: 'text',
    value: editing?.description ?? '',
    placeholder: 'Optional: what they have in common, for whoever reads it next',
  });
  let kind: 'dynamic' | 'static' = editing?.kind ?? 'dynamic';
  const def: CohortDefinition = editing?.definition
    ? structuredClone(editing.definition)
    : emptyDefinition();
  const estimate = h('p', { class: 'muted small cohort-estimate', 'aria-live': 'polite' });
  const counter = liveCount(def, project, estimate);
  const ids = h('textarea', {
    rows: 5,
    placeholder: 'user-1\nuser-2\n… (one per line, or a CSV with an id column)',
    'aria-label': 'Person ids',
  });
  const recount = () => {
    if (kind === 'dynamic') return counter.schedule();
    counter.cancel();
    estimate.textContent = staticEstimate(parseIds(ids.value).length, editing);
  };
  ids.addEventListener('input', recount);
  const choices = cohorts
    .filter((c) => c.key !== editing?.key)
    .map((c) => ({ key: c.key, name: c.name }));
  const staticEditor = staticListEditor(ids, editing, recount);
  const slot = h('div', {});
  const kindTabs = h('div', {});
  const paint = () => {
    mount(
      kindTabs,
      tabs(
        [
          { value: 'dynamic', label: 'Conditions', icon: 'filter' },
          { value: 'static', label: 'A list of people', icon: 'users' },
        ],
        kind,
        (v) => {
          kind = v;
          paint();
        },
        'tabs-small',
      ),
    );
    mount(slot, kind === 'dynamic' ? cohortEditor(def, project, choices, recount) : staticEditor);
    recount();
  };
  paint();
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'cohort-form' },
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
    ),
    h('div', { class: 'field' }, h('span', {}, 'Who is in it'), kindTabs, slot),
    error,
    h(
      'div',
      { class: 'form-actions cohort-submit' },
      h('button', { type: 'submit', class: 'primary' }, editing ? 'Save changes' : 'Save cohort'),
      editing ? h('button', { type: 'button', onclick: onCancel }, 'Cancel') : null,
      estimate,
    ),
  );
  const save = async () => {
    mount(error);
    if (!name.value.trim()) return toast('Name the cohort', 'error');
    const base = {
      project,
      ...(editing ? { key: editing.key } : {}),
      name: name.value.trim(),
      description: description.value.trim() || undefined,
    };
    const body = cohortBody(kind, base, ids.value, def, editing);
    if (typeof body === 'string') return toast(body, 'error');
    try {
      const r = await api.post<{ summary: string }>('/api/cohorts', body);
      toast(r.summary.replace(/:.*$/, '.'));
      invalidateValues('cohort');
      onSaved();
    } catch (err) {
      mount(error, errorState(err));
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });
  return form;
}

function cohortsPanel(project: string | undefined): HTMLElement {
  const body = h('div', { class: 'cohorts' });
  let editing: Cohort | null = null;
  const render = async () => {
    try {
      const { cohorts } = await api.get<{ cohorts: Cohort[] }>('/api/cohorts', { project });
      const formPanel = panel(
        editing ? `Edit “${editing.name}”` : 'New cohort',
        cohortForm(
          cohorts,
          editing,
          project,
          () => {
            editing = null;
            void render();
          },
          () => {
            editing = null;
            void render();
          },
        ),
        {
          icon: editing ? 'settings' : 'plus',
          subtitle: editing
            ? 'Changes apply everywhere the cohort is used: filters, breakdowns and flags.'
            : 'By what people are and what they did, or a list of ids.',
          class: 'cohort-form-panel',
        },
      );
      mount(
        body,
        panel(
          'Cohorts',
          cohorts.length
            ? cohortTable(
                cohorts,
                project,
                (c) => {
                  editing = c;
                  void render().then(() =>
                    body
                      .querySelector('.cohort-form-panel')
                      ?.scrollIntoView({ behavior: 'smooth' }),
                  );
                },
                () => void render(),
              )
            : empty(
                'Save one below. Counts update live, and each cohort works as a filter and breakdown everywhere.',
                undefined,
                { icon: 'layers', title: 'No cohorts yet' },
              ),
          {
            icon: 'layers',
            subtitle: 'Reusable groups of people for filters, breakdowns, flags and experiments.',
          },
        ),
        formPanel,
      );
    } catch (err) {
      mount(body, errorState(err));
    }
  };
  mount(body, loading('Loading cohorts', 'table'));
  void render();
  return body;
}

/** The most common property keys, shown as their own columns. */
function topKeys(persons: PersonSummary[], limit = 3): string[] {
  const seen = new Map<string, number>();
  for (const p of persons)
    for (const k of Object.keys(p.properties)) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

const show = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** The best human label for a person: name, then email, then id. */
function personLabel(
  id: string,
  props: Record<string, unknown>,
): { primary: string; secondary: string | null; via: string | null } {
  const name = show(props.name);
  const email = show(props.email);
  if (name) return { primary: name, secondary: email || id, via: email ? 'email' : null };
  if (email) return { primary: email, secondary: email === id ? null : id, via: 'email' };
  return { primary: id, secondary: null, via: null };
}

function personCell(id: string, props: Record<string, unknown>): HTMLElement {
  const label = personLabel(id, props);
  return h(
    'a',
    { class: 'person-cell', href: href(`users/${encodeURIComponent(id)}`) },
    avatar(id, initials(label.primary), hue(id)),
    h(
      'span',
      { class: 'person-text' },
      h('span', { class: 'person-id' }, label.primary),
      label.secondary ? h('span', { class: 'muted small' }, label.secondary) : null,
    ),
  );
}

const PAGE_SIZE = 25;

function peopleTable(persons: PersonSummary[]): HTMLElement {
  const keys = topKeys(persons, 4)
    .filter((k) => k !== 'name' && k !== 'email')
    .slice(0, 3);
  const holder = h('div', {});
  let page = 0;
  const pages = Math.max(1, Math.ceil(persons.length / PAGE_SIZE));
  const paint = () => {
    const rows = persons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    mount(
      holder,
      table(
        ['Person', ...keys, 'First seen', 'Last seen'],
        rows.map((p) => [
          personCell(p.id, p.properties),
          ...keys.map((k) => {
            const v = show(p.properties[k]);
            return v
              ? k === 'plan' || k.endsWith('_plan') || k === 'role'
                ? h('span', { class: 'badge' }, v)
                : h('span', { class: 'cell-clip', title: v }, v)
              : h('span', { class: 'muted' }, '–');
          }),
          h('span', { class: 'muted' }, dateTime(p.firstSeen)),
          ago(p.lastSeen),
        ]),
        { class: 'people-table' },
      ),
      pages > 1
        ? h(
            'div',
            { class: 'pager' },
            h(
              'span',
              { class: 'muted small' },
              `${page * PAGE_SIZE + 1}–${Math.min(persons.length, (page + 1) * PAGE_SIZE)} of ${count(persons.length)}${persons.length >= 100 ? ' most recently active' : ''}`,
            ),
            h(
              'div',
              { class: 'pager-buttons' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'ghost small',
                  disabled: page === 0,
                  'aria-label': 'Previous page',
                  onclick: () => {
                    page--;
                    paint();
                  },
                },
                icon('chevronLeft', 14),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'ghost small',
                  disabled: page >= pages - 1,
                  'aria-label': 'Next page',
                  onclick: () => {
                    page++;
                    paint();
                  },
                },
                icon('chevronRight', 14),
              ),
            ),
          )
        : null,
    );
  };
  paint();
  return holder;
}

function list(route: Route): Node[] {
  const tab = route.params.get('tab') === 'cohorts' ? 'cohorts' : 'people';
  const q = route.params.get('q') ?? '';
  const search = h('input', {
    type: 'search',
    value: q,
    placeholder: 'Search by id or property value',
    'aria-label': 'Search people',
  });
  const form = h('form', { class: 'search-field', role: 'search' }, icon('search', 15), search);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go('users', { q: search.value });
  });
  const project = scope().project;
  const switcher = tabs(
    [
      { value: 'people', label: 'People', icon: 'users' },
      { value: 'cohorts', label: 'Cohorts', icon: 'layers' },
    ],
    tab,
    (v) => go('users', { tab: v === 'people' ? null : v }),
  );
  if (tab === 'cohorts') {
    return [
      pageHeader(
        'People',
        'Saved cohorts: reusable groups of people for filters, funnels and retention.',
        switcher,
      ),
      cohortsPanel(project),
    ];
  }
  return [
    pageHeader(
      'People',
      'Identified users from glass.identify(), and how much traffic is still anonymous.',
      switcher,
    ),
    later(
      async () => {
        const r = await api.get<{
          persons: PersonSummary[];
          stats: PeopleStats;
          summary: string;
          sql?: string[];
        }>('/api/persons', { project, query: q, limit: 100 });
        const body: Child =
          r.persons.length === 0
            ? empty(
                q
                  ? `No identified people match "${q}".`
                  : 'Call glass.identify(userId) after login. Anonymous devices still count in the overview above.',
                undefined,
                { icon: 'users', title: q ? 'No matches' : 'No identified people yet' },
              )
            : peopleTable(r.persons);
        return [
          peopleKpis(r.stats),
          panel('Identified people', body, {
            sql: r.sql,
            actions: form,
            subtitle: r.summary,
            class: 'people-panel',
          }),
        ];
      },
      'Loading people',
      'table',
    ),
  ];
}

function revenueKpis(r: NonNullable<Person['revenue']>): HTMLElement {
  return h(
    'dl',
    { class: 'kpis' },
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Lifetime revenue'),
      h('dd', {}, money(r.net, r.currency)),
      h(
        'div',
        { class: 'kpi-note muted small' },
        r.gross !== r.net ? `${money(r.gross, r.currency)} before refunds` : 'Net of refunds',
      ),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Payments'),
      h('dd', {}, count(r.orders)),
      h('div', { class: 'kpi-note muted small' }, 'In the last two years'),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'First payment'),
      h('dd', { class: 'kpi-date' }, r.firstAt ? dateTime(r.firstAt) : '–'),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Latest payment'),
      h('dd', { class: 'kpi-date' }, r.lastAt ? ago(r.lastAt) : '–'),
    ),
  );
}

function propertiesPanel(p: Person): HTMLElement {
  const entries = Object.entries(p.properties);
  const body = entries.length
    ? h(
        'dl',
        { class: 'props' },
        entries.map(([k, v]) => [
          h('dt', {}, k),
          h('dd', {}, typeof v === 'object' ? JSON.stringify(v) : String(v)),
        ]),
      )
    : empty(
        p.identified ? 'No properties set.' : 'Anonymous device: identify() has not been called.',
      );
  return panel('Properties', body);
}

function devicesPanel(p: Person): HTMLElement {
  const seen = `First seen ${p.firstSeen ? dateTime(p.firstSeen) : 'never'}, last seen ${p.lastSeen ? ago(p.lastSeen) : 'never'}.`;
  const devices = p.devices.length
    ? h('p', {}, `${p.devices.length} linked device${p.devices.length === 1 ? '' : 's'}.`)
    : null;
  const replays = p.replays.length
    ? h(
        'ul',
        { class: 'plain' },
        p.replays.map((r) =>
          h(
            'li',
            {},
            h('a', { href: href(`replays/${r.session}`) }, dateTime(r.started)),
            r.errors ? h('span', { class: 'badge bad' }, `${r.errors} errors`) : null,
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'No recorded sessions.');
  return panel(
    'Devices and sessions',
    h('div', {}, h('p', { class: 'muted' }, seen), devices, replays),
  );
}

function groupsPanel(groups: NonNullable<Person['groups']>): HTMLElement {
  const card = (g: (typeof groups)[number]) =>
    h(
      'a',
      {
        class: 'person-group',
        href: href(`groups/${encodeURIComponent(g.type)}/${encodeURIComponent(g.key)}`),
      },
      avatar(`${g.type}:${g.key}`, initials(g.name ?? g.key), hue(g.key), 28),
      h(
        'span',
        { class: 'person-text' },
        h('span', { class: 'person-id' }, g.name ?? g.key),
        h(
          'span',
          { class: 'muted small' },
          `${g.type}${g.name ? ` · ${g.key}` : ''} · active ${ago(g.lastSeen)}`,
        ),
      ),
    );
  return panel('Groups', h('div', { class: 'person-groups' }, groups.map(card)), {
    icon: 'layers',
    subtitle: 'Companies, teams or accounts their events named in the last 90 days.',
  });
}

function recentEventsPanel(p: Person): HTMLElement {
  const body = p.recentEvents.length
    ? table(
        ['Time', 'Event', 'Page', 'Properties'],
        p.recentEvents.map((e) => [
          h('span', { class: 'muted' }, dateTime(e.time)),
          h('span', { class: 'event-pill' }, e.event),
          e.path,
          h('span', { class: 'muted cell-clip' }, preview(e.properties)),
        ]),
      )
    : empty('No events in the last 90 days.');
  return panel('Recent events', body, { sql: p.sql });
}

async function personView(id: string): Promise<Child[]> {
  const p = await api.get<Person>(`/api/persons/${encodeURIComponent(id)}`, {
    project: scope().project,
  });
  const label = personLabel(p.id, p.properties).primary;
  return [
    h(
      'div',
      { class: 'person-head' },
      avatar(p.id, initials(label), hue(p.id), 52),
      pageHeader(label, p.summary, copyButton(p.id, 'Copy id')),
    ),
    p.revenue ? revenueKpis(p.revenue) : null,
    h('div', { class: 'grid-2' }, propertiesPanel(p), devicesPanel(p)),
    p.groups?.length ? groupsPanel(p.groups) : null,
    recentEventsPanel(p),
  ];
}

function detail(id: string): Node[] {
  return [later(() => personView(id))];
}

export function peoplePage(route: Route): Node[] {
  return route.rest[0] ? detail(route.rest[0]) : list(route);
}
