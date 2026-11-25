/**
 * Insights: saved analyses (library), and the analysis workspace: a query rail on the left,
 * the chart on the right, run again as you edit.
 *
 * Routes:
 *   #/insights                  library of saved analyses
 *   #/insights/new[/:kind]      create
 *   #/insights/:kind?spec=…     ephemeral run (agent / share links)
 *   #/insights/:key[?spec=…]    a saved analysis (with unsaved edits, when there are any)
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { PathsResult } from '@dataflare/core/insights/paths';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import { resolveRange } from '@dataflare/core/time';
import { api } from '../api.ts';
import { activation } from '../components/activation.ts';
import { chartOptionsButton } from '../components/chart-options.ts';
import { type Annotation, periodReached, sparkline } from '../components/charts.ts';
import { previousRange } from '../components/date-range.ts';
import { cleanFilters, type FilterRow } from '../components/filter-editor.ts';
import type { FormulaData } from '../components/formula-editor.ts';
import { funnelRail, funnelViewControls } from '../components/funnel-rail.ts';
import { type IconName, icon } from '../components/icons.ts';
import { PROPERTY_MATHS, showActors } from '../components/insight-options.ts';
import { readBreakdowns, type SeriesSpec, type StepSpec } from '../components/insight-rail.ts';
import { starters } from '../components/insight-starters.ts';
import {
  countedNoun,
  funnelView,
  retentionView,
  TIME_DISPLAYS,
  trendsView,
} from '../components/insight-views.ts';
import { modal, popover, selectMenu, toggle } from '../components/menu.ts';
import { pathsRail } from '../components/paths-rail.ts';
import { pathsView } from '../components/paths-view.ts';
import { INSIGHT_PROMPT } from '../components/prompts.ts';
import { alertDialog } from '../components/report-dialogs.ts';
import { retentionRail } from '../components/retention-rail.ts';
import { type RailContext, type RailState, trendsRail } from '../components/trends-rail.ts';
import {
  copyButton,
  empty,
  errorState,
  iconButton,
  later,
  loading,
  pageHeader,
  panel,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, bucketLabel, count, percent } from '../format.ts';
import { go, href, prefs, type Route, scope } from '../state.ts';

type Kind = 'trends' | 'funnel' | 'retention' | 'paths';
type Spec = Record<string, unknown>;

const KINDS: Kind[] = ['trends', 'funnel', 'retention', 'paths'];
const KIND_LABEL: Record<Kind, string> = {
  trends: 'Trends',
  funnel: 'Funnel',
  retention: 'Retention',
  paths: 'Paths',
};
const KIND_ICON: Record<Kind, IconName> = {
  trends: 'lineChart',
  funnel: 'funnel',
  retention: 'retention',
  paths: 'paths',
};
const KIND_BLURB: Record<Kind, string> = {
  trends: 'Counts, uniques or sums of any event over time.',
  funnel: 'How many people complete a sequence of steps.',
  retention: 'How many people come back after their first visit.',
  paths: 'The journeys people take, page by page or event by event.',
};

const DEFAULTS: Record<Kind, Spec> = {
  trends: { series: [{ event: '$pageview', math: 'total' }], interval: 'day' },
  funnel: { steps: [{ event: '$pageview' }, { event: '' }], window: '7d' },
  retention: {
    cohortEvent: { event: '$pageview' },
    returnEvent: { event: '$pageview' },
    period: 'week',
    periods: 8,
  },
  paths: { steps: 5 },
};

interface SavedInsight {
  key: string;
  name: string;
  description: string;
  kind: Kind;
  spec: Spec;
  updatedAt: string;
}

/** Set `key` when there is a value, or leave it out. */
function setOrDelete(out: Spec, key: string, value: unknown): void {
  if (value === undefined) delete out[key];
  else out[key] = value;
}

/** A series, step or event with its unfinished filter rows dropped. */
function withCleanFilters<T extends { filters?: FilterRow[] }>(s: T): T {
  const next = { ...s };
  const filters = cleanFilters(s.filters);
  if (filters) next.filters = filters;
  else delete next.filters;
  return next;
}

const KIND_CLEANERS: Record<Kind, (out: Spec) => void> = {
  trends: (out) => {
    out.series = (out.series as SeriesSpec[]).map(withCleanFilters);
    // A formula row still being typed isn't part of the query yet.
    const formulas = ((out.formulas as { expr: string }[] | undefined) ?? []).filter((f) =>
      f.expr?.trim(),
    );
    setOrDelete(out, 'formulas', formulas.length ? formulas : undefined);
  },
  funnel: (out) => {
    out.steps = (out.steps as StepSpec[]).map(withCleanFilters);
    // Exclusions without an event yet are still being filled in.
    const exclusions = ((out.exclusions as { event: string }[] | undefined) ?? []).filter(
      (x) => x.event,
    );
    setOrDelete(out, 'exclusions', exclusions.length ? exclusions : undefined);
  },
  retention: (out) => {
    for (const key of ['cohortEvent', 'returnEvent'] as const) {
      const step = out[key] as StepSpec | undefined;
      if (step) out[key] = withCleanFilters(step);
    }
  },
  paths: (out) => {
    // Patterns still being typed aren't part of the query yet.
    for (const key of ['exclude', 'groups']) {
      const list = ((out[key] as string[] | undefined) ?? []).filter((x) => x.trim());
      setOrDelete(out, key, list.length ? list : undefined);
    }
  },
};

