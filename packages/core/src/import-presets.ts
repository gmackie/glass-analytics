/**
 * Turning other tools' exports into Dataflare events, for `dataflare import`.
 *
 * Each preset maps one exported record to a wire event (or null to skip it):
 * PostHog event exports, Mixpanel raw exports, Amplitude exports, Segment
 * messages and GA4's BigQuery export, plus "raw" for files already in Dataflare's
 * shape. Records without an id get one from a hash of their content, so running
 * the same import twice doesn't double count.
 */

import type { WireContext, WireEvent } from './events.ts';
import { sha256Hex } from './hash.ts';

export type ImportPreset = 'raw' | 'posthog' | 'mixpanel' | 'amplitude' | 'segment' | 'ga4';
export const IMPORT_PRESETS: ImportPreset[] = [
  'raw',
  'posthog',
  'mixpanel',
  'amplitude',
  'segment',
  'ga4',
];

type Rec = Record<string, unknown>;

const obj = (v: unknown): Rec => {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Rec) : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
};
const str = (v: unknown): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : String(v);

/** Milliseconds from an ISO date, epoch seconds, ms or µs. */
export function toMillis(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (n > 1e15) return Math.round(n / 1000); // microseconds
    if (n > 1e12) return Math.round(n); // milliseconds
    return Math.round(n * 1000); // seconds
  }
  // "2024-01-01 12:00:00.123" (Amplitude) reads as UTC.
  const text = String(v).replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Split off a URL's parts the way the SDK sends them. */
function page(url: unknown): { url?: string } {
  const u = str(url);
  return u ? { url: u } : {};
}

function dropDollar(props: Rec, keep: string[] = []): Rec {
  return Object.fromEntries(
    Object.entries(props).filter(
      ([k]) => !k.startsWith('$') || keep.includes(k) || k === '$set' || k === '$set_once',
    ),
  );
}

function context(c: WireContext): WireContext | undefined {
  const out = Object.fromEntries(
    Object.entries(c).filter(([, v]) => v !== undefined && v !== ''),
  ) as WireContext;
  return Object.keys(out).length ? out : undefined;
}

type Mapped = Omit<WireEvent, 'id'> & { id?: string };

/** Segment calls that are Dataflare's own events; "track" calls keep their event name. */
const SEGMENT_EVENTS: Record<string, string> = {
  page: '$pageview',
  identify: '$identify',
  group: '$groupidentify',
};

/** Properties of a Segment call: traits for identify and group calls, properties otherwise. */
function segmentProps(type: string, r: Rec): Rec {
  if (type === 'identify') return { $set: obj(r.traits) };
  if (type === 'group')
    return { $group_type: 'company', $group_key: str(r.groupId), $group_set: obj(r.traits) };
  return obj(r.properties);
}

