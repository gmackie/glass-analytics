/**
 * Reports: Web (default), Marketing, and Health.
 *
 * One `/api/query` kind=web fetch powers all three tabs; the tabs only change
 * which panels are shown. With "compare" on, a second fetch for the previous
 * period draws the dashed line on the main chart.
 */

import type { BreakdownRow, WebBreakdown, WebResult } from '@dataflare/core/insights/web';
import { api } from '../api.ts';
import { barList, lineChart, sparkline } from '../components/charts.ts';
import { previousRange } from '../components/date-range.ts';
import { type IconName, icon } from '../components/icons.ts';
import {
  HEALTH_PROMPTS,
  HOME_PROMPTS,
  MARKETING_PROMPTS,
  promptStrip,
} from '../components/prompts.ts';
import {
  fetchConversions,
  healthPanels,
  keyEventTiles,
  marketingPanels,
} from '../components/report-panels.ts';
import { copyButton, empty, later, pageHeader, panel, tabs } from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { apiFilters, filterChips } from '../filters.ts';
import {
  capitalize,
  change,
  count,
  countryFlag,
  countryName,
  decimal,
  duration,
  percent,
} from '../format.ts';
import { currentRoute, go, href, prefs, type Route, scope } from '../state.ts';

type Result = WebResult & { project: string };
type ReportTab = 'web' | 'marketing' | 'health';
type Metric = 'visitors' | 'pageviews';

/** Which filter property each breakdown row applies when clicked. */
const FILTER_FOR: Partial<Record<WebBreakdown, string>> = {
  pages: 'path',
  entry_pages: 'path',
  exit_pages: 'path',
  referrers: 'referrer_host',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  countries: 'country',
  devices: 'device',
  browsers: 'browser',
  os: 'os',
};

const DEVICE_ICON: Record<string, IconName> = {
  desktop: 'monitor',
  mobile: 'smartphone',
  tablet: 'tablet',
};

/** Labels and decorations per breakdown. */
const DECOR: Partial<
  Record<WebBreakdown, { display?: (v: string) => string; decorate?: (v: string) => Child }>
> = {
  countries: {
    display: countryName,
    decorate: (v) => h('span', { class: 'flag' }, countryFlag(v) || icon('globe', 14)),
  },
  devices: { display: capitalize, decorate: (v) => icon(DEVICE_ICON[v] ?? 'monitor', 14) },
  referrers: {
    decorate: (v) =>
      v === 'Direct / None' || v === '(none)'
        ? icon('arrowRight', 14)
        : h('span', { class: 'favicon' }, (v.replace(/^www\./, '')[0] ?? '?').toUpperCase()),
  },
  errors: { decorate: () => icon('alert', 14) },
};

function metric(): Metric {
  return currentRoute().params.get('metric') === 'pageviews' ? 'pageviews' : 'visitors';
}

