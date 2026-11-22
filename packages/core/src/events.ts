/**
 * The Dataflare event model.
 *
 * Everything Dataflare records — pageviews, clicks, custom events, flag exposures,
 * errors — is one row in a single wide `events` table. Two shapes matter:
 *
 * - {@link WireEvent}: what the browser SDK (or any HTTP client) sends.
 * - {@link StoredEvent}: what the Worker writes after enrichment.
 *
 * Both event stores (D1 and the Iceberg lake) use the same columns, which is
 * what lets one set of SQL compilers serve both.
 */

/** Event names Dataflare emits itself. Custom events must not start with `$`. */
export const SYSTEM_EVENTS = {
  pageview: '$pageview',
  pageleave: '$pageleave',
  click: '$click',
  exception: '$exception',
  webVitals: '$web_vitals',
  identify: '$identify',
  set: '$set',
  exposure: '$exposure',
  groupIdentify: '$groupidentify',
} as const;

/** At most this many group types per project (company, workspace, …), as in PostHog. */
export const MAX_GROUP_TYPES = 5;

/** Request context a trusted sender (an import, a server SDK) may supply instead of the request's own. */
export interface WireContext {
  country?: string;
  region?: string;
  city?: string;
  browser?: string;
  os?: string;
  device?: string;
}

export type SystemEventName = (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS];

/** One event as sent over the wire to `POST /e`. */
export interface WireEvent {
  /** Client-generated UUIDv7, used for de-duplication. */
  id: string;
  /** Event name, e.g. `$pageview` or `signup_completed`. */
  event: string;
  /** Client clock, milliseconds since epoch. The Worker corrects for clock skew. */
  ts: number;
  /** Anonymous device id. Stable across `identify()`. Omitted in cookieless mode. */
  distinct_id?: string | null;
  /** Your user id once `identify()` has been called on this device. */
  user_id?: string | null;
  session_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  title?: string | null;
  /** Arbitrary event properties. `$set` / `$set_once` update the person. */
  props?: Record<string, unknown>;
  /** Feature flag variants active when the event fired. */
  flags?: Record<string, string>;
  /**
   * Imports and server SDKs only (requests made with the server or admin key): where the event
   * happened, since the request itself comes from a server. Ignored on public `POST /e`.
   */
  context?: WireContext;
}

/** A batch of events, the body of `POST /e`. */
export interface WireBatch {
  project: string;
  /** Client clock when the batch was sent; used to correct event timestamps. */
  sent_at?: number;
  /** SDK name and version, e.g. `web/0.1.0`. */
  lib?: string;
  events: WireEvent[];
}

/** One row of the `events` table. Column order here is the canonical order. */
export interface StoredEvent {
  id: string;
  project: string;
  event: string;
  ts_ms: number;
  distinct_id: string;
  user_id: string | null;
  person_id: string;
  session_id: string;
  url: string;
  host: string;
  path: string;
  referrer: string;
  referrer_host: string;
  title: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  country: string;
  region: string;
  city: string;
  device: string;
  browser: string;
  os: string;
  /** JSON object of flag key → variant. */
  flags: string;
  /** JSON object of event properties. */
  props: string;
  /** JSON snapshot of the person's properties when the event was ingested. */
  person_props: string;
  lib: string;
  received_ms: number;
}

/** Canonical column list, in table order. */
export const EVENT_COLUMNS = [
  'id',
  'project',
  'event',
  'ts_ms',
  'distinct_id',
  'user_id',
  'person_id',
  'session_id',
  'url',
  'host',
  'path',
  'referrer',
  'referrer_host',
  'title',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
  'flags',
  'props',
  'person_props',
  'lib',
  'received_ms',
] as const satisfies readonly (keyof StoredEvent)[];

export type EventColumn = (typeof EVENT_COLUMNS)[number];

/**
 * Columns that can be used directly as filter or breakdown properties.
 * Anything else is looked up in `props` (or `person_props` with a `person.` prefix).
 */
export const FILTERABLE_COLUMNS = new Set<string>([
  'event',
  'distinct_id',
  'user_id',
  'person_id',
  'session_id',
  'url',
  'host',
  'path',
  'referrer',
  'referrer_host',
  'title',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
  'lib',
]);

/** Event names: printable, no control characters, sensible length. */
export function isValidEventName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f]/.test(name)
  );
}