function sanitizeSpec(kind: Kind, spec: Spec): Spec {
  const out = structuredClone(spec) as Spec;
  setOrDelete(out, 'filters', cleanFilters(out.filters as FilterRow[] | undefined));
  KIND_CLEANERS[kind](out);
  const breakdowns = readBreakdowns(out)
    .map((v) => v.trim())
    .filter(Boolean);
  setOrDelete(out, 'breakdown', breakdowns.length ? breakdowns : undefined);
  // A map wants every country, not the top ten, however the breakdown got there.
  if (out.display === 'world_map' && breakdowns.join() === 'country') out.breakdownLimit ??= 50;
  return out;
}

/** A saved paths card: how many paths, and the most common one. */
function pathsPreview(r: PathsResult): HTMLElement {
  const top = r.topPaths[0];
  return h(
    'div',
    { class: 'card-preview' },
    h(
      'div',
      { class: 'card-number' },
      count(r.total),
      h('span', { class: 'muted small' }, ' paths'),
    ),
    top ? h('div', { class: 'muted small card-path' }, top.items.join(' → ')) : null,
  );
}

// ── Library ─────────────────────────────────────────────────────────────────

function newMenu(label = 'New analysis'): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button', class: 'primary' },
    icon('plus', 15),
    label,
    icon('chevronDown', 14),
  );
  popover(
    trigger,
    (close) =>
      h(
        'div',
        { class: 'menu new-menu' },
        KINDS.map((k) =>
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item menu-item-rich',
              onclick: () => {
                close();
                go(`insights/new/${k}`, { spec: null });
              },
            },
            h('span', { class: 'menu-icon' }, icon(KIND_ICON[k], 18)),
            h(
              'span',
              { class: 'menu-rich-text' },
              h('strong', {}, KIND_LABEL[k]),
              h('span', { class: 'muted small' }, KIND_BLURB[k]),
            ),
          ),
        ),
        h('div', { class: 'menu-divider', role: 'separator' }),
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item menu-item-rich agent-item',
            onclick: async (e: Event) => {
              const button = e.currentTarget as HTMLElement;
              try {
                await navigator.clipboard.writeText(INSIGHT_PROMPT);
                button.querySelector('strong')!.textContent = 'Prompt copied';
                setTimeout(close, 900);
              } catch {
                toast(
                  'Could not copy. Use "Ask your agent to build analyses" on the Insights page.',
                  'error',
                );
              }
            },
          },
          h('span', { class: 'menu-icon' }, icon('bot', 18)),
          h(
            'span',
            { class: 'menu-rich-text' },
            h('strong', {}, 'Ask your coding agent'),
            h(
              'span',
              { class: 'muted small' },
              'Copy a prompt that has your agent read the product, then build and save the funnel, retention and trends it needs.',
            ),
          ),
          icon('copy', 14),
        ),
      ),
    { width: 320, align: 'end' },
  );
  return trigger;
}

/** A small async preview for a library card. */
function trendsPreview(r: Record<string, unknown>): HTMLElement {
  const t = r as unknown as TrendsResult;
  const s = t.series[0];
  if (!s) return h('div', { class: 'card-preview muted small' }, 'No data');
  return h(
    'div',
    { class: 'card-preview' },
    h(
      'div',
      { class: 'card-number' },
      count(s.total),
      h('span', { class: 'muted small' }, ` ${s.label}`),
    ),
    sparkline(s.values, { height: 44 }),
  );
}

function funnelPreview(r: Record<string, unknown>): HTMLElement {
  const f = r as unknown as FunnelResult;
  const first = f.steps[0]?.count ?? 0;
  const lastStep = f.steps[f.steps.length - 1]?.count ?? 0;
  return h(
    'div',
    { class: 'card-preview' },
    h(
      'div',
      { class: 'card-number' },
      percent(first ? lastStep / first : 0, 1),
      h('span', { class: 'muted small' }, ' converted'),
    ),
    h(
      'div',
      { class: 'mini-funnel' },
      f.steps.map((st) =>
        h('span', { style: `height:${first ? Math.max(4, (st.count / first) * 100) : 4}%` }),
      ),
    ),
  );
}

function retentionPreview(r: Record<string, unknown>): HTMLElement {
  const rr = r as unknown as RetentionResult;
  const now = Date.now();
  let last = rr.average.length - 1;
  while (last > 0 && !rr.cohorts.some((c) => periodReached(c.start, last, rr.period, now))) last--;
  return h(
    'div',
    { class: 'card-preview' },
    h(
      'div',
      { class: 'card-number' },
      last >= 1 ? percent(rr.average[1] ?? 0, 0) : '–',
      h('span', { class: 'muted small' }, ` back after 1 ${rr.period}`),
    ),
    last >= 1
      ? sparkline(rr.average.slice(0, last + 1), { height: 44 })
      : h('div', { class: 'sparkline' }),
  );
}

