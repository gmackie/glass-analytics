import type { coverageTotals, runCoverage } from '@dataflare/core/insights/coverage';
import { api } from '../api.ts';
import { later, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { href, scope } from '../state.ts';

type Projects = Awaited<ReturnType<typeof runCoverage>>;
const actions: Record<Projects[number]['status'], string> = {
  'Marked action observed': 'Check the marked actions against the app’s main workflow.',
  'Custom events to review':
    'Review the event description and emitting code. Mark verified product actions as important or conversion.',
  'Operational probes only among custom events':
    'Exercise a product workflow and check for its success event.',
  'System events only':
    'Run a known product action and compare its event with the app’s tracking call.',
  'No observed traffic':
    'Check the selected dates and the last known successful visit before investigating the loader.',
};

export function coveragePanel(project: string | null) {
  return later(
    async () => {
      const { from, to } = scope();
      const { projects, totals } = await api.get<{
        projects: Projects;
        totals: ReturnType<typeof coverageTotals>;
      }>('/api/instrumentation', {
        project,
        from,
        to,
      });
      const app = projects[0];
      if (project && app)
        return panel('Product instrumentation', [
          h('p', {}, app.status, ' · ', actions[app.status]),
          h(
            'p',
            {},
            app.configured
              ? `${app.configured} marked product signals`
              : 'No custom product signal marked important or conversion.',
          ),
          table(
            ['Event', 'Observed', 'Evidence', 'Role', 'Description', 'Saved funnels'],
            app.events.map((e) => [
              h('a', { href: href(`events/${encodeURIComponent(e.event)}`, { project }) }, e.event),
              String(e.count),
              e.kind,
              e.role || '—',
              e.description || '—',
              e.funnels.join(', ') || '—',
            ]),
          ),
        ]);
      return panel('Product instrumentation', [
        h(
          'p',
          {},
          `${totals.registered} registered · ${totals.active} active · ${totals.custom} with custom events · ${totals.systemOnly} system only · ${totals.quiet} quiet`,
        ),
        table(
          ['Project', 'Observed evidence', 'Marked signals', 'Saved funnel steps'],
          projects.map((p) => [
            h(
              'a',
              { href: href('sites', { project: p.project, view: 'instrumentation' }) },
              p.project,
            ),
            p.status,
            String(p.configured),
            String(p.events.filter((e) => e.funnels.length > 0).length),
          ]),
        ),
      ]);
    },
    'Loading instrumentation coverage',
    'table',
  );
}
