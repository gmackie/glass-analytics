/**
 * Stripe as a revenue source: verifying webhook signatures, and turning Stripe
 * objects into Dataflare events with normalised revenue fields. Used by the
 * Worker's webhook and by `dataflare stripe import` (the same mapping both ways).
 *
 * - paid invoices → `$stripe_invoice_paid` (revenue)
 * - one-off charges (no invoice) → `$stripe_charge` (revenue)
 * - refunds → `$stripe_refund` (negative revenue)
 * - subscriptions created, updated or deleted → `$stripe_subscription` (MRR state)
 *
 * Events belong to the customer's person: `customer.metadata[personKey]` when the
 * app sets it (it should be the id passed to `glass.identify`), else a person
 * matched by email, else `stripe:<customer id>`. With a group type, events also
 * carry `$groups` (the customer's `metadata[groupKey]`, or the customer id), so
 * revenue can be reported per account.
 */

import type { WireEvent } from './events.ts';
import { fromMinorUnits } from './fx.ts';

/** Verify a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export async function verifyStripeSignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  now = Date.now(),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((x) => x.trim());
    if (k === 't') t = v ?? null;
    else if (k === 'v1' && v) sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)),
  );
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison.
  return sigs.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export interface StripeLink {
  /** `customer.metadata` key holding your user id. Default "dataflare_id"; "user_id" and "userId" are also tried. */
  personKey?: string;
  /** Report revenue per account: the group type, e.g. "company". */
  groupType?: string;
  /** `customer.metadata` key holding the group key. Default: the Stripe customer id. */
  groupKey?: string;
}

/** What is known about a Stripe customer (from customer events, metadata or a lookup). */
export interface StripeCustomerLink {
  id: string;
  person?: string | null;
  group?: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const idOf = (v: unknown): string | undefined => str(v) ?? str(obj(v).id);

/** Person and group from a customer's metadata. */
export function linkFromCustomer(customer: Obj, link: StripeLink): StripeCustomerLink {
  const meta = obj(customer.metadata);
  const keys = [link.personKey ?? 'dataflare_id', 'dataflare_id', 'user_id', 'userId'];
  const person = keys.map((k) => str(meta[k])).find(Boolean) ?? null;
  const group = link.groupType ? (str(meta[link.groupKey ?? '']) ?? null) : null;
  return { id: String(customer.id), person, group };
}

/** Months per billing interval: a yearly price is 1/12 of its amount a month, and so on. */
const PER_MONTH: Record<string, number> = { year: 1 / 12, week: 52 / 12, day: 365 / 12, month: 1 };

/** One subscription item's monthly amount, in minor units. */
function itemMrr(item: Obj): number {
  const price = obj(item.price ?? item.plan);
  const recurring = obj(price.recurring);
  const interval = str(recurring.interval) ?? str(price.interval) ?? 'month';
  const count = num(recurring.interval_count ?? price.interval_count) || 1;
  const unit =
    price.unit_amount_decimal !== undefined
      ? Number(price.unit_amount_decimal)
      : num(price.unit_amount ?? price.amount);
  const amount = unit * (num(item.quantity) || 1);
  return (amount * (PER_MONTH[interval] ?? 1)) / count;
}

/** Monthly amount of a subscription, in its currency's major units (0 unless it's paying). */
export function subscriptionMrr(sub: Obj): number {
  if (!['active', 'past_due'].includes(str(sub.status) ?? '')) return 0;
  const items = (obj(sub.items).data as Obj[] | undefined) ?? [];
  let total = items.reduce((sum, item) => sum + itemMrr(item), 0);
  const percentOff = num(obj(obj(sub.discount).coupon).percent_off);
  if (percentOff > 0) total *= 1 - percentOff / 100;
  return fromMinorUnits(total, str(sub.currency) ?? 'usd');
}

function productOf(lines: unknown): string | undefined {
  const first = ((obj(lines).data as Obj[] | undefined) ?? [])[0];
  if (!first) return undefined;
  const price = obj(first.price);
  return idOf(price.product) ?? str(first.description);
}

type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Obj; previous_attributes?: Obj };
};

type Out = Omit<WireEvent, 'project'>;

/** Builds one Dataflare event for a Stripe event: name, time, props and the id it's keyed on. */
type Make = (name: string, ts: number, props: Obj, key?: string) => Out;

/** The customer an object belongs to (a customer event is about the customer itself). */
function customerIdOf(event: StripeEvent): string | undefined {
  const o = event.data.object;
  const own = event.type.startsWith('customer.') && !event.type.startsWith('customer.subscription');
  return idOf(o.customer) ?? (own ? str(o.id) : undefined);
}

/**
 * Payments are keyed on the Stripe object, so a webhook and an import of the same invoice or
 * charge are one event; subscription changes on the Stripe event.
 */