const PREVIEWS: Record<Kind, (r: Record<string, unknown>) => HTMLElement> = {
  trends: trendsPreview,
  funnel: funnelPreview,
  retention: retentionPreview,
  paths: (r) => pathsPreview(r as unknown as PathsResult),
};

function cardPreview(insight: SavedInsight): HTMLElement {
  const sc = scope();
  return later(
    async () => {
      const body = {
        kind: insight.kind,
        ...insight.spec,
        from: (insight.spec.from as string) ?? sc.from,
        to: (insight.spec.to as string) ?? sc.to,
        project: sc.project,
      };
      const r = await api.post<Record<string, unknown>>('/api/query', body);
      return PREVIEWS[insight.kind](r);
    },
    'Loading preview',
    'block',
  );
}

function listView(route: Route): Node[] {
  const project = scope().project;
  const filterKind = (route.params.get('kind') as Kind | null) ?? null;
  let query = '';
  const grid = h('div', { class: 'insight-library' });
  let all: SavedInsight[] = [];
  const paint = () => {
    const q = query.trim().toLowerCase();
    const shown = all.filter(
      (i) =>
        (!filterKind || i.kind === filterKind) &&
        (!q || `${i.name} ${i.description}`.toLowerCase().includes(q)),
    );
    if (!shown.length) {
      mount(
        grid,
        empty(
          q ? `Nothing matches “${query}”.` : 'No saved analyses of this type yet.',
          undefined,
          { icon: 'search' },
        ),
      );
      return;
    }
    mount(
      grid,
      shown.map((insight) =>
        h(
          'a',
          { class: 'insight-card', href: href(`insights/${insight.key}`) },
          h(
            'div',
            { class: 'insight-card-head' },
            h(
              'span',
              { class: `kind-chip kind-${insight.kind}` },
              icon(KIND_ICON[insight.kind], 14),
              KIND_LABEL[insight.kind],
            ),
            h(
              'span',
              { class: 'muted small' },
              insight.updatedAt ? `Updated ${ago(insight.updatedAt)}` : '',
            ),
          ),
          h('h2', {}, insight.name),
          h('p', { class: 'muted insight-card-desc' }, insight.description || 'No description'),
          cardPreview(insight),
        ),
      ),
    );
  };
  const search = h('input', {
    type: 'search',
    placeholder: 'Search analyses',
    'aria-label': 'Search analyses',
  });
  search.addEventListener('input', () => {
    query = search.value;
    paint();
  });
  return [
    pageHeader('Insights', 'Saved analyses you and your agents can reopen.', [
      copyButton(INSIGHT_PROMPT, 'Ask your agent to build analyses', 'bot'),
      newMenu(),
    ]),
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'search-field' }, icon('search', 15), search),
      tabs(
        [
          { value: 'all', label: 'All' },
          ...KINDS.map((k) => ({ value: k as string, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
        ],
        filterKind ?? 'all',
        (v) => go('insights', { kind: v === 'all' ? null : v }),
      ),
    ),
    later(
      async () => {
        const r = await api.get<{ insights: SavedInsight[] }>('/api/insights', { project });
        const cohort = project ? activation(project, r.insights) : null;
        if (r.insights.length === 0) {
          return h(
            'div',
            { class: 'stack' },
            cohort,
            empty(
              'Build a trends, funnel, retention or paths chart, then save it here so you and your agents can reopen it.',
              newMenu('Create your first analysis'),
              { icon: 'insights', title: 'No saved analyses yet' },
            ),
          );
        }
        all = r.insights;
        paint();
        return h('div', { class: 'stack' }, cohort, grid);
      },
      'Loading analyses',
      'cards',
    ),
  ];
}

// ── The analysis workspace ──────────────────────────────────────────────────

interface RunResult extends Record<string, unknown> {
  summary: string;
  sql: string[];
}

const needsProperty = (s: SeriesSpec) => PROPERTY_MATHS.has(s.math ?? '') && !s.property;

/** What's still missing before a kind can run, in words; null when it's ready. */
const MISSING: Record<Kind, (spec: Spec) => string | null> = {
  trends: (spec) => {
    const series = spec.series as SeriesSpec[];
    if (series.some((s) => !s.event)) return 'Pick an event for every series.';
    if (series.some(needsProperty)) return 'Pick the property to measure.';
    if (series.some((s) => s.math === 'unique_groups' && !s.groupType)) return 'Pick a group type.';
    return null;
  },
  funnel: (spec) =>
    (spec.steps as StepSpec[]).every((s) => s.event) ? null : 'Pick an event for every step.',
  retention: (spec) =>
    (spec.cohortEvent as StepSpec).event && (spec.returnEvent as StepSpec).event
      ? null
      : 'Pick both events.',
  paths: (spec) => {
    if (spec.start && !(spec.start as { value: string }).value) return 'Pick where paths start.';
    if (spec.end && !(spec.end as { value: string }).value) return 'Pick where paths end.';
    return null;
  },
};

