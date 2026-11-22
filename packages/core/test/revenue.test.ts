/**
 * Revenue: exchange rates, normalising revenue at ingest, Stripe signatures and
 * mapping, and the revenue query (sales, MRR movements, churn, LTV, breakdowns,
 * top customers and accounts) on a scenario with known answers.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { convert, fromMinorUnits, parseEcbXml } from '../src/fx.ts';
import { runRevenue } from '../src/insights/revenue.ts';
import { applyRevenue, revenueCurrencies } from '../src/revenue.ts';
import { stripeEvents, subscriptionMrr, verifyStripeSignature } from '../src/stripe.ts';
import { context, createDb, insert } from './helpers.ts';

const ECB = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time='2026-11-17'><Cube currency='USD' rate='1.0800'/><Cube currency='GBP' rate='0.8400'/><Cube currency='JPY' rate='165.20'/></Cube>
<Cube time='2026-11-16'><Cube currency='USD' rate='1.0700'/></Cube></Cube></gesmes:Envelope>`;

describe('exchange rates', () => {
  it('parses the ECB feeds and converts through the euro', () => {
    const rates = parseEcbXml(ECB);
    assert.deepEqual(rates[0], { day: '2026-11-17', currency: 'USD', rate: 1.08 });
    assert.equal(rates.length, 4);
    const day = new Map(
      rates.filter((r) => r.day === '2026-11-17').map((r) => [r.currency, r.rate]),
    );
    assert.equal(convert(108, 'USD', 'EUR', day), 100);
    assert.equal(Math.round(convert(108, 'USD', 'GBP', day)! * 100) / 100, 84);
    assert.equal(convert(5, 'GBP', 'gbp', new Map()), 5);
    assert.equal(convert(5, 'CHF', 'GBP', day), null);
    assert.equal(fromMinorUnits(4999, 'usd'), 49.99);
    assert.equal(fromMinorUnits(500, 'JPY'), 500);
    assert.equal(fromMinorUnits(1234, 'KWD'), 1.234);
  });
});

describe('revenue at ingest', () => {
  const rates = new Map([
    ['USD', 1.08],
    ['GBP', 0.84],
  ]);
  const rules = [
    {
      event: 'order_paid',
      amountProperty: 'amount',
      currencyProperty: 'currency',
      productProperty: 'plan',
    },
    { event: 'order_refunded', amountProperty: 'amount', currency: 'USD', kind: 'refund' as const },
    {
      event: 'renewal',
      amountProperty: 'total',
      subscriptionProperty: 'sub',
      interval: 'year' as const,
    },
  ];

  it('converts revenue events to the base currency', () => {
    assert.deepEqual(
      revenueCurrencies('order_paid', { amount: 10, currency: 'usd' }, rules, 'GBP'),
      ['USD'],
    );
    const paid = applyRevenue(
      'order_paid',
      { amount: 108, currency: 'usd', plan: 'pro' },
      rules,
      'GBP',
      rates,
    )!;
    assert.deepEqual(
      [paid.$revenue_base, paid.$revenue_amount, paid.$revenue_currency, paid.$revenue_product],
      [84, 108, 'USD', 'pro'],
    );
    const refund = applyRevenue('order_refunded', { amount: 10.8 }, rules, 'GBP', rates)!;
    assert.equal(refund.$revenue_base, -8.4);
    assert.equal(applyRevenue('pageview', { amount: 1 }, rules, 'GBP', rates), null);
    const missing = applyRevenue(
      'order_paid',
      { amount: 5, currency: 'CHF' },
      rules,
      'GBP',
      rates,
    )!;
    assert.equal(missing.$revenue_unconverted, true);
    assert.equal(missing.$revenue_base, undefined);
  });

  it('tracks subscriptions from payments, and from Stripe-style state', () => {
    const yearly = applyRevenue('renewal', { total: 1200, sub: 's1' }, rules, 'GBP', rates)!;
    assert.deepEqual(
      [yearly.$subscription_id, yearly.$mrr, yearly.$subscription_status, yearly.$mrr_grace_days],
      ['s1', 100, 'active', 370],
    );
    const state = applyRevenue(
      '$stripe_subscription',
      { $subscription_id: 'sub_1', $mrr_amount: 54, $mrr_currency: 'USD' },
      rules,
      'GBP',
      rates,
    )!;
    assert.deepEqual([state.$mrr, state.$revenue_base], [42, undefined]);
  });
});

describe('stripe', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const now = Date.UTC(2026, 10, 17, 12);
  const t = Math.floor(now / 1000);
  // The signature as Stripe computes it (and its SDKs' test helpers), with Node's own HMAC.
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

  it('verifies webhook signatures', async () => {
    assert.equal(await verifyStripeSignature(`t=${t},v1=${v1}`, body, secret, now), true);
    assert.equal(
      await verifyStripeSignature(`t=${t},v1=deadbeef,v1=${v1}`, body, secret, now),
      true,
    );
    assert.equal(await verifyStripeSignature(`t=${t},v1=${v1}`, `${body} `, secret, now), false);
    assert.equal(await verifyStripeSignature(`t=${t},v1=${v1}`, body, 'whsec_other', now), false);
    assert.equal(
      await verifyStripeSignature(`t=${t},v1=${v1}`, body, secret, now + 600_000),
      false,
    );
    assert.equal(await verifyStripeSignature(null, body, secret, now), false);
  });

  it('turns invoices, charges, refunds and subscriptions into events', () => {
    const customer = { id: 'cus_1', person: 'user-1', group: 'acme' };
    const link = { groupType: 'company' };
    const [invoice] = stripeEvents(
      {
        id: 'evt_inv',
        type: 'invoice.paid',
        created: t,
        data: {
          object: {
            id: 'in_1',
            customer: 'cus_1',
            currency: 'gbp',
            amount_paid: 4999,
            subscription: 'sub_1',
            lines: { data: [{ price: { product: 'prod_pro' } }] },
            status_transitions: { paid_at: t - 60 },
          },
        },
      },
      customer,
      link,
    );
    assert.deepEqual(
      [invoice!.id, invoice!.event, invoice!.distinct_id, invoice!.user_id, invoice!.ts],
      ['stripe_in_1', '$stripe_invoice_paid', 'user-1', 'user-1', (t - 60) * 1000],
    );
    assert.deepEqual(
      [
        invoice!.props?.$revenue_amount,
        invoice!.props?.$revenue_currency,
        invoice!.props?.$revenue_product,
        invoice!.props?.$groups,
      ],
      [49.99, 'GBP', 'prod_pro', { company: 'acme' }],
    );
    // Charges for invoices are counted once, by the invoice.
    assert.deepEqual(
      stripeEvents(
        {
          id: 'e',
          type: 'charge.succeeded',
          created: t,
          data: { object: { invoice: 'in_1', amount: 4999 } },
        },
        customer,
      ),
      [],
    );
    const [refund] = stripeEvents(
      {
        id: 'evt_ref',
        type: 'charge.refunded',
        created: t,
        data: {
          object: { id: 'ch_1', customer: 'cus_1', currency: 'usd', amount_refunded: 1500 },
          previous_attributes: { amount_refunded: 500 },
        },
      },
      null,
    );
    assert.deepEqual(
      [refund!.event, refund!.distinct_id, refund!.props?.$revenue_amount],
      ['$stripe_refund', 'stripe:cus_1', -10],
    );
    const sub = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      currency: 'usd',
      items: {
        data: [
          {
            quantity: 2,
            price: {
              unit_amount: 1000,
              recurring: { interval: 'month', interval_count: 1 },
              product: 'prod_team',
            },
          },
          {
            quantity: 1,
            price: { unit_amount: 12000, recurring: { interval: 'year', interval_count: 1 } },
          },
        ],
      },
      discount: { coupon: { percent_off: 50 } },
    };
    assert.equal(subscriptionMrr(sub), 15); // (2×$10 + $120/12) × 50%
    assert.equal(subscriptionMrr({ ...sub, status: 'trialing' }), 0);
    const [created] = stripeEvents(
      { id: 'evt_sub', type: 'customer.subscription.created', created: t, data: { object: sub } },
      customer,
    );
    assert.deepEqual(
      [
        created!.event,
        created!.props?.$subscription_id,
        created!.props?.$mrr_amount,
        created!.props?.$subscription_status,
      ],
      ['$stripe_subscription', 'sub_1', 15, 'active'],
    );
    const [deleted] = stripeEvents(
      { id: 'evt_del', type: 'customer.subscription.deleted', created: t, data: { object: sub } },
      customer,
    );
    assert.deepEqual(
      [deleted!.props?.$mrr_amount, deleted!.props?.$subscription_status],
      [0, 'canceled'],
    );
  });
});

describe('the revenue query', () => {
  const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
  function scenario() {
    const db = createDb();
    const pay = (who: string, iso: string, amount: number, product: string, company: string) => ({
      event: 'order_paid',
      distinct_id: who,
      ts_ms: at(iso),
      props: { $revenue_base: amount, $revenue_product: product, $groups: { company } },
    });
    const sub = (who: string, iso: string, id: string, mrr: number, company: string) => ({
      event: '$stripe_subscription',
      distinct_id: who,
      ts_ms: at(iso),
      props: {
        $subscription_id: id,
        $mrr: mrr,
        $subscription_status: mrr ? 'active' : 'canceled',
        $groups: { company },
      },
    });
    insert(db, [
      // c subscribed before the range, churned in July, came back in September.
      sub('c', '2026-05-10', 'sub_c', 30, 'globex'),
      sub('c', '2026-07-15', 'sub_c', 0, 'globex'),
      sub('c', '2026-09-05', 'sub_c', 30, 'globex'),
      // a is new in July and upgrades in September; b is new in August and leaves in October.
      sub('a', '2026-07-03', 'sub_a', 100, 'acme'),
      sub('a', '2026-09-10', 'sub_a', 150, 'acme'),
      sub('b', '2026-08-02', 'sub_b', 50, 'acme'),
      sub('b', '2026-10-20', 'sub_b', 0, 'acme'),
      pay('a', '2026-07-03', 100, 'Pro', 'acme'),
      pay('a', '2026-08-03', 100, 'Pro', 'acme'),
      pay('a', '2026-09-10', 150, 'Pro', 'acme'),
      pay('a', '2026-10-10', 150, 'Pro', 'acme'),
      pay('b', '2026-08-02', 50, 'Starter', 'acme'),
      pay('b', '2026-09-02', 50, 'Starter', 'acme'),
      pay('b', '2026-10-02', 50, 'Starter', 'acme'),
      pay('c', '2026-09-05', 30, 'Starter', 'globex'),
      pay('c', '2026-10-05', 30, 'Starter', 'globex'),
      pay('d', '2026-08-20', 200, 'Consulting', 'globex'),
      { ...pay('a', '2026-10-12', -20, 'Pro', 'acme'), event: 'order_refunded' },
      // First touches: a from search, b from an email.
      {
        event: '$pageview',
        distinct_id: 'a',
        ts_ms: at('2026-06-25'),
        referrer_host: 'www.google.com',
      },
      {
        event: '$pageview',
        distinct_id: 'b',
        ts_ms: at('2026-07-30'),
        utm_medium: 'email',
        utm_source: 'newsletter',
      },
    ]);
    return db;
  }
  const spec = { from: '2026-07-01', currency: 'GBP' } as const;

  it('reports sales, MRR movements, churn and LTV per month', async () => {
    const r = await runRevenue(spec, context(scenario()));
    assert.deepEqual(
      r.buckets.map((b) => new Date(b).toISOString().slice(0, 7)),
      ['2026-07', '2026-08', '2026-09', '2026-10'],
    );
    assert.deepEqual(
      r.periods.map((p) => [p.gross, p.refunds, p.net, p.orders, p.customers]),
      [
        [100, 0, 100, 1, 1],
        [350, 0, 350, 3, 3],
        [230, 0, 230, 3, 3],
        [230, -20, 210, 3, 3],
      ],
    );
    assert.deepEqual(
      r.periods.map((p) => [
        p.mrr,
        p.newMrr,
        p.expansionMrr,
        p.contractionMrr,
        p.churnedMrr,
        p.reactivatedMrr,
        p.netNewMrr,
      ]),
      [
        [100, 100, 0, 0, 30, 0, 70],
        [150, 50, 0, 0, 0, 0, 50],
        [230, 0, 50, 0, 0, 30, 80],
        [180, 0, 0, 0, 50, 0, -50],
      ],
    );
    assert.deepEqual(
      r.periods.map((p) => Math.round(p.customerChurn * 1000) / 1000),
      [1, 0, 0, 0.333],
    );
    assert.equal(Math.round(r.periods[3]!.revenueChurn * 1000) / 1000, 0.217);
    assert.deepEqual(
      [r.totals.gross, r.totals.refunds, r.totals.net, r.totals.customers, r.totals.arpu],
      [910, -20, 890, 4, 222.5],
    );
    assert.deepEqual([r.totals.mrr, r.totals.arr, r.totals.netNewMrr], [180, 2160, 150]);
    // ARPA £90 (two paying subscribers) / average monthly customer churn of a third.
    assert.equal(r.totals.ltv, 270);
    assert.deepEqual(
      r.topCustomers.map((c) => [c.actor, c.net, c.orders, c.mrr]),
      [
        ['a', 480, 4, 150],
        ['d', 200, 1, 0],
        ['b', 150, 3, 0],
        ['c', 60, 2, 30],
      ],
    );
    assert.match(
      r.summary,
      /^Net revenue £890 \(gross £910, refunds £20\) from 4 paying customers\. MRR £180 \(ARR £2,160\)/,
    );
  });

  it('breaks revenue down by product and first-touch channel, and per account', async () => {
    const byProduct = await runRevenue({ ...spec, breakdown: 'product' }, context(scenario()));
    assert.deepEqual(
      byProduct.breakdown?.values.map((v) => [v.value, v.net]),
      [
        ['Pro', 480],
        ['Starter', 210],
        ['Consulting', 200],
      ],
    );
    const byChannel = await runRevenue({ ...spec, breakdown: 'channel' }, context(scenario()));
    assert.equal(byChannel.breakdown?.by, 'first-touch channel');
    assert.deepEqual(
      byChannel.breakdown?.values.map((v) => [v.value, v.net]),
      [
        ['Organic search', 480],
        ['(unknown)', 260],
        ['Email', 150],
      ],
    );
    const accounts = await runRevenue({ ...spec, aggregateBy: 'company' }, context(scenario()));
    assert.deepEqual(
      accounts.topCustomers.map((c) => [c.actor, c.net, c.mrr]),
      [
        ['acme', 630, 150],
        ['globex', 260, 30],
      ],
    );
    assert.equal(accounts.totals.customers, 2);
    assert.match(accounts.summary, /from 2 paying company accounts/);
  });

  it('says so when there is no revenue', async () => {
    const r = await runRevenue(spec, context(createDb()));
    assert.match(r.summary, /^No revenue in this range/);
  });
});
