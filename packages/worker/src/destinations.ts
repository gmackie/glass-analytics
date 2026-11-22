/**
 * Destinations: forward events to other tools as they arrive.
 *
 * After ingest writes a batch, each event is matched against the project's
 * enabled destinations and every match becomes a delivery message. Messages go
 * to the DELIVERIES queue (Cloudflare Queues, on every plan), whose consumer
 * renders the template and sends the request, retrying failures with backoff.
 * Without a queue binding — or when sending to it fails — messages go to the
 * D1 outbox instead, which the five-minute task delivers. Deliveries that still
 * fail after the retries are logged with the message, so they can be retried by
 * hand; every hour's deliveries, failures and skips are counted per destination.
 *
 * Secrets (access tokens, webhook URLs) are stored AES-GCM encrypted.
 */

import { decryptJson, encryptJson, secretKey } from '@dataflare/core/crypto';
import {
  type DeliveryEvent,
  type DeliveryRequest,
  type DestinationTemplate,
  TEMPLATES,
} from '@dataflare/core/destinations/index';
import { NOTICE_RENDERERS, type Notice } from '@dataflare/core/destinations/notices';
import type { StoredEvent } from '@dataflare/core/events';
import { type Filter, matchEventFilter } from '@dataflare/core/filters';
import type { D1Database, D1PreparedStatement, Env, MessageBatch } from './env.ts';
import { HttpError } from './http.ts';

let deliveryFetch: typeof fetch = (input, init) => fetch(input, init);

/** Tests (and the dev server) can route deliveries to a fake fetch. */
export function configureDeliveries(options: { fetch?: typeof fetch }): void {
  if (options.fetch) deliveryFetch = options.fetch;
}

/** Retries before a delivery is logged as failed. */
export const MAX_ATTEMPTS = 6;
/** Events that are bookkeeping, not behaviour: not forwarded unless named explicitly. */
const BOOKKEEPING = new Set(['$pageleave', '$web_vitals', '$exposure']);

interface DestinationMatch {
  /** Event names; ["*"] for everything. */
  events?: string[];
  filters?: Filter[];
}

