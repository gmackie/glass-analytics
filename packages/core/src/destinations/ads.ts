/**
 * Ad platforms' server-side conversion APIs: Meta Conversions API, Google
 * Analytics 4 Measurement Protocol and the TikTok Events API. Identifiers are
 * SHA-256 hashed before they leave the Worker, as the platforms require.
 */

import { sha256Normalised } from '../crypto.ts';
import {
  type DeliveryEvent,
  type DestinationTemplate,
  JSON_HEADERS,
  json,
  pick,
  str,
} from './types.ts';

/** Map a Dataflare event name to the platform's ({"signup_completed":"CompleteRegistration"}). */
function mapped(event: DeliveryEvent, config: Record<string, unknown>): string | null {
  const map = (config.eventMap as Record<string, string> | undefined) ?? {};
  if (Object.keys(map).length) return map[event.event] ?? null;
  return event.event.startsWith('$') ? null : event.event;
}

const identityInputs = [
  {
    key: 'emailProperty',
    label: 'Email property',
    type: 'string' as const,
    default: 'person.email',
    description: 'Where the email is (hashed before sending).',
  },
  {
    key: 'phoneProperty',
    label: 'Phone property',
    type: 'string' as const,
    default: 'person.phone',
  },
  {
    key: 'phoneCountryCode',
    label: 'Phone country code',
    type: 'string' as const,
    description:
      'Calling code for numbers stored without one, e.g. "44" turns 07946 095800 into 447946095800.',
  },
];

/**
 * A phone number in the form ad platforms match on: country code and number, digits only
 * (Meta) or E.164 with a "+" (TikTok). Drops a "(0)" trunk prefix and a "00" international
 * prefix; a national number ("07946…") gets `countryCode` when one is configured.
 */
export function normalisePhone(
  raw: string,
  style: 'digits' | 'e164',
  countryCode?: string,
): string | null {
  const text = raw.trim().replace(/\(0\)/g, '');
  const international = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (text.startsWith('00')) digits = digits.slice(2);
  else if (!international && digits.startsWith('0') && countryCode) {
    digits = countryCode.replace(/\D/g, '') + digits.replace(/^0+/, '');
  }
  digits = digits.replace(/^0+/, '');
  if (digits.length < 7) return null;
  return style === 'e164' ? `+${digits}` : digits;
}

const valueInputs = [
  {
    key: 'valueProperty',
    label: 'Value property',
    type: 'string' as const,
    default: 'props.$revenue_base',
    description: 'Purchase value, e.g. props.amount.',
  },
  {
    key: 'currencyProperty',
    label: 'Currency property',
    type: 'string' as const,
    default: 'props.currency',
  },
  { key: 'currency', label: 'Default currency', type: 'string' as const, default: 'USD' },
];

async function hashedField(event: DeliveryEvent, path: unknown): Promise<string | null> {
  const raw = pick(event, str(path));
  if (raw === undefined || raw === null || raw === '') return null;
  return sha256Normalised(String(raw));
}

async function hashedPhone(
  event: DeliveryEvent,
  config: Record<string, unknown>,
  style: 'digits' | 'e164',
): Promise<string | null> {
  const raw = pick(event, str(config.phoneProperty) || 'person.phone');
  if (raw === undefined || raw === null || raw === '') return null;
  const phone = normalisePhone(String(raw), style, str(config.phoneCountryCode) || undefined);
  return phone ? sha256Normalised(phone) : null;
}

function valueFrom(event: DeliveryEvent, config: Record<string, unknown>) {
  const raw = pick(event, str(config.valueProperty) || 'props.$revenue_base');
  const value =
    typeof raw === 'number' ? raw : raw !== undefined && raw !== null ? Number(raw) : undefined;
  const currency =
    str(pick(event, str(config.currencyProperty) || 'props.currency')) ||
    str(config.currency) ||
    'USD';
  return {
    value: Number.isFinite(value) ? (value as number) : undefined,
    currency: currency.toUpperCase(),
  };
}

