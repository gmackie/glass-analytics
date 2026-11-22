/**
 * `dataflare stripe import` and `dataflare revenue rates`: Stripe history and
 * older exchange rates land in the Worker, once.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN, type TestApp, testApp } from '../../worker/test/harness.ts';
import { revenueRates, stripeImport } from '../src/commands/stripe.ts';

let t: TestApp;
const saved = { ...process.env };
const fetcher: typeof fetch = (input, init) => t.app.fetch(new Request(input, init), t.env);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const day = 86_400;
const ago = (days: number) => Math.floor(Date.now() / 1000) - days * day;

/** A fake Stripe API: two pages of invoices, a refunded one-off charge, and a cancelled subscription. */
const stripe: typeof fetch = async (input, init) => {
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer rk_test_123');
  const url = new URL(String(input));
  const page = (data: unknown[], more = false) => Response.json({ data, has_more: more });
  switch (url.pathname) {
    case '/v1/customers':
      return page([
        { id: 'cus_1', metadata: { dataflare_id: 'user-1' } },
        { id: 'cus_2', metadata: {} },
      ]);
    case '/v1/invoices':
      return url.searchParams.get('starting_after')
        ? page([
            { id: 'in_2', customer: 'cus_1', currency: 'gbp', amount_paid: 2900, created: ago(10) },
          ])
        : page(
            [
              {
                id: 'in_1',
                customer: 'cus_1',
                currency: 'gbp',
                amount_paid: 2900,
                created: ago(40),
              },
            ],
            true,
          );
    case '/v1/charges':
      return page([
        {
          id: 'ch_9',
          customer: 'cus_2',
          currency: 'gbp',
          amount: 10000,
          amount_refunded: 2500,
          status: 'succeeded',
          invoice: null,
          created: ago(20),
        },
        {
          id: 'ch_1',
          customer: 'cus_1',
          currency: 'gbp',
          amount: 2900,
          amount_refunded: 0,
          status: 'succeeded',
          invoice: 'in_1',
          created: ago(40),
        },
      ]);
    case '/v1/subscriptions':
      return page([
        {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'canceled',
          currency: 'gbp',
          start_date: ago(40),
          ended_at: ago(5),
          items: {
            data: [{ quantity: 1, price: { unit_amount: 2900, recurring: { interval: 'month' } } }],
          },
        },
      ]);
    default:
      return new Response('{}', { status: 404 });
  }
};

describe('revenue history', () => {
  before(async () => {
    t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
    await t.json('PATCH', '/api/settings', {
      body: { project: 'acme', settings: { baseCurrency: 'GBP' } },
    });
    Object.assign(process.env, {
      GLASS_HOST: 'https://glass.test',
      GLASS_API_KEY: ADMIN,
      GLASS_PROJECT: 'acme',
    });
  });
  after(() => {
    process.env = saved;
  });

  it('imports Stripe invoices, charges, refunds and subscriptions, once', async () => {
    await assert.rejects(stripeImport({}, { fetcher, stripeFetch: stripe }), /--api-key/);
    for (let i = 0; i < 2; i++)
      await quiet(() =>
        stripeImport({ apiKey: 'rk_test_123', json: true }, { fetcher, stripeFetch: stripe }),
      );
    const { results } = await t.db
      .prepare(
        'SELECT event, distinct_id, json_extract(props, \'$."$revenue_base"\') AS rev FROM events ORDER BY ts_ms, event',
      )
      .all<{ event: string; distinct_id: string; rev: number | null }>();
    assert.deepEqual(
      results.map((r) => [r.event, r.distinct_id, r.rev]),
      [
        ['$stripe_invoice_paid', 'user-1', 29],
        ['$stripe_subscription', 'user-1', null],
        ['$stripe_charge', 'stripe:cus_2', 100],
        ['$stripe_refund', 'stripe:cus_2', -25],
        ['$stripe_invoice_paid', 'user-1', 29],
        ['$stripe_subscription', 'user-1', null],
      ],
    );
    const r = await t.json<{
      totals: { net: number; mrr: number };
      periods: { churnedMrr: number }[];
    }>('POST', '/api/query', {
      body: { project: 'acme', kind: 'revenue', from: '-60d', interval: 'week' },
    });
    assert.equal(r.totals.net, 133);
    assert.equal(r.totals.mrr, 0);
    assert.equal(
      r.periods.reduce((n, p) => n + p.churnedMrr, 0),
      29,
    );
  });

  it('loads older ECB rates', async () => {
    const xml = `<Cube><Cube time='2025-03-03'><Cube currency='USD' rate='1.04'/></Cube><Cube time='2023-01-02'><Cube currency='USD' rate='1.06'/></Cube></Cube>`;
    await quiet(() =>
      revenueRates(
        { since: '2024-01-01', json: true },
        { fetcher, ecbFetch: async () => new Response(xml) },
      ),
    );
    const { results } = await t.db.prepare('SELECT day, currency, rate FROM fx_rates').all();
    assert.deepEqual(
      results.map((r) => ({ ...r })),
      [{ day: '2025-03-03', currency: 'USD', rate: 1.04 }],
    );
  });
});