export interface Destination {
  id: string;
  name: string;
  template: string;
  enabled: boolean;
  match: DestinationMatch;
  config: Record<string, unknown>;
  /** Names of secret inputs that are set (values are never returned). */
  secretsSet: string[];
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  template: string;
  enabled: number;
  match: string;
  config: string;
  secrets: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryMessage {
  v: 1;
  project: string;
  destination: string;
  event: DeliveryEvent;
}

/** The key secrets are encrypted with: GLASS_ENCRYPTION_KEY, or derived from the salt secret. */
export function encryptionKey(env: Env): Promise<CryptoKey> {
  const secret = env.GLASS_ENCRYPTION_KEY ?? env.GLASS_SALT_SECRET ?? env.GLASS_ADMIN_KEY;
  if (!secret)
    throw new HttpError(
      503,
      'No secret to encrypt destination credentials with',
      'Run `dataflare upgrade`.',
    );
  return secretKey(secret);
}

/** Inputs whose values are stored encrypted and never shown again. */
function secretInputs(template: DestinationTemplate): Set<string> {
  return new Set(
    template.inputs.filter((i) => i.type === 'secret' || i.key === 'headers').map((i) => i.key),
  );
}

function templateOf(id: string): DestinationTemplate {
  const t = TEMPLATES[id];
  if (!t) {
    throw new HttpError(
      400,
      `Unknown destination template "${id}"`,
      `Templates: ${Object.keys(TEMPLATES).join(', ')}.`,
    );
  }
  return t;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

async function toDestination(env: Env, r: Row): Promise<Destination> {
  let secretsSet: string[] = [];
  if (r.secrets) {
    try {
      secretsSet = Object.keys(
        await decryptJson<Record<string, unknown>>(await encryptionKey(env), r.secrets),
      );
    } catch {
      secretsSet = [];
    }
  }
  return {
    id: r.id,
    name: r.name,
    template: r.template,
    enabled: r.enabled === 1,
    match: parse<DestinationMatch>(r.match, {}),
    config: parse<Record<string, unknown>>(r.config, {}),
    secretsSet,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listDestinations(env: Env, project: string): Promise<Destination[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM destinations WHERE project = ? ORDER BY name',
  )
    .bind(project)
    .all<Row>();
  return Promise.all(results.map((r) => toDestination(env, r)));
}

async function row(db: D1Database, project: string, id: string): Promise<Row> {
  const r = await db
    .prepare('SELECT * FROM destinations WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<Row>();
  if (!r) throw new HttpError(404, `No destination "${id}"`);
  return r;
}

export async function getDestination(env: Env, project: string, id: string): Promise<Destination> {
  return toDestination(env, await row(env.DB, project, id));
}

export interface DestinationInput {
  id?: string;
  name?: string;
  template?: string;
  enabled?: boolean;
  events?: string[];
  filters?: Filter[];
  /** Template inputs; secret ones are encrypted. Omit a secret to keep it, null to clear it. */
  inputs?: Record<string, unknown>;
}

const cache = new Map<
  string,
  { list: (Destination & { secrets: Record<string, unknown> })[]; until: number }
>();

export function clearDestinationCache(): void {
  cache.clear();
}

/** Create or update a destination. */
type Template = ReturnType<typeof templateOf>;

async function existingDestination(
  env: Env,
  project: string,
  id: string | undefined,
): Promise<Row | null> {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM destinations WHERE project = ? AND id = ?')
    .bind(project, id)
    .first<Row>();
}

/** The template's inputs into config or secrets (credentials); null removes one. */
function applyInputs(
  template: Template,
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): void {
  const secretKeys = secretInputs(template);
  for (const [k, v] of Object.entries(inputs)) {
    if (!template.inputs.some((i) => i.key === k))
      throw new HttpError(
        400,
        `"${k}" is not an input of ${template.name}`,
        `Inputs: ${template.inputs.map((i) => i.key).join(', ')}.`,
      );
    const target = secretKeys.has(k) ? secrets : config;
    if (v === null) delete target[k];
    else target[k] = v;
  }
  const missing = template.inputs.filter(
    (i) => i.required && (secretKeys.has(i.key) ? secrets : config)[i.key] === undefined,
  );
  if (missing.length)
    throw new HttpError(400, `${template.name} needs ${missing.map((m) => m.label).join(', ')}`);
}

/** Which events go: the saved match with the input's events and filters on top. */
function matchOf(
  existing: Row | null,
  input: DestinationInput,
  template: Template,
): DestinationMatch {
  const match: DestinationMatch = {
    ...(existing ? parse<DestinationMatch>(existing.match, {}) : {}),
    ...(input.events !== undefined ? { events: input.events } : {}),
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
  };
  if (!match.events?.length && !template.defaultEvents)
    throw new HttpError(
      400,
      'Name the events to send',
      'e.g. "events": ["signup_completed"], or ["*"] for every event.',
    );
  return match;
}

export async function saveDestination(
  env: Env,
  project: string,
  input: DestinationInput,
): Promise<Destination> {
  const existing = await existingDestination(env, project, input.id);
  const template = templateOf(input.template ?? existing?.template ?? '');
  if (existing && input.template && input.template !== existing.template)
    throw new HttpError(
      400,
      "A destination's template can't change",
      'Create a new destination instead.',
    );
  const key = await encryptionKey(env);
  const secrets: Record<string, unknown> = existing?.secrets
    ? await decryptJson<Record<string, unknown>>(key, existing.secrets).catch(() => ({}))
    : {};
  const config: Record<string, unknown> = existing ? parse(existing.config, {}) : {};
  applyInputs(template, input.inputs ?? {}, config, secrets);
  const match = matchOf(existing, input, template);
  const now = Date.now();
  const id = existing?.id ?? input.id ?? crypto.randomUUID().slice(0, 12);
  const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
  await env.DB.prepare(
    `INSERT INTO destinations (project, id, name, template, enabled, match, config, secrets, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, match = excluded.match,
       config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at`,
  )
    .bind(
      project,
      id,
      input.name ?? existing?.name ?? template.name,
      template.id,
      enabled ? 1 : 0,
      JSON.stringify(match),
      JSON.stringify(config),
      Object.keys(secrets).length ? await encryptJson(key, secrets) : null,
      existing?.created_at ?? now,
      now,
    )
    .run();
  cache.delete(project);
  return getDestination(env, project, id);
}

export async function deleteDestination(env: Env, project: string, id: string): Promise<void> {
  const res = await env.DB.prepare('DELETE FROM destinations WHERE project = ? AND id = ?')
    .bind(project, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `No destination "${id}"`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM destination_failures WHERE project = ? AND destination = ?').bind(
      project,
      id,
    ),
    env.DB.prepare('DELETE FROM destination_stats WHERE project = ? AND destination = ?').bind(
      project,
      id,
    ),
    env.DB.prepare('DELETE FROM delivery_outbox WHERE project = ? AND destination = ?').bind(
      project,
      id,
    ),
  ]);
  cache.delete(project);
}

/** Enabled destinations with decrypted secrets, cached briefly (ingest reads them on every batch). */
async function activeDestinations(env: Env, project: string) {
  const hit = cache.get(project);
  if (hit && hit.until > Date.now()) return hit.list;
  const { results } = await env.DB.prepare(
    'SELECT * FROM destinations WHERE project = ? AND enabled = 1',
  )
    .bind(project)
    .all<Row>();
  const key = results.length ? await encryptionKey(env) : null;
  const list = await Promise.all(
    results.map(async (r) => ({
      ...(await toDestination(env, r)),
      secrets:
        r.secrets && key
          ? await decryptJson<Record<string, unknown>>(key, r.secrets).catch(() => ({}))
          : {},
    })),
  );
  cache.set(project, { list, until: Date.now() + 10_000 });
  return list;
}

/** A stored row as destinations see it. */
export function deliveryEvent(row: StoredEvent): DeliveryEvent {
  const json = (s: string) => parse<Record<string, unknown>>(s, {});
  return {
    id: row.id,
    event: row.event,
    ts_ms: row.ts_ms,
    distinct_id: row.distinct_id,
    user_id: row.user_id,
    person_id: row.person_id,
    session_id: row.session_id,
    url: row.url,
    host: row.host,
    path: row.path,
    referrer: row.referrer,
    title: row.title,
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_term: row.utm_term,
    utm_content: row.utm_content,
    country: row.country,
    region: row.region,
    city: row.city,
    device: row.device,
    browser: row.browser,
    os: row.os,
    props: json(row.props),
    person: json(row.person_props),
    flags: json(row.flags) as Record<string, string>,
  };
}

function matches(d: { template: string; match: DestinationMatch }, e: DeliveryEvent): boolean {
  const events = d.match.events?.length
    ? d.match.events
    : (TEMPLATES[d.template]?.defaultEvents ?? []);
  const named = events.includes(e.event);
  if (!named && !(events.includes('*') && !BOOKKEEPING.has(e.event))) return false;
  return (d.match.filters ?? []).every((f) =>
    matchEventFilter(f, { ...e, props: e.props, person: e.person }),
  );
}

/** After ingest: queue a delivery for every event × matching destination. */
export async function enqueueDeliveries(
  rows: StoredEvent[],
  env: Env,
  project: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const destinations = await activeDestinations(env, project);
  if (destinations.length === 0) return 0;
  const messages: DeliveryMessage[] = [];
  for (const r of rows) {
    const e = deliveryEvent(r);
    for (const d of destinations)
      if (matches(d, e)) messages.push({ v: 1, project, destination: d.id, event: e });
  }
  return sendMessages(env, messages);
}

/** Queue deliveries (or put them in the outbox when there's no queue, or it refuses them). */
export async function sendMessages(env: Env, messages: DeliveryMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  if (env.DELIVERIES) {
    try {
      for (let i = 0; i < messages.length; i += 100) {
        await env.DELIVERIES.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
      }
      return messages.length;
    } catch (err) {
      console.error('[glass] queue send failed; using the outbox', err);
    }
  }
  await toOutbox(env.DB, messages, Date.now());
  return messages.length;
}

async function toOutbox(
  db: D1Database,
  messages: DeliveryMessage[],
  at: number,
  attempts = 0,
): Promise<void> {
  for (let i = 0; i < messages.length; i += 50) {
    await db.batch(
      messages
        .slice(i, i + 50)
        .map((m) =>
          db
            .prepare(
              'INSERT INTO delivery_outbox (id, project, destination, message, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              crypto.randomUUID(),
              m.project,
              m.destination,
              JSON.stringify(m),
              attempts,
              at,
              Date.now(),
            ),
        ),
    );
  }
}

export interface DeliveryOutcome {
  ok: boolean;
  /** A retry might work (network error, 429, 5xx). */
  retryable: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
  /** The first part of the response, for test sends. */
  response?: string;
}

/** Render and send one delivery. */
async function deliver(
  m: DeliveryMessage,
  destination: {
    template: string;
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  },
  fetcher: typeof fetch = deliveryFetch,
): Promise<DeliveryOutcome> {
  const template = TEMPLATES[destination.template];
  if (!template)
    return { ok: false, retryable: false, error: `Unknown template ${destination.template}` };
  let requests: DeliveryRequest[] | null;
  try {
    requests = await template.render(m.event, { ...destination.config, ...destination.secrets });
  } catch (err) {
    return {
      ok: false,
      retryable: false,
      error: `Render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!requests || requests.length === 0) return { ok: true, retryable: false, skipped: true };
  let response = '';
  for (const r of requests) {
    let res: Response;
    try {
      res = await fetcher(r.url, { method: r.method, headers: r.headers, body: r.body });
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    response = (await res.text().catch(() => '')).slice(0, 500);
    if (!res.ok) {
      return {
        ok: false,
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
        error: `HTTP ${res.status}: ${response.slice(0, 200)}`,
        response,
      };
    }
  }
  return { ok: true, retryable: false, response };
}

/** Backoff before attempt n (1-based): 10s, 40s, 2.5m, 10m, 40m… */
const backoffSeconds = (attempt: number) => Math.min(6 * 3600, 10 * 4 ** (attempt - 1));

type Counter = Map<
  string,
  { project: string; destination: string; delivered: number; failed: number; skipped: number }
>;
const count = (c: Counter, m: DeliveryMessage, field: 'delivered' | 'failed' | 'skipped') => {
  const k = `${m.project}\u0000${m.destination}`;
  const s = c.get(k) ?? {
    project: m.project,
    destination: m.destination,
    delivered: 0,
    failed: 0,
    skipped: 0,
  };
  s[field]++;
  c.set(k, s);
};

/**
 * The bookkeeping after a round of deliveries, as statements for one `db.batch()`: hourly
 * counts, failure logs (the latest 200 per destination are kept) and any other writes. One
 * batch keeps a round well inside D1's per-invocation query limit on the Free plan.
 */
function bookkeeping(
  db: D1Database,
  stats: Counter,
  failures: { m: DeliveryMessage; outcome: DeliveryOutcome }[],
): D1PreparedStatement[] {
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const out = [...stats.values()].map((s) =>
    db
      .prepare(
        `INSERT INTO destination_stats (project, destination, hour, delivered, failed, skipped) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, destination, hour) DO UPDATE SET delivered = delivered + excluded.delivered,
           failed = failed + excluded.failed, skipped = skipped + excluded.skipped`,
      )
      .bind(s.project, s.destination, hour, s.delivered, s.failed, s.skipped),
  );
  const trimmed = new Set<string>();
  for (const { m, outcome } of failures) {
    out.push(
      db
        .prepare(
          'INSERT INTO destination_failures (project, id, destination, event_id, at, status, error, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          m.project,
          crypto.randomUUID(),
          m.destination,
          m.event.id,
          Date.now(),
          outcome.status ?? null,
          outcome.error ?? 'failed',
          JSON.stringify(m),
        ),
    );
    trimmed.add(`${m.project}\u0000${m.destination}`);
  }
  for (const k of trimmed) {
    const [project, destination] = k.split('\u0000');
    out.push(
      db
        .prepare(
          `DELETE FROM destination_failures WHERE project = ?1 AND destination = ?2 AND id NOT IN (
             SELECT id FROM destination_failures WHERE project = ?1 AND destination = ?2 ORDER BY at DESC LIMIT 200)`,
        )
        .bind(project, destination),
    );
  }
  return out;
}

async function destinationFor(env: Env, m: DeliveryMessage) {
  return (await activeDestinations(env, m.project)).find((d) => d.id === m.destination);
}

/** The Worker's queue() handler. */
export async function consumeDeliveries(
  batch: MessageBatch<DeliveryMessage>,
  env: Env,
): Promise<void> {
  const stats: Counter = new Map();
  const failures: { m: DeliveryMessage; outcome: DeliveryOutcome }[] = [];
  for (const msg of batch.messages) {
    const m = msg.body;
    const d = await destinationFor(env, m);
    // Deleted or disabled since it was queued: drop it.
    if (!d) {
      msg.ack();
      continue;
    }
    const outcome = await deliver(m, d);
    if (outcome.ok) {
      count(stats, m, outcome.skipped ? 'skipped' : 'delivered');
      msg.ack();
    } else if (outcome.retryable && msg.attempts < MAX_ATTEMPTS) {
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    } else {
      count(stats, m, 'failed');
      failures.push({ m, outcome });
      msg.ack();
    }
  }
  const writes = bookkeeping(env.DB, stats, failures);
  if (writes.length) await env.DB.batch(writes);
}

/** Outbox deliveries per five-minute tick: keeps the tick inside the Free plan's 50 subrequests. */
const OUTBOX_PER_TICK = 20;

/**
 * Maintenance: deliver what is due in the outbox (no queue bound, failed enqueues, retries).
 * Rows are claimed first (their next try is pushed five minutes out), so an overlapping run
 * never sends the same delivery twice.
 */
export async function drainOutbox(env: Env, now: number, limit = OUTBOX_PER_TICK): Promise<number> {
  const { results } = await env.DB.prepare(
    `UPDATE delivery_outbox SET next_at = ?1 WHERE id IN (
       SELECT id FROM delivery_outbox WHERE next_at <= ?2 ORDER BY next_at LIMIT ?3)
     RETURNING id, message, attempts`,
  )
    .bind(now + 300_000, now, limit)
    .all<{ id: string; message: string; attempts: number }>();
  const stats: Counter = new Map();
  const failures: { m: DeliveryMessage; outcome: DeliveryOutcome }[] = [];
  const writes: D1PreparedStatement[] = [];
  const done = (id: string) =>
    writes.push(env.DB.prepare('DELETE FROM delivery_outbox WHERE id = ?').bind(id));
  let sent = 0;
  for (const r of results) {
    const m = JSON.parse(r.message) as DeliveryMessage;
    const d = await destinationFor(env, m);
    const attempts = r.attempts + 1;
    if (!d) {
      done(r.id);
      continue;
    }
    const outcome = await deliver(m, d);
    if (outcome.ok) {
      count(stats, m, outcome.skipped ? 'skipped' : 'delivered');
      sent++;
      done(r.id);
    } else if (outcome.retryable && attempts < MAX_ATTEMPTS) {
      writes.push(
        env.DB.prepare('UPDATE delivery_outbox SET attempts = ?, next_at = ? WHERE id = ?').bind(
          attempts,
          now + backoffSeconds(attempts) * 1000,
          r.id,
        ),
      );
    } else {
      count(stats, m, 'failed');
      failures.push({ m, outcome });
      done(r.id);
    }
  }
  writes.push(...bookkeeping(env.DB, stats, failures));
  if (writes.length) await env.DB.batch(writes);
  return sent;
}

/** Requeue logged failures (all, or some ids) for another try. */
export async function retryFailures(
  env: Env,
  project: string,
  destination: string,
  ids?: string[],
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, message FROM destination_failures WHERE project = ?1 AND destination = ?2
     ${ids?.length ? 'AND id IN (SELECT value FROM json_each(?3))' : ''} ORDER BY at LIMIT 500`,
  )
    .bind(project, destination, ...(ids?.length ? [JSON.stringify(ids)] : []))
    .all<{ id: string; message: string }>();
  if (results.length === 0) return 0;
  await toOutbox(
    env.DB,
    results.map((r) => JSON.parse(r.message) as DeliveryMessage),
    Date.now(),
  );
  await env.DB.prepare(
    'DELETE FROM destination_failures WHERE project = ?1 AND id IN (SELECT value FROM json_each(?2))',
  )
    .bind(project, JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}

export async function destinationActivity(db: D1Database, project: string, id: string, hours = 48) {
  const since = Date.now() - hours * 3_600_000;
  const [{ results: stats }, { results: failures }, pending] = await Promise.all([
    db
      .prepare(
        'SELECT hour, delivered, failed, skipped FROM destination_stats WHERE project = ? AND destination = ? AND hour >= ? ORDER BY hour',
      )
      .bind(project, id, since)
      .all<{ hour: number; delivered: number; failed: number; skipped: number }>(),
    db
      .prepare(
        'SELECT id, event_id, at, status, error FROM destination_failures WHERE project = ? AND destination = ? ORDER BY at DESC LIMIT 20',
      )
      .bind(project, id)
      .all<{ id: string; event_id: string; at: number; status: number | null; error: string }>(),
    db
      .prepare('SELECT COUNT(*) AS n FROM delivery_outbox WHERE project = ? AND destination = ?')
      .bind(project, id)
      .first<{ n: number }>(),
  ]);
  const totals = stats.reduce(
    (a, s) => ({
      delivered: a.delivered + s.delivered,
      failed: a.failed + s.failed,
      skipped: a.skipped + s.skipped,
    }),
    { delivered: 0, failed: 0, skipped: 0 },
  );
  return {
    hours,
    totals,
    pending: Number(pending?.n ?? 0),
    byHour: stats.map((s) => ({ ...s, hour: new Date(s.hour).toISOString() })),
    failures: failures.map((f) => ({ ...f, at: new Date(f.at).toISOString() })),
  };
}

/**
 * Send a report or alert to a destination now (not through the queue: reports are already
 * scheduled work, and their links are what matters). Reports go even to a paused destination,
 * since the subscription chose it; a template that can't carry notices is an error.
 */
export async function sendNotice(
  env: Env,
  project: string,
  id: string,
  notice: Notice,
  fetcher: typeof fetch = deliveryFetch,
): Promise<DeliveryOutcome> {
  const r = await row(env.DB, project, id);
  const render = NOTICE_RENDERERS[r.template];
  if (!render)
    return {
      ok: false,
      retryable: false,
      error: `${r.name} (${r.template}) can't receive reports or alerts.`,
    };
  const secrets = r.secrets
    ? await decryptJson<Record<string, unknown>>(await encryptionKey(env), r.secrets)
    : {};
  const requests = render(notice, { ...parse(r.config, {}), ...secrets });
  for (const req of requests) {
    let res: Response;
    try {
      res = await fetcher(req.url, { method: req.method, headers: req.headers, body: req.body });
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
        error: `HTTP ${res.status}: ${text}`,
      };
    }
  }
  return { ok: true, retryable: false };
}

/** Send a sample (or a given) event through a destination now, and report what happened. */
export async function testDestination(
  env: Env,
  project: string,
  id: string,
  event: Partial<DeliveryEvent> = {},
  fetcher?: typeof fetch,
): Promise<DeliveryOutcome & { event: DeliveryEvent }> {
  const r = await row(env.DB, project, id);
  const key = await encryptionKey(env);
  const secrets = r.secrets ? await decryptJson<Record<string, unknown>>(key, r.secrets) : {};
  const match = parse<DestinationMatch>(r.match, {});
  const now = Date.now();
  const sample: DeliveryEvent = {
    id: crypto.randomUUID(),
    event:
      match.events?.find((e) => e !== '*') ??
      TEMPLATES[r.template]?.defaultEvents?.[0] ??
      'dataflare_test',
    ts_ms: now,
    distinct_id: 'test-device',
    user_id: 'test-user',
    person_id: 'test-user',
    session_id: 'test-session',
    url: 'https://example.com/pricing',
    host: 'example.com',
    path: '/pricing',
    referrer: '',
    title: 'Pricing',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    country: 'GB',
    region: '',
    city: '',
    device: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    props: { test: true, amount: 49, currency: 'GBP' },
    person: { email: 'test@example.com', name: 'Test User' },
    flags: {},
    ...event,
  };
  const outcome = await deliver(
    { v: 1, project, destination: id, event: sample },
    { template: r.template, config: parse(r.config, {}), secrets },
    fetcher,
  );
  return { ...outcome, event: sample };
}
