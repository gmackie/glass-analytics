/**
 * Revenue history:
 *
 * - `dataflare stripe import --api-key rk_… [--since 2024-01-01]` reads paid invoices, charges,
 *   refunds and subscriptions from Stripe (a restricted key with read access is enough) and
 *   sends them through `/api/import` as the same events the webhook records. Payments are keyed
 *   on the Stripe object, so importing what the webhook already sent doesn't double count.
 * - `dataflare revenue rates [--since 2024-01-01]` loads ECB exchange rates older than the
 *   Worker's own 90 days, for imported revenue in other currencies.
 */

import type { WireEvent } from '@dataflare/core/events';
import { ECB_HISTORY, parseEcbXml } from '@dataflare/core/fx';
import {
  linkFromCustomer,
  type StripeCustomerLink,
  type StripeLink,
  stripeEvents,
  subscriptionMrr,
} from '@dataflare/core/stripe';
import { call, withProject } from '../client.ts';
import { UsageError } from '../config.ts';
import { color, line, ok, printJson } from '../output.ts';

type Obj = Record<string, unknown>;

async function* list(
  path: string,
  key: string,
  fetcher: typeof fetch,
  params: Record<string, string> = {},
): AsyncGenerator<Obj> {
  let after: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const q = new URLSearchParams({
      limit: '100',
      ...params,
      ...(after ? { starting_after: after } : {}),
    });
    const res = await fetcher(`https://api.stripe.com/v1/${path}?${q}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Obj[];
      has_more?: boolean;
      error?: { message?: string };
    };
    if (!res.ok)
      throw new UsageError(
        `Stripe ${path}: ${body.error?.message ?? `HTTP ${res.status}`}`,
        'Use a restricted key with read access to Customers, Invoices, Charges and Subscriptions.',
      );
    for (const item of body.data ?? []) yield item;
    if (!body.has_more || !body.data?.length) return;
    after = String(body.data.at(-1)!.id);
  }
}

interface ImportOptions {
  apiKey?: string;
  since?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
  personKey?: string;
  groupType?: string;
  groupKey?: string;
}

type ImportDeps = { fetcher?: typeof fetch; stripeFetch?: typeof fetch };

/** How customers map to people: the Worker's Stripe settings, unless given here. */
async function linkOf(
  project: string | undefined,
  options: ImportOptions,
  deps: ImportDeps,
): Promise<StripeLink> {
  const status = await call<{ config?: StripeLink }>(
    'GET',
    `/api/stripe${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    undefined,
    { fetcher: deps.fetcher },
  ).catch(() => ({}) as { config?: StripeLink });
  return {
    ...(status.config ?? {}),
    ...(options.personKey ? { personKey: options.personKey } : {}),
    ...(options.groupType ? { groupType: options.groupType } : {}),
    ...(options.groupKey ? { groupKey: options.groupKey } : {}),
  };
}

/** Stripe's list filter for objects created since `--since`. */
function createdSince(since: string | undefined): Record<string, string> {
  if (!since) return {};
  const seconds = Math.floor(Date.parse(since) / 1000);
  if (!Number.isFinite(seconds)) throw new UsageError(`--since "${since}" is not a date.`);
  return { 'created[gte]': String(seconds) };
}

/** Collects Dataflare events for Stripe objects, as the webhook would make them. */
function collector(customers: Map<string, StripeCustomerLink>, link: StripeLink) {
  const events: WireEvent[] = [];
  const add = (type: string, createdAt: number, object: Obj, extra: Obj = {}) => {
    const customer =
      typeof object.customer === 'string' ? (customers.get(object.customer) ?? null) : null;
    events.push(
      ...stripeEvents(
        { id: `import_${object.id}_${type}`, type, created: createdAt, data: { object, ...extra } },
        customer,
        link,
      ),
    );
  };
  return { events, add };
}

type Add = ReturnType<typeof collector>['add'];

function addCharge(ch: Obj, add: Add): void {
  if (ch.status === 'succeeded' && !ch.invoice) add('charge.succeeded', Number(ch.created), ch);
  if (!(Number(ch.amount_refunded) > 0)) return;
  const refunds = ((ch.refunds as Obj | undefined)?.data as Obj[] | undefined) ?? [];
  add('charge.refunded', Number(refunds[0]?.created ?? ch.created), ch, {
    previous_attributes: { amount_refunded: 0 },
  });
}

/**
 * A subscription's start, and its end if it ended (Stripe keeps 30 days of events, so plan
 * changes before that aren't recoverable; the webhook records them from now on).
 */
function addSubscription(sub: Obj, add: Add): void {
  add('customer.subscription.created', Number(sub.start_date ?? sub.created), {
    ...sub,
    status: sub.status === 'trialing' ? 'trialing' : 'active',
  });
  const ended = Number(sub.ended_at ?? sub.canceled_at ?? 0);
  if (ended && ['canceled', 'incomplete_expired', 'unpaid'].includes(String(sub.status)))
    add('customer.subscription.deleted', ended, sub);
  else if (subscriptionMrr(sub) !== subscriptionMrr({ ...sub, status: 'active' }))
    add('customer.subscription.updated', Math.floor(Date.now() / 1000), sub);
}

async function sendImport(
  project: string | undefined,
  events: WireEvent[],
  deps: ImportDeps,
): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < events.length; i += 1000) {
    const res = await call<{ accepted: number }>(
      'POST',
      '/api/import',
      { project, events: events.slice(i, i + 1000), skip_destinations: true },
      { fetcher: deps.fetcher },
    );
    accepted += res.accepted;
  }
  return accepted;
}