function kpis(r: Result, onSelect: (m: Metric) => void, selected: Metric): HTMLElement {
  const items: {
    key?: Metric;
    label: string;
    value: string;
    now: number;
    before?: number;
    lowerIsBetter?: boolean;
    spark?: number[];
  }[] = [
    {
      key: 'visitors',
      label: 'Visitors',
      value: count(r.totals.visitors),
      now: r.totals.visitors,
      before: r.previous?.visitors,
      spark: r.timeseries.visitors,
    },
    {
      key: 'pageviews',
      label: 'Pageviews',
      value: count(r.totals.pageviews),
      now: r.totals.pageviews,
      before: r.previous?.pageviews,
      spark: r.timeseries.pageviews,
    },
    {
      label: 'Sessions',
      value: count(r.totals.sessions),
      now: r.totals.sessions,
      before: r.previous?.sessions,
    },
    {
      label: 'Bounce rate',
      value: percent(r.totals.bounceRate, 0),
      now: r.totals.bounceRate,
      before: r.previous?.bounceRate,
      lowerIsBetter: true,
    },
    {
      label: 'Session length',
      value: duration(r.totals.avgSessionSeconds),
      now: r.totals.avgSessionSeconds,
      before: r.previous?.avgSessionSeconds,
    },
    {
      label: 'Views per session',
      value: decimal(r.totals.viewsPerSession, 1),
      now: r.totals.viewsPerSession,
      before: r.previous?.viewsPerSession,
    },
  ];
  return h(
    'dl',
    { class: 'kpis' },
    items.map((item) => {
      const c = change(item.now, item.before);
      const good =
        c && c.direction !== 'flat' && (c.direction === 'up') !== Boolean(item.lowerIsBetter);
      const delta = c
        ? h(
            'span',
            {
              class: `delta ${c.direction === 'flat' ? '' : good ? 'good' : 'bad'}`,
              title: 'vs previous period',
            },
            c.direction === 'up'
              ? icon('arrowUp', 12)
              : c.direction === 'down'
                ? icon('arrowDown', 12)
                : null,
            c.text.replace(/^[+−]/, ''),
          )
        : null;
      const selectable = Boolean(item.key);
      return h(
        'div',
        {
          class: `kpi ${selectable ? 'selectable' : ''} ${item.key === selected ? 'selected' : ''}`,
          role: selectable ? 'button' : null,
          tabindex: selectable ? 0 : null,
          'aria-pressed': selectable ? String(item.key === selected) : null,
          title: selectable ? `Chart ${item.label.toLowerCase()}` : null,
          onclick: selectable ? () => onSelect(item.key!) : null,
          onkeydown: selectable
            ? (e: Event) => {
                if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
                  e.preventDefault();
                  onSelect(item.key!);
                }
              }
            : null,
        },
        h('dt', {}, item.label),
        h('dd', {}, item.value, delta),
        item.spark && item.spark.length > 1
          ? sparkline(item.spark, { height: 28 })
          : h('div', { class: 'kpi-spacer' }),
      );
    }),
  );
}

function breakdownPanel(
  r: Result,
  title: string,
  panelIcon: IconName,
  options: { key: WebBreakdown; label: string }[],
  headers: [string, string, string?],
): HTMLElement {
  const body = h('div', {});
  let selected = options[0]!.key;
  const switcher = () =>
    options.length > 1
      ? tabs(
          options.map((o) => ({ value: o.key, label: o.label })),
          selected,
          (v) => {
            selected = v;
            render();
            mount(actions, switcher());
          },
          'tabs-small',
        )
      : null;
  const actions = h('div', {}, switcher());
  const render = () => {
    const rows: BreakdownRow[] = r.breakdowns[selected] ?? [];
    const filter = FILTER_FOR[selected];
    const decor = DECOR[selected] ?? {};
    mount(
      body,
      rows.length
        ? barList(
            rows.map((row) => ({
              label: row.value,
              value: selected === 'errors' ? row.count : row.visitors,
              secondary: selected === 'errors' ? row.visitors : row.count,
              // Rows open a full report for that page, source, country or device; errors open their recordings.
              href:
                selected === 'errors'
                  ? href('replays', { has: 'errors', q: row.value })
                  : filter && row.value !== '(none)' && row.value !== 'Direct / None'
                    ? segmentHref(filter, row.value)
                    : undefined,
            })),
            headers,
            decor,
          )
        : empty('Nothing here for this period.'),
    );
  };
  render();
  return panel(title, body, { sql: [r.sql[r.sql.length - 2]!], actions, icon: panelIcon });
}

/** The drill-down report for one value of a property, e.g. utm_source = google. */
export function segmentHref(property: string, value: string): string {
  return href('reports/segment', { p: property, v: value });
}

/** Key event tiles, fetched separately so the main report never waits for them. */
function keyEvents(): HTMLElement {
  return later(
    async () => keyEventTiles(await fetchConversions(apiFilters())),
    'Loading key events',
    'kpis',
  );
}

const VITALS: Record<
  string,
  { good: number; poor: number; show: (n: number) => string; name: string }
