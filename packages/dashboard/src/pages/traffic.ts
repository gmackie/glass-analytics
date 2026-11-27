import type { TrafficResult } from '@dataflare/core/insights/traffic';
import { api } from '../api.ts';
import { dashboardUsage } from '../app-usage.ts';
import { lineChart } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { empty, later, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { count, percent } from '../format.ts';
import { href, type Route, scope } from '../state.ts';

const PAGE_SIZE = 10;
const LABELS = {
  path: ['Most viewed paths', 'Path'],
  project: ['Contributing sites', 'Site'],
  referrer_host: ['Referrers', 'Referrer'],
} as const;

function rankLabel(
  dimension: TrafficResult['dimension'],
  value: string,
  project: string | null,
  path: string | null,
) {
  if (dimension === 'referrer_host') return value || 'Direct / None';
  const next = dimension === 'path' ? { project, path: value } : { project: value, path };
  return h(
    'a',
    { href: href('sites', next), class: 'rank-link' },
    h(dimension === 'path' ? 'code' : 'span', {}, value),
    icon('chevronRight', 13),
  );
}

function ranking(
  result: TrafficResult,
  project: string | null,
  path: string | null,
  offset: number,
) {
  const [title, column] = LABELS[result.dimension];
  const rows = result.ranking.map((row, i) => {
    const share = row.pageviews / result.pageviews;
    return [
      String(offset + i + 1),
      rankLabel(result.dimension, row.value, project, path),
      h(
        'span',
        { class: 'traffic-share' },
        h('meter', { min: 0, max: 1, value: share, 'aria-hidden': 'true' }),
        percent(share, 1),
      ),
      row.pageviews.toLocaleString(),
    ];
  });
  const pageLink = (label: string, start: number) =>
    h(
      'a',
      { class: 'button small', href: href('sites', { project, path, offset: String(start) }) },
      label,
    );
  const pager =
    result.hasMore || offset > 0
      ? h(
          'nav',
          { class: 'rank-pager', 'aria-label': 'Ranking pages' },
          offset > 0 ? pageLink('Previous', Math.max(0, offset - PAGE_SIZE)) : null,
          rows.length
            ? h('span', { class: 'muted' }, `${offset + 1}–${offset + rows.length}`)
            : null,
          result.hasMore ? pageLink('Next', offset + PAGE_SIZE) : null,
        )
      : null;
  return panel(
    title,
    [
      rows.length
        ? table(['Rank', column, 'Share', 'Views'], rows, {
            numeric: [0, 2, 3],
            class: 'traffic-ranking',
          })
        : empty(
            offset > 0
              ? 'No more results in this period.'
              : `No ${column.toLowerCase()} data in this period.`,
          ),
      pager,
    ],
    { class: 'traffic-ranks', sql: result.sql.slice(1) },
  );
}

export function trafficPanels(route: Route) {
  const project = route.params.get('project');
  const path = route.params.get('path');
  const start = Number(route.params.get('offset'));
  const offset = Number.isSafeInteger(start) && start > 0 ? start : 0;
  const { from, to } = scope();
  const reportViewed = dashboardUsage.reportResult();
  return later(
    async () => {
      const result = await api.get<TrafficResult>('/api/traffic', {
        project,
        path,
        from,
        to,
        offset,
        limit: PAGE_SIZE,
      });
      if (project && !path) reportViewed('overview', result.pageviews > 0);
      return h(
        'div',
        { class: 'traffic-grid' },
        panel(
          'Pageviews',
          [
            h('strong', { class: 'traffic-total' }, result.pageviews.toLocaleString()),
            lineChart(
              result.buckets,
              [{ label: 'Pageviews', values: result.series }],
              result.interval,
              { type: 'area', height: 230, legend: false, format: count },
            ),
          ],
          { class: 'traffic-chart', sql: result.sql.slice(0, 1) },
        ),
        ranking(result, project, path, offset),
      );
    },
    'Loading pageviews',
    'table',
  );
}
