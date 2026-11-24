/**
 * All sites: every project side by side, so a deployment that tracks several
 * sites shows which are gaining or losing traffic, and which stopped sending
 * pageviews.
 * Traffic rankings drill into exact paths and their contributing sites.
 */

import type {
  SiteRow as Site,
  SitesResult as Sites,
  SiteTrend as Trend,
} from '@dataflare/core/insights/sites';
import { api } from '../api.ts';
import { sparkline } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { empty, later, pageHeader, panel, table, tabs } from '../components/ui.ts';
import { h } from '../dom.ts';
import { ago, change, count } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';
import { trafficPanels } from './traffic.ts';
import { trafficBreakdownPanels } from './traffic-breakdown.ts';

type Sort = 'traffic' | 'change';

const TREND: Record<Trend, { label: string; class: string; title: string }> = {
  up: { label: 'Gaining', class: 'good', title: 'Visitors up 20% or more vs the previous period' },
  down: {
    label: 'Losing',
    class: 'bad',
    title: 'Visitors down 20% or more vs the previous period',
  },
  steady: { label: 'Steady', class: '', title: 'Within 20% of the previous period' },
  quiet: { label: 'Low traffic', class: 'muted', title: 'Too few visitors to call a trend' },
  new: { label: 'New', class: 'good', title: 'Pageviews this period, none in the previous one' },
  stopped: {
    label: 'Stopped',
    class: 'warn',
    title: 'Pageviews in the previous period, none in this one. Check the tracking tag.',
  },
  none: { label: 'No data', class: 'muted', title: 'No pageviews in either period' },
};

/** Losing and stopped first, then gaining, then the rest; biggest moves first within each. */
const ATTENTION: Record<Trend, number> = {
  stopped: 0,
  down: 1,
  up: 2,
  new: 3,
  steady: 4,
  quiet: 5,
  none: 6,
};

function sorted(sites: Site[], sort: Sort): Site[] {
  if (sort === 'traffic')
    return [...sites].sort(
      (a, b) => b.pageviews - a.pageviews || a.project.localeCompare(b.project),
    );
  return [...sites].sort(
    (a, b) =>
      ATTENTION[a.trend] - ATTENTION[b.trend] ||
      Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) ||
      b.visitors - a.visitors,
  );
}

function delta(now: number, before: number): HTMLElement | string {
  const c = change(now, before);
  if (!c) return now > 0 ? h('span', { class: 'muted' }, 'new') : '';
  return h(
    'span',
    {
      class: `delta ${c.direction === 'flat' ? '' : c.direction === 'up' ? 'good' : 'bad'}`,
      title: `${count(before)} in the previous period`,
    },
    c.direction === 'up'
      ? icon('arrowUp', 12)
      : c.direction === 'down'
        ? icon('arrowDown', 12)
        : null,
    c.text.replace(/^[+−]/, ''),
  );
}

/** Site activity keeps the comparison with the preceding period alongside the path ranking. */
function siteActivity(route: Route): HTMLElement {
  const sc = scope();
  const sort: Sort = route.params.get('sort') === 'change' ? 'change' : 'traffic';
  const order = tabs(
    [
      { value: 'traffic', label: 'Most traffic' },
      { value: 'change', label: 'Needs attention' },
    ],
    sort,
    (next) => go('sites', { project: null, sort: next }),
  );
  return later(
    async () => {
      const r = await api.get<Sites>('/api/sites', { from: sc.from, to: sc.to });
      if (r.sites.length === 0) return empty('No projects yet.');
      const counts = (t: Trend) => r.sites.filter((s) => s.trend === t).length;
      const chips = (['up', 'down', 'stopped', 'new'] as Trend[])
        .filter((t) => counts(t) > 0)
        .map((t) =>
          h(
            'span',
            { class: `site-trend ${TREND[t].class}`, title: TREND[t].title },
            `${counts(t)} ${TREND[t].label.toLowerCase()}`,
          ),
        );
      const rows = sorted(r.sites, sort).map((s) => {
        const t = TREND[s.trend];
        return [
          h(
            'a',
            {
              class: 'site-name',
              href: href('sites', { project: s.project }),
            },
            h(
              'span',
              { class: 'project-mark', 'aria-hidden': 'true' },
              s.project[0]!.toUpperCase(),
            ),
            s.project,
          ),
          h('span', { class: `site-trend ${t.class}`, title: t.title }, t.label),
          h('span', { class: 'site-spark' }, sparkline(s.series, { height: 28 })),
          count(s.visitors),
          delta(s.visitors, s.previous.visitors),
          count(s.pageviews),
          delta(s.pageviews, s.previous.pageviews),
          s.lastPageview
            ? h('span', { class: 'muted', title: s.lastPageview }, ago(s.lastPageview))
            : h('span', { class: 'muted' }, 'never'),
        ];
      });
      return panel(
        'Site activity',
        [
          h(
            'p',
            { class: 'sites-summary' },
            chips,
            h(
              'span',
              { class: 'muted' },
              `${count(r.sites.reduce((n, s) => n + s.visitors, 0))} visitors across ${r.sites.length} sites`,
            ),
          ),
          table(
            [
              'Site',
              'Trend',
              'Visitors over time',
              'Visitors',
              '',
              'Pageviews',
              '',
              'Last pageview',
            ],
            rows,
            { numeric: [3, 4, 5, 6], class: 'sites-table' },
          ),
        ],
        { sql: r.sql, actions: order },
      );
    },
    'Loading sites',
    'table',
  );
}

function trafficLink(label: string, page: string, params: Record<string, string | null>) {
  return h('a', { class: 'button small', href: href(page, params) }, label);
}

export function sitesPage(route: Route): Node[] {
  const project = route.params.get('project');
  const path = route.params.get('path');
  if (!project && !path) {
    return [
      pageHeader('All sites', 'Pageviews across every registered site.'),
      trafficPanels(route),
      trafficBreakdownPanels(null),
      siteActivity(route),
    ];
  }
  const actions = [];
  if (project && path) {
    actions.push(trafficLink('Compare sites for this path', 'sites', { project: null, path }));
    actions.push(trafficLink('Top paths', 'sites', { project }));
    actions.push(
      trafficLink('Explore sessions', 'reports/segment', { project, p: 'path', v: path }),
    );
  } else {
    actions.push(trafficLink('All sites', 'sites', { project: null }));
  }
  if (project) actions.push(trafficLink('Site dashboards', 'dashboards', { project }));
  const description = path
    ? `Pageviews for this path · ${project ?? 'All sites'}`
    : 'Pageviews, sessions and top paths for this site.';
  const content: Node[] = [
    pageHeader(path ?? project!, description, actions),
    trafficPanels(route),
  ];
  if (!path) content.push(trafficBreakdownPanels(project));
  return content;
}