function missingInput(kind: Kind, spec: Spec): string | null {
  const cohorts = spec.breakdownCohorts as string[] | undefined;
  if (readBreakdowns(spec).includes('cohort') && !cohorts?.length)
    return 'Pick the cohorts to compare under “Break down by”.';
  return MISSING[kind](spec);
}

/** The latest trends result, per spec series, for the formula preview. */
function formulaData(r: TrendsResult | null): FormulaData | null {
  if (!r?.series.length) return null;
  const key = r.series[0]!.breakdown;
  const n = Math.max(...r.series.map((s) => s.seriesIndex)) + 1;
  const lines = Array.from({ length: n }, (_, i) =>
    r.series.find((s) => s.seriesIndex === i && s.breakdown === key),
  );
  return {
    values: lines.map((l) => l?.values ?? r.buckets.map(() => 0)),
    totals: lines.map((l) => l?.total ?? 0),
  };
}

/** Undo and redo over snapshots of the spec (50 steps). */
function specHistory(spec: Spec, apply: () => void) {
  const past: string[] = [];
  const future: string[] = [];
  let current = JSON.stringify(spec);
  const restore = (json: string) => {
    for (const k of Object.keys(spec)) delete spec[k];
    Object.assign(spec, JSON.parse(json));
    current = json;
    apply();
  };
  return {
    record() {
      const next = JSON.stringify(spec);
      if (next === current) return;
      past.push(current);
      if (past.length > 50) past.shift();
      future.length = 0;
      current = next;
    },
    undo() {
      const prev = past.pop();
      if (prev === undefined) return;
      future.push(current);
      restore(prev);
    },
    redo() {
      const next = future.pop();
      if (next === undefined) return;
      past.push(current);
      restore(next);
    },
  };
}

const isTextTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Redraw `form` with `render()`, keeping the focus (and caret) on the same control. */
function keepFocus(form: HTMLElement, render: () => void): void {
  const active = document.activeElement as HTMLInputElement | null;
  const label = active && form.contains(active) ? active.getAttribute('aria-label') : null;
  const caret = [active?.selectionStart ?? null, active?.selectionEnd ?? null] as const;
  render();
  if (!label) return;
  const again = form.querySelector<HTMLInputElement>(`[aria-label="${CSS.escape(label)}"]`);
  again?.focus();
  if (again && caret[0] !== null && 'setSelectionRange' in again)
    again.setSelectionRange(caret[0], caret[1] ?? caret[0]);
}

interface Fetched {
  result: RunResult;
  previous: TrendsResult | null;
  notes: (Annotation & { id: string })[];
}