> = {
  LCP: {
    good: 2500,
    poor: 4000,
    show: (n) => `${(n / 1000).toFixed(2)}s`,
    name: 'Largest Contentful Paint',
  },
  INP: {
    good: 200,
    poor: 500,
    show: (n) => `${Math.round(n)}ms`,
    name: 'Interaction to Next Paint',
  },
  CLS: { good: 0.1, poor: 0.25, show: (n) => n.toFixed(2), name: 'Cumulative Layout Shift' },
  FCP: {
    good: 1800,
    poor: 3000,
    show: (n) => `${(n / 1000).toFixed(2)}s`,
    name: 'First Contentful Paint',
  },
  TTFB: { good: 800, poor: 1800, show: (n) => `${Math.round(n)}ms`, name: 'Time to First Byte' },
};

function vitalsPanel(r: Result): HTMLElement {
  const metrics = Object.entries(r.vitals);
  return panel(
    'Web vitals',
    metrics.length
      ? h(
          'dl',
          { class: 'vitals' },
          metrics.map(([name, v]) => {
            const t = VITALS[name] ?? {
              good: Number.POSITIVE_INFINITY,
              poor: Number.POSITIVE_INFINITY,
              show: (n: number) => String(n),
              name,
            };
            const rating = v.p75 <= t.good ? 'good' : v.p75 <= t.poor ? 'ok' : 'poor';
            // Position on a scale where "poor" sits at 2/3 of the bar.
            const pos = Math.min(100, (v.p75 / (t.poor * 1.5)) * 100);
            return h(
              'div',
              {
                class: `vital ${rating}`,
                title: `${t.name}: good ≤ ${t.show(t.good)}, poor > ${t.show(t.poor)}`,
              },
              h(
                'dt',
                {},
                name,
                h(
                  'span',
                  { class: `vital-badge ${rating}` },
                  rating === 'good' ? 'Good' : rating === 'ok' ? 'Needs work' : 'Poor',
                ),
              ),
              h('dd', {}, t.show(v.p75)),
              h(
                'div',
                { class: 'vital-scale' },
                h('span', { class: 'vital-marker', style: `left:${pos}%` }),
              ),
              h(
                'span',
                { class: 'muted small' },
                `${t.name} · ${count(v.samples)} ${v.samples === 1 ? 'sample' : 'samples'}`,
              ),
            );
          }),
        )
      : empty('No web vitals yet. They are sent when a visitor leaves a page.', undefined, {
          icon: 'gauge',
        }),
    {
      sql: [r.sql[r.sql.length - 1]!],
      subtitle: '75th percentile, as Google rates it',
      icon: 'gauge',
    },
  );
}

function mainChart(r: Result, selected: Metric): HTMLElement {
  const label = selected === 'visitors' ? 'Visitors' : 'Pageviews';
  const holder = h('div', {});
  const draw = (previous?: number[]) =>
    mount(
      holder,
      lineChart(
        r.timeseries.buckets,
        [{ label, values: r.timeseries[selected], previous }],
        r.interval,
        { height: 280, type: 'area' },
      ),
    );
  draw();
  const sc = scope();
  const prev = prefs.compare ? previousRange(sc.from, sc.to) : null;
  if (prev) {
    void api
      .post<Result>('/api/query', {
        kind: 'web',
        project: sc.project,
        from: prev.from,
        to: prev.to,
        interval: r.interval,
        compare: false,
        filters: apiFilters(),
      })
      .then((p) => draw(p.timeseries[selected]))
      .catch(() => undefined);
  }
  const switcher = tabs(
    [
      { value: 'visitors' as Metric, label: 'Visitors' },
      { value: 'pageviews' as Metric, label: 'Pageviews' },
    ],
    selected,
    (m) => setMetric(m),
    'tabs-small',
  );
  return panel(label, holder, {
    sql: [r.sql[0]!, r.sql[r.previous ? 2 : 1]!],
    class: 'wide chart-panel',
    actions: switcher,
    subtitle: `${count(r.totals[selected])} in this period${r.previous ? ` · ${count(r.previous[selected])} the period before` : ''}`,
  });
}

