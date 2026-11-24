/**
 * Dashboards: saved analyses and notes on a 12-column grid, with one date range and filter set
 * for the lot. Start one from a template; add tiles from saved analyses or as text; drag (or
 * use the arrow keys on the handle) to reorder; resize from a tile's menu; schedule the whole
 * dashboard as a report.
 */

import { api } from '../api.ts';
import { type TileView, tileBody } from '../components/dashboard-tile.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { icon } from '../components/icons.ts';
import { modal, popover, selectMenu, toggle } from '../components/menu.ts';
import { eventPicker } from '../components/picker.ts';
import { subscribeDialog } from '../components/report-dialogs.ts';
import { empty, errorState, iconButton, later, pageHeader, toast } from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  tiles: number;
  updatedAt: string;
}

interface Filters {
  from?: string;
  to?: string;
  filters?: FilterRow[];
  filterTestAccounts?: boolean;
}

interface Dashboard {
  id: string;
  name: string;
  description: string;
  filters: Filters;
  tiles: TileView[];
}

interface Template {
  id: string;
  name: string;
  description: string;
  needs: ('signup' | 'purchase')[];
}

const project = () => scope().project;

// ── The list ────────────────────────────────────────────────────────────────

/** Ask for the event a template needs, then create it. */
function askForEvent(
  t: Template,
  role: 'signup' | 'purchase',
  events: Record<string, string>,
): void {
  let picked = '';
  const close = modal({
    title: `${t.name}: which event is your ${role}?`,
    body: h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted' },
        `Dataflare couldn't tell from your event names. Pick the event people send when they ${role === 'signup' ? 'sign up' : 'pay'}.`,
      ),
      eventPicker({ value: '', project: project(), label: 'Event', onChange: (v) => (picked = v) }),
    ),
    actions: h(
      'button',
      {
        type: 'button',
        class: 'primary',
        onclick: () => {
          if (!picked) return;
          close();
          void createFromTemplate(t, { ...events, [role]: picked });
        },
      },
      'Create dashboard',
    ),
  });
}

