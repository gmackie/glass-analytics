import type { runProduct } from '@dataflare/core/insights/product';
import { api } from '../api.ts';
import { later, pageHeader, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { href, scope } from '../state.ts';

const percent = (share: number | null) => (share === null ? '—' : `${(100 * share).toFixed(1)}%`);

export function productPage(): Node[] {
  const sc = scope();
  return [
    pageHeader('Product analytics', 'Which features do people use and which do they return to?'),
    later(async () => {
      const r = await api.get<Awaited<ReturnType<typeof runProduct>>>('/api/product', sc);
      const params = { ...sc, project: r.project };
      return panel('Feature adoption', [
        h(
          'p',
          {},
          `Audience: ${r.audience.toLocaleString()} people with a page or screen view or a marked action in this period. Adoption is the share of this audience who used an action.`,
        ),
        h(
          'p',
          {},
          `Repeat use is the share of adopters who used the same action on at least two dates in ${r.timezone} during this period.`,
        ),
        r.actions.length
          ? table(
              ['Action', 'Role', 'Events', 'Adopters', 'Adoption', 'Repeat users', 'Repeat use'],
              r.actions.map((a) => [
                h('a', { href: href(`events/${encodeURIComponent(a.event)}`, params) }, a.event),
                a.role,
                a.volume.toLocaleString(),
                a.adopters.toLocaleString(),
                percent(a.adoptionShare),
                a.repeaters.toLocaleString(),
                percent(a.repeatShare),
              ]),
              { numeric: [2, 3, 4, 5, 6] },
            )
          : h(
              'p',
              {},
              'No marked custom actions. Mark an action as important or conversion in ',
              h('a', { href: href('events', params) }, 'Events'),
              '.',
            ),
      ]);
    }),
  ];
}