function setMetric(m: Metric): void {
  const route = currentRoute();
  go([route.page, ...route.rest].join('/'), {
    ...Object.fromEntries(route.params),
    metric: m === 'visitors' ? null : m,
  });
}

function webReport(r: Result): Node[] {
  const selected = metric();
  return [
    kpis(r, setMetric, selected),
    keyEvents(),
    mainChart(r, selected),
    h(
      'div',
      { class: 'grid-3' },
      breakdownPanel(
        r,
        'Pages',
        'events',
        [
          { key: 'pages', label: 'Top' },
          { key: 'entry_pages', label: 'Entry' },
          { key: 'exit_pages', label: 'Exit' },
        ],
        ['Page', 'Visitors', 'Views'],
      ),
      breakdownPanel(
        r,
        'Locations',
        'globe',
        [{ key: 'countries', label: 'Countries' }],
        ['Country', 'Visitors', 'Views'],
      ),
      breakdownPanel(
        r,
        'Devices',
        'monitor',
        [
          { key: 'devices', label: 'Device' },
          { key: 'browsers', label: 'Browser' },
          { key: 'os', label: 'OS' },
        ],
        ['Device', 'Visitors', 'Views'],
      ),
    ),
  ];
}

function marketingReport(r: Result): Node[] {
  return [
    kpis(r, setMetric, metric()),
    later(
      async () => {
        const c = await fetchConversions(apiFilters());
        return [
          keyEventTiles(c),
          marketingPanels(
            apiFilters(),
            c.goals.some((g) => g.role === 'conversion'),
          ),
        ];
      },
      'Loading sources',
      'report',
    ),
  ];
}

function healthReport(r: Result): Node[] {
  return [
    healthPanels(apiFilters()),
    h(
      'div',
      { class: 'grid-2' },
      breakdownPanel(
        r,
        'JavaScript errors',
        'alert',
        [{ key: 'errors', label: 'Errors' }],
        ['Message', 'Times', 'Visitors'],
      ),
      vitalsPanel(r),
    ),
  ];
}

/** Reports (or Marketing) with this filter added to the ones already applied. */
function reportsFilteredBy(property: string, value: string, marketing: boolean): string {
  const current = currentRoute().params;
  const next = new URLSearchParams();
  for (const k of ['project', 'from', 'to']) if (current.get(k)) next.set(k, current.get(k)!);
  for (const f of current.getAll('f')) next.append('f', f);
  next.append('f', `${property}:${value}`);
  return `#/${marketing ? 'reports/marketing' : 'reports'}?${next}`;
}

const PROPERTY_LABEL: Record<string, string> = {
  path: 'Page',
  referrer_host: 'Referrer',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  country: 'Country',
  device: 'Device',
  browser: 'Browser',
  os: 'Operating system',
};

