/**
 * Revenue at ingest: events that carry money get normalised `$revenue_*` fields
 * in the base currency, so every report and both stores read revenue the same way.
 *
 * Two ways an event carries revenue:
 * - it matches one of the project's `revenueEvents` (an event name with the
 *   property holding the amount, and optionally currency, product and subscription);
 * - it already has `$revenue_amount` and `$revenue_currency` (Stripe events, or an
 *   app that sends them).
 *
 * Fields written (in `props`):
 * - `$revenue_base`: the amount in the base currency (negative for refunds);
 * - `$revenue_amount`, `$revenue_currency`: the original amount and currency;
 * - `$revenue_product`: the product or plan, when known;
 * - `$subscription_id`, `$mrr` (monthly recurring revenue in the base currency, 0 when
 *   cancelled), `$subscription_status`, and `$mrr_grace_days` for payment-based
 *   subscriptions (no payment within the grace period counts as churned).
 * - `$revenue_unconverted: true` when no exchange rate was available.
 */

import { convert, type RateTable, roundMoney } from './fx.ts';
import type { RevenueEvent } from './settings.ts';

type Props = Record<string, unknown>;

function at(props: Props, path: string | undefined): unknown {
  if (!path) return undefined;
  let v: unknown = props;
  for (const part of path.replace(/^props\./, '').split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Props)[part];
  }
  return v;
}

const numberOf = (v: unknown): number | null => {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** The currencies an event's revenue and MRR are in (empty when it carries neither). */
export function revenueCurrencies(
  event: string,
  props: Props,
  rules: readonly RevenueEvent[],
  base: string,
): string[] {
  const out: string[] = [];
  if (props.$revenue_amount !== undefined && typeof props.$revenue_currency === 'string') {
    out.push(props.$revenue_currency.toUpperCase());
  } else {
    const rule = rules.find((r) => r.event === event);
    if (rule) {
      const c = at(props, rule.currencyProperty);
      out.push(
        (typeof c === 'string' && c.length === 3 ? c : (rule.currency ?? base)).toUpperCase(),
      );
    }
  }
  if (props.$mrr_amount !== undefined && typeof props.$mrr_currency === 'string')
    out.push(props.$mrr_currency.toUpperCase());
  return out;
}

/** The money an event carries, read from `$revenue_*` fields or the project's matching rule. */
interface Money {
  amount: number | null;
  currency: string;
  product?: unknown;
  /** Set for a rule's payment of a subscription (custom events). */
  subscription?: unknown;
  interval: 'month' | 'year';
  fromRule: boolean;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '';

function ruleCurrency(props: Props, rule: RevenueEvent, base: string): string {
  const c = at(props, rule.currencyProperty);
  return (typeof c === 'string' && c.length === 3 ? c : (rule.currency ?? base)).toUpperCase();
}

function moneyOf(event: string, props: Props, rules: readonly RevenueEvent[], base: string): Money {
  if (props.$revenue_amount !== undefined && typeof props.$revenue_currency === 'string')
    return {
      amount: numberOf(props.$revenue_amount),
      currency: props.$revenue_currency.toUpperCase(),
      product: props.$revenue_product,
      interval: 'month',
      fromRule: false,
    };
  const rule = rules.find((r) => r.event === event);
  if (!rule) return { amount: null, currency: base, interval: 'month', fromRule: false };
  const amount = numberOf(at(props, rule.amountProperty));
  return {
    amount: amount !== null && rule.kind === 'refund' ? -Math.abs(amount) : amount,
    currency: ruleCurrency(props, rule, base),
    product: at(props, rule.productProperty),
    subscription: at(props, rule.subscriptionProperty),
    interval: rule.interval ?? 'month',
    fromRule: true,
  };
}

/**
 * A payment of a subscription (custom events): its amount is the subscription's MRR until the
 * next one; 0 cancels it, and no payment within the grace period counts as churned.
 */
function addSubscription(out: Props, m: Money, converted: number | null, base: string): void {
  if (!m.fromRule || !present(m.subscription) || (m.amount ?? 0) < 0) return;
  const yearly = m.interval === 'year';
  out.$subscription_id = String(m.subscription).slice(0, 200);
  if (converted !== null) out.$mrr = roundMoney(yearly ? converted / 12 : converted, base);
  out.$subscription_status = (m.amount ?? 0) > 0 ? 'active' : 'canceled';
  out.$mrr_grace_days = yearly ? 370 : 35;
}

function moneyFields(
  props: Props,
  m: Money & { amount: number },
  base: string,
  rates: RateTable,
): Props {
  const out: Props = { ...props, $revenue_amount: m.amount, $revenue_currency: m.currency };
  if (present(m.product)) out.$revenue_product = String(m.product).slice(0, 200);
  const converted = convert(m.amount, m.currency, base, rates);
  if (converted === null) {
    out.$revenue_unconverted = true;
    delete out.$revenue_base;
  } else {
    out.$revenue_base = roundMoney(converted, base);
    delete out.$revenue_unconverted;
  }
  addSubscription(out, m, converted, base);
  return out;
}

/** Subscription state with an explicit monthly amount (Stripe subscription events). */
function addMrr(out: Props, props: Props, base: string, rates: RateTable): void {
  const mrrAmount = numberOf(props.$mrr_amount);
  const mrr =
    mrrAmount === null ? null : convert(mrrAmount, props.$mrr_currency as string, base, rates);
  if (mrr === null) out.$revenue_unconverted = true;
  else out.$mrr = roundMoney(mrr, base);
}

/**
 * Add the normalised revenue fields to an event's props. Returns null when the event carries no
 * revenue and no subscription state. `rates` are for the event's day (an empty table is enough
 * when everything is in the base currency).
 */
export function applyRevenue(
  event: string,
  props: Props,
  rules: readonly RevenueEvent[],
  base: string,
  rates: RateTable,
): Props | null {
  const baseCcy = base.toUpperCase();
  const m = moneyOf(event, props, rules, baseCcy);
  let out: Props | null =
    m.amount === null ? null : moneyFields(props, { ...m, amount: m.amount }, baseCcy, rates);
  if (props.$mrr_amount !== undefined && typeof props.$mrr_currency === 'string') {
    out = out ?? { ...props };
    addMrr(out, props, baseCcy, rates);
  }
  return out;
}
