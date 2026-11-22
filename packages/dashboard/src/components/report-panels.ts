/**
 * Panels for the Reports pages that sit on top of the web overview: key event
 * conversions, traffic channels and sources with conversion rates, and site
 * health. Data comes from `/api/reports/*`.
 */

import { api } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { change, count, percent } from '../format.ts';
import { href, scope } from '../state.ts';
import { lineChart, sparkline } from './charts.ts';
import { type IconName, icon } from './icons.ts';
import { HOME_PROMPTS } from './prompts.ts';
import { copyButton, empty, later, panel, table, tabs } from './ui.ts';

export interface Goal {
  event: string;
  role: 'conversion' | 'important';
  description: string;
  count: number;
  visitors: number;
  rate: number;
  previous: { count: number; visitors: number; rate: number } | null;
  series: number[];
}

export interface Conversions {
  interval: string;
  buckets: number[];
  visitors: number;
  goals: Goal[];
  converted: { visitors: number; rate: number; previous: number | null };
  sql: string[];
}

export interface SourceRow {
  value: string;
  visitors: number;
  sessions: number;
  converted: number;
  rate: number;
  bounceRate: number;
}

type Filters = { property: string; value: string }[];

const body = (filters: Filters, extra: Record<string, unknown> = {}) => ({
  project: scope().project,
  from: scope().from,
  to: scope().to,
  filters,
  ...extra,
});

export const fetchConversions = (filters: Filters) =>
  api.post<Conversions>('/api/reports/conversions', body(filters));

function delta(now: number, before: number | null | undefined): Child {
  const c = change(now, before ?? undefined);
  if (!c || c.direction === 'flat') return null;
  return h(
    'span',
    { class: `delta ${c.direction === 'up' ? 'good' : 'bad'}`, title: 'vs previous period' },
    icon(c.direction === 'up' ? 'arrowUp' : 'arrowDown', 12),
    c.text.replace(/^[+−]/, ''),
  );
}

/** One tile per key event: rate of visitors who did it, how many, the trend. Plus overall conversion. */
export function keyEventTiles(c: Conversions): HTMLElement {
  if (c.goals.length === 0) {
    return h(
      'section',
      { class: 'key-events-empty' },
      h('span', { class: 'empty-icon' }, icon('flag', 18)),
      h(
        'div',
        {},
        h('strong', {}, 'No conversions marked yet'),
        h(
          'p',
          { class: 'muted' },
          'Mark the events that mean success (a signup, a pledge, a purchase) to see conversion rates here and per traffic source. Star them on the Events page, or ask your agent.',
        ),
      ),
      h(
        'div',
        { class: 'key-events-actions' },
        h('a', { class: 'button ghost small', href: href('events') }, icon('events', 14), 'Events'),
        copyButton(HOME_PROMPTS[2]!.prompt, 'Copy prompt', 'bot'),
      ),
    );
  }
  const conversions = c.goals.filter((g) => g.role === 'conversion');
  const tiles: Child[] = [];
  if (conversions.length > 1) {
    tiles.push(
      h(
        'div',
        { class: 'kpi key-event overall' },
        h('dt', {}, icon('flag', 13), 'Converted'),
        h('dd', {}, percent(c.converted.rate, 1), delta(c.converted.rate, c.converted.previous)),
        h(
          'span',
          { class: 'muted small' },
          `${count(c.converted.visitors)} of ${count(c.visitors)} visitors`,
        ),
      ),
    );
  }
  for (const g of c.goals) {
    tiles.push(
      h(
        'a',
        {
          class: `kpi key-event ${g.role}`,
          href: href('insights/new/trends', {
            spec: JSON.stringify({ series: [{ event: g.event, math: 'unique_persons' }] }),
          }),
          title: g.description || `Open a trend of ${g.event}`,
        },
        h('dt', {}, icon(g.role === 'conversion' ? 'flag' : 'zap', 13), g.event),
        h('dd', {}, percent(g.rate, 1), delta(g.rate, g.previous?.rate)),
        h(
          'span',
          { class: 'muted small' },
          `${count(g.visitors)} visitors · ${count(g.count)} times`,
        ),
        g.series.length > 1 ? sparkline(g.series, { height: 26 }) : null,
      ),
    );
  }
  return h('dl', { class: 'kpis key-events' }, tiles);
}

