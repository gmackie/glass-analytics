/**
 * Pieces of the insight editor that run their own queries: the project's group types,
 * funnel correlation, the time-to-convert and conversion-over-time views, and the people
 * behind a number.
 */

import { api } from '../api.ts';
import { h, mount } from '../dom.ts';
import { count } from '../format.ts';
import { href, scope } from '../state.ts';
import { lineChart } from './charts.ts';
import { icon } from './icons.ts';
import { modal } from './menu.ts';
import { propertyPicker } from './picker.ts';
import { empty, errorState, loading, table, tabs, toast } from './ui.ts';

type Spec = Record<string, unknown>;

export const PROPERTY_MATHS = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p75',
  'p90',
  'p95',
  'p99',
]);

let groupTypes: { project: string | undefined; types: string[] } | null = null;

/** The project's group types, loaded once per project; `onLoad` re-renders when they arrive. */
export function knownGroupTypes(project: string | undefined, onLoad: () => void): string[] {
  if (groupTypes && groupTypes.project === project) return groupTypes.types;
  groupTypes = { project, types: [] };
  api
    .get<{ types: { type: string }[] }>('/api/groups/types', { project })
    .then((r) => {
      groupTypes = { project, types: r.types.map((t) => t.type) };
      if (r.types.length) onLoad();
    })
    .catch(() => {});
  return [];
}

interface CorrelationItem {
  name: string;
  event?: string;
  successCount: number;
  failureCount: number;
  conversionRate: number;
  oddsRatio: number;
  significant: boolean;
}

function oddsCell(it: CorrelationItem, good: boolean): HTMLElement {
  const tone = good ? 'good' : 'bad';
  const odds = it.oddsRatio >= 10 ? Math.round(it.oddsRatio) : it.oddsRatio.toFixed(1);
  return h(
    'span',
    {
      class: it.significant ? tone : 'muted',
      title: it.significant ? 'Significant (p < 0.05)' : 'Not significant yet',
    },
    `${odds}×`,
  );
}

function correlationList(
  items: CorrelationItem[],
  title: string,
  good: boolean,
  mode: 'events' | 'properties',
): HTMLElement {
  const events = mode === 'events';
  const body = items.length
    ? table(
        [events ? 'Event' : 'Value', 'Converted', 'Dropped off', 'Conversion', 'Odds'],
        items.map((it) => [
          events
            ? h('span', { class: 'event-pill' }, it.event ?? it.name)
            : h('span', { class: 'cell-clip', title: it.name }, it.name),
          count(it.successCount),
          count(it.failureCount),
          `${Math.round(it.conversionRate * 100)}%`,
          oddsCell(it, good),
        ]),
        { numeric: [1, 2, 3, 4] },
      )
    : h('p', { class: 'muted small' }, 'Nothing stands out.');
  return h('div', { class: 'correlation-list' }, h('h4', {}, title), body);
}

/**
 * What goes with converting through a funnel, and with dropping off: other
 * events people did (or values of a property they had), by odds ratio. Runs on
 * demand, since it reads every event of everyone who entered the funnel.
 */
export function correlationView(spec: Spec): HTMLElement {
  const project = scope().project;
  const root = h('div', { class: 'correlation' });
  let mode: 'events' | 'properties' = 'events';
  let property = '';
  const results = h('div', {});
  const list = (items: CorrelationItem[], title: string, good: boolean) =>
    correlationList(items, title, good, mode);
  const run = async () => {
    if (mode === 'properties' && !property) {
      mount(results, h('p', { class: 'muted small' }, 'Pick a property to compare its values.'));
      return;
    }
    mount(results, loading('Comparing converters with drop-offs', 'table'));
    try {
      const r = await api.post<{
        converters: number;
        dropOffs: number;
        success: CorrelationItem[];
        failure: CorrelationItem[];
        summary: string;
      }>('/api/query', {
        ...spec,
        kind: 'funnel_correlation',
        project,
        correlation: mode,
        ...(mode === 'properties' ? { properties: [property] } : {}),
      });
      mount(
        results,
        h(
          'p',
          { class: 'muted small' },
          `${count(r.converters)} converted, ${count(r.dropOffs)} dropped off.`,
        ),
        h(
          'div',
          { class: 'grid-2 correlation-grid' },
          list(r.success, 'Goes with converting', true),
          list(r.failure, 'Goes with dropping off', false),
        ),
      );
    } catch (err) {
      mount(results, errorState(err));
    }
  };
  const paint = () =>
    mount(
      root,
      h(
        'div',
        { class: 'correlation-head' },
        h(
          'div',
          {},
          h('strong', {}, 'What goes with converting'),
          h(
            'p',
            { class: 'muted small correlation-note' },
            'Events or property values far more common among people who converted, or who dropped off.',
          ),
        ),
        tabs(
          [
            { value: 'events', label: 'Events' },
            { value: 'properties', label: 'A property' },
          ],
          mode,
          (v) => {
            mode = v;
            paint();
            void run();
          },
          'tabs-small',
        ),
      ),
      mode === 'properties'
        ? h(
            'div',
            { class: 'correlation-property' },
            propertyPicker({
              value: property,
              project,
              event: (spec.steps as { event: string }[] | undefined)?.[0]?.event,
              placeholder: 'person.plan, browser, utm_source…',
              onChange: (v) => {
                property = v;
                void run();
              },
            }),
          )
        : null,
      results,
    );
  paint();
  mount(
    results,
    h(
      'button',
      { type: 'button', onclick: () => void run() },
      icon('search', 14),
      'Find what drives conversion',
    ),
  );
  return root;
}

