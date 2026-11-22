/**
 * Revenue end to end: revenue events converted to the base currency at ingest,
 * ECB rates fetched by maintenance, Stripe's signed webhook (customers linked to
 * people, payments, refunds, subscriptions), and revenue in queries, sources and
 * people.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { runMaintenance } from '../src/cron.ts';
import { clearGroupTypeCache } from '../src/ingest.ts';
import { clearRateCache, configureRevenue } from '../src/revenue.ts';
import { D1Store } from '../src/stores/d1.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;
const today = new Date().toISOString().slice(0, 10);

async function setup(settings: Record<string, unknown> = {}) {
  clearGroupTypeCache();
  clearRateCache();
  t = testApp();
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
  await t.json('PATCH', '/api/settings', {
    body: {
      project: 'acme',
      settings: {
        baseCurrency: 'GBP',
        revenueEvents: [
          {
            event: 'order_paid',
            amountProperty: 'amount',
            currencyProperty: 'currency',
            productProperty: 'plan',
          },
        ],
        ...settings,
      },
    },
  });
}

const props = async (event: string) => {
  const { results } = await t.db
    .prepare('SELECT props FROM events WHERE event = ? ORDER BY ts_ms')
    .bind(event)
    .all<{ props: string }>();
  return results.map((r) => JSON.parse(r.props) as Record<string, unknown>);
};

describe('revenue at ingest', () => {
  beforeEach(() => setup());

  it('converts revenue events to the base currency with the day’s ECB rates', async () => {
    await t.json('POST', '/api/fx-rates', {
      body: {
        rates: [
          { day: today, currency: 'USD', rate: 1.08 },
          { day: today, currency: 'GBP', rate: 0.84 },
        ],
      },
    });
    await t.ingest([
      wire('order_paid', { props: { amount: 108, currency: 'USD', plan: 'pro' } }),
      wire('order_paid', { props: { amount: 20, currency: 'GBP', plan: 'starter' } }),
      wire('order_paid', { props: { amount: 5, currency: 'CHF' } }),
      wire('$pageview'),
    ]);
    const [usd, gbp, chf] = await props('order_paid');
    assert.deepEqual(
      [usd!.$revenue_base, usd!.$revenue_currency, usd!.$revenue_product],
      [84, 'USD', 'pro'],
    );
    assert.equal(gbp!.$revenue_base, 20);
    assert.equal(chf!.$revenue_unconverted, true);
    const r = await t.json<{
      totals: { net: number; customers: number };
      unconverted: number;
      summary: string;
      currency: string;
      dashboard: string;
    }>('POST', '/api/query', {
      key: READ,
      body: { project: 'acme', kind: 'revenue', from: '-7d', interval: 'week' },
    });
    assert.deepEqual([r.totals.net, r.currency, r.unconverted], [104, 'GBP', 1]);
    // The link opens the Revenue page with the same view.
    const link = new URL(r.dashboard.replace('/app#/', '/'));
    assert.equal(link.pathname, '/revenue');
    assert.equal(link.searchParams.get('interval'), 'week');
    assert.match(r.summary, /^Net revenue £104/);
    assert.match(r.summary, /1 revenue events had no exchange rate/);
  });

  it('fetches ECB rates in maintenance once a project records revenue', async () => {
    const fetched: string[] = [];
    configureRevenue({
      fetch: async (input) => {
        fetched.push(String(input));
        return new Response(
          `<Cube><Cube time='${today}'><Cube currency='USD' rate='1.10'/><Cube currency='GBP' rate='0.85'/></Cube></Cube>`,
        );
      },
    });
    const hour = new Date();
    hour.setUTCMinutes(1, 0, 0);
    await runMaintenance(t.env, new D1Store(t.db), hour.getTime(), { hourly: false });
    assert.match(fetched[0]!, /eurofxref-hist-90d\.xml$/);
    const stored = await t.db.prepare('SELECT COUNT(*) AS n FROM fx_rates').first<{ n: number }>();
    assert.equal(stored?.n, 2);
    // Up to date: nothing fetched; and not in the rest of the hour.
    await runMaintenance(t.env, new D1Store(t.db), hour.getTime() + 60_000, { hourly: false });
    assert.equal(fetched.length, 1);
  });
});

describe('stripe', () => {
  const secret = 'whsec_test';
  beforeEach(() => setup());

  const send = (event: Record<string, unknown>, sign = secret) => {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', sign).update(`${ts}.${body}`).digest('hex');
    return t.call('POST', '/hooks/stripe/acme', {
      key: null,
      body,
      headers: { 'Stripe-Signature': `t=${ts},v1=${sig}` },
    });
  };
  const now = () => Math.floor(Date.now() / 1000) - 60;

  it('connects, verifies signatures, links customers and records revenue and MRR', async () => {
    assert.equal(
      (await send({ id: 'evt_0', type: 'invoice.paid', data: { object: {} } })).status,
      404,
    );
    const connected = await t.json<{ webhookUrl: string; events: string[]; secretsSet: string[] }>(
      'POST',
      '/api/stripe',
      {
        body: { project: 'acme', webhookSecret: secret, groupType: 'company', groupKey: 'account' },
      },
    );
    assert.equal(connected.webhookUrl, 'https://glass.test/hooks/stripe/acme');
    assert.ok(connected.events.includes('invoice.paid'));
    assert.deepEqual(connected.secretsSet, ['webhookSecret']);
    const read = await t.json<Record<string, unknown>>('GET', '/api/stripe?project=acme', {
      key: READ,
    });
    assert.ok(!JSON.stringify(read).includes(secret));
    // Wrong secret: refused.
    assert.equal(
      (await send({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } }, 'whsec_other'))
        .status,
      400,
    );
    // The customer says who they are; then their invoice and subscription follow.
    await send({
      id: 'evt_1',
      type: 'customer.created',
      created: now(),
      data: {
        object: {
          id: 'cus_1',
          email: 'ann@example.com',
          metadata: { dataflare_id: 'user-1', account: 'acme-inc' },
        },
      },
    });
    const paid = await send({
      id: 'evt_2',
      type: 'invoice.paid',
      created: now(),
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          currency: 'gbp',
          amount_paid: 4900,
          lines: { data: [{ price: { product: 'prod_team' } }] },
          status_transitions: { paid_at: now() },
        },
      },
    });
    assert.deepEqual(await paid.json(), { received: true, events: 1 });
    // A Stripe retry of the same event is one payment.
    await send({
      id: 'evt_2b',
      type: 'invoice.paid',
      created: now(),
      data: { object: { id: 'in_1', customer: 'cus_1', currency: 'gbp', amount_paid: 4900 } },
    });
    await send({
      id: 'evt_3',
      type: 'customer.subscription.created',
      created: now(),
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          currency: 'gbp',
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  unit_amount: 4900,
                  recurring: { interval: 'month' },
                  product: 'prod_team',
                },
              },
            ],
          },
        },
      },
    });
    await send({
      id: 'evt_4',
      type: 'charge.refunded',
      created: now(),
      data: {
        object: { id: 'ch_1', customer: 'cus_1', currency: 'gbp', amount_refunded: 900 },
        previous_attributes: { amount_refunded: 0 },
      },
    });
    const [invoice] = await props('$stripe_invoice_paid');
    assert.deepEqual(
      [invoice!.$revenue_base, invoice!.$revenue_product, invoice!.$groups],
      [49, 'prod_team', { company: 'acme-inc' }],
    );
    const { results } = await t.db
      .prepare(
        "SELECT distinct_id, user_id FROM events WHERE event LIKE '$stripe_%' GROUP BY distinct_id, user_id",
      )
      .all();
    assert.deepEqual(
      results.map((r) => ({ ...r })),
      [{ distinct_id: 'user-1', user_id: 'user-1' }],
    );
    const r = await t.json<{
      totals: { gross: number; refunds: number; net: number; mrr: number };
      topCustomers: { actor: string }[];
    }>('POST', '/api/query', {
      key: READ,
      body: { project: 'acme', kind: 'revenue', from: '-30d', aggregateBy: 'company' },
    });
    assert.deepEqual(
      [r.totals.gross, r.totals.refunds, r.totals.net, r.totals.mrr],
      [49, -9, 40, 49],
    );
    assert.equal(r.topCustomers[0]?.actor, 'acme-inc');
    const status = await t.json<{ received: number; customers: { linked: number } }>(
      'GET',
      '/api/stripe?project=acme',
    );
    assert.deepEqual([status.received, status.customers.linked], [4, 1]);
    // The person page shows what they've paid.
    const person = await t.json<{ revenue: { net: number; orders: number } }>(
      'GET',
      '/api/persons/user-1?project=acme',
      { key: READ },
    );
    assert.deepEqual([person.revenue.net, person.revenue.orders], [40, 1]);
  });

  it('matches customers to people by email when asked', async () => {
    await t.json('POST', '/api/stripe', {
      body: { project: 'acme', webhookSecret: secret, linkByEmail: true },
    });
    await t.ingest([
      wire('$identify', {
        distinct_id: 'dev-9',
        user_id: 'user-9',
        props: { $set: { email: 'Bo@Example.com' } },
      }),
    ]);
    await send({
      id: 'evt_c',
      type: 'customer.created',
      created: now(),
      data: { object: { id: 'cus_9', email: 'bo@example.com', metadata: {} } },
    });
    await send({
      id: 'evt_i',
      type: 'invoice.paid',
      created: now(),
      data: { object: { id: 'in_9', customer: 'cus_9', currency: 'gbp', amount_paid: 1000 } },
    });
    const [invoice] = await t.db
      .prepare("SELECT user_id FROM events WHERE event = '$stripe_invoice_paid'")
      .all<{ user_id: string }>()
      .then((r) => r.results);
    assert.equal(invoice?.user_id, 'user-9');
    const row = await t.db
      .prepare('SELECT * FROM stripe_customers')
      .first<Record<string, unknown>>();
    // The customer's email is only ever stored hashed.
    assert.doesNotMatch(JSON.stringify(row), /bo@example\.com/);
  });
});

describe('revenue in reports', () => {
  beforeEach(() => setup());

  it('adds revenue per first-touch source', async () => {
    await t.ingest([
      wire('$pageview', {
        distinct_id: 'a',
        url: 'https://acme.com/?utm_source=newsletter&utm_medium=email',
      }),
      wire('order_paid', { distinct_id: 'a', props: { amount: 30, currency: 'GBP' } }),
      wire('$pageview', { distinct_id: 'b', referrer: 'https://www.google.com/' }),
    ]);
    const r = await t.json<{
      rows: { value: string; revenue: number; revenuePerVisitor: number }[];
    }>('POST', '/api/reports/sources', {
      key: READ,
      body: { project: 'acme', dimension: 'channel' },
    });
    const email = r.rows.find((x) => x.value === 'Email');
    assert.deepEqual([email?.revenue, email?.revenuePerVisitor], [30, 30]);
    assert.equal(r.rows.find((x) => x.value === 'Organic search')?.revenue, 0);
  });
});