/** A table of sources with visitors, conversions and bounce, each row opening the segment report. */
function sourceTable(
  rows: SourceRow[],
  property: string | null,
  hasGoals: boolean,
  label: string,
): HTMLElement {
  if (!rows.length) return empty('No visitors in this period.');
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  const linkable = (v: string) => property && v !== '(none)' && v !== 'Direct / None';
  return table(
    [label, 'Visitors', ...(hasGoals ? ['Converted', 'Rate'] : []), 'Bounce'],
    rows.map((r) => [
      h(
        linkable(r.value) ? 'a' : 'span',
        {
          class: 'source-cell',
          ...(linkable(r.value)
            ? {
                href: href('reports/segment', { p: property!, v: r.value }),
                title: `Open a report for ${r.value}`,
              }
            : {}),
          style: `--w:${((r.visitors / max) * 100).toFixed(1)}%`,
        },
        r.value,
      ),
      count(r.visitors),
      ...(hasGoals
        ? [
            count(r.converted),
            h('span', { class: r.rate > 0 ? 'rate' : 'muted' }, percent(r.rate, 1)),
          ]
        : []),
      h('span', { class: 'muted' }, percent(r.bounceRate, 0)),
    ]),
    { numeric: hasGoals ? [1, 2, 3, 4] : [1, 2], class: 'source-table' },
  );
}

const DIMENSIONS: { value: string; label: string; property: string | null }[] = [
  { value: 'referrer', label: 'Referrer', property: 'referrer_host' },
  { value: 'utm_source', label: 'Source', property: 'utm_source' },
  { value: 'utm_medium', label: 'Medium', property: 'utm_medium' },
  { value: 'utm_campaign', label: 'Campaign', property: 'utm_campaign' },
  { value: 'entry_page', label: 'Landing page', property: 'path' },
];

/** Channels with conversion rates, and a source table switchable between referrer, UTM tags and landing page. */
export function marketingPanels(filters: Filters, hasGoals: boolean, only?: string[]): HTMLElement {
  const channels = later(async () => {
    const r = await api.post<{ rows: SourceRow[]; sql: string[] }>(
      '/api/reports/sources',
      body(filters, { dimension: 'channel' }),
    );
    return panel('Channels', sourceTable(r.rows, null, hasGoals, 'Channel'), {
      icon: 'layers',
      subtitle: 'Visitors by where their first visit in this period came from',
      sql: r.sql,
    });
  }, 'Loading channels');
  const dims = only ? DIMENSIONS.filter((d) => only.includes(d.value)) : DIMENSIONS;
  let selected = dims[0]!.value;
  const holder = h('div', {});
  const switcher = h('div', {});
  const paint = () => {
    const dim = dims.find((d) => d.value === selected)!;
    mount(
      switcher,
      dims.length > 1
        ? tabs(
            dims.map((d) => ({ value: d.value, label: d.label })),
            selected,
            (v) => {
              selected = v;
              paint();
            },
            'tabs-small',
          )
        : null,
    );
    mount(
      holder,
      later(async () => {
        const r = await api.post<{ rows: SourceRow[] }>(
          '/api/reports/sources',
          body(filters, { dimension: dim.value, limit: 25 }),
        );
        return sourceTable(r.rows, dim.property, hasGoals, dim.label);
      }, 'Loading sources'),
    );
  };
  paint();
  return h(
    'div',
    { class: 'grid-2 marketing-grid' },
    channels,
    panel('Sources', holder, {
      icon: 'megaphone',
      actions: switcher,
    }),
  );
}

// ── Health ────────────────────────────────────────────────────────────────

interface Health {
  interval: string;
  buckets: number[];
  errors: {
    total: number;
    previous: number;
    series: number[];
    visitors: number;
    sessions: number;
    sessionsTotal: number;
    sessionRate: number;
  };
  errorPages: { path: string; errors: number; visitors: number }[];
  notFound: { path: string; title: string; views: number; visitors: number; referrer: string }[];
  slowPages: { path: string; p75: number; samples: number }[];
  replays: {
    sessions: number;
    rageClicks: number;
    deadClicks: number;
    failedRequests: number;
    consoleErrors: number;
  } | null;
  sql: string[];
}

function stat(
  label: string,
  value: string,
  sub: Child,
  iconName: IconName,
  tone = '',
): HTMLElement {
  return h(
    'div',
    { class: `kpi health-stat ${tone}` },
    h('dt', {}, icon(iconName, 13), label),
    h('dd', {}, value),
    h('span', { class: 'muted small' }, sub),
  );
}