export const META_CAPI: DestinationTemplate = {
  id: 'meta-capi',
  name: 'Meta Conversions API',
  description:
    'Send conversions to a Meta (Facebook/Instagram) Pixel from the server. Pass the event id to the Pixel as eventID to deduplicate.',
  category: 'ads',
  inputs: [
    { key: 'pixelId', label: 'Pixel (dataset) id', type: 'string', required: true },
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true },
    {
      key: 'eventMap',
      label: 'Event names',
      type: 'json',
      description:
        'Dataflare event → Meta event, e.g. {"signup_completed":"CompleteRegistration","order_paid":"Purchase"}. Only these are sent when set.',
    },
    {
      key: 'testEventCode',
      label: 'Test event code',
      type: 'string',
      description: 'From Events Manager → Test events.',
    },
    ...identityInputs,
    ...valueInputs,
  ],
  async render(event, config) {
    const name = mapped(event, config);
    if (!name) return null;
    const em = await hashedField(event, config.emailProperty || 'person.email');
    const ph = await hashedPhone(event, config, 'digits');
    const externalId = await sha256Normalised(event.user_id ?? event.person_id);
    const { value, currency } = valueFrom(event, config);
    const fbp = str(event.props.$fbp ?? event.props.fbp);
    const fbc = str(event.props.$fbc ?? event.props.fbc);
    const data = {
      event_name: name,
      event_time: Math.floor(event.ts_ms / 1000),
      event_id: event.id,
      action_source: 'website',
      ...(event.url ? { event_source_url: event.url } : {}),
      user_data: {
        ...(em ? { em: [em] } : {}),
        ...(ph ? { ph: [ph] } : {}),
        external_id: [externalId],
        ...(event.country ? { country: [await sha256Normalised(event.country)] } : {}),
        ...(fbp ? { fbp } : {}),
        ...(fbc ? { fbc } : {}),
      },
      custom_data: { ...(value !== undefined ? { value, currency } : {}) },
    };
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(str(config.pixelId))}/events?access_token=${encodeURIComponent(str(config.accessToken))}`;
    return [
      {
        url,
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({
          data: [data],
          ...(config.testEventCode ? { test_event_code: str(config.testEventCode) } : {}),
        }),
      },
    ];
  },
};

/** GA4 event names: letters, digits and underscores, starting with a letter, at most 40. */
export function ga4Name(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (clean || 'event').slice(0, 40);
}

export const GA4: DestinationTemplate = {
  id: 'ga4',
  name: 'Google Analytics 4',
  description:
    'Send events to a GA4 property with the Measurement Protocol (and on to Google Ads as conversions).',
  category: 'ads',
  inputs: [
    {
      key: 'measurementId',
      label: 'Measurement id',
      type: 'string',
      required: true,
      description: 'G-XXXXXXX',
    },
    { key: 'apiSecret', label: 'API secret', type: 'secret', required: true },
    {
      key: 'eventMap',
      label: 'Event names',
      type: 'json',
      description: 'e.g. {"signup_completed":"sign_up","order_paid":"purchase"}.',
    },
    { key: 'eu', label: 'Collect in the EU (region1 endpoint)', type: 'boolean' },
    ...valueInputs,
  ],
  async render(event, config) {
    const name = mapped(event, config);
    if (!name) return null;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.props)) {
      if (k.startsWith('$') || v === null || typeof v === 'object') continue;
      if (Object.keys(params).length >= 20) break;
      params[ga4Name(k)] = typeof v === 'string' ? v.slice(0, 100) : v;
    }
    const { value, currency } = valueFrom(event, config);
    if (value !== undefined) Object.assign(params, { value, currency });
    if (event.session_id) params.session_id = event.session_id;
    params.engagement_time_msec = 1;
    const host = config.eu ? 'region1.google-analytics.com' : 'www.google-analytics.com';
    const url = `https://${host}/mp/collect?measurement_id=${encodeURIComponent(str(config.measurementId))}&api_secret=${encodeURIComponent(str(config.apiSecret))}`;
    return [
      {
        url,
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({
          client_id: event.distinct_id,
          ...(event.user_id ? { user_id: event.user_id } : {}),
          timestamp_micros: event.ts_ms * 1000,
          events: [{ name: ga4Name(name), params }],
        }),
      },
    ];
  },
};

export const TIKTOK: DestinationTemplate = {
  id: 'tiktok',
  name: 'TikTok Events API',
  description: 'Send conversions to a TikTok Pixel from the server.',
  category: 'ads',
  inputs: [
    { key: 'pixelCode', label: 'Pixel code', type: 'string', required: true },
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true },
    {
      key: 'eventMap',
      label: 'Event names',
      type: 'json',
      description: 'e.g. {"order_paid":"CompletePayment"}.',
    },
    { key: 'testEventCode', label: 'Test event code', type: 'string' },
    ...identityInputs,
    ...valueInputs,
  ],
  async render(event, config) {
    const name = mapped(event, config);
    if (!name) return null;
    const email = await hashedField(event, config.emailProperty || 'person.email');
    // TikTok hashes E.164 numbers, "+" included.
    const phone = await hashedPhone(event, config, 'e164');
    const { value, currency } = valueFrom(event, config);
    return [
      {
        url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/',
        method: 'POST',
        headers: { ...JSON_HEADERS, 'Access-Token': str(config.accessToken) },
        body: json({
          event_source: 'web',
          event_source_id: str(config.pixelCode),
          ...(config.testEventCode ? { test_event_code: str(config.testEventCode) } : {}),
          data: [
            {
              event: name,
              event_time: Math.floor(event.ts_ms / 1000),
              event_id: event.id,
              user: {
                ...(email ? { email } : {}),
                ...(phone ? { phone } : {}),
                external_id: await sha256Normalised(event.user_id ?? event.person_id),
              },
              page: { url: event.url, ...(event.referrer ? { referrer: event.referrer } : {}) },
              properties: { ...(value !== undefined ? { value, currency } : {}) },
            },
          ],
        }),
      },
    ];
  },
};
