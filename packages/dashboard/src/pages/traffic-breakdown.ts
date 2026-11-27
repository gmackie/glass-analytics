import type { TrafficBreakdown } from '@dataflare/core/insights/traffic-breakdown';
import { api } from '../api.ts';
import { barList, lineChart } from '../components/charts.ts';
import { pieChart } from '../components/display.ts';
import { empty, later, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { duration } from '../format.ts';
import { href, scope } from '../state.ts';

const exact = (n: number) => n.toLocaleString();
const detail = (label: string, body: HTMLElement) =>
  h('details', { class: 'traffic-detail' }, h('summary', {}, label), body);
const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function hourlyPanel(r: TrafficBreakdown) {
  return panel(
    'Pageviews by hour',
    [
      r.hourly.some((n) => n > 0)
        ? lineChart(
            r.hourly.map((_, i) => i),
            [{ label: 'Pageviews', values: r.hourly }],
            'hour',
            { type: 'bar', labels: HOURS, height: 195, format: exact },
          )
        : empty('No tracked pageviews in this period.'),
      detail(
        'Hourly counts',
        table(
          ['Hour', 'Pageviews'],
          r.hourly.map((n, i) => [HOURS[i]!, exact(n)]),
          { numeric: [1] },
        ),
      ),
    ],
    { subtitle: `Hour of day · ${r.timezone}`, sql: r.sql.slice(0, 1) },
  );
}

function heatmapRow(day: string, values: number[], max: number) {
  return h(
    'tr',
    {},
    h('th', { scope: 'row', title: day, 'aria-label': day }, day.slice(0, 3)),
    values.map((n, hour) =>
      h(
        'td',
        {
          title: `${day} ${HOURS[hour]} · ${exact(n)} pageviews`,
          style: `--heat:${Math.round(Math.sqrt(n / max) * 85)}%`,
        },
        h('span', {}, exact(n)),
      ),
    ),
  );
}

function heatmapPanel(r: TrafficBreakdown) {
  const max = Math.max(...r.weekdayHourly.flat());
  const heatmap = max
    ? h(
        'div',
        { class: 'traffic-heatmap' },
        h(
          'div',
          { class: 'heatmap-toolbar' },
          h('label', {}, h('input', { type: 'checkbox', class: 'heatmap-toggle' }), 'Show counts'),
          h(
            'span',
            { class: 'heatmap-scale' },
            'Fewer',
            h('span', { class: 'heatmap-ramp', 'aria-hidden': 'true' }),
            'More',
          ),
        ),
        h(
          'div',
          { class: 'heatmap-scroll', role: 'region', 'aria-label': 'Traffic heatmap', tabindex: 0 },
          h(
            'table',
            { 'aria-label': 'Pageviews by weekday and hour' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, 'Day'),
                HOURS.map((label) => h('th', { scope: 'col', title: label }, label.slice(0, 2))),
              ),
            ),
            h(
              'tbody',
              {},
              r.weekdayHourly.map((row, i) => heatmapRow(DAYS[i]!, row, max)),
            ),
          ),
        ),
      )
    : empty('No tracked pageviews in this period.');
  return panel('Pageviews by weekday and hour', heatmap, {
    class: 'traffic-heatmap-panel',
    subtitle: `Total pageviews in the selected period · ${r.timezone}`,
    sql: r.sql.slice(0, 1),
  });
}

function sessionPanel(r: TrafficBreakdown, fleet: boolean) {
  const s = r.sessions;
  const bands = ['No elapsed time', 'Under 1 min', '1 to under 5 min', '5 min or more'];
  return panel(
    'Average session duration',
    [
      s.averageSeconds === null
        ? empty('No sessions with a pageview in this period.')
        : [
            h(
              'div',
              { class: 'session-average' },
              h('strong', {}, duration(s.averageSeconds)),
              h(
                'span',
                { class: 'muted' },
                `across ${exact(s.count)} ${s.count === 1 ? 'session' : 'sessions'}`,
              ),
            ),
            barList(
              s.bands.map((value, i) => ({ label: bands[i]!, value })),
              ['Observed duration', 'Sessions'],
              { format: exact },
            ),
          ],
      fleet && s.sites.length
        ? detail(
            'Compare sessions by site',
            table(
              ['Site', 'Sessions', 'Average duration'],
              s.sites.map((site) => [
                h('a', { href: href('sites', { project: site.project }) }, site.project),
                exact(site.count),
                site.averageSeconds === null ? '—' : duration(site.averageSeconds),
              ]),
              { numeric: [1, 2] },
            ),
          )
        : null,
    ],
    {
      subtitle: 'Time between the first and last pageview or page leave in the period.',
      sql: r.sql.slice(1),
    },
  );
}

function visitorPanel(r: TrafficBreakdown) {
  const v = r.visitors;
  const start = new Date(v.collectionStarted).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const slices = [
    { label: 'Likely human', value: v.likelyHuman, color: 'var(--accent)' },
    { label: 'Known bot', value: v.knownBot ?? 0, color: 'var(--series-amber)' },
    { label: 'Unclassified', value: v.unclassified, color: 'var(--smoke)' },
  ];
  const note =
    Date.parse(r.range.from) < Date.parse(v.collectionStarted)
      ? `Bot counting began ${start} (UTC). Older pageviews, imports and unfamiliar clients are unclassified.`
      : 'Recognized browser user agents count as likely human. Imports and unfamiliar clients are unclassified.';
  return panel(
    'Human and bot traffic',
    [
      slices.some((x) => x.value > 0)
        ? pieChart(v.knownBot === null ? slices.filter((x) => x.value > 0) : slices, exact, 3, true)
        : empty(
            v.knownBot === null
              ? 'No visitor classification for this period.'
              : 'No submitted pageviews in this period.',
          ),
      h('p', { class: 'muted' }, note),
    ],
    { subtitle: 'Submitted pageviews, including detected bots filtered at collection.' },
  );
}

function devicePanel(r: TrafficBreakdown) {
  const slices = [
    { label: 'Desktop', value: r.devices.desktop, color: 'var(--accent)' },
    { label: 'Mobile', value: r.devices.mobile, color: 'var(--series-violet)' },
    { label: 'Tablet', value: r.devices.tablet, color: 'var(--series-cyan)' },
    { label: 'Other / unknown', value: r.devices.other, color: 'var(--smoke)' },
  ];
  return panel(
    'Devices',
    slices.some((x) => x.value > 0)
      ? pieChart(slices, exact, 4, true)
      : empty('No device data in this period.'),
    { subtitle: 'Share of tracked pageviews.' },
  );
}

export function trafficBreakdownPanels(project: string | null): HTMLElement {
  const { from, to } = scope();
  return later(
    async () => {
      const r = await api.get<TrafficBreakdown>('/api/traffic/breakdown', { project, from, to });
      return h(
        'div',
        { class: 'grid-2 traffic-breakdown' },
        hourlyPanel(r),
        sessionPanel(r, project === null),
        heatmapPanel(r),
        visitorPanel(r),
        devicePanel(r),
      );
    },
    'Loading traffic breakdowns',
    'table',
  );
}