async function createFromTemplate(t: Template, events: Record<string, string> = {}): Promise<void> {
  try {
    const r = await api.post<{ id: string }>('/api/dashboards/from-template', {
      project: project(),
      template: t.id,
      events,
    });
    toast(`Created ${t.name}`);
    go(`dashboards/${r.id}`);
  } catch (err) {
    const missing = /needs your (signup|purchase) event/.exec(
      err instanceof Error ? err.message : '',
    );
    if (missing) askForEvent(t, missing[1] as 'signup' | 'purchase', events);
    else toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function templateCards(
  templates: Template[],
  guessed: Record<string, string | undefined>,
): HTMLElement {
  return h(
    'div',
    { class: 'template-cards' },
    templates.map((t) => {
      const uses = t.needs.map((role) => guessed[role]).filter(Boolean);
      return h(
        'button',
        { type: 'button', class: 'template-card', onclick: () => void createFromTemplate(t) },
        h('span', { class: 'template-icon' }, icon('dashboard', 18)),
        h('strong', {}, t.name),
        h('span', { class: 'muted small' }, t.description),
        uses.length
          ? h('span', { class: 'template-uses small' }, `Uses ${uses.join(' and ')}`)
          : null,
      );
    }),
  );
}

async function newDashboard(): Promise<void> {
  const name = prompt('Name the dashboard', 'My dashboard');
  if (!name?.trim()) return;
  const r = await api.post<{ id: string }>('/api/dashboards', {
    project: project(),
    name: name.trim(),
  });
  go(`dashboards/${r.id}`);
}

async function dashboardList(): Promise<Child> {
  const [list, templates] = await Promise.all([
    api.get<{ dashboards: DashboardSummary[] }>('/api/dashboards', { project: project() }),
    api.get<{ templates: Template[]; events: Record<string, string | undefined> }>(
      '/api/dashboards/templates',
      { project: project() },
    ),
  ]);
  const starters = h(
    'section',
    { class: 'stack' },
    h(
      'h2',
      { class: 'section-title' },
      list.dashboards.length ? 'Start from a template' : 'Start with a template',
    ),
    templateCards(templates.templates, templates.events),
  );
  if (!list.dashboards.length)
    return [
      empty(
        'A dashboard puts several analyses side by side, and can be sent to Slack or email every week.',
        null,
        { icon: 'dashboard', title: 'No dashboards yet' },
      ),
      starters,
    ];
  return h(
    'div',
    { class: 'dashboards-home' },
    h(
      'div',
      { class: 'dashboard-list' },
      list.dashboards.map((d) =>
        h(
          'a',
          { class: 'dashboard-card', href: href(`dashboards/${d.id}`) },
          h('strong', {}, d.name),
          d.description ? h('span', { class: 'muted small' }, d.description) : null,
          h(
            'span',
            { class: 'muted small' },
            `${d.tiles} tile${d.tiles === 1 ? '' : 's'} · updated ${ago(d.updatedAt)}`,
          ),
        ),
      ),
    ),
    starters,
  );
}

// ── One dashboard ──────────────────────────────────────────────────────────

const SIZES: [string, number][] = [
  ['Small (¼)', 3],
  ['Third', 4],
  ['Half', 6],
  ['Full width', 12],
];

const RANGES = [
  { value: '', label: 'Page date range' },
  { value: '-7d', label: 'Last 7 days' },
  { value: '-30d', label: 'Last 30 days' },
  { value: '-90d', label: 'Last 90 days' },
  { value: '-12mo', label: 'Last 12 months' },
];

interface BoardState {
  d: Dashboard;
  grid: HTMLElement;
  reload: () => void;
}

async function saveFilters(s: BoardState, filters: Filters): Promise<void> {
  s.d.filters = filters;
  await api.put(`/api/dashboards/${s.d.id}`, {
    project: project(),
    name: s.d.name,
    description: s.d.description,
    filters,
  });
  s.reload();
}

function filterBar(s: BoardState): HTMLElement {
  const rows = structuredClone((s.d.filters.filters ?? []) as FilterRow[]);
  const commit = () =>
    void saveFilters(s, { ...s.d.filters, filters: (cleanFilters(rows) ?? []) as FilterRow[] });
  return h(
    'div',
    { class: 'toolbar dashboard-filters' },
    selectMenu({
      value: s.d.filters.from ?? '',
      label: 'Date range for every tile',
      icon: 'clock',
      options: RANGES,
      width: 190,
      onChange: (v) => void saveFilters(s, { ...s.d.filters, from: v || undefined }),
    }),
    filterEditor(rows, commit, { project: project(), cohorts: true }),
    toggle({
      checked: Boolean(s.d.filters.filterTestAccounts),
      label: 'Hide internal traffic',
      onChange: (c) => void saveFilters(s, { ...s.d.filters, filterTestAccounts: c || undefined }),
    }),
  );
}

async function moveTile(s: BoardState, id: string, to: number): Promise<void> {
  const ids = s.d.tiles.map((t) => t.id).filter((x) => x !== id);
  ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
  await api.put(`/api/dashboards/${s.d.id}/order`, { project: project(), tiles: ids });
  s.reload();
}

async function updateTile(
  s: BoardState,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await api.put(`/api/dashboards/${s.d.id}/tiles/${id}`, { project: project(), ...patch });
  s.reload();
}

async function removeTile(s: BoardState, t: TileView): Promise<void> {
  await api.delete(`/api/dashboards/${s.d.id}/tiles/${t.id}`, { project: project() });
  toast(t.kind === 'insight' ? 'Tile removed (the analysis stays)' : 'Text removed');
  s.reload();
}

function editText(s: BoardState, t: TileView): void {
  const area = h('textarea', { rows: 8, 'aria-label': 'Text' }) as HTMLTextAreaElement;
  area.value = t.text ?? '';
  const close = modal({
    title: 'Edit text',
    body: h(
      'div',
      { class: 'stack tight' },
      area,
      h(
        'p',
        { class: 'muted small' },
        '# Heading, **bold**, _italic_, [link](https://…), - list item',
      ),
    ),
    actions: h(
      'button',
      {
        type: 'button',
        class: 'primary',
        onclick: () => void updateTile(s, t.id, { text: area.value }).then(close),
      },
      'Save',
    ),
  });
}

function tileMenu(s: BoardState, t: TileView, index: number): HTMLElement {
  const trigger = iconButton('more', 'Tile options', () => {});
  const item = (label: string, run: () => void, current = false) =>
    h(
      'button',
      {
        type: 'button',
        class: `menu-item ${current ? 'current' : ''}`,
        role: 'menuitem',
        onclick: run,
      },
      label,
    );
  popover(trigger, (close) =>
    h(
      'div',
      { class: 'menu', role: 'menu' },
      h('div', { class: 'menu-title' }, 'Size'),
      SIZES.map(([label, w]) =>
        item(label, () => (close(), void updateTile(s, t.id, { width: w })), t.width === w),
      ),
      item(
        t.height === 2 ? 'Make it shorter' : 'Make it taller',
        () => (close(), void updateTile(s, t.id, { height: t.height === 2 ? 1 : 2 })),
      ),
      h('div', { class: 'menu-divider', role: 'separator' }),
      t.kind === 'insight'
        ? item(
            t.ignoreFilters ? 'Use the dashboard filters' : 'Ignore the dashboard filters',
            () => (close(), void updateTile(s, t.id, { ignoreFilters: !t.ignoreFilters })),
          )
        : item('Edit text', () => (close(), editText(s, t))),
      index > 0 ? item('Move earlier', () => (close(), void moveTile(s, t.id, index - 1))) : null,
      index < s.d.tiles.length - 1
        ? item('Move later', () => (close(), void moveTile(s, t.id, index + 1)))
        : null,
      item('Remove from dashboard', () => (close(), void removeTile(s, t))),
    ),
  );
  return trigger;
}

/** The drag handle: drag onto another tile, or Arrow keys to move. */
function grip(s: BoardState, t: TileView, index: number, tile: HTMLElement): HTMLElement {
  const handle = h(
    'button',
    {
      type: 'button',
      class: 'icon-button tile-grip',
      'aria-label': `Move ${t.insight?.name ?? 'text'} (arrow keys)`,
      draggable: 'true',
    },
    icon('grip', 14),
  );
  handle.addEventListener('dragstart', (e) => {
    (e as DragEvent).dataTransfer?.setData('text/x-tile', t.id);
    tile.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => tile.classList.remove('dragging'));
  handle.addEventListener('keydown', (e) => {
    const step =
      e.key === 'ArrowUp' || e.key === 'ArrowLeft'
        ? -1
        : e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? 1
          : 0;
    if (!step) return;
    e.preventDefault();
    void moveTile(s, t.id, index + step);
  });
  return handle;
}

function dropTarget(s: BoardState, tile: HTMLElement, index: number): void {
  tile.addEventListener('dragover', (e) => {
    e.preventDefault();
    tile.classList.add('drop');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
  tile.addEventListener('drop', (e) => {
    e.preventDefault();
    tile.classList.remove('drop');
    const id = (e as DragEvent).dataTransfer?.getData('text/x-tile');
    if (id) void moveTile(s, id, index);
  });
}

function tileCard(s: BoardState, t: TileView, index: number): HTMLElement {
  const computed = h('span', { class: 'muted small tile-computed' });
  const title =
    t.kind === 'insight'
      ? t.insight
        ? h('a', { href: href(`insights/${t.insight.key}`), class: 'tile-title' }, t.insight.name)
        : h('span', { class: 'tile-title muted' }, 'Deleted analysis')
      : null;
  const tile = h('article', {
    class: `tile tile-${t.kind} span-${t.width} rows-${t.height}`,
    'data-tile': t.id,
  });
  tile.append(
    h(
      'header',
      { class: 'tile-head' },
      grip(s, t, index, tile),
      title,
      t.ignoreFilters
        ? h(
            'span',
            { class: 'badge', title: 'Runs as saved, without the dashboard range and filters' },
            'Own filters',
          )
        : null,
      h('span', { class: 'spacer' }),
      computed,
      tileMenu(s, t, index),
    ),
    tileBody(
      t,
      (at) =>
        (computed.textContent = `at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
    ),
  );
  dropTarget(s, tile, index);
  return tile;
}

async function pickAnalysis(s: BoardState): Promise<void> {
  const r = await api.get<{ insights: { key: string; name: string; kind: string }[] }>(
    '/api/insights',
    { project: project() },
  );
  const onBoard = new Set(s.d.tiles.map((t) => t.insight?.key));
  const close = modal({
    title: 'Add a saved analysis',
    width: 520,
    body: r.insights.length
      ? h(
          'ul',
          { class: 'pick-list' },
          r.insights.map((i) =>
            h(
              'li',
              {},
              h(
                'button',
                {
                  type: 'button',
                  class: 'pick-row',
                  onclick: async () => {
                    await api.post(`/api/dashboards/${s.d.id}/tiles`, {
                      project: project(),
                      insightKey: i.key,
                    });
                    close();
                    s.reload();
                  },
                },
                h('span', { class: `kind-chip kind-${i.kind}` }, i.kind),
                h('span', {}, i.name),
                onBoard.has(i.key)
                  ? h('span', { class: 'muted small' }, 'on this dashboard')
                  : null,
              ),
            ),
          ),
        )
      : empty(
          'Save an analysis in Insights first.',
          h('a', { class: 'button', href: href('insights/new/trends') }, 'New analysis'),
        ),
  });
}

async function addText(s: BoardState): Promise<void> {
  const text = prompt('Text for the tile (# heading, **bold**, - list)', '## Notes');
  if (!text?.trim()) return;
  await api.post(`/api/dashboards/${s.d.id}/tiles`, { project: project(), text, width: 12 });
  s.reload();
}

function addMenu(s: BoardState): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button' },
    icon('plus', 15),
    'Add tile',
    icon('chevronDown', 14),
  );
  popover(trigger, (close) =>
    h(
      'div',
      { class: 'menu', role: 'menu' },
      h(
        'button',
        { type: 'button', class: 'menu-item', onclick: () => (close(), void pickAnalysis(s)) },
        'A saved analysis',
      ),
      h(
        'button',
        { type: 'button', class: 'menu-item', onclick: () => (close(), void addText(s)) },
        'Text',
      ),
    ),
  );
  return trigger;
}

async function renameDashboard(s: BoardState): Promise<void> {
  const name = prompt('Rename the dashboard', s.d.name);
  if (!name?.trim()) return;
  await api.put(`/api/dashboards/${s.d.id}`, {
    project: project(),
    name: name.trim(),
    description: s.d.description,
    filters: s.d.filters,
  });
  s.reload();
}

async function duplicate(s: BoardState): Promise<void> {
  const r = await api.post<{ id: string }>(`/api/dashboards/${s.d.id}/duplicate`, {
    project: project(),
    name: `${s.d.name} (copy)`,
  });
  go(`dashboards/${r.id}`);
}

async function remove(s: BoardState): Promise<void> {
  if (!confirm(`Delete "${s.d.name}" and its scheduled reports? The analyses stay.`)) return;
  await api.delete(`/api/dashboards/${s.d.id}`, { project: project() });
  toast('Dashboard deleted');
  go('dashboards');
}

function moreMenu(s: BoardState): HTMLElement {
  const trigger = iconButton('more', 'Dashboard options', () => {});
  popover(trigger, (close) =>
    h(
      'div',
      { class: 'menu', role: 'menu' },
      h(
        'button',
        { type: 'button', class: 'menu-item', onclick: () => (close(), void renameDashboard(s)) },
        'Rename',
      ),
      h(
        'button',
        { type: 'button', class: 'menu-item', onclick: () => (close(), void duplicate(s)) },
        'Duplicate',
      ),
      h(
        'button',
        { type: 'button', class: 'menu-item danger', onclick: () => (close(), void remove(s)) },
        'Delete',
      ),
    ),
  );
  return trigger;
}

function headerActions(s: BoardState): HTMLElement {
  const tiles = s.d.tiles
    .filter((t) => t.kind === 'insight' && t.insight)
    .map((t): [string, string] => [t.id, t.insight!.name]);
  return h(
    'div',
    { class: 'row' },
    h('button', { type: 'button', onclick: () => s.reload() }, icon('refresh', 15), 'Refresh'),
    h(
      'button',
      {
        type: 'button',
        onclick: () => subscribeDialog({ kind: 'dashboard', id: s.d.id, name: s.d.name, tiles }),
      },
      icon('send', 15),
      'Subscribe',
    ),
    addMenu(s),
    moreMenu(s),
  );
}

function boardGrid(s: BoardState): Child {
  if (!s.d.tiles.length)
    return empty(
      'Add saved analyses or notes, then arrange them.',
      h('div', { class: 'row' }, addMenu(s)),
      { icon: 'dashboard', title: 'An empty dashboard' },
    );
  return s.d.tiles.map((t, i) => tileCard(s, t, i));
}

function dashboardView(id: string): Node[] {
  const holder = h('div', { class: 'dashboard-view' });
  const load = async () => {
    try {
      const d = await api.get<Dashboard>(`/api/dashboards/${encodeURIComponent(id)}`, {
        project: project(),
      });
      const grid = h('div', { class: 'dashboard-grid' });
      const s: BoardState = { d, grid, reload: () => void load() };
      mount(grid, boardGrid(s));
      mount(
        holder,
        pageHeader(d.name, d.description || undefined, headerActions(s)),
        filterBar(s),
        grid,
      );
    } catch (err) {
      mount(holder, errorState(err));
    }
  };
  void load();
  return [holder];
}

export function dashboardsPage(route: Route): Node[] {
  const id = route.rest[0];
  if (id) return dashboardView(id);
  return [
    pageHeader(
      'Dashboards',
      'Analyses side by side, with one date range and filters, sent to Slack or email on a schedule.',
      [
        h(
          'a',
          { class: 'button small', href: href('sites', { project: project() }) },
          'Traffic overview',
        ),
        h(
          'button',
          { type: 'button', class: 'primary', onclick: () => void newDashboard() },
          icon('plus', 15),
          'New dashboard',
        ),
      ],
    ),
    later(dashboardList, 'Loading dashboards'),
  ];
}
