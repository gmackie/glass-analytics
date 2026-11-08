/**
 * Student mode: a per-project policy for products used by minors (K-12), enforced
 * by the Worker on every write, whatever the SDK on the page was told to do.
 *
 * A project with `audience: "minors"`:
 *
 * - never stores a device or session id the browser chose: ids are the daily-rotating
 *   cookieless ones, so nothing links a device across days except a pseudonym;
 * - accepts `identify()` only with a pseudonym (by default a keyed HMAC: 64 hex or
 *   43 base64url characters), never an email, name or anything with spaces or "@";
 * - keeps only allow-listed event and person properties, and drops any value that
 *   looks like an email, phone number or SSN even when its key is allowed;
 * - stores URLs as paths with id-like segments replaced by ":id", the referrer as its
 *   host only, no page titles, and no city or region;
 * - refuses session replay unless `replay: "scrubbed"`, and then masks every text
 *   node, input value and free-text attribute on the server and drops console and
 *   network records;
 * - may cap event and replay retention below the deployment's defaults;
 * - records every read of its data (API, MCP, SQL) in an audit log.
 *
 * This module is pure; the Worker applies it in ingest.ts and replays.ts.
 */

import { z } from 'zod/v4';
import type { WireEvent } from './events.ts';

const propertyName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'snake_case, max 64 characters');

/** A keyed-HMAC pseudonym: SHA-256 as 64 hex characters or 43 base64url characters. */
export const DEFAULT_PSEUDONYM_PATTERN = '^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$';

export const studentPolicySchema = z
  .object({
    audience: z
      .enum(['general', 'minors'])
      .describe('"minors" turns student mode on for the project; "general" turns it off.'),
    pseudonym_pattern: z
      .string()
      .max(200)
      .default(DEFAULT_PSEUDONYM_PATTERN)
      .refine(
        (p) => {
          try {
            new RegExp(p);
            return p.startsWith('^') && p.endsWith('$');
          } catch {
            return false;
          }
        },
        { message: 'Must be a valid regular expression anchored with ^ and $.' },
      )
      .describe(
        'Regular expression user ids must match. Values with "@" or whitespace are refused whatever it says.',
      ),
    event_properties: z
      .array(propertyName)
      .max(200)
      .default([])
      .describe('Custom event property names that may be stored. Everything else is dropped.'),
    person_properties: z
      .array(propertyName)
      .max(50)
      .default([])
      .describe('Person property names that $set / $set_once may store, e.g. "grade_band".'),
    replay: z
      .enum(['off', 'scrubbed'])
      .default('off')
      .describe(
        '"off" refuses replay uploads. "scrubbed" stores them with all text and inputs masked on the server.',
      ),
    retention_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe('Delete this project’s events and people after this many days.'),
    replay_retention_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Delete this project’s replays after this many days.'),
  })
  .strict();

export type StudentPolicy = z.infer<typeof studentPolicySchema>;

export const isMinors = (policy: StudentPolicy | null | undefined): policy is StudentPolicy =>
  policy?.audience === 'minors';

// ── Values ────────────────────────────────────────────────────────────────

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
/** Ten or more digits, optionally separated: phone numbers and long account numbers. */
const PHONE = /(?:\+?\d[\s().-]*){10,}/;

/** True when a string looks like contact details or a government id. */
export function looksLikePii(value: string): boolean {
  return EMAIL.test(value) || SSN.test(value) || PHONE.test(value);
}

/** Whether a user id is an acceptable pseudonym under the policy. */
export function isPseudonym(value: string, policy: StudentPolicy): boolean {
  if (!value || value.length > 200 || /[@\s]/.test(value)) return false;
  return new RegExp(policy.pseudonym_pattern).test(value);
}

type Scalar = string | number | boolean;

/** A value safe to store: a finite number, a boolean, or a short string that isn't PII. */
function safeScalar(value: unknown): Scalar | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.length <= 100 && !looksLikePii(value)) return value;
  return undefined;
}