function maker(event: StripeEvent, customer: StripeCustomerLink | null, link: StripeLink): Make {
  const customerId = customerIdOf(event);
  const person = customer?.person ?? null;
  const distinct = person ?? (customerId ? `stripe:${customerId}` : `stripe:${event.id}`);
  const groups =
    link.groupType && customerId ? { [link.groupType]: customer?.group ?? customerId } : undefined;
  const extra = {
    stripe_event: event.id,
    ...(customerId ? { stripe_customer: customerId } : {}),
    ...(groups ? { $groups: groups } : {}),
  };
  return (name, ts, props, key = event.id) => ({
    id: `stripe_${key}`,
    event: name,
    ts: ts * 1000,
    distinct_id: distinct,
    user_id: person,
    props: { ...props, ...extra },
  });
}

const currencyOf = (o: Obj) => (str(o.currency) ?? 'usd').toUpperCase();

function invoicePaid(event: StripeEvent, make: Make): Out[] {
  const o = event.data.object;
  const currency = currencyOf(o);
  const product = productOf(o.lines);
  const paidAt = num(obj(o.status_transitions).paid_at) || event.created;
  const subscription =
    idOf(o.subscription) ?? idOf(obj(obj(o.parent).subscription_details).subscription);
  return [
    make(
      '$stripe_invoice_paid',
      paidAt,
      {
        invoice: str(o.id),
        subscription,
        billing_reason: str(o.billing_reason),
        $revenue_amount: fromMinorUnits(num(o.amount_paid), currency),
        $revenue_currency: currency,
        ...(product ? { $revenue_product: product } : {}),
      },
      str(o.id) ?? event.id,
    ),
  ];
}

function chargeSucceeded(event: StripeEvent, make: Make): Out[] {
  const o = event.data.object;
  // Charges for invoices are counted by invoice.paid.
  if (o.invoice) return [];
  const currency = currencyOf(o);
  return [
    make(
      '$stripe_charge',
      num(o.created) || event.created,
      {
        charge: str(o.id),
        description: str(o.description),
        $revenue_amount: fromMinorUnits(num(o.amount), currency),
        $revenue_currency: currency,
      },
      str(o.id) ?? event.id,
    ),
  ];
}

function chargeRefunded(event: StripeEvent, make: Make): Out[] {
  const o = event.data.object;
  const refunded = num(o.amount_refunded) - num(event.data.previous_attributes?.amount_refunded);
  if (refunded <= 0) return [];
  const currency = currencyOf(o);
  return [
    make(
      '$stripe_refund',
      event.created,
      {
        charge: str(o.id),
        $revenue_amount: -fromMinorUnits(refunded, currency),
        $revenue_currency: currency,
      },
      `${str(o.id) ?? event.id}_refund_${num(o.amount_refunded)}`,
    ),
  ];
}

function subscriptionChanged(event: StripeEvent, make: Make): Out[] {
  const o = event.data.object;
  const status =
    event.type === 'customer.subscription.deleted' ? 'canceled' : (str(o.status) ?? 'active');
  const items = (obj(o.items).data as Obj[] | undefined) ?? [];
  const price = obj(items[0]?.price ?? items[0]?.plan);
  const product = idOf(price.product);
  return [
    make('$stripe_subscription', event.created, {
      subscription: str(o.id),
      change: event.type.split('.').pop(),
      plan: str(price.nickname) ?? product,
      interval: str(obj(price.recurring).interval) ?? str(price.interval),
      $subscription_id: str(o.id),
      $subscription_status: status,
      $mrr_amount: status === 'canceled' ? 0 : subscriptionMrr(o),
      $mrr_currency: currencyOf(o),
      ...(product ? { $revenue_product: product } : {}),
    }),
  ];
}

const HANDLERS: Record<string, (event: StripeEvent, make: Make) => Out[]> = {
  'invoice.paid': invoicePaid,
  // invoice.paid covers it; listen to either.
  'invoice.payment_succeeded': () => [],
  'charge.succeeded': chargeSucceeded,
  'charge.refunded': chargeRefunded,
  'customer.subscription.created': subscriptionChanged,
  'customer.subscription.updated': subscriptionChanged,
  'customer.subscription.deleted': subscriptionChanged,
};

/**
 * Dataflare events for one Stripe event (none for types that carry no revenue). `customer` is what's
 * known about the object's customer; without it events go to `stripe:<customer id>`.
 */
export function stripeEvents(
  event: StripeEvent,
  customer: StripeCustomerLink | null,
  link: StripeLink = {},
): Out[] {
  if (!Object.hasOwn(HANDLERS, event.type)) return [];
  return HANDLERS[event.type]!(event, maker(event, customer, link));
}

/** The Stripe event types the webhook should send. */
export const STRIPE_EVENT_TYPES = [
  'invoice.paid',
  'charge.succeeded',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.created',
  'customer.updated',
] as const;
