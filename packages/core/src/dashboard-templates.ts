/**
 * Starter dashboards: a few questions most products ask, filled in with the project's own
 * events (the signup and purchase events are asked for, or guessed from the event names).
 */

export interface TemplateTile {
  /** An insight tile: a saved analysis made from this. */
  insight?: {
    name: string;
    kind: 'trends' | 'funnel' | 'retention' | 'paths';
    spec: Record<string, unknown>;
  };
  /** A text tile (Markdown-lite). */
  text?: string;
  width: 3 | 4 | 6 | 12;
  height: 1 | 2;
}

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  /** Events the template needs, by role. */
  needs: ('signup' | 'purchase')[];
  starter?: true;
  tiles: (events: TemplateEvents) => TemplateTile[];
}

export interface TemplateEvents {
  signup?: string;
  purchase?: string;
}

const pageviews = (math: string, extra: Record<string, unknown> = {}) => ({
  series: [{ event: '$pageview', math }],
  interval: 'day',
  ...extra,
});

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'website',
    name: 'Website overview',
    description: 'Visitors, where they come from, what they read, and where they go next.',
    needs: [],
    starter: true,
    tiles: () => [
      {
        insight: { name: 'Daily visitors', kind: 'trends', spec: pageviews('unique_persons') },
        width: 6,
        height: 1,
      },
      {
        insight: { name: 'Pageviews', kind: 'trends', spec: pageviews('total') },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Visitors by source',
          kind: 'trends',
          spec: pageviews('unique_persons', { breakdown: ['referrer_host'], display: 'bar_value' }),
        },
        width: 6,
        height: 2,
      },
      {
        insight: {
          name: 'Visitors by country',
          kind: 'trends',
          spec: pageviews('unique_persons', {
            breakdown: ['country'],
            breakdownLimit: 50,
            display: 'world_map',
          }),
        },
        width: 6,
        height: 2,
      },
      {
        insight: { name: 'Where visitors go', kind: 'paths', spec: { steps: 4 } },
        width: 12,
        height: 2,
      },
    ],
  },
  {
    id: 'acquisition',
    name: 'Acquisition',
    description: 'Referrers, campaigns, and countries behind your pageviews.',
    needs: [],
    starter: true,
    tiles: () => [
      {
        insight: {
          name: 'Pageviews by referrer',
          kind: 'trends',
          spec: pageviews('total', { breakdown: ['referrer_host'], display: 'pie' }),
        },
        width: 6,
        height: 2,
      },
      {
        insight: {
          name: 'Pageviews by country',
          kind: 'trends',
          spec: pageviews('total', {
            breakdown: ['country'],
            breakdownLimit: 50,
            display: 'world_map',
          }),
        },
        width: 6,
        height: 2,
      },
      {
        insight: {
          name: 'Top campaigns',
          kind: 'trends',
          spec: pageviews('total', {
            filters: [{ property: 'utm_campaign', op: 'is_set' }],
            breakdown: ['utm_campaign'],
            display: 'bar_value',
          }),
        },
        width: 12,
        height: 1,
      },
    ],
  },
  {
    id: 'engagement',
    name: 'Engagement',
    description: 'Sessions, device mix, popular pages, and visitor journeys.',
    needs: [],
    starter: true,
    tiles: () => [
      {
        insight: {
          name: 'Sessions over time',
          kind: 'trends',
          spec: pageviews('unique_sessions', {
            filters: [{ property: 'session_id', op: 'is_set' }],
            display: 'area',
          }),
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Pageviews by device',
          kind: 'trends',
          spec: pageviews('total', { breakdown: ['device'], display: 'pie' }),
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Most viewed pages',
          kind: 'trends',
          spec: pageviews('total', { breakdown: ['path'], display: 'bar_value' }),
        },
        width: 6,
        height: 2,
      },
      {
        insight: { name: 'Top visitor journeys', kind: 'paths', spec: { steps: 4 } },
        width: 6,
        height: 2,
      },
    ],
  },
  {
    id: 'product',
    name: 'Product health',
    description: 'Active users, signups, how many convert and how many come back.',
    needs: ['signup'],
    tiles: (e) => [
      {
        insight: { name: 'Daily active users', kind: 'trends', spec: pageviews('dau') },
        width: 4,
        height: 1,
      },
      {
        insight: { name: 'Weekly active users', kind: 'trends', spec: pageviews('wau') },
        width: 4,
        height: 1,
      },
      {
        insight: {
          name: `${e.signup} per day`,
          kind: 'trends',
          spec: { series: [{ event: e.signup, math: 'total' }], interval: 'day' },
        },
        width: 4,
        height: 1,
      },
      {
        insight: {
          name: 'Visit to signup',
          kind: 'funnel',
          spec: { steps: [{ event: '$pageview' }, { event: e.signup }], window: '7d' },
        },
        width: 6,
        height: 2,
      },
      {
        insight: {
          name: 'Do new users come back?',
          kind: 'retention',
          spec: {
            cohortEvent: { event: e.signup },
            returnEvent: { event: '$pageview' },
            period: 'week',
            periods: 8,
          },
        },
        width: 6,
        height: 2,
      },
    ],
  },
  {
    id: 'revenue',
    name: 'Revenue',
    description: 'Purchases over time, who buys, and the way there.',
    needs: ['purchase'],
    tiles: (e) => [
      {
        insight: {
          name: 'Purchases per week',
          kind: 'trends',
          spec: { series: [{ event: e.purchase, math: 'total' }], interval: 'week' },
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Buyers per week',
          kind: 'trends',
          spec: { series: [{ event: e.purchase, math: 'unique_persons' }], interval: 'week' },
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Visit to purchase',
          kind: 'funnel',
          spec: { steps: [{ event: '$pageview' }, { event: e.purchase }], window: '14d' },
        },
        width: 6,
        height: 2,
      },
      {
        insight: {
          name: `What leads to ${e.purchase}`,
          kind: 'paths',
          spec: { end: { type: 'event', value: e.purchase }, include: { events: true }, steps: 5 },
        },
        width: 6,
        height: 2,
      },
    ],
  },
  {
    id: 'errors',
    name: 'Errors',
    description: 'Exceptions over time and who they hit.',
    needs: [],
    tiles: () => [
      {
        insight: {
          name: 'Exceptions per day',
          kind: 'trends',
          spec: { series: [{ event: '$exception', math: 'total' }], interval: 'day' },
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'People with errors',
          kind: 'trends',
          spec: { series: [{ event: '$exception', math: 'unique_persons' }], interval: 'day' },
        },
        width: 6,
        height: 1,
      },
      {
        insight: {
          name: 'Exceptions by browser',
          kind: 'trends',
          spec: {
            series: [{ event: '$exception', math: 'total' }],
            breakdown: ['browser'],
            display: 'bar_value',
          },
        },
        width: 12,
        height: 2,
      },
      {
        text: 'Issues, stack traces and replays are on the **Errors** page.',
        width: 12,
        height: 1,
      },
    ],
  },
];

const SIGNUP = /sign.?up|register|create.?account|join/i;
const PURCHASE = /purchase|order|checkout|subscri|paid|payment/i;

/** The busiest custom events that look like a signup and a purchase (events by volume). */
export function guessEvents(events: string[]): TemplateEvents {
  const custom = events.filter((e) => !e.startsWith('$'));
  return {
    signup: custom.find((e) => SIGNUP.test(e)),
    purchase: custom.find((e) => PURCHASE.test(e)),
  };
}

/** The template's tiles with the events filled in, or the role still missing. */
export function templateTiles(id: string, events: TemplateEvents): TemplateTile[] {
  const t = DASHBOARD_TEMPLATES.find((x) => x.id === id);
  if (!t)
    throw new RangeError(
      `Unknown template "${id}". Use ${DASHBOARD_TEMPLATES.map((x) => x.id).join(', ')}.`,
    );
  const missing = t.needs.find((role) => !events[role]);
  if (missing) throw new TypeError(`The ${t.name} template needs your ${missing} event.`);
  return t.tiles(events);
}