function pick(source: unknown, keys: Iterable<string>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const v = safeScalar(record[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ── URLs ──────────────────────────────────────────────────────────────────

/** Segments that identify a record (and so possibly a student): numbers, UUIDs, long hex or tokens. */
const ID_SEGMENT = /^(?:\d{3,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

/** A path with ids replaced by ":id" and anything with "@" by ":redacted". */
export function sanitizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment.
      }
      if (decoded.includes('@') || looksLikePii(decoded)) return ':redacted';
      return ID_SEGMENT.test(decoded) ? ':id' : segment;
    })
    .join('/');
}

/** Origin plus sanitized path; no query string or fragment. '' when it isn't an http(s) URL. */
export function sanitizeUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.origin}${sanitizePath(u.pathname)}`;
  } catch {
    return '';
  }
}

/** The referrer's origin only: where a visit came from, not which page. */
export function sanitizeReferrer(referrer: unknown): string {
  if (typeof referrer !== 'string' || !referrer) return '';
  try {
    const u = new URL(referrer);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

// ── Events ────────────────────────────────────────────────────────────────

/** Properties Dataflare's own events may keep. Free text (click labels, error messages) never is. */
const SYSTEM_PROPS: Record<string, readonly string[]> = {
  $pageview: [],
  $pageleave: ['duration_ms'],
  $click: ['tag', 'outbound'],
  $exception: ['type'],
  $web_vitals: ['metric', 'value'],
  $exposure: ['flag', 'variant'],
  $identify: [],
  $set: [],
};

export interface SanitizedEvent {
  /** The event to store, or null to drop it. */
  event: WireEvent | null;
  /** Why something was removed, for counters and tests; never contains the removed value. */
  removed: string[];
}

/**
 * Apply student mode to one wire event. Device and session ids are always cleared so
 * the Worker derives cookieless ones; an `$identify` without a valid pseudonym is
 * dropped, as is any user id that isn't one.
 */
export function sanitizeMinorsEvent(e: WireEvent, policy: StudentPolicy): SanitizedEvent {
  const removed: string[] = [];
  let user: string | null = null;
  if (typeof e.user_id === 'string' && e.user_id) {
    if (isPseudonym(e.user_id, policy)) user = e.user_id;
    else removed.push('user_id');
  }
  if (e.event === '$identify' && !user) return { event: null, removed: [...removed, 'event'] };

  const system = Object.hasOwn(SYSTEM_PROPS, e.event) ? SYSTEM_PROPS[e.event]! : null;
  if (e.event.startsWith('$') && !system) return { event: null, removed: ['event'] };
  const allowed = system ?? policy.event_properties;
  const rawProps = (e.props && typeof e.props === 'object' ? e.props : {}) as Record<
    string,
    unknown
  >;
  const props: Record<string, unknown> = pick(rawProps, allowed);
  if (e.event === '$click' && typeof rawProps.href === 'string') {
    const href = sanitizeUrl(rawProps.href);
    if (href) props.href = href;
  }
  for (const key of Object.keys(rawProps))
    if (!(key in props) && key !== '$set' && key !== '$set_once') removed.push(`props.${key}`);

  if (e.event === '$identify' || e.event === '$set') {
    for (const op of ['$set', '$set_once'] as const) {
      const value = rawProps[op];
      if (!value || typeof value !== 'object') continue;
      const kept = pick(value, policy.person_properties);
      for (const key of Object.keys(value as object))
        if (!(key in kept)) removed.push(`${op}.${key}`);
      if (Object.keys(kept).length) props[op] = kept;
    }
  }

  const flags: Record<string, string> = {};
  if (e.flags && typeof e.flags === 'object')
    for (const [k, v] of Object.entries(e.flags))
      if (typeof v === 'string' && v.length <= 100 && k.length <= 100) flags[k] = v;

  return {
    event: {
      id: e.id,
      event: e.event,
      ts: e.ts,
      distinct_id: null,
      session_id: null,
      user_id: user,
      url: sanitizeUrl(e.url),
      referrer: sanitizeReferrer(e.referrer),
      title: '',
      props,
      flags,
    },
    removed,
  };
}

// ── Replay ────────────────────────────────────────────────────────────────

/** rrweb event and node types this module reads. */
const RR = {
  FullSnapshot: 2,
  Incremental: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
  Mutation: 0,
  Input: 5,
  Text: 3,
  CDATA: 4,
  Comment: 5,
} as const;

/** Attributes kept on replayed elements: layout and styling only. Everything else could carry text. */
const SAFE_ATTRIBUTES = new Set([
  'class',
  'style',
  '_cssText',
  'type',
  'role',
  'rel',
  'media',
  'charset',
  'width',
  'height',
  'rr_width',
  'rr_height',
  'rr_dataURL',
  'colspan',
  'rowspan',
  'tabindex',
  'disabled',
  'checked',
  'selected',
  'hidden',
  'dir',
  'lang',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'xmlns',
]);
const URL_ATTRIBUTES = new Set(['href', 'src']);

/** Replace every visible character with "*", keeping whitespace so layout survives. */
export const maskText = (text: string): string => text.replace(/\S/g, '*');

function scrubAttributes(
  attrs: Record<string, unknown> | undefined,
  tag: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs || typeof attrs !== 'object') return out;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) {
      out[name] = null; // a removal in a mutation
      continue;
    }
    if (name === 'rr_dataURL') continue; // inlined canvas/image pixels
    if (URL_ATTRIBUTES.has(name)) {
      // Stylesheets and scripts keep their location so the page renders; images and links don't.
      const keep = tag === 'link' || tag === 'script' || tag === undefined;
      if (keep && typeof value === 'string') {
        const url = sanitizeUrl(value);
        if (url) out[name] = url;
      }
      continue;
    }
    if (SAFE_ATTRIBUTES.has(name)) out[name] = value;
  }
  return out;
}

interface RrNode {
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  isStyle?: boolean;
  childNodes?: RrNode[];
  [key: string]: unknown;
}

function scrubNode(node: RrNode): RrNode {
  if (!node || typeof node !== 'object') return node;
  const out: RrNode = { ...node };
  if (
    (node.type === RR.Text || node.type === RR.CDATA || node.type === RR.Comment) &&
    typeof node.textContent === 'string' &&
    !node.isStyle
  ) {
    out.textContent = maskText(node.textContent);
  }
  if (node.attributes) out.attributes = scrubAttributes(node.attributes, node.tagName);
  if (Array.isArray(node.childNodes)) out.childNodes = node.childNodes.map(scrubNode);
  return out;
}

/** Custom events kept, with their payload reduced: navigation only. */
function scrubCustom(data: { tag?: unknown; payload?: unknown }): unknown | null {
  if (data?.tag === 'glass:url') {
    const href = sanitizeUrl((data.payload as { href?: unknown })?.href);
    return href ? { tag: 'glass:url', payload: { href } } : null;
  }
  return null; // glass:console, glass:network and anything the page added
}

export interface ReplayEventLike {
  type: number;
  timestamp: number;
  // biome-ignore lint/suspicious/noExplicitAny: rrweb payloads are heterogeneous
  data?: any;
}

/**
 * Mask a chunk of rrweb events for student mode. Text, input values, free-text
 * attributes, image sources, console and network records never reach storage.
 */
export function scrubReplayEvents(events: ReplayEventLike[]): ReplayEventLike[] {
  const out: ReplayEventLike[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const { type, data } = event;
    if (type === RR.FullSnapshot) {
      out.push({ ...event, data: { ...data, node: scrubNode(data?.node) } });
    } else if (type === RR.Meta) {
      out.push({ ...event, data: { ...data, href: sanitizeUrl(data?.href) } });
    } else if (type === RR.Custom) {
      const kept = scrubCustom(data);
      if (kept) out.push({ ...event, data: kept });
    } else if (type === RR.Plugin) {
      // Plugins record arbitrary page data.
    } else if (type === RR.Incremental && data?.source === RR.Mutation) {
      out.push({
        ...event,
        data: {
          ...data,
          texts: (data.texts ?? []).map((t: { value?: unknown }) => ({
            ...t,
            value: typeof t.value === 'string' ? maskText(t.value) : t.value,
          })),
          attributes: (data.attributes ?? []).map(
            (a: { attributes?: Record<string, unknown> }) => ({
              ...a,
              attributes: scrubAttributes(a.attributes, undefined),
            }),
          ),
          adds: (data.adds ?? []).map((a: { node?: RrNode }) => ({
            ...a,
            node: scrubNode(a.node as RrNode),
          })),
        },
      });
    } else if (type === RR.Incremental && data?.source === RR.Input) {
      out.push({
        ...event,
        data: { ...data, text: typeof data.text === 'string' ? maskText(data.text) : '' },
      });
    } else {
      out.push(event);
    }
  }
  return out;
}