/** Everything about one segment of traffic: a source, campaign, page, country or device. */
function segmentPage(route: Route): Node[] {
  const property = route.params.get('p') ?? '';
  const value = route.params.get('v') ?? '';
  const label = PROPERTY_LABEL[property] ?? property;
  const shown = property === 'country' ? `${countryFlag(value)} ${countryName(value)}` : value;
  // Sources live on the landing pageview, and a page is one view of a visit: keep whole sessions
  // so the rest of the visit, and its conversions, count. Countries and devices are on every event.
  const visitLevel =
    property.startsWith('utm_') || property === 'referrer_host' || property === 'path';
  const filterProperty = visitLevel ? `session.${property}` : property;
  const filters = [...apiFilters(), { property: filterProperty, value }];
  const sc = scope();
  const isSource = property.startsWith('utm_') || property === 'referrer_host';
  const prompt = `Use the Dataflare MCP tools to analyse traffic where ${property} is "${value}" for ${sc.from}${sc.to ? ` to ${sc.to}` : ''}: query_web and query_sources with the filter {"property":"${filterProperty}","value":"${value}"}, compared with all traffic. Tell me how it performs (visitors, bounce, conversion), which landing pages and campaigns work for it, watch a few of its sessions (list_replays with that filter), and what to change.`;
  return [
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-title' },
        h(
          'a',
          { class: 'back-link', href: href(isSource ? 'reports/marketing' : 'reports') },
          '← Reports',
        ),
        h('h1', {}, shown || '(none)'),
        h(
          'p',
          { class: 'muted' },
          visitLevel
            ? `${label} · whole visits ${property === 'path' ? 'that viewed this page' : 'that came from here'}, in the selected period`
            : `${label} · everything about this segment in the selected period`,
        ),
      ),
      h(
        'div',
        { class: 'page-actions' },
        h(
          'a',
          { class: 'button ghost small', href: reportsFilteredBy(filterProperty, value, isSource) },
          icon('filter', 14),
          'Filter all reports',
        ),
        h(
          'a',
          {
            class: 'button ghost small',
            href: href('replays', {
              filters: JSON.stringify([{ property: filterProperty, value }]),
            }),
          },
          icon('replay', 14),
          'Watch sessions',
        ),
        copyButton(prompt, 'Ask an agent', 'bot'),
      ),
    ),
    later(
      async () => {
        const [r, all] = await Promise.all([
          api.post<Result>('/api/query', { kind: 'web', ...sc, filters }),
          api.post<Result>('/api/query', {
            kind: 'web',
            ...sc,
            filters: apiFilters(),
            compare: false,
          }),
        ]);
        if (r.totals.pageviews === 0)
          return empty(
            `No pageviews where ${label.toLowerCase()} is ${value} in this period.`,
            undefined,
            { icon: 'search', title: 'No traffic' },
          );
        const share = all.totals.visitors ? r.totals.visitors / all.totals.visitors : 0;
        const selected = metric();
        const vs = (now: number, base: number, lowerIsBetter = false) => {
          if (!base) return null;
          const diff = (now - base) / base;
          if (Math.abs(diff) < 0.05) return h('span', { class: 'muted' }, 'about average');
          const good = diff > 0 !== lowerIsBetter;
          return h(
            'span',
            { class: good ? 'good-text' : 'bad-text' },
            `${diff > 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(0)}% vs all traffic`,
          );
        };
        const breakdowns: [
          string,
          IconName,
          { key: WebBreakdown; label: string }[],
          [string, string, string?],
        ][] = [
          [
            'Landing pages',
            'external',
            [
              { key: 'entry_pages', label: 'Entry' },
              { key: 'pages', label: 'Top' },
              { key: 'exit_pages', label: 'Exit' },
            ],
            ['Page', 'Visitors', 'Visits'],
          ],
          ...(property === 'utm_source' || property === 'utm_medium' || property === 'utm_campaign'
            ? ([
                [
                  'Campaign tags',
                  'megaphone',
                  [
                    { key: 'utm_campaign', label: 'Campaign' },
                    { key: 'utm_medium', label: 'Medium' },
                    { key: 'utm_source', label: 'Source' },
                  ].filter((o) => o.key !== property),
                  ['Value', 'Visitors', 'Visits'],
                ],
              ] as typeof breakdowns)
            : property !== 'referrer_host'
              ? ([
                  [
                    'Referrers',
                    'external',
                    [{ key: 'referrers', label: 'Referrers' }],
                    ['Referrer', 'Visitors', 'Visits'],
                  ],
                ] as typeof breakdowns)
              : []),
          [
            'Locations',
            'globe',
            [{ key: 'countries', label: 'Countries' }],
            ['Country', 'Visitors', 'Views'],
          ],
          [
            'Devices',
            'monitor',
            [
              { key: 'devices', label: 'Device' },
              { key: 'browsers', label: 'Browser' },
              { key: 'os', label: 'OS' },
            ],
            ['Device', 'Visitors', 'Views'],
          ],
        ];
        return [
          h(
            'div',
            { class: 'segment-compare' },
            h(
              'div',
              {},
              h('strong', {}, percent(share, 1)),
              h(
                'span',
                { class: 'muted' },
                ` of all visitors (${count(r.totals.visitors)} of ${count(all.totals.visitors)})`,
              ),
            ),
            h(
              'div',
              {},
              h('span', { class: 'muted' }, 'Bounce rate '),
              h('strong', {}, percent(r.totals.bounceRate, 0)),
              ' ',
              vs(r.totals.bounceRate, all.totals.bounceRate, true),
            ),
            h(
              'div',
              {},
              h('span', { class: 'muted' }, 'Session length '),
              h('strong', {}, duration(r.totals.avgSessionSeconds)),
              ' ',
              vs(r.totals.avgSessionSeconds, all.totals.avgSessionSeconds),
            ),
            h(
              'div',
              {},
              h('span', { class: 'muted' }, 'Views per session '),
              h('strong', {}, decimal(r.totals.viewsPerSession, 1)),
              ' ',
              vs(r.totals.viewsPerSession, all.totals.viewsPerSession),
            ),
          ),
          kpis(r, setMetric, selected),
          later(
            async () => keyEventTiles(await fetchConversions(filters)),
            'Loading key events',
            'kpis',
          ),
          mainChart(r, selected),
          h(
            'div',
            { class: 'grid-2' },
            ...breakdowns.map(([title, ic, options, headers]) =>
              breakdownPanel(r, title, ic, options, headers),
            ),
          ),
          h(
            'div',
            { class: 'grid-2' },
            breakdownPanel(
              r,
              'JavaScript errors',
              'alert',
              [{ key: 'errors', label: 'Errors' }],
              ['Message', 'Times', 'Visitors'],
            ),
            vitalsPanel(r),
          ),
        ];
      },
      'Loading segment',
      'report',
    ),
  ];
}