const MAPPERS: Record<ImportPreset, (r: Rec) => Mapped | null> = {
  raw(r) {
    const ts = toMillis(r.ts ?? r.timestamp ?? r.time);
    const event = str(r.event);
    const distinct = str(r.distinct_id ?? r.user_id);
    if (!event || ts === null || !distinct) return null;
    return {
      id: str(r.id ?? r.uuid),
      event,
      ts,
      distinct_id: distinct,
      user_id: str(r.user_id) ?? null,
      session_id: str(r.session_id) ?? null,
      ...page(r.url),
      referrer: str(r.referrer) ?? null,
      title: str(r.title) ?? null,
      props: obj(r.props ?? r.properties),
      ...(r.context ? { context: obj(r.context) as WireContext } : {}),
    };
  },

  posthog(r) {
    const p = obj(r.properties);
    const ts = toMillis(r.timestamp);
    const event = str(r.event);
    const distinct = str(r.distinct_id);
    if (!event || ts === null || !distinct) return null;
    const name =
      event === '$autocapture' ? '$click' : event === '$feature_flag_called' ? '$exposure' : event;
    const props = dropDollar(p, ['$groups']);
    if (name === '$exposure')
      Object.assign(props, { flag: p.$feature_flag, variant: p.$feature_flag_response });
    return {
      id: str(r.uuid),
      event: name,
      ts,
      distinct_id: str(p.$device_id) ?? distinct,
      user_id: p.$is_identified || p.$user_id ? (str(p.$user_id) ?? distinct) : null,
      session_id: str(p.$session_id) ?? null,
      ...page(p.$current_url),
      referrer: str(p.$referrer) ?? null,
      title: str(p.title) ?? null,
      props,
      context: context({
        country: str(p.$geoip_country_code),
        region: str(p.$geoip_subdivision_1_name),
        city: str(p.$geoip_city_name),
        browser: str(p.$browser),
        os: str(p.$os),
        device: str(p.$device_type)?.toLowerCase(),
      }),
    };
  },

  mixpanel(r) {
    const p = obj(r.properties);
    const ts = toMillis(p.time);
    const event = str(r.event);
    const distinct = str(p.$device_id ?? p.distinct_id);
    if (!event || ts === null || !distinct) return null;
    return {
      id: str(p.$insert_id),
      event: event === '$mp_web_page_view' || event === 'Page View' ? '$pageview' : event,
      ts,
      distinct_id: distinct,
      user_id: str(p.$user_id) ?? null,
      ...page(p.$current_url),
      referrer: str(p.$referrer) ?? null,
      props: Object.fromEntries(
        Object.entries(p).filter(
          ([k]) =>
            !k.startsWith('$') && !k.startsWith('mp_') && k !== 'time' && k !== 'distinct_id',
        ),
      ),
      context: context({
        country: str(p.mp_country_code),
        region: str(p.$region),
        city: str(p.$city),
        browser: str(p.$browser),
        os: str(p.$os),
        device: p.$device ? 'mobile' : undefined,
      }),
    };
  },

  amplitude(r) {
    const ts = toMillis(r.event_time ?? r.client_event_time);
    const event = str(r.event_type);
    const distinct = str(r.device_id ?? r.user_id);
    if (!event || ts === null || !distinct) return null;
    const ep = obj(r.event_properties);
    const pageView = event === '[Amplitude] Page Viewed';
    return {
      id: str(r.uuid ?? r.insert_id),
      event: pageView ? '$pageview' : event === '$identify' ? '$set' : event,
      ts,
      distinct_id: distinct,
      user_id: str(r.user_id) ?? null,
      session_id: r.session_id && r.session_id !== -1 ? String(r.session_id) : null,
      ...page(ep['[Amplitude] Page URL'] ?? ep.page_url),
      props:
        event === '$identify'
          ? { $set: obj(r.user_properties) }
          : Object.fromEntries(Object.entries(ep).filter(([k]) => !k.startsWith('[Amplitude]'))),
      context: context({
        country: str(r.country),
        region: str(r.region),
        city: str(r.city),
        os: str(r.os_name),
        browser: str(r.device_family ?? r.platform),
        device: str(r.device_type)?.toLowerCase(),
      }),
    };
  },

  segment(r) {
    const ts = toMillis(r.timestamp ?? r.originalTimestamp ?? r.receivedAt);
    const type = str(r.type) ?? 'track';
    const distinct = str(r.anonymousId ?? r.userId);
    if (ts === null || !distinct) return null;
    const event =
      (Object.hasOwn(SEGMENT_EVENTS, type) ? SEGMENT_EVENTS[type] : undefined) ?? str(r.event);
    if (!event) return null;
    const c = obj(r.context);
    const pg = obj(c.page);
    const loc = obj(c.location);
    return {
      id: str(r.messageId),
      event,
      ts,
      distinct_id: distinct,
      user_id: str(r.userId) ?? null,
      ...page(pg.url ?? obj(r.properties).url),
      referrer: str(pg.referrer) ?? null,
      title: str(pg.title) ?? null,
      props: segmentProps(type, r),
      context: context({ country: str(loc.country), city: str(loc.city), region: str(loc.region) }),
    };
  },

  ga4(r) {
    const ts = toMillis(r.event_timestamp);
    const event = str(r.event_name);
    const distinct = str(r.user_pseudo_id ?? r.user_id);
    if (!event || ts === null || !distinct) return null;
    const params: Rec = {};
    for (const p of Array.isArray(r.event_params) ? (r.event_params as Rec[]) : []) {
      const v = obj(p.value);
      params[String(p.key)] =
        v.string_value ?? v.int_value ?? v.double_value ?? v.float_value ?? null;
    }
    const geo = obj(r.geo);
    const device = obj(r.device);
    const web = obj(device.web_info);
    const { page_location, page_referrer, page_title, ga_session_id, ...rest } = params;
    return {
      event: event === 'page_view' ? '$pageview' : event,
      ts,
      distinct_id: distinct,
      user_id: str(r.user_id) ?? null,
      session_id:
        ga_session_id !== undefined && ga_session_id !== null
          ? `ga_${distinct}_${ga_session_id}`
          : null,
      ...page(page_location),
      referrer: str(page_referrer) ?? null,
      title: str(page_title) ?? null,
      props: Object.fromEntries(
        Object.entries(rest).filter(([k]) => !k.startsWith('ga_') && k !== 'engagement_time_msec'),
      ),
      context: context({
        country: str(geo.country),
        region: str(geo.region),
        city: str(geo.city),
        os: str(device.operating_system),
        browser: str(web.browser),
        device: str(device.category)?.toLowerCase(),
      }),
    };
  },
};

/** Map one record with a preset. Ids default to a hash of the record, so re-imports de-duplicate. */
export async function mapRecord(preset: ImportPreset, record: Rec): Promise<WireEvent | null> {
  const mapped = MAPPERS[preset](record);
  if (!mapped) return null;
  const id = mapped.id ?? (await sha256Hex(JSON.stringify(record))).slice(0, 32);
  return { ...mapped, id: id.slice(0, 64) } as WireEvent;
}

/** Parse one CSV line (RFC 4180 quotes; no newlines inside quoted cells). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out;
}

/**
 * A CSV row as a raw record: known columns (event, timestamp, distinct_id, user_id, url…) as
 * fields, a "properties" column parsed as JSON, and every other column as a property.
 */
export function csvRecord(header: string[], cells: string[]): Rec {
  const known = new Set([
    'id',
    'uuid',
    'event',
    'timestamp',
    'ts',
    'time',
    'distinct_id',
    'user_id',
    'session_id',
    'url',
    'referrer',
    'title',
    'properties',
    'props',
  ]);
  const r: Rec = {};
  const props: Rec = {};
  header.forEach((h, i) => {
    const v = cells[i] ?? '';
    if (known.has(h)) r[h] = v;
    else if (v !== '') props[h] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  });
  r.props = { ...obj(r.properties ?? r.props), ...props };
  delete r.properties;
  return r;
}