async function fetchResults(kind: Kind, body: Spec, insight: string | undefined): Promise<Fetched> {
  const prev =
    kind === 'trends' && prefs.compare
      ? previousRange(String(body.from), body.to ? String(body.to) : null)
      : null;
  const [result, previous, notes] = await Promise.all([
    api.post<RunResult>('/api/query', body),
    prev
      ? api
          .post<TrendsResult>('/api/query', { ...body, from: prev.from, to: prev.to })
          .catch(() => null)
      : Promise.resolve(null),
    kind === 'trends'
      ? api
          .get<{ annotations: { id: string; at: string; text: string }[] }>('/api/annotations', {
            project: body.project as string | undefined,
            from: String(body.from),
            to: body.to ? String(body.to) : undefined,
            insight,
          })
          .then((x) => x.annotations.map((a) => ({ id: a.id, at: Date.parse(a.at), text: a.text })))
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  return { result, previous, notes };
}

interface ResultContext {
  spec: Spec;
  display: string;
  notes: (Annotation & { id: string })[];
  shared: Spec;
  onAnnotate: () => void;
  onDeleteNote: (id: string) => void;
  onMapBreakdown: () => void;
  /** Change the spec, then run again. */
  edit: (change: (spec: Spec) => void) => void;
}

const RENDER: Record<Kind, (f: Fetched, c: ResultContext) => HTMLElement> = {
  trends: (f, c) =>
    trendsView(f.result as unknown as TrendsResult, f.previous, {
      display: c.display,
      spec: c.spec,
      annotations: c.notes,
      onPeople: (series, label) => showActors('trends', c.shared, { series }, `Who did ${label}`),
      onAnnotate: c.onAnnotate,
      onDeleteNote: c.onDeleteNote,
      onMapBreakdown: c.onMapBreakdown,
    }),
  funnel: (f, c) => funnelView(f.result as unknown as FunnelResult, c.spec, c.shared),
  retention: (f, c) => {
    const r = f.result as unknown as RetentionResult;
    return retentionView(r, countedNoun(c.spec.aggregateBy), (cohort, period, breakdown) =>
      showActors(
        'retention',
        c.shared,
        { cohort, period, ...(breakdown === undefined ? {} : { breakdown }) },
        period === 0
          ? `Who joined the ${bucketLabel(cohort, 'day')} cohort`
          : `Who came back in ${r.period} ${period}`,
      ),
    );
  },
  paths: (f, c) =>
    pathsView(f.result as unknown as PathsResult, {
      display: c.display,
      noun: c.spec.aggregateBy === 'session' ? ['session', 'sessions'] : ['person', 'people'],
      shared: c.shared,
      edit: c.edit,
    }),
};

const RAILS: Record<Kind, (spec: Spec, ctx: RailContext) => HTMLElement> = {
  trends: trendsRail,
  funnel: funnelRail,
  retention: retentionRail,
  paths: pathsRail,
};

function builder(kind: Kind, spec: Spec, ctx: RailContext): HTMLElement {
  if (!Array.isArray(spec.filters)) spec.filters = [];
  return RAILS[kind](spec, ctx);
}

/** The words under the funnel and retention toolbars: what the numbers count. */
function kindSentence(kind: Kind, spec: Spec): string {
  const noun = countedNoun(spec.aggregateBy);
  if (kind === 'funnel') {
    const order =
      spec.order === 'unordered'
        ? 'in any order'
        : spec.order === 'strict'
          ? 'one right after another'
          : 'in order';
    return `Unique ${noun} who did each step ${order}.`;
  }
  const one = noun === 'people' ? 'person' : noun.replace(/s$/, '');
  return `Cohorts by the period of each ${one}’s ${spec.retentionType === 'recurring' ? 'events' : 'first event'}.`;
}

/** Minute buckets only for ranges up to two days (the query refuses longer ones). */
function minuteAllowed(from: string, to: string | null | undefined): boolean {
  try {
    const r = resolveRange(from, to ?? undefined);
    return r.to - r.from <= 2 * 86_400_000 + 60_000;
  } catch {
    return false;
  }
}

const INTERVALS = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const MORE_VIEWS = [
  { value: 'bar_value', label: 'Bars by total', icon: 'barChart' as IconName },
  { value: 'table', label: 'Table of values', icon: 'table' as IconName },
  { value: 'pie', label: 'Pie of totals', icon: 'gauge' as IconName },
  { value: 'world_map', label: 'World map', icon: 'globe' as IconName },
];

function trendsToolbar(
  spec: Spec,
  display: string,
  from: string,
  to: string | null | undefined,
  on: { display: (v: string) => void; interval: (v: string) => void; options: () => void },
): Child[] {
  const lines =
    (spec.series as SeriesSpec[]).length + ((spec.formulas as unknown[] | undefined)?.length ?? 0);
  return [
    tabs(
      [
        { value: 'line', label: 'Line', icon: 'lineChart' as IconName },
        { value: 'area', label: 'Area', icon: 'areaChart' as IconName },
        { value: 'bar', label: 'Bar', icon: 'barChart' as IconName },
        { value: 'number', label: 'Number', icon: 'hash' as IconName },
      ],
      display,
      on.display,
      'tabs-small',
    ),
    selectMenu({
      value: display,
      label: 'More ways to show it',
      options: MORE_VIEWS,
      fallback: 'More views',
      width: 200,
      onChange: on.display,
    }),
    TIME_DISPLAYS.has(display)
      ? tabs(
          [
            ...(minuteAllowed(from, to) ? [{ value: 'minute', label: 'Minute' }] : []),
            ...INTERVALS,
          ],
          String(spec.interval ?? 'day'),
          on.interval,
          'tabs-small',
        )
      : null,
    chartOptionsButton(spec, on.options, {
      timeChart: TIME_DISPLAYS.has(display),
      lines,
      hasFormulas: Boolean((spec.formulas as unknown[] | undefined)?.length),
    }),
  ];
}

/** Paths: the flow chart, or the most common whole paths. */
function pathsToolbar(display: string, set: (v: string) => void): HTMLElement {
  return tabs(
    [
      { value: 'line', label: 'Flow', icon: 'paths' as IconName },
      { value: 'top', label: 'Top paths', icon: 'table' as IconName },
    ],
    display === 'top' ? 'top' : 'line',
    set,
    'tabs-small',
  );
}

/** Put a saved analysis on a dashboard: an existing one, or a new one. */
function addToDashboardButton(key: string): HTMLElement {
  const trigger = h('button', { type: 'button' }, icon('dashboard', 15), 'Add to dashboard');
  const add = async (dashboard: string) => {
    await api.post(`/api/dashboards/${dashboard}/tiles`, {
      project: scope().project,
      insightKey: key,
    });
    toast('Added', 'ok', { label: 'Open dashboard', run: () => go(`dashboards/${dashboard}`) });
  };
  const create = async () => {
    const name = prompt('Name the new dashboard', 'My dashboard');
    if (!name?.trim()) return;
    const r = await api.post<{ id: string }>('/api/dashboards', {
      project: scope().project,
      name: name.trim(),
    });
    await add(r.id);
  };
  popover(trigger, (close) =>
    later(async () => {
      const r = await api.get<{ dashboards: { id: string; name: string }[] }>('/api/dashboards', {
        project: scope().project,
      });
      const item = (label: string, run: () => void) =>
        h(
          'button',
          { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => (close(), run()) },
          label,
        );
      return h(
        'div',
        { class: 'menu', role: 'menu' },
        r.dashboards.map((d) => item(d.name, () => void add(d.id))),
        r.dashboards.length ? h('div', { class: 'menu-divider', role: 'separator' }) : null,
        item('New dashboard…', () => void create()),
      );
    }),
  );
  return trigger;
}

/** The series (trends) or steps (funnels) an alert can watch. */
function alertParts(kind: string, spec: Spec): string[] {
  if (kind === 'funnel')
    return ((spec.steps as StepSpec[]) ?? []).map((s, i) => `Step ${i + 1}: ${s.label || s.event}`);
  return ((spec.series as SeriesSpec[]) ?? []).map(
    (s, i) => `${String.fromCharCode(65 + i)}: ${s.label || s.event}`,
  );
}

/** Buttons a saved analysis has: add it to a dashboard, and alerts (trends and funnels). */
function savedActions(o: { key: string; name: string; kind: Kind; spec: Spec }): HTMLElement[] {
  const out = [addToDashboardButton(o.key)];
  if (o.kind === 'trends' || o.kind === 'funnel')
    out.push(
      iconButton('bell', 'Alerts', () =>
        alertDialog({ key: o.key, name: o.name, kind: o.kind, parts: alertParts(o.kind, o.spec) }),
      ),
    );
  return out;
}

/** Delete a saved analysis, after asking. */
function deleteButton(key: string, project: string | undefined): HTMLElement {
  const remove = async () => {
    if (!confirm('Delete this saved analysis?')) return;
    await api.delete(`/api/insights/${encodeURIComponent(key)}`, { project });
    toast('Deleted');
    go('insights', { spec: null });
  };
  return iconButton('trash', 'Delete analysis', () => void remove());
}

/** The kind (trends, funnel, retention, paths): tabs while the analysis is new, a label once it's saved. */
function kindSwitch(mode: 'new' | 'saved' | 'ephemeral', kind: Kind): HTMLElement {
  if (mode === 'saved')
    return h(
      'span',
      { class: `kind-chip kind-${kind}` },
      icon(KIND_ICON[kind], 14),
      KIND_LABEL[kind],
    );
  const open = (next: Kind) =>
    go(mode === 'new' ? `insights/new/${next}` : `insights/${next}`, { spec: null });
  return tabs(
    KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
    kind,
    open,
    'tabs-block',
  );
}

/** ⌘/Ctrl+Enter runs now; ⌘/Ctrl+Z and ⇧⌘/Ctrl+Z undo and redo outside text fields. */
function editorKeys(on: { run: () => void; undo: () => void; redo: () => void }) {
  return (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'Enter') on.run();
    else if (e.key.toLowerCase() === 'z' && !isTextTarget(e.target))
      (e.shiftKey ? on.redo : on.undo)();
    else return;
    e.preventDefault();
  };
}

function editorView(options: {
  mode: 'new' | 'saved' | 'ephemeral';
  kind: Kind;
  key?: string;
  name?: string;
  description?: string;
  spec: Spec;
  /** The saved spec, to tell when the open one has unsaved edits. */
  savedSpec?: Spec;
  route: Route;
}): Node[] {
  const kind = options.kind;
  const spec = structuredClone(options.spec);
  const savedJson = JSON.stringify(options.savedSpec ?? null);
  const sc = scope();
  const form = h('form', { class: 'builder' });
  const output = h('div', { class: 'insight-output' });
  const status = h('span', { class: 'run-status muted small', 'aria-live': 'polite' });
  // How trends are drawn: saved with the analysis (an old ?chart= link still works).
  let display = String(spec.display ?? options.route.params.get('chart') ?? 'line');
  let notes: (Annotation & { id: string })[] = [];
  let lastTrends: TrendsResult | null = null;
  let runId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ui: RailState = { addingFormula: false };

  const fullSpec = () => {
    const cleaned = sanitizeSpec(kind, spec);
    return {
      kind,
      ...cleaned,
      from: cleaned.from ?? sc.from,
      to: cleaned.to ?? sc.to,
      project: sc.project,
    };
  };
  const shareable = () => {
    const { kind: _k, project: _p, ...rest } = fullSpec();
    return rest;
  };
  const agentPrompt = () =>
    `Using the Dataflare MCP tool query_${kind}, run ${JSON.stringify(shareable())} and explain what it shows.`;

  /** Keep the open analysis in the URL, so a reload, a date change or a shared link keeps it. */
  const persist = () => {
    const params = new URLSearchParams(Object.fromEntries(options.route.params));
    const json = JSON.stringify(spec);
    if (options.mode === 'saved' && json === savedJson) params.delete('spec');
    else params.set('spec', json);
    const paths = {
      new: `insights/new/${kind}`,
      ephemeral: `insights/${kind}`,
      saved: `insights/${options.key}`,
    };
    history.replaceState(null, '', `#/${paths[options.mode]}?${params}`);
  };

  const almostThere = (message: string) => {
    mount(output, empty(message, undefined, { icon: KIND_ICON[kind], title: 'Almost there' }));
    status.textContent = '';
    const control = form.querySelector<HTMLElement>('[data-needs-input]');
    control?.classList.add('needs-attention');
    control?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const run = async () => {
    clearTimeout(timer);
    persist();
    const missing = missingInput(kind, spec);
    if (missing) return almostThere(missing);
    const id = ++runId;
    status.textContent = 'Running…';
    output.classList.add('running');
    if (!output.firstChild || output.querySelector('.state.empty'))
      mount(output, loading('Running query', 'chart'));
    try {
      const fetched = await fetchResults(kind, fullSpec(), options.key);
      if (id !== runId) return;
      notes = fetched.notes;
      if (kind === 'trends') lastTrends = fetched.result as unknown as TrendsResult;
      const view = RENDER[kind](fetched, {
        spec,
        display,
        notes,
        shared: shareable(),
        onAnnotate: addNote,
        onDeleteNote: deleteNote,
        onMapBreakdown,
        edit: (change) => {
          change(spec);
          update();
        },
      });
      mount(
        output,
        panel(
          '',
          [
            h('p', { class: 'summary' }, icon('bot', 15), h('span', {}, fetched.result.summary)),
            view,
          ],
          {
            sql: fetched.result.sql,
            class: 'result-panel',
          },
        ),
      );
      status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (err) {
      if (id !== runId) return;
      mount(output, errorState(err));
      status.textContent = '';
    } finally {
      if (id === runId) output.classList.remove('running');
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 450);
  };

  function onMapBreakdown(): void {
    spec.breakdown = ['country'];
    spec.breakdownLimit = 50;
    delete spec.breakdownBins;
    delete spec.breakdownCohorts;
    update();
  }

  function addNote(): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const when = h('input', {
      type: 'datetime-local',
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    });
    const text = h('input', {
      type: 'text',
      maxlength: 500,
      placeholder: 'e.g. Launched pricing v2',
      required: true,
    });
    let onlyHere = false;
    const save = async () => {
      if (!text.value.trim() || !when.value) {
        toast('Say what happened, and when', 'error');
        return;
      }
      try {
        await api.post('/api/annotations', {
          project: sc.project,
          at: new Date(when.value).toISOString(),
          text: text.value.trim(),
          ...(onlyHere && options.key ? { insight: options.key } : {}),
        });
        toast('Note added');
        close();
        void run();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    const close = modal({
      title: 'Add a note to the chart',
      width: 480,
      body: h(
        'div',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'What happened'), text),
        h('label', { class: 'field' }, h('span', {}, 'When'), when),
        options.mode === 'saved'
          ? toggle({
              checked: false,
              label: 'Only on this analysis (otherwise on every time chart)',
              onChange: (c) => {
                onlyHere = c;
              },
            })
          : h('p', { class: 'muted small' }, 'Notes show on every time chart in this project.'),
      ),
      actions: [
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: () => void save() }, 'Add note'),
      ],
    });
    text.focus();
  }

  function deleteNote(id: string): void {
    if (!confirm('Delete this note? It disappears from every chart.')) return;
    void api
      .delete(`/api/annotations/${encodeURIComponent(id)}`, { project: sc.project })
      .then(() => {
        toast('Note deleted');
        void run();
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err), 'error'));
  }

  const rail: RailContext = {
    project: sc.project,
    update: () => update(),
    changed: () => {
      undo.record();
      schedule();
    },
    ui,
    data: () => formulaData(lastTrends),
  };
  const renderForm = () => keepFocus(form, () => mount(form, builder(kind, spec, rail)));
  const reapply = () => {
    display = String(spec.display ?? 'line');
    paintToolbar();
    renderForm();
    schedule();
  };
  const undo = specHistory(spec, reapply);
  function update() {
    undo.record();
    renderForm();
    paintToolbar();
    schedule();
  }
  // Text and number inputs inside filters change without a structural update.
  const onFormChange = () => {
    undo.record();
    schedule();
  };
  const onSubmit = (e: Event) => {
    e.preventDefault();
    void run();
  };
  form.addEventListener('change', onFormChange);
  form.addEventListener('submit', onSubmit);

  const openSave = () => {
    const titleInput = h('input', {
      type: 'text',
      value: options.name ?? '',
      placeholder: 'e.g. Daily active users',
      'aria-label': 'Title',
      required: true,
    });
    const descriptionInput = h(
      'textarea',
      {
        rows: 3,
        placeholder: 'What question does this answer? Agents read this too.',
        'aria-label': 'Description',
        class: 'prose',
      },
      options.description ?? '',
    );
    const save = async () => {
      if (!titleInput.value.trim()) {
        toast('Add a title', 'error');
        titleInput.focus();
        return;
      }
      try {
        const saved = await api.post<{ key: string }>('/api/insights', {
          project: sc.project,
          key: options.mode === 'saved' ? options.key : undefined,
          name: titleInput.value.trim(),
          description: descriptionInput.value.trim(),
          kind,
          spec: sanitizeSpec(kind, spec),
        });
        close();
        toast(options.mode === 'saved' ? 'Changes saved' : 'Saved to library');
        go(`insights/${saved.key}`, { spec: null });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    const formEl = h(
      'form',
      { class: 'stack modal-form' },
      h('label', { class: 'field' }, h('span', {}, 'Title'), titleInput),
      h('label', { class: 'field' }, h('span', {}, 'Description'), descriptionInput),
    );
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void save();
    });
    const close = modal({
      title: options.mode === 'saved' ? 'Save changes' : 'Save analysis',
      body: formEl,
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => close() }, 'Cancel'),
        h(
          'button',
          { type: 'button', class: 'primary', onclick: () => void save() },
          icon('save', 14),
          options.mode === 'saved' ? 'Save changes' : 'Save to library',
        ),
      ],
    });
  };

  const saved = options.mode === 'saved';
  const pageLink = () => location.href;
  const headerActions = [
    copyButton(agentPrompt, 'Agent prompt', 'bot'),
    copyButton(pageLink, 'Link', 'link'),
    ...(saved
      ? savedActions({ key: options.key!, name: options.name ?? 'Analysis', kind, spec })
      : []),
    saved ? deleteButton(options.key!, sc.project) : null,
    h(
      'button',
      { type: 'button', class: 'primary', onclick: openSave },
      icon('save', 15),
      saved ? 'Save changes' : 'Save',
    ),
  ];

  const titles = {
    new: `New ${KIND_LABEL[kind].toLowerCase()} analysis`,
    saved: options.name ?? 'Analysis',
    ephemeral: `${KIND_LABEL[kind]} query`,
  };
  const blurb = (saved && options.description) || KIND_BLURB[kind];

  const toolbar = h('div', { class: 'canvas-toolbar' });
  if (spec.interval === 'minute' && !minuteAllowed(sc.from, sc.to)) spec.interval = 'hour';
  function setDisplay(v: string): void {
    display = v;
    if (v === 'line') delete spec.display;
    else spec.display = v;
    update();
  }
  function paintToolbar(): void {
    const controls =
      kind === 'trends'
        ? trendsToolbar(spec, display, sc.from, sc.to, {
            display: setDisplay,
            interval: (v) => {
              spec.interval = v;
              update();
            },
            options: update,
          })
        : kind === 'funnel'
          ? funnelViewControls(spec, (spec.steps as StepSpec[]).length, update)
          : kind === 'paths'
            ? [pathsToolbar(display, setDisplay)]
            : [h('span', { class: 'muted small' }, kindSentence(kind, spec))];
    mount(toolbar, ...controls, h('span', { class: 'toolbar-spacer' }), status);
  }

  const startFrom = (next: Spec, view?: string) => {
    for (const k of Object.keys(spec)) delete spec[k];
    Object.assign(spec, next);
    display = view ?? 'line';
    if (view) spec.display = view;
    update();
  };
  // Questions to start from, for a blank new analysis (not one opened from a link).
  const fresh = options.mode === 'new' && !options.route.params.get('spec');
  const root = h(
    'div',
    { class: 'analysis' },
    h(
      'aside',
      { class: 'query-rail', 'aria-label': 'Query' },
      h('div', { class: 'rail-kind' }, kindSwitch(options.mode, kind)),
      form,
      saved
        ? h(
            'a',
            { class: 'link-button rail-back', href: href('insights') },
            icon('chevronLeft', 14),
            'Back to library',
          )
        : null,
    ),
    h(
      'section',
      { class: 'query-canvas' },
      fresh ? starters(kind, sc.project, startFrom) : null,
      toolbar,
      output,
    ),
  );
  root.addEventListener(
    'keydown',
    editorKeys({ run: () => void run(), undo: () => undo.undo(), redo: () => undo.redo() }),
  );

  paintToolbar();
  renderForm();
  void run();
  return [pageHeader(titles[options.mode], blurb, headerActions), root];
}

