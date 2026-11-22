/**
 * Revenue: money in (gross, refunds, net), recurring revenue (MRR and what moved
 * it), churn and LTV, revenue by product or first-touch source, and the top
 * customers or accounts. Reads revenue events and Stripe.
 */

import { api } from '../api.ts';
import { kpiStat, lineChart } from '../components/charts.ts';
import { selectMenu } from '../components/menu.ts';
import { empty, later, pageHeader, panel, table, tabs } from '../components/ui.ts';
import { type Child, h } from '../dom.ts';
import { ago, bucketLabel, percent } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface Period {
  gross: number;
  refunds: number;
  net: number;
  orders: number;
  customers: number;
  arpu: number;
  mrr: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnedMrr: number;
  reactivatedMrr: number;
  netNewMrr: number;
  revenueChurn: number;
}

interface RevenueResult {
  currency: string;
  interval: string;
  buckets: number[];
  periods: Period[];
  totals: {
    gross: number;
    refunds: number;
    net: number;
    orders: number;
    customers: number;
    arpu: number;
    mrr: number;
    arr: number;
    netNewMrr: number;
    revenueChurn: number | null;
    ltv: number | null;
  };
  breakdown: {
    by: string;
    values: { value: string; net: number; customers: number; series: number[] }[];
  } | null;
  topCustomers: { actor: string; net: number; orders: number; mrr: number; lastAt: string }[];
  unconverted: number;
  summary: string;
  sql: string[];
}

const BREAKDOWNS = [
  { value: '', label: 'No breakdown' },
  { value: 'product', label: 'Product' },
  { value: 'channel', label: 'First-touch channel' },
  { value: 'utm_source', label: 'First-touch UTM source' },
  { value: 'utm_campaign', label: 'First-touch UTM campaign' },
  { value: 'country', label: 'Country' },
];

type GroupType = { type: string; plural: string };

/** Money formatters for one currency. */
function moneyFormats(currency: string) {
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
    }).format(n === 0 ? 0 : n);
  return {
    money,
    /** A loss shown with a minus (and no "-£0.00"). */
    loss: (n: number) => (n === 0 ? '–' : money(-Math.abs(n))),
    /** Table cells: a dash for nothing. */
    cell: (n: number) => (n === 0 ? '–' : money(n)),
    /** Chart axes: whole amounts. */
    axis: (n: number) =>
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(n),
  };
}
type Money = ReturnType<typeof moneyFormats>;

interface RevenueView {
  r: RevenueResult;
  m: Money;
  who: string;
  aggregateBy: string;
}

function revenueControls(
  interval: string,
  breakdown: string,
  aggregateBy: string,
  types: GroupType[],
  set: (k: string, v: string | null) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'toolbar' },
    tabs(
      [
        { value: 'day', label: 'Day' },
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
      ],
      interval,
      (v) => set('interval', v === 'month' ? null : v),
    ),
    selectMenu({
      label: 'Breakdown',
      value: breakdown,
      options: BREAKDOWNS,
      onChange: (v) => set('breakdown', v || null),
    }),
    selectMenu({
      label: 'Customers are',
      value: aggregateBy,
      options: [
        { value: 'person', label: 'People' },
        ...types.map((t) => ({ value: t.type, label: t.plural })),
      ],
      onChange: (v) => set('by', v === 'person' ? null : v),
    }),
  );
}

function noRevenue(): HTMLElement {
  return empty(
    'Tell Dataflare which events carry money (Settings › Revenue: event, amount and currency properties), or connect Stripe.',
    h(
      'a',
      { class: 'button primary', href: href('settings', { tab: 'revenue' }) },
      'Set up revenue',
    ),
    { icon: 'dollar', title: 'No revenue in this range' },
  );
}

function revenueStats({ r, m, who }: RevenueView): HTMLElement {
  const t = r.totals;
  const { money } = m;
  return h(
    'div',
    { class: 'stats stats-panel' },
    kpiStat(
      'Net revenue',
      money(t.net),
      `${money(t.gross)} gross${t.refunds ? `, ${money(-t.refunds)} refunded` : ''}`,
    ),
    kpiStat('MRR', money(t.mrr), `ARR ${money(t.arr)}`),
    kpiStat('Net new MRR', `${t.netNewMrr >= 0 ? '+' : ''}${money(t.netNewMrr)}`),
    kpiStat(who, String(t.customers), `${t.orders} payments`),
    kpiStat('ARPU', money(t.arpu)),
    kpiStat(
      'Revenue churn',
      t.revenueChurn === null ? '—' : `${percent(t.revenueChurn)}/mo`,
      t.ltv ? `LTV ${money(t.ltv)}` : null,
    ),
  );
}