export function healthPanels(filters: Filters): HTMLElement {
  return later(
    async () => {
      const r = await api.post<Health>('/api/reports/health', body(filters));
      const e = r.errors;
      const rp = r.replays;
      const errorDelta = delta(e.total, e.previous);
      const lcp = (ms: number) =>
        ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
      return [
        h(
          'dl',
          { class: 'kpis health-kpis' },
          stat(
            'Errors',
            count(e.total),
            h('span', {}, errorDelta ?? 'vs previous period'),
            'alert',
            e.total ? 'bad' : 'good',
          ),
          stat(
            'Sessions with an error',
            percent(e.sessionRate, 1),
            `${count(e.sessions)} of ${count(e.sessionsTotal)} sessions`,
            'replay',
            e.sessionRate > 0.02 ? 'bad' : '',
          ),
          stat('Visitors affected', count(e.visitors), 'saw at least one error', 'users'),
          stat(
            'Broken pages',
            count(r.notFound.length),
            r.notFound.length
              ? `${count(r.notFound.reduce((n, p) => n + p.views, 0))} views of "not found" pages`
              : 'none found',
            'link',
            r.notFound.length ? 'bad' : 'good',
          ),
          rp
            ? stat(
                'Frustration',
                count(rp.rageClicks + rp.deadClicks),
                `${count(rp.rageClicks)} rage · ${count(rp.deadClicks)} dead clicks in ${count(rp.sessions)} recordings`,
                'zap',
                rp.rageClicks ? 'warn' : '',
              )
            : null,
          rp
            ? stat(
                'Failed requests',
                count(rp.failedRequests),
                `${count(rp.consoleErrors)} console errors in recordings`,
                'globe',
                rp.failedRequests ? 'bad' : '',
              )
            : null,
        ),
        panel(
          'Errors over time',
          e.total
            ? lineChart(r.buckets, [{ label: 'Errors', values: e.series }], r.interval, {
                height: 180,
                type: 'bar',
              })
            : empty('No JavaScript errors in this period.', undefined, {
                icon: 'check',
                title: 'All clear',
              }),
          {
            class: 'wide',
            icon: 'alert',
            sql: [r.sql[0]!, r.sql[2]!],
            actions: e.total
              ? h(
                  'a',
                  { class: 'button ghost small', href: href('replays', { has: 'errors' }) },
                  icon('replay', 14),
                  'Watch sessions with errors',
                )
              : null,
          },
        ),
        h(
          'div',
          { class: 'grid-3' },
          panel(
            'Where errors happen',
            r.errorPages.length
              ? table(
                  ['Page', 'Errors', 'Visitors'],
                  r.errorPages.map((p) => [
                    h(
                      'a',
                      {
                        href: href('replays', { has: 'errors', url: p.path }),
                        title: 'Watch sessions with errors on this page',
                      },
                      p.path,
                    ),
                    count(p.errors),
                    count(p.visitors),
                  ]),
                  { numeric: [1, 2] },
                )
              : empty('No errors.'),
            { icon: 'alert', sql: [r.sql[3]!] },
          ),
          panel(
            'Pages that look broken',
            r.notFound.length
              ? table(
                  ['Page', 'Views', 'From'],
                  r.notFound.map((p) => [
                    h('span', { title: p.title }, p.path),
                    count(p.views),
                    h('span', { class: 'muted cell-clip' }, p.referrer),
                  ]),
                  { numeric: [1] },
                )
              : empty('No pages with a "not found" title or a /404 path.', undefined, {
                  icon: 'check',
                }),
            {
              icon: 'link',
              sql: [r.sql[4]!],
              subtitle: 'Titles or paths that say 404 or "not found"',
            },
          ),
          panel(
            'Slowest pages',
            r.slowPages.length
              ? table(
                  ['Page', 'LCP p75', 'Samples'],
                  r.slowPages.map((p) => [
                    p.path,
                    h(
                      'span',
                      { class: p.p75 > 4000 ? 'bad-text' : p.p75 > 2500 ? 'warn-text' : '' },
                      lcp(p.p75),
                    ),
                    count(p.samples),
                  ]),
                  { numeric: [1, 2] },
                )
              : empty('Needs 5+ Largest Contentful Paint samples per page.', undefined, {
                  icon: 'gauge',
                }),
            {
              icon: 'gauge',
              sql: [r.sql[5]!],
              subtitle: 'Largest Contentful Paint; good is under 2.5s',
            },
          ),
        ),
      ];
    },
    'Checking site health',
    'report',
  );
}
