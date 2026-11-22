/**
 * Destinations: forward events to other tools as they arrive (Slack, webhooks,
 * ad platforms' conversion APIs, CRMs, other analytics tools).
 *
 * A template turns one event into the HTTP request(s) the tool's API expects,
 * from the destination's inputs (pixel id, channel webhook…) and secrets (access
 * tokens). Templates are data plus a render function; the Worker does delivery,
 * retries and logging (packages/worker/src/destinations.ts).
 */

/** An event as destinations see it: the stored row with JSON parsed. */
export interface DeliveryEvent {
  id: string;
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
  props: Record<string, unknown>;
  person: Record<string, unknown>;
  flags: Record<string, string>;
}

export interface DeliveryRequest {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export interface TemplateInput {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'boolean' | 'json' | 'select';
  required?: boolean;
  description?: string;
  default?: unknown;
  options?: string[];
}

export interface DestinationTemplate {
  id: string;
  name: string;
  /** One line: what it does. */
  description: string;
  category: 'notifications' | 'ads' | 'crm' | 'analytics' | 'automation' | 'custom';
  inputs: TemplateInput[];
  /** Events forwarded when the destination names none (e.g. only $identify for a CRM). */
  defaultEvents?: string[];
  /** The request(s) for one event, or null to skip it. */
  render(event: DeliveryEvent, config: Record<string, unknown>): Promise<DeliveryRequest[] | null>;
}

/** Read a dotted path from an event: "event", "props.plan", "person.email", "url"… */
export function pick(event: DeliveryEvent, path: string): unknown {
  const [head, ...rest] = path.split('.');
  let value: unknown =
    head === 'props' || head === 'properties'
      ? event.props
      : head === 'person'
        ? event.person
        : head === 'flags'
          ? event.flags
          : (event as unknown as Record<string, unknown>)[head!];
  for (const key of rest) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Fill `{event}`, `{props.plan}`, `{person.email}`, `{url}` placeholders. Missing
 * values become empty strings; objects become JSON. With `json`, values are
 * JSON-escaped for use inside a JSON string template.
 */
export function interpolate(template: string, event: DeliveryEvent, json = false): string {
  return template.replace(/\{\s*([a-zA-Z_$][\w$.]*)\s*\}/g, (_, path: string) => {
    const v = pick(event, path);
    const s =
      v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return json ? JSON.stringify(s).slice(1, -1) : s;
  });
}

/** The person's best label for messages: email, name, then id. */
export function whoIs(event: DeliveryEvent): string {
  const p = event.person;
  return String(p.email ?? p.name ?? event.user_id ?? event.distinct_id);
}

export const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
export const json = (body: unknown) => JSON.stringify(body);
export const JSON_HEADERS = { 'Content-Type': 'application/json' };