export function insightsPage(route: Route): Node[] {
  const head = route.rest[0];
  if (!head) return listView(route);

  const parseSpec = (kind: Kind): Spec => {
    try {
      return route.params.get('spec')
        ? (JSON.parse(route.params.get('spec')!) as Spec)
        : structuredClone(DEFAULTS[kind]);
    } catch {
      return structuredClone(DEFAULTS[kind]);
    }
  };

  if (head === 'new') {
    const kind = (KINDS.includes(route.rest[1] as Kind) ? route.rest[1] : 'trends') as Kind;
    return editorView({ mode: 'new', kind, spec: parseSpec(kind), route });
  }

  if (KINDS.includes(head as Kind)) {
    const kind = head as Kind;
    return editorView({ mode: 'ephemeral', kind, spec: parseSpec(kind), route });
  }

  return [
    later(
      async () => {
        const project = scope().project;
        const insight = await api.get<SavedInsight>(`/api/insights/${encodeURIComponent(head)}`, {
          project,
        });
        // Unsaved edits ride in the URL, so they survive a date change or a reload.
        const edited = route.params.get('spec') ? parseSpec(insight.kind) : null;
        return editorView({
          mode: 'saved',
          kind: insight.kind,
          key: insight.key,
          name: insight.name,
          description: insight.description,
          spec: edited ?? insight.spec,
          savedSpec: insight.spec,
          route,
        });
      },
      'Loading analysis',
      'chart',
    ),
  ];
}