function periodLabel(r: RevenueResult, i: number): string {
  const at = r.buckets[i]!;
  if (r.interval !== 'month') return bucketLabel(at, r.interval);
  return new Date(at).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function mrrMovementPanel({ r, m }: RevenueView): HTMLElement {
  const periods = r.periods;
  const signed = (n: number) => (n === 0 ? '–' : `${n > 0 ? '+' : ''}${m.money(n)}`);
  return panel(
    'What moved MRR',
    [
      lineChart(
        r.buckets,
        [
          { label: 'New', values: periods.map((x) => x.newMrr) },
          { label: 'Expansion', values: periods.map((x) => x.expansionMrr) },
          { label: 'Reactivated', values: periods.map((x) => x.reactivatedMrr) },
          { label: 'Contraction', values: periods.map((x) => x.contractionMrr) },
          { label: 'Churned', values: periods.map((x) => x.churnedMrr) },
        ],
        r.interval,
        { type: 'bar', format: m.axis, height: 200 },
      ),
      table(
        ['Period', 'New', 'Expansion', 'Reactivated', 'Contraction', 'Churned', 'Net new', 'Churn'],
        periods.map((x, i) => [
          h('span', { class: 'nowrap' }, periodLabel(r, i)),
          m.cell(x.newMrr),
          m.cell(x.expansionMrr),
          m.cell(x.reactivatedMrr),
          m.loss(x.contractionMrr),
          m.loss(x.churnedMrr),
          signed(x.netNewMrr),
          x.revenueChurn ? percent(x.revenueChurn) : '–',
        ]),
        { numeric: [1, 2, 3, 4, 5, 6, 7] },
      ),
    ],
    { icon: 'retention' },
  );
}

function revenueCharts({ r, m }: RevenueView): HTMLElement[] {
  const periods = r.periods;
  return [
    panel(
      'Revenue',
      lineChart(
        r.buckets,
        [
          { label: 'Net revenue', values: periods.map((x) => x.net) },
          { label: 'Refunds', values: periods.map((x) => Math.abs(x.refunds)) },
        ],
        r.interval,
        { type: 'bar', format: m.axis, height: 220 },
      ),
      { icon: 'dollar', subtitle: r.summary, sql: r.sql },
    ),
    panel(
      'MRR',
      lineChart(r.buckets, [{ label: 'MRR', values: periods.map((x) => x.mrr) }], r.interval, {
        type: 'area',
        format: m.axis,
        height: 200,
      }),
      { icon: 'insights', subtitle: 'At the end of each period' },
    ),
  ];
}

function breakdownPanel({ r, m, who }: RevenueView): HTMLElement | null {
  const b = r.breakdown;
  if (!b) return null;
  return panel(
    `By ${b.by}`,
    [
      lineChart(
        r.buckets,
        b.values.slice(0, 6).map((v) => ({ label: v.value, values: v.series })),
        r.interval,
        { type: 'bar', format: m.axis, height: 200 },
      ),
      table(
        ['Value', 'Net revenue', who],
        b.values.map((v) => [v.value, m.money(v.net), String(v.customers)]),
        { numeric: [1, 2] },
      ),
    ],
    { icon: 'filter' },
  );
}

function topCustomersPanel({ r, m, who, aggregateBy }: RevenueView): HTMLElement {
  const link = (actor: string) =>
    aggregateBy === 'person'
      ? href(`users/${encodeURIComponent(actor)}`)
      : href(`groups/${encodeURIComponent(aggregateBy)}/${encodeURIComponent(actor)}`);
  return panel(
    `Top ${who.toLowerCase()}`,
    table(
      [who.replace(/s$/, ''), 'Net revenue', 'Payments', 'MRR now', 'Last payment'],
      r.topCustomers.map((c) => [
        h('a', { href: link(c.actor) }, c.actor),
        m.money(c.net),
        String(c.orders),
        m.cell(c.mrr),
        h('span', { class: 'nowrap' }, ago(c.lastAt)),
      ]),
      { numeric: [1, 2, 3] },
    ),
    { icon: 'users' },
  );
}

const hasNoRevenue = (r: RevenueResult) =>
  r.totals.net === 0 && r.totals.mrr === 0 && r.periods.every((x) => x.mrr === 0);

async function revenueView(p: URLSearchParams): Promise<Child[]> {
  const interval = (p.get('interval') ?? 'month') as 'day' | 'week' | 'month';
  const breakdown = p.get('breakdown') ?? '';
  const aggregateBy = p.get('by') ?? 'person';
  const set = (k: string, v: string | null) => go('revenue', { ...Object.fromEntries(p), [k]: v });
  const { from, to, project } = scope();
  const [types, r] = await Promise.all([
    api.get<{ types: GroupType[] }>('/api/groups/types', { project }),
    api.post<RevenueResult>('/api/query', {
      kind: 'revenue',
      project,
      from: p.get('from') ? from : '-6mo',
      to,
      interval,
      ...(breakdown ? { breakdown } : {}),
      ...(aggregateBy !== 'person' ? { aggregateBy } : {}),
    }),
  ]);
  const controls = revenueControls(interval, breakdown, aggregateBy, types.types, set);
  if (hasNoRevenue(r)) return [controls, noRevenue()];
  const who =
    aggregateBy === 'person'
      ? 'Customers'
      : (types.types.find((x) => x.type === aggregateBy)?.plural ?? aggregateBy);
  const view: RevenueView = { r, m: moneyFormats(r.currency), who, aggregateBy };
  return [
    controls,
    revenueStats(view),
    ...revenueCharts(view),
    mrrMovementPanel(view),
    breakdownPanel(view),
    topCustomersPanel(view),
    r.unconverted
      ? h(
          'p',
          { class: 'muted small' },
          `${r.unconverted} payments had no exchange rate for their currency and are left out.`,
        )
      : null,
  ];
}

export function revenuePage(route: Route): Node[] {
  return [
    pageHeader(
      'Revenue',
      'Payments, refunds and recurring revenue, from your revenue events and Stripe.',
      h('a', { class: 'button', href: href('settings', { tab: 'revenue' }) }, 'Revenue settings'),
    ),
    later(() => revenueView(route.params), 'Loading revenue'),
  ];
}