const TAB_COPY: Record<ReportTab, string> = {
  web: 'Traffic, key events, pages, locations and devices. Click any row for its full report.',
  marketing: 'Where visitors come from and which channels, sources and campaigns convert.',
  health:
    'Whether the site is broken or slow: errors, broken pages, frustration and Core Web Vitals.',
};

function parseTab(rest: string[]): ReportTab {
  const raw = rest[0] ?? 'web';
  return raw === 'marketing' || raw === 'health' || raw === 'web' ? raw : 'web';
}

export function webPage(route: Route): Node[] {
  if (route.rest[0] === 'segment') return segmentPage(route);
  const tab = parseTab(route.rest);
  const sc = scope();
  const prompts =
    tab === 'marketing'
      ? promptStrip('marketing', 'Ask your coding agent', MARKETING_PROMPTS)
      : tab === 'health'
        ? promptStrip('health', 'Ask your coding agent', HEALTH_PROMPTS)
        : promptStrip('home', 'Ask your coding agent', HOME_PROMPTS);
  return [
    pageHeader('Reports', TAB_COPY[tab], [
      h(
        'a',
        { class: 'button small', href: href('sites', { project: sc.project }) },
        'Pageview rankings',
      ),
      tabs(
        [
          { value: 'web', label: 'Web', icon: 'globe' },
          { value: 'marketing', label: 'Marketing', icon: 'megaphone' },
          { value: 'health', label: 'Health', icon: 'gauge' },
        ],
        tab,
        (next) => go(next === 'web' ? 'reports' : `reports/${next}`),
      ),
    ]),
    filterChips() ?? h('span', {}),
    prompts ?? h('span', {}),
    later(
      async () => {
        const r = await api.post<Result>('/api/query', {
          kind: 'web',
          ...sc,
          filters: apiFilters(),
        });
        if (r.totals.pageviews === 0 && !r.previous?.pageviews) {
          return empty(
            'Add the script tag to your site, then visit a page. Numbers appear within seconds.',
            h(
              'a',
              { class: 'button primary', href: '#/settings' },
              icon('code', 14),
              'Show the install snippet',
            ),
            {
              icon: 'reports',
              title: 'No pageviews yet',
            },
          );
        }
        if (tab === 'marketing') return marketingReport(r);
        if (tab === 'health') return healthReport(r);
        return webReport(r);
      },
      'Loading reports',
      'report',
    ),
  ];
}