function reportImport(
  customers: Map<string, StripeCustomerLink>,
  unique: WireEvent[],
  accepted: number,
  link: StripeLink,
  options: ImportOptions,
): void {
  const counts = unique.reduce<Record<string, number>>((acc, e) => {
    acc[e.event] = (acc[e.event] ?? 0) + 1;
    return acc;
  }, {});
  if (options.json) {
    printJson({
      customers: customers.size,
      events: unique.length,
      imported: accepted,
      byType: counts,
      dryRun: Boolean(options.dryRun),
    });
    return;
  }
  ok(
    `${options.dryRun ? 'Would import' : 'Imported'} ${unique.length} Stripe events for ${customers.size} customers`,
  );
  for (const [type, n] of Object.entries(counts)) line(color.dim(`  ${type}: ${n}`));
  const unlinked = [...customers.values()].filter((c) => !c.person).length;
  if (!unlinked) return;
  line(
    color.dim(
      `${unlinked} customers have no "${link.personKey ?? 'dataflare_id'}" in their metadata, so their revenue is under stripe:<customer id>. Set it to your user id (what glass.identify gets), or connect Stripe with linkByEmail.`,
    ),
  );
}

export async function stripeImport(options: ImportOptions, deps: ImportDeps = {}): Promise<void> {
  const key = options.apiKey ?? process.env.STRIPE_API_KEY;
  if (!key)
    throw new UsageError(
      'Pass --api-key rk_… (or set STRIPE_API_KEY): a restricted key with read access is enough.',
    );
  const stripeFetch = deps.stripeFetch ?? fetch;
  const project = withProject({ project: options.project }).project;
  const link = await linkOf(project, options, deps);
  const created = createdSince(options.since);
  const customers = new Map<string, StripeCustomerLink>();
  for await (const c of list('customers', key, stripeFetch))
    customers.set(String(c.id), linkFromCustomer(c, link));
  const { events, add } = collector(customers, link);
  for await (const inv of list('invoices', key, stripeFetch, { status: 'paid', ...created }))
    add('invoice.paid', Number(inv.created), inv);
  for await (const ch of list('charges', key, stripeFetch, created)) addCharge(ch, add);
  for await (const sub of list('subscriptions', key, stripeFetch, { status: 'all', ...created }))
    addSubscription(sub, add);
  // De-duplicate (an invoice and its charge are one payment) and send.
  const unique = [...new Map(events.map((e) => [e.id, e])).values()].sort((a, b) => a.ts - b.ts);
  const accepted = options.dryRun ? 0 : await sendImport(project, unique, deps);
  reportImport(customers, unique, accepted, link, options);
}

export async function revenueRates(
  options: { since?: string; json?: boolean },
  deps: { fetcher?: typeof fetch; ecbFetch?: typeof fetch } = {},
): Promise<void> {
  const since = options.since ?? new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
    throw new UsageError('--since takes a date, e.g. 2024-01-01');
  const res = await (deps.ecbFetch ?? fetch)(ECB_HISTORY);
  if (!res.ok) throw new UsageError(`Could not download the ECB rates: HTTP ${res.status}`);
  const rates = parseEcbXml(await res.text()).filter((r) => r.day >= since);
  let stored = 0;
  for (let i = 0; i < rates.length; i += 5000) {
    const r = await call<{ stored: number }>(
      'POST',
      '/api/fx-rates',
      { rates: rates.slice(i, i + 5000) },
      { fetcher: deps.fetcher },
    );
    stored += r.stored;
  }
  const days = new Set(rates.map((r) => r.day)).size;
  if (options.json) return printJson({ since, days, stored });
  ok(`Stored ${stored} exchange rates for ${days} days since ${since}`);
}
