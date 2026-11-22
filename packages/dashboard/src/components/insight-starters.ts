/**
 * Questions to start a new analysis from, filled in with the project's own events: the
 * signup or purchase event is guessed from the names it sends, so a starter runs as soon as
 * it's picked.
 */

import { type CatalogEvent, loadEvents } from '../catalog.ts';
import { h, mount } from '../dom.ts';
import type { Spec } from './insight-rail.ts';

type Kind = 'trends' | 'funnel' | 'retention' | 'paths';

interface Starter {
  title: string;
  spec: Spec;
  display?: string;
}

/** Starters that need an event the project doesn't send come out as null. */
const present = (list: (Starter | null)[]): Starter[] =>
  list.filter((s): s is Starter => s !== null);

const SIGNUP = /sign.?up|register|create.?account|join/i;
const PURCHASE = /purchase|order|checkout|subscri|paid|payment/i;

/** The busiest custom event whose name matches, if any. */
function find(events: CatalogEvent[], re: RegExp): string | null {
  return events.find((e) => !e.event.startsWith('$') && re.test(e.event))?.event ?? null;
}

function trendsStarters(signup: string | null): Starter[] {
  return present([
    {
      title: 'Daily visitors',
      spec: { series: [{ event: '$pageview', math: 'unique_persons' }], interval: 'day' },
    },
    signup
      ? {
          title: `${signup} per week`,
          spec: { series: [{ event: signup, math: 'total' }], interval: 'week' },
        }
      : null,
    {
      title: 'Visitors by country',
      spec: {
        series: [{ event: '$pageview', math: 'unique_persons' }],
        breakdown: ['country'],
        breakdownLimit: 50,
      },
      display: 'world_map',
    },
    {
      title: 'Visitors by browser',
      spec: { series: [{ event: '$pageview', math: 'unique_persons' }], breakdown: ['browser'] },
      display: 'bar_value',
    },
  ]);
}

function funnelStarters(signup: string | null, purchase: string | null): Starter[] {
  const steps = (...events: (string | null)[]) =>
    events.filter((e): e is string => Boolean(e)).map((event) => ({ event }));
  return present([
    signup
      ? { title: `Visit to ${signup}`, spec: { steps: steps('$pageview', signup), window: '7d' } }
      : null,
    purchase
      ? {
          title: `Visit to ${purchase}`,
          spec: { steps: steps('$pageview', signup, purchase), window: '30d' },
        }
      : null,
  ]);
}

function retentionStarters(signup: string | null): Starter[] {
  return present([
    {
      title: 'Do visitors come back?',
      spec: {
        cohortEvent: { event: '$pageview' },
        returnEvent: { event: '$pageview' },
        period: 'week',
        periods: 8,
      },
    },
    signup
      ? {
          title: `Do people who ${signup} keep coming back?`,
          spec: {
            cohortEvent: { event: signup },
            returnEvent: { event: '*' },
            period: 'week',
            periods: 8,
          },
        }
      : null,
  ]);
}

function pathsStarters(signup: string | null): Starter[] {
  return present([
    {
      title: 'Where do visitors go from the home page?',
      spec: { start: { type: 'page', value: '/' }, steps: 5 },
    },
    { title: 'The most common visits', spec: { steps: 5 }, display: 'top' },
    signup
      ? {
          title: `What leads to ${signup}?`,
          spec: { end: { type: 'event', value: signup }, include: { events: true }, steps: 5 },
        }
      : null,
    { title: 'Journeys across visits (7 days)', spec: { steps: 6, boundary: { minutes: 10_080 } } },
  ]);
}

function startersFor(kind: Kind, events: CatalogEvent[]): Starter[] {
  const signup = find(events, SIGNUP);
  const purchase = find(events, PURCHASE);
  if (kind === 'funnel') return funnelStarters(signup, purchase);
  if (kind === 'retention') return retentionStarters(signup);
  if (kind === 'paths') return pathsStarters(signup);
  return trendsStarters(signup);
}

/** A row of questions; picking one replaces the analysis. Empty when none fit the data. */
export function starters(
  kind: Kind,
  project: string | undefined,
  pick: (spec: Spec, display?: string) => void,
): HTMLElement {
  const row = h('div', { class: 'starters' });
  void loadEvents(project).then((events) => {
    const list = startersFor(kind, events);
    if (!list.length) return;
    mount(
      row,
      h('span', { class: 'muted small' }, 'Start from'),
      list.map((s) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            onclick: () => {
              row.remove();
              pick(structuredClone(s.spec), s.display);
            },
          },
          s.title,
        ),
      ),
    );
  });
  return row;
}
