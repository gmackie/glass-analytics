/**
 * Insights: saved analyses (library), and the analysis workspace — a query
 * rail on the left, the chart on the right, re-run automatically as you edit.
 *
 * Routes:
 *   #/insights                  — library of saved analyses
 *   #/insights/new[/:kind]      — create
 *   #/insights/:kind?spec=…     — ephemeral run (agent / share links)
 *   #/insights/:key             — open a saved analysis
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { JourneysResult } from '@dataflare/core/insights/journeys';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import { api } from '../api.ts';
import {
  type ChartType,
  funnelChart,
  kpiStat,
  lineChart,
  periodReached,
  retentionCurve,
  retentionGrid,
  SERIES,
  sparkline,
} from '../components/charts.ts';
import { previousRange } from '../components/date-range.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { type IconName, icon } from '../components/icons.ts';
import { journeyChart } from '../components/journeys.ts';
import { modal, popover, selectMenu } from '../components/menu.ts';
import { eventPicker, propertyPicker } from '../components/picker.ts';
import { INSIGHT_PROMPT } from '../components/prompts.ts';
import {
  copyButton,
  empty,
  errorState,
  iconButton,
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
import { go, href, prefs, type Route, scope } from '../state.ts';

type Kind = 'trends' | 'funnel' | 'retention' | 'journeys';
type Spec = Record<string, unknown>;

const KINDS: Kind[] = ['trends', 'funnel', 'retention', 'journeys'];
const KIND_LABEL: Record<Kind, string> = {
  journeys: 'Journeys',
  trends: 'Trends',
  funnel: 'Funnel',
  retention: 'Retention',
};
const KIND_ICON: Record<Kind, IconName> = {
  journeys: 'funnel',
  trends: 'lineChart',
  funnel: 'funnel',
  retention: 'retention',
};
const KIND_BLURB: Record<Kind, string> = {
  journeys: 'Explore branching session paths with a Sankey diagram.',
  trends: 'Counts, uniques or sums of any event over time.',
  funnel: 'How many people complete a sequence of steps.',
  retention: 'How many people come back after their first visit.',
};

const DEFAULTS: Record<Kind, Spec> = {
  journeys: {
    anchor: { event: '$pageview' },
    direction: 'forward',
    node: 'event',
    maxSteps: 6,
    maxDuration: '1h',
    collapseConsecutive: true,
  },
  trends: { series: [{ event: '$pageview', math: 'total' }], interval: 'day' },
  funnel: { steps: [{ event: '$pageview' }, { event: '' }], window: '7d' },
  retention: {
    cohortEvent: { event: '$pageview' },
    returnEvent: { event: '$pageview' },
    period: 'week',
    periods: 8,
  },
};

interface SavedInsight {
  key: string;
  name: string;
  description: string;
  kind: Kind;
  spec: Spec;
  updatedAt: string;
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

function seriesTag(i: number): HTMLElement {
  return h('span', { class: 'series-tag', style: `--tag:${SERIES[i % SERIES.length]}` }, letter(i));
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'rail-section' }, h('div', { class: 'rail-label' }, title), ...children);
}

function addButton(label: string, onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'link-button add-button', onclick: onClick },
    icon('plus', 14),
    label,
  );
}

type SeriesSpec = {
  event: string;
  math?: string;
  property?: string;
  filters?: FilterRow[];
  label?: string;
};
type StepSpec = { event: string; filters?: FilterRow[]; label?: string };

function readBreakdowns(spec: Spec): string[] {
  const b = spec.breakdown;
  if (Array.isArray(b)) return b.filter((x): x is string => typeof x === 'string');
  if (typeof b === 'string' && b) return [b];
  return [];
}

function writeBreakdowns(spec: Spec, values: string[]): void {
  if (values.length === 0) delete spec.breakdown;
  else spec.breakdown = values;
}

function ensureFilters(target: { filters?: FilterRow[] }): FilterRow[] {
  target.filters ??= [];
  return target.filters;
}

function breakdownEditor(
  spec: Spec,
  event: string | undefined,
  project: string | undefined,
  update: () => void,
): HTMLElement {
  const values = readBreakdowns(spec);
  return h(
    'div',
    { class: 'breakdown-editor' },
    values.map((value, i) =>
      h(
        'div',
        { class: 'breakdown-row' },
        propertyPicker({
          value,
          event,
          project,
          placeholder: i === 0 ? 'browser, utm_source, plan…' : 'Add another property',
          onChange: (v) => {
            const next = readBreakdowns(spec);
            if (v) next[i] = v;
            else next.splice(i, 1);
            writeBreakdowns(spec, next);
            update();
          },
        }),
        iconButton('x', 'Remove breakdown', () => {
          const next = readBreakdowns(spec);
          next.splice(i, 1);
          writeBreakdowns(spec, next);
          update();
        }),
      ),
    ),
    values.length < 4
      ? addButton(values.length ? 'Add another' : 'Add breakdown', () => {
          writeBreakdowns(spec, [...readBreakdowns(spec), '']);
          update();
        })
      : null,
    values.length > 1
      ? h('p', { class: 'muted small' }, 'Values are combined with “ · ”, e.g. Chrome · google.')
      : null,
  );
}

function sanitizeSpec(kind: Kind, spec: Spec): Spec {
  const out = structuredClone(spec) as Spec;
  const global = cleanFilters(out.filters as FilterRow[] | undefined);
  if (global) out.filters = global;
  else delete out.filters;

  const clean = <T extends { filters?: FilterRow[] }>(s: T): T => {
    const filters = cleanFilters(s.filters);
    const next = { ...s };
    if (filters) next.filters = filters;
    else delete next.filters;
    return next;
  };
  if (kind === 'trends') out.series = (out.series as SeriesSpec[]).map(clean);
  if (kind === 'funnel') out.steps = (out.steps as StepSpec[]).map(clean);
  if (kind === 'retention') {
    for (const key of ['cohortEvent', 'returnEvent'] as const) {
      const step = out[key] as StepSpec | undefined;
      if (step) out[key] = clean(step);
    }
  }
  const breakdowns = readBreakdowns(out)
    .map((v) => v.trim())
    .filter(Boolean);
  if (breakdowns.length) out.breakdown = breakdowns;
  else delete out.breakdown;
  return out;
}

const MEASURES: { value: string; label: string }[] = [
  { value: 'total', label: 'Total count' },
  { value: 'unique_persons', label: 'Unique people' },
  { value: 'unique_sessions', label: 'Unique sessions' },
  { value: 'sum', label: 'Sum of property' },
  { value: 'avg', label: 'Average of property' },
];

const WINDOWS = ['1h', '1d', '3d', '7d', '14d', '30d', '90d'].map((w) => ({
  value: w,
  label: w
    .replace(/^(\d+)h$/, '$1 hour')
    .replace(/^1d$/, '1 day')
    .replace(/^(\d+)d$/, '$1 days'),
}));

function builder(kind: Kind, spec: Spec, update: () => void, project?: string): HTMLElement {
  if (!Array.isArray(spec.filters)) spec.filters = [];

  if (kind === 'journeys') {
    if (!spec.anchor) spec.anchor = { event: '$pageview' };
    const anchor = spec.anchor as StepSpec;
    return h(
      'div',
      { class: 'builder-stack' },
      section(
        'Anchor event',
        eventPicker({
          value: anchor.event,
          project,
          label: 'Journey anchor',
          onChange: (v) => {
            anchor.event = v;
            update();
          },
        }),
      ),
      section(
        'Direction',
        selectMenu({
          value: String(spec.direction ?? 'forward'),
          label: 'Journey direction',
          options: [
            { value: 'forward', label: 'After anchor' },
            { value: 'backward', label: 'Before anchor' },
          ],
          onChange: (v) => {
            spec.direction = v;
            update();
          },
        }),
      ),
      section(
        'Nodes',
        selectMenu({
          value: String(spec.node ?? 'event'),
          label: 'Journey nodes',
          options: [
            { value: 'event', label: 'Events' },
            { value: 'page', label: 'Page paths' },
          ],
          onChange: (v) => {
            spec.node = v;
            update();
          },
        }),
      ),
      section(
        'Observation window',
        selectMenu({
          value: String(spec.maxDuration ?? '1h'),
          label: 'Journey duration',
          options: ['30m', '1h', '6h', '24h'].map((v) => ({ value: v, label: v })),
          onChange: (v) => {
            spec.maxDuration = v;
            update();
          },
        }),
      ),
      section(
        'Maximum steps',
        selectMenu({
          value: String(spec.maxSteps ?? 6),
          label: 'Journey steps',
          options: [3, 6, 10].map((v) => ({ value: String(v), label: String(v) })),
          onChange: (v) => {
            spec.maxSteps = Number(v);
            update();
          },
        }),
      ),
      section(
        'Repeated steps',
        selectMenu({
          value: spec.collapseConsecutive ? 'collapse' : 'keep',
          label: 'Consecutive repeats',
          options: [
            { value: 'collapse', label: 'Collapse consecutive repeats' },
            { value: 'keep', label: 'Keep every repeat' },
          ],
          onChange: (v) => {
            spec.collapseConsecutive = v === 'collapse';
            update();
          },
        }),
      ),
      section(
        'Sessions with an event matching',
        filterEditor(spec.filters as FilterRow[], update, { project, cohorts: true }),
      ),
      h(
        'p',
        { class: 'muted small' },
        'Choose at most seven days in the date picker. Equal-time events use event id order, not causal order.',
      ),
    );
  }
  if (kind === 'trends') {
    const series = spec.series as SeriesSpec[];
    return h(
      'div',
      { class: 'builder-stack' },
      section(
        'Measure',
        series.map((s, i) => {
          ensureFilters(s);
          return h(
            'div',
            { class: 'query-card' },
            h(
              'div',
              { class: 'query-card-head' },
              seriesTag(i),
              eventPicker({
                value: s.event,
                project,
                label: `Event ${letter(i)}`,
                onChange: (v) => {
                  s.event = v;
                  update();
                },
              }),
              series.length > 1
                ? iconButton('x', 'Remove series', () => {
                    series.splice(i, 1);
                    update();
                  })
                : null,
            ),
            h(
              'div',
              { class: 'query-card-row' },
              selectMenu({
                value: s.math ?? 'total',
                label: 'Measure',
                options: MEASURES,
                width: 220,
                onChange: (v) => {
                  s.math = v;
                  update();
                },
              }),
              s.math === 'sum' || s.math === 'avg'
                ? propertyPicker({
                    value: s.property ?? '',
                    event: s.event,
                    project,
                    columns: false,
                    placeholder: 'Property to aggregate',
                    onChange: (v) => {
                      s.property = v;
                      update();
                    },
                  })
                : null,
            ),
            filterEditor(s.filters!, update, { event: s.event, project, cohorts: true }),
          );
        }),
        addButton('Add series', () => {
          series.push({ event: '', math: 'total', filters: [] });
          update();
        }),
      ),
      section('Break down by', breakdownEditor(spec, series[0]?.event, project, update)),
      section(
        'Filters on all series',
        filterEditor(spec.filters as FilterRow[], update, {
          event: series[0]?.event,
          project,
          cohorts: true,
        }),
      ),
    );
  }
  if (kind === 'funnel') {
    const steps = spec.steps as StepSpec[];
    const windowValue = String(spec.window ?? '7d');
    const windows = WINDOWS.some((w) => w.value === windowValue)
      ? WINDOWS
      : [...WINDOWS, { value: windowValue, label: windowValue }];
    return h(
      'div',
      { class: 'builder-stack' },
      section(
        'Steps',
        h(
          'ol',
          { class: 'steps-editor' },
          steps.map((step, i) => {
            ensureFilters(step);
            return h(
              'li',
              { class: 'query-card step-card' },
              h(
                'div',
                { class: 'query-card-head' },
                h('span', { class: 'funnel-step-index' }, String(i + 1)),
                eventPicker({
                  value: step.event,
                  project,
                  label: `Step ${i + 1}`,
                  placeholder: `Step ${i + 1} event`,
                  onChange: (v) => {
                    step.event = v;
                    update();
                  },
                }),
                steps.length > 2
                  ? iconButton('x', 'Remove step', () => {
                      steps.splice(i, 1);
                      update();
                    })
                  : null,
              ),
              filterEditor(step.filters!, update, { event: step.event, project, cohorts: true }),
            );
          }),
        ),
        addButton('Add step', () => {
          steps.push({ event: '', filters: [] });
          update();
        }),
      ),
      section(
        'Completed within',
        selectMenu({
          value: windowValue,
          label: 'Conversion window',
          options: windows,
          width: 200,
          onChange: (v) => {
            spec.window = v;
            update();
          },
        }),
      ),
      section('Break down by', breakdownEditor(spec, steps[0]?.event, project, update)),
      section(
        'Filters on every step',
        filterEditor(spec.filters as FilterRow[], update, {
          event: steps[0]?.event,
          project,
          cohorts: true,
        }),
      ),
    );
  }
  const cohort = spec.cohortEvent as StepSpec;
  const ret = spec.returnEvent as StepSpec;
  ensureFilters(cohort);
  ensureFilters(ret);
  const periods = Number(spec.periods ?? 8);
  return h(
    'div',
    { class: 'builder-stack' },
    section(
      'First did',
      h(
        'div',
        { class: 'query-card' },
        h(
          'div',
          { class: 'query-card-head' },
          seriesTag(0),
          eventPicker({
            value: cohort.event,
            project,
            label: 'Cohort event',
            onChange: (v) => {
              cohort.event = v;
              update();
            },
          }),
        ),
        filterEditor(cohort.filters!, update, { event: cohort.event, project, cohorts: true }),
      ),
    ),
    section(
      'Came back and did',
      h(
        'div',
        { class: 'query-card' },
        h(
          'div',
          { class: 'query-card-head' },
          seriesTag(1),
          eventPicker({
            value: ret.event,
            project,
            label: 'Return event',
            onChange: (v) => {
              ret.event = v;
              update();
            },
          }),
        ),
        filterEditor(ret.filters!, update, { event: ret.event, project, cohorts: true }),
      ),
    ),
    section(
      'Measured in',
      h(
        'div',
        { class: 'query-card-row' },
        tabs(
          [
            { value: 'day', label: 'Days' },
            { value: 'week', label: 'Weeks' },
            { value: 'month', label: 'Months' },
          ],
          String(spec.period ?? 'week'),
          (v) => {
            spec.period = v;
            update();
          },
          'tabs-small',
        ),
        selectMenu({
          value: String(periods),
          label: 'Number of periods',
          options: [4, 6, 8, 10, 12, 16, 24].map((n) => ({
            value: String(n),
            label: `${n} periods`,
          })),
          fallback: `${periods} periods`,
          width: 160,
          onChange: (v) => {
            spec.periods = Number(v);
            update();
          },
        }),
      ),
    ),
    section(
      'Filters on both events',
      filterEditor(spec.filters as FilterRow[], update, {
        event: cohort.event,
        project,
        cohorts: true,
      }),
    ),
  );
}

interface RunResult extends Record<string, unknown> {
  summary: string;
  sql: string[];
}

function trendsView(
  r: TrendsResult,
  previous: TrendsResult | null,
  chartType: ChartType | 'number',
): HTMLElement {
  const stats = h(
    'div',
    { class: `stats ${chartType === 'number' ? 'stats-large' : ''}` },
    r.series.map((s, i) => {
      const before = previous?.series[i]?.total;
      const c = before ? (s.total - before) / before : null;
      return kpiStat(
        s.label,
        count(s.total),
        c === null
          ? `by ${r.interval}`
          : h(
              'span',
              { class: `delta ${Math.abs(c) < 0.005 ? '' : c > 0 ? 'good' : 'bad'}` },
              c > 0 ? icon('arrowUp', 12) : icon('arrowDown', 12),
              `${Math.abs(c * 100).toFixed(0)}% vs previous`,
            ),
        { tag: letter(i), color: SERIES[i % SERIES.length] },
      );
    }),
  );
  if (chartType === 'number') return h('div', { class: 'insight-result' }, stats);
  const chart = lineChart(
    r.buckets,
    r.series.map((s, i) => ({
      label: s.label,
      values: s.values,
      previous: previous?.series[i]?.values,
    })),
    r.interval,
    { height: 320, type: chartType },
  );
  const rows = r.series.map((s, i) => {
    const before = previous?.series[i]?.total;
    return [
      h('span', { class: 'series-cell' }, seriesTag(i), s.label),
      sparkline(s.values, { color: SERIES[i % SERIES.length], height: 22 }),
      count(s.total),
      before === undefined ? '–' : count(before),
      before
        ? h(
            'span',
            { class: `delta ${s.total >= before ? 'good' : 'bad'}` },
            `${s.total >= before ? '+' : '−'}${Math.abs(((s.total - before) / before) * 100).toFixed(0)}%`,
          )
        : '–',
    ];
  });
  return h(
    'div',
    { class: 'insight-result' },
    stats,
    chart,
    r.series.length > 1 || previous
      ? table(['Series', 'Trend', 'Total', 'Previous', 'Change'], rows, {
          numeric: [2, 3, 4],
          class: 'series-table',
        })
      : null,
  );
}

function retentionView(r: RetentionResult): HTMLElement {
  if (!r.cohorts.length)
    return empty('No one in any cohort for this period.', undefined, { icon: 'retention' });
  const now = Date.now();
  let last = r.average.length - 1;
  while (last > 0 && !r.cohorts.some((c) => periodReached(c.start, last, r.period, now))) last--;
  const p = r.period[0]!.toUpperCase();
  return h(
    'div',
    { class: 'insight-result' },
    h(
      'div',
      { class: 'stats' },
      kpiStat(
        `Retained at ${p}1`,
        r.average.length > 1 && last >= 1 ? percent(r.average[1] ?? 0, 1) : '–',
        `of people come back the next ${r.period}`,
      ),
      last > 1
        ? kpiStat(
            `Retained at ${p}${last}`,
            percent(r.average[last] ?? 0, 1),
            `latest ${r.period} any cohort has reached`,
          )
        : null,
      kpiStat(
        'People in cohorts',
        count(r.cohorts.reduce((n, c) => n + c.size, 0)),
        `${r.cohorts.length} ${r.period}ly cohorts`,
      ),
    ),
    retentionCurve(r.cohorts, r.average, r.period, now),
    retentionGrid(r.cohorts, r.average, r.period, now),
  );
}

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
      if (insight.kind === 'trends') {
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
      if (insight.kind === 'funnel') {
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
      if (insight.kind === 'journeys')
        return h(
          'div',
          { class: 'card-preview' },
          h('div', { class: 'card-number' }, count((r as unknown as JourneysResult).sessions)),
          h('span', { class: 'muted small' }, ' session journeys'),
        );
      const rr = r as unknown as RetentionResult;
      const now = Date.now();
      let last = rr.average.length - 1;
      while (last > 0 && !rr.cohorts.some((c) => periodReached(c.start, last, rr.period, now)))
        last--;
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
    pageHeader(
      'Insights',
      'Saved analyses you and your agents can reopen. New projects start with DAU, WAU, retention and a few other defaults.',
      [copyButton(INSIGHT_PROMPT, 'Ask your agent to build analyses', 'bot'), newMenu()],
    ),
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
        if (r.insights.length === 0) {
          return empty(
            'Build a trends, funnel or retention chart, then save it here so you and your agents can reopen it.',
            newMenu('Create your first analysis'),
            { icon: 'insights', title: 'No saved analyses yet' },
          );
        }
        all = r.insights;
        paint();
        return grid;
      },
      'Loading analyses',
      'cards',
    ),
  ];
}

function editorView(options: {
  mode: 'new' | 'saved' | 'ephemeral';
  kind: Kind;
  key?: string;
  name?: string;
  description?: string;
  spec: Spec;
  route: Route;
}): Node[] {
  const kind = options.kind;
  const spec = structuredClone(options.spec);
  const sc = scope();
  const form = h('form', { class: 'builder' });
  const output = h('div', { class: 'insight-output' });
  const status = h('span', { class: 'run-status muted small', 'aria-live': 'polite' });
  let chartType: ChartType | 'number' =
    (options.route.params.get('chart') as ChartType | 'number' | null) ?? 'line';
  let runId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

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

  const ready = () => {
    if (kind === 'journeys')
      return !(spec.anchor as StepSpec | undefined) || Boolean((spec.anchor as StepSpec).event);
    if (kind === 'funnel') return (spec.steps as StepSpec[]).every((s) => s.event);
    if (kind === 'trends')
      return (spec.series as SeriesSpec[]).every(
        (s) => s.event && ((s.math !== 'sum' && s.math !== 'avg') || s.property),
      );
    return Boolean((spec.cohortEvent as StepSpec).event && (spec.returnEvent as StepSpec).event);
  };

  const run = async () => {
    clearTimeout(timer);
    if (!ready()) {
      mount(
        output,
        empty(
          kind === 'funnel'
            ? 'Pick an event for every step to see the funnel.'
            : 'Pick an event to see results.',
          undefined,
          { icon: KIND_ICON[kind], title: 'Almost there' },
        ),
      );
      status.textContent = '';
      return;
    }
    const id = ++runId;
    status.textContent = 'Running…';
    output.classList.add('running');
    if (!output.firstChild || output.querySelector('.state.empty'))
      mount(output, loading('Running query', 'chart'));
    try {
      const body = fullSpec();
      const prev =
        kind === 'trends' && prefs.compare
          ? previousRange(String(body.from), body.to ? String(body.to) : null)
          : null;
      const [result, previous] = await Promise.all([
        api.post<RunResult>('/api/query', body),
        prev
          ? api
              .post<TrendsResult>('/api/query', { ...body, from: prev.from, to: prev.to })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (id !== runId) return;
      const view =
        kind === 'journeys'
          ? journeyChart(result as unknown as JourneysResult)
          : kind === 'trends'
            ? trendsView(result as unknown as TrendsResult, previous, chartType)
            : kind === 'funnel'
              ? (result as unknown as FunnelResult).steps[0]?.count
                ? funnelChart((result as unknown as FunnelResult).steps, {
                    windowSeconds: (result as unknown as FunnelResult).windowSeconds,
                    breakdowns: (result as unknown as FunnelResult).breakdowns,
                  })
                : empty('No one did the first step in this period.', undefined, { icon: 'funnel' })
              : retentionView(result as unknown as RetentionResult);
      mount(
        output,
        panel(
          '',
          [h('p', { class: 'summary' }, icon('bot', 15), h('span', {}, result.summary)), view],
          { sql: result.sql, class: 'result-panel' },
        ),
      );
      status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (options.mode === 'ephemeral' || options.mode === 'new') {
        const params = new URLSearchParams(Object.fromEntries(options.route.params));
        params.set('spec', JSON.stringify(spec));
        const path = options.mode === 'new' ? `insights/new/${kind}` : `insights/${kind}`;
        history.replaceState(null, '', `#/${path}?${params}`);
      }
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

  const renderForm = () => mount(form, builder(kind, spec, update, sc.project));
  function update() {
    renderForm();
    schedule();
  }
  // Text and number inputs inside filters change without a structural update.
  form.addEventListener('change', schedule);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });

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
        go(`insights/${saved.key}`);
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

  const headerActions = [
    copyButton(agentPrompt, 'Agent prompt', 'bot'),
    copyButton(() => location.href, 'Link', 'link'),
    options.mode === 'saved'
      ? iconButton('trash', 'Delete analysis', () => {
          if (!confirm('Delete this saved analysis?')) return;
          void api
            .delete(`/api/insights/${encodeURIComponent(options.key!)}`, { project: sc.project })
            .then(() => {
              toast('Deleted');
              go('insights');
            });
        })
      : null,
    h(
      'button',
      { type: 'button', class: 'primary', onclick: openSave },
      icon('save', 15),
      options.mode === 'saved' ? 'Save changes' : 'Save',
    ),
  ];

  const title =
    options.mode === 'new'
      ? `New ${KIND_LABEL[kind].toLowerCase()} analysis`
      : options.mode === 'saved'
        ? (options.name ?? 'Analysis')
        : `${KIND_LABEL[kind]} query`;
  const blurb =
    options.mode === 'saved' ? options.description || KIND_BLURB[kind] : KIND_BLURB[kind];

  const kindSwitch =
    options.mode === 'new' || options.mode === 'ephemeral'
      ? tabs(
          KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
          kind,
          (next) =>
            go(options.mode === 'new' ? `insights/new/${next}` : `insights/${next}`, {
              spec: null,
            }),
          'tabs-block',
        )
      : h('span', { class: `kind-chip kind-${kind}` }, icon(KIND_ICON[kind], 14), KIND_LABEL[kind]);

  const toolbar = h('div', { class: 'canvas-toolbar' });
  const paintToolbar = (): void =>
    mount(
      toolbar,
      kind === 'trends'
        ? [
            tabs(
              [
                { value: 'line', label: 'Line', icon: 'lineChart' as IconName },
                { value: 'area', label: 'Area', icon: 'areaChart' as IconName },
                { value: 'bar', label: 'Bar', icon: 'barChart' as IconName },
                { value: 'number', label: 'Number', icon: 'hash' as IconName },
              ],
              chartType,
              (v) => {
                chartType = v as ChartType | 'number';
                paintToolbar();
                void run();
              },
              'tabs-small',
            ),
            tabs(
              [
                { value: 'hour', label: 'Hour' },
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ],
              String(spec.interval ?? 'day'),
              (v) => {
                spec.interval = v;
                paintToolbar();
                void run();
              },
              'tabs-small',
            ),
          ]
        : h(
            'span',
            { class: 'muted small' },
            kind === 'journeys'
              ? 'Link widths count sessions; observation is bounded.'
              : kind === 'funnel'
                ? 'Counts unique people who did each step in order.'
                : 'Cohorts by the period of each person’s first event.',
          ),
      h('span', { class: 'toolbar-spacer' }),
      status,
    );
  paintToolbar();

  renderForm();
  void run();

  return [
    pageHeader(title, blurb, headerActions),
    h(
      'div',
      { class: 'analysis' },
      h(
        'aside',
        { class: 'query-rail', 'aria-label': 'Query' },
        h('div', { class: 'rail-kind' }, kindSwitch),
        form,
        options.mode !== 'saved'
          ? null
          : h(
              'a',
              { class: 'link-button rail-back', href: href('insights') },
              icon('chevronLeft', 14),
              'Back to library',
            ),
      ),
      h('section', { class: 'query-canvas' }, toolbar, output),
    ),
  ];
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
        return editorView({
          mode: 'saved',
          kind: insight.kind,
          key: insight.key,
          name: insight.name,
          description: insight.description,
          spec: insight.spec,
          route,
        });
      },
      'Loading analysis',
      'chart',
    ),
  ];
}