const formatSeconds = (s: number) =>
  s < 60
    ? `${Math.round(s)}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : s < 86400
        ? `${(s / 3600).toFixed(1)}h`
        : `${(s / 86400).toFixed(1)}d`;

/** Funnel views other than steps: the time-to-convert histogram, or conversion over time. */
export function funnelVizView(r: {
  timeToConvert?: {
    fromStep: number;
    toStep: number;
    converters: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    histogram: { fromSeconds: number; toSeconds: number; count: number }[];
  };
  trend?: {
    interval: string;
    buckets: number[];
    fromStep: number;
    toStep: number;
    series: { breakdown: string | null; rate: number[] }[];
  };
}): HTMLElement | null {
  if (r.timeToConvert) {
    const t = r.timeToConvert;
    return h(
      'div',
      { class: 'insight-result' },
      h(
        'p',
        { class: 'muted' },
        `${count(t.converters)} converted from step ${t.fromStep} to ${t.toStep}. Median ${t.medianSeconds === null ? '–' : formatSeconds(t.medianSeconds)}, average ${t.averageSeconds === null ? '–' : formatSeconds(t.averageSeconds)}.`,
      ),
      t.histogram.length
        ? lineChart(
            t.histogram.map((_, i) => i),
            [{ label: 'People', values: t.histogram.map((b) => b.count) }],
            'day',
            {
              type: 'bar',
              height: 260,
              labels: t.histogram.map(
                (b) => `${formatSeconds(b.fromSeconds)}–${formatSeconds(b.toSeconds)}`,
              ),
            },
          )
        : empty('No one converted in this range.'),
    );
  }
  if (r.trend) {
    const t = r.trend;
    return h(
      'div',
      { class: 'insight-result' },
      lineChart(
        t.buckets,
        t.series.map((s) => ({
          label: s.breakdown ?? `Step ${t.fromStep} → ${t.toStep}`,
          values: s.rate,
        })),
        t.interval,
        { height: 300, yMax: 1, format: (n) => `${Math.round(n * 100)}%` },
      ),
    );
  }
  return null;
}

/** The people (sessions, groups) behind a number, with CSV export and "save as cohort". */
export function showActors(
  kind: 'trends' | 'funnel' | 'retention' | 'paths',
  spec: Spec,
  selection: Record<string, unknown>,
  title: string,
): void {
  const project = scope().project;
  const body = h('div', {}, loading('Loading people', 'table'));
  const request = {
    project,
    kind,
    spec: { ...spec, kind: undefined, project: undefined },
    selection,
    limit: 100,
  };
  const close = modal({
    title,
    body,
    width: 720,
    actions: [
      h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const name = prompt('Name the cohort:', title);
            if (!name) return;
            try {
              await api.post('/api/actors', { ...request, saveAsCohort: { name } });
              toast(`Saved "${name}" as a cohort`);
              close();
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), 'error');
            }
          },
        },
        'Save as cohort',
      ),
      h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const r = await api.post<{ csv: string }>('/api/actors', {
              ...request,
              format: 'csv',
              limit: 1000,
            });
            const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
            const a = h('a', { href: url, download: 'people.csv' });
            a.click();
            URL.revokeObjectURL(url);
          },
        },
        'Download CSV',
      ),
    ],
  });
  api
    .post<{
      actors: {
        id: string;
        type: string;
        groupType?: string;
        events: number;
        properties: Record<string, unknown>;
      }[];
      summary: string;
      hasMore: boolean;
    }>('/api/actors', request)
    .then((r) =>
      mount(
        body,
        h('p', { class: 'muted' }, r.summary),
        r.actors.length
          ? table(
              ['Who', 'Events', ''],
              r.actors.map((a) => [
                h(
                  'a',
                  {
                    href:
                      a.type === 'person'
                        ? href(`users/${encodeURIComponent(a.id)}`)
                        : a.type === 'group'
                          ? href(
                              `groups/${encodeURIComponent(a.groupType ?? '')}/${encodeURIComponent(a.id)}`,
                            )
                          : href(`replays/${encodeURIComponent(a.id)}`),
                  },
                  a.id,
                ),
                count(a.events),
                h(
                  'span',
                  { class: 'muted small' },
                  String(a.properties.email ?? a.properties.name ?? ''),
                ),
              ]),
              { numeric: [1] },
            )
          : null,
      ),
    )
    .catch((err) => mount(body, errorState(err)));
}
