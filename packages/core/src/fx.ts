/**
 * Exchange rates for revenue analytics: the European Central Bank's euro
 * reference rates (about 30 currencies, published each working day around 16:00
 * CET), and converting amounts between currencies through the euro.
 */

/** One ECB rate: units of `currency` per euro on `day` (YYYY-MM-DD). */
export interface FxRate {
  day: string;
  currency: string;
  rate: number;
}

export const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const ECB_90_DAYS = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
export const ECB_HISTORY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

/** Parse any of the ECB feeds (daily, 90 days, full history). */
export function parseEcbXml(xml: string): FxRate[] {
  const out: FxRate[] = [];
  const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rate = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const d of xml.matchAll(day)) {
    for (const r of d[2]!.matchAll(rate)) {
      const value = Number(r[2]);
      if (value > 0) out.push({ day: d[1]!, currency: r[1]!, rate: value });
    }
  }
  return out;
}

/** Rates for one day: currency → units per euro (the euro itself is 1). */
export type RateTable = ReadonlyMap<string, number>;

/** Convert between currencies through the euro; null when either rate is missing. */
export function convert(amount: number, from: string, to: string, rates: RateTable): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const perEurFrom = f === 'EUR' ? 1 : rates.get(f);
  const perEurTo = t === 'EUR' ? 1 : rates.get(t);
  if (!perEurFrom || !perEurTo) return null;
  return (amount / perEurFrom) * perEurTo;
}

/** Currencies Stripe (and most payment APIs) send in whole units. */
export const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
/** Currencies with three decimal places. */
export const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** An amount in a currency's smallest unit (cents) as major units (e.g. 4999 USD → 49.99). */
export function fromMinorUnits(amount: number, currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return amount;
  return amount / (THREE_DECIMAL.has(c) ? 1000 : 100);
}

/** Round to cents (or the currency's precision), avoiding binary-float noise in sums. */
export function roundMoney(amount: number, currency = 'USD'): number {
  const c = currency.toUpperCase();
  const places = ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
  const f = 10 ** places;
  return Math.round(amount * f) / f;
}
