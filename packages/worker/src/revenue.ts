/**
 * Revenue in the Worker: converting revenue events to the base currency at
 * ingest, keeping ECB exchange rates fresh, and Stripe as a revenue source
 * (a signed webhook, customer → person linking, the connection settings).
 */

import { decryptJson, encryptJson } from '@dataflare/core/crypto';
import type { StoredEvent } from '@dataflare/core/events';
import {
  ECB_90_DAYS,
  ECB_DAILY,
  type FxRate,
  parseEcbXml,
  type RateTable,
} from '@dataflare/core/fx';
import { applyRevenue, revenueCurrencies } from '@dataflare/core/revenue';
import {
  linkFromCustomer,
  STRIPE_EVENT_TYPES,
  type StripeCustomerLink,
  type StripeLink,
  stripeEvents,
  verifyStripeSignature,
} from '@dataflare/core/stripe';
import { encryptionKey } from './destinations.ts';
import type { Env } from './env.ts';
import { HttpError, readText } from './http.ts';
import { type EnrichContext, ingestBatch, requestInfo } from './ingest.ts';
import { getProject } from './projects.ts';
import type { EventStore } from './stores/types.ts';

let revenueFetch: typeof fetch = (input, init) => fetch(input, init);
export function configureRevenue(options: { fetch?: typeof fetch }): void {
  if (options.fetch) revenueFetch = options.fetch;
}

// ── Exchange rates ─────────────────────────────────────────────────────────

const tables = new Map<string, Map<string, number>>();
export function clearRateCache(): void {
  tables.clear();
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The rates in force on a day: the latest ECB day on or before it. */
async function ratesFor(env: Env, day: string): Promise<RateTable> {
  const hit = tables.get(day);
  if (hit) return hit;
  const { results } = await env.DB.prepare(
    'SELECT currency, rate FROM fx_rates WHERE day = (SELECT MAX(day) FROM fx_rates WHERE day <= ?)',
  )
    .bind(day)
    .all<{ currency: string; rate: number }>();
  const table = new Map(results.map((r) => [r.currency, r.rate]));
  // An empty table isn't cached: rates may arrive later today.
  if (table.size) {
    tables.set(day, table);
    if (tables.size > 200) tables.delete(tables.keys().next().value!);
  }
  return table;
}

export async function storeRates(env: Env, rates: FxRate[]): Promise<number> {
  for (let i = 0; i < rates.length; i += 50) {
    await env.DB.batch(
      rates
        .slice(i, i + 50)
        .map((r) =>
          env.DB.prepare(
            'INSERT OR REPLACE INTO fx_rates (day, currency, rate) VALUES (?, ?, ?)',
          ).bind(r.day, r.currency, r.rate),
        ),
    );
  }
  tables.clear();
  return rates.length;
}

/** The latest day the ECB has published by `now` (working days, after 16:00 UTC). */
function expectedRateDay(now: number): string {
  const d = new Date(now);
  if (d.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Maintenance (first tick of each hour): fetch the ECB rates when a project uses revenue and the
 * latest stored day is older than the latest published one. The first fetch takes 90 days.
 */
export async function refreshRates(env: Env, now: number): Promise<number> {
  if (new Date(now).getUTCMinutes() >= 5) return 0;
  const uses = await env.DB.prepare(
    "SELECT 1 AS yes FROM projects WHERE settings LIKE '%revenueEvents%' UNION ALL SELECT 1 FROM stripe_accounts LIMIT 1",
  ).first<{ yes: number }>();
  if (!uses) return 0;
  const latest = await env.DB.prepare('SELECT MAX(day) AS day FROM fx_rates').first<{
    day: string | null;
  }>();
  if (latest?.day && latest.day >= expectedRateDay(now)) return 0;
  const res = await revenueFetch(latest?.day ? ECB_DAILY : ECB_90_DAYS);
  if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
  return storeRates(env, parseEcbXml(await res.text()));
}

type RevenueRules = NonNullable<EnrichContext['project']['settings']['revenueEvents']>;

/** Cheap test first: most events are neither a rule's event nor carry $revenue_amount/$mrr_amount. */
function mayCarryRevenue(row: StoredEvent, rules: RevenueRules): boolean {
  if (rules.some((r) => r.event === row.event)) return true;
  return row.props.includes('"$revenue_amount"') || row.props.includes('"$mrr_amount"');
}

/** The event's props with revenue fields added, or null when it carries none. */
async function revenueProps(
  row: StoredEvent,
  rules: RevenueRules,
  base: string,
  env: Env,
): Promise<string | null> {
  let props: Record<string, unknown>;
  try {
    props = JSON.parse(row.props) as Record<string, unknown>;
  } catch {
    return null;
  }
  const currencies = revenueCurrencies(row.event, props, rules, base);
  if (currencies.length === 0) return null;
  const rates = currencies.every((c) => c === base)
    ? new Map<string, number>()
    : await ratesFor(env, dayOf(row.ts_ms));
  const next = applyRevenue(row.event, props, rules, base, rates);
  return next ? JSON.stringify(next) : null;
}

/**
 * The ingest step: add `$revenue_base` (and MRR fields) to revenue events, converting with the
 * rates for each event's day. Events with no rate for their currency keep `$revenue_unconverted`.
 */
export async function convertRevenue(
  rows: StoredEvent[],
  ctx: EnrichContext,
): Promise<StoredEvent[]> {
  const rules = ctx.project.settings.revenueEvents ?? [];
  const base = (ctx.project.settings.baseCurrency ?? 'USD').toUpperCase();
  let out: StoredEvent[] | null = null;
  for (const [i, row] of rows.entries()) {
    if (!mayCarryRevenue(row, rules)) continue;
    const props = await revenueProps(row, rules, base, ctx.env);
    if (props === null) continue;
    out ??= rows.slice();
    out[i] = { ...row, props };
  }
  return out ?? rows;
}

// ── Stripe ─────────────────────────────────────────────────────────────────

interface StripeConfig extends StripeLink {
  /** Match customers to people by email when the metadata has no id (the email is not stored). */
  linkByEmail?: boolean;
}

interface StripeSecrets {
  webhookSecret: string;
  apiKey?: string;
}

interface AccountRow {
  project: string;
  config: string;
  secrets: string | null;
  events: number;
  last_event_at: number | null;
  last_error: string | null;
  created_at: number;
}

async function account(env: Env, project: string) {
  const row = await env.DB.prepare('SELECT * FROM stripe_accounts WHERE project = ?')
    .bind(project)
    .first<AccountRow>();
  if (!row) return null;
  const secrets = row.secrets
    ? await decryptJson<StripeSecrets>(await encryptionKey(env), row.secrets).catch(() => null)
    : null;
  return { row, config: JSON.parse(row.config) as StripeConfig, secrets };
}

export async function connectStripe(
  env: Env,
  project: string,
  input: StripeConfig & { webhookSecret?: string; apiKey?: string | null },
  base: string,
) {
  const existing = await account(env, project);
  const secrets: Partial<StripeSecrets> = { ...(existing?.secrets ?? {}) };
  if (input.webhookSecret) secrets.webhookSecret = input.webhookSecret;
  if (input.apiKey === null) delete secrets.apiKey;
  else if (input.apiKey) secrets.apiKey = input.apiKey;
  if (!secrets.webhookSecret) {
    throw new HttpError(
      400,
      'webhookSecret is required (whsec_…)',
      `In Stripe: Developers › Webhooks › Add endpoint ${base}/hooks/stripe/${project}, then copy its signing secret.`,
    );
  }
  if (secrets.apiKey && !/^(rk|sk)_(live|test)_/.test(secrets.apiKey)) {
    throw new HttpError(
      400,
      'apiKey should be a restricted key (rk_live_… or rk_test_…) with read access to customers',
    );
  }
  const config: StripeConfig = {
    ...(existing?.config ?? {}),
    ...Object.fromEntries(
      Object.entries({
        personKey: input.personKey,
        groupType: input.groupType,
        groupKey: input.groupKey,
        linkByEmail: input.linkByEmail,
      }).filter(([, v]) => v !== undefined),
    ),
  };
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO stripe_accounts (project, config, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at`,
  )
    .bind(
      project,
      JSON.stringify(config),
      await encryptJson(await encryptionKey(env), secrets),
      now,
      now,
    )
    .run();
  return stripeStatus(env, project, base);
}

export async function stripeStatus(env: Env, project: string, base: string) {
  const a = await account(env, project);
  const customers = a
    ? await env.DB.prepare(
        'SELECT COUNT(*) AS n, SUM(CASE WHEN person IS NOT NULL THEN 1 ELSE 0 END) AS linked FROM stripe_customers WHERE project = ?',
      )
        .bind(project)
        .first<{ n: number; linked: number }>()
    : null;
  return {
    connected: Boolean(a),
    webhookUrl: `${base}/hooks/stripe/${project}`,
    events: STRIPE_EVENT_TYPES,
    ...(a
      ? {
          config: a.config,
          secretsSet: Object.keys(a.secrets ?? {}),
          received: a.row.events,
          lastEventAt: a.row.last_event_at ? new Date(a.row.last_event_at).toISOString() : null,
          lastError: a.row.last_error,
          customers: { known: Number(customers?.n ?? 0), linked: Number(customers?.linked ?? 0) },
        }
      : {}),
  };
}

export async function disconnectStripe(env: Env, project: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM stripe_accounts WHERE project = ?').bind(project),
    env.DB.prepare('DELETE FROM stripe_customers WHERE project = ?').bind(project),
  ]);
}

async function personByEmail(
  env: Env,
  project: string,
  email: string | undefined,
): Promise<string | null> {
  if (!email) return null;
  const row = await env.DB.prepare(
    "SELECT person_id FROM persons WHERE project = ? AND lower(json_extract(props, '$.email')) = lower(?) ORDER BY last_seen DESC LIMIT 1",
  )
    .bind(project, email.trim())
    .first<{ person_id: string }>();
  return row?.person_id ?? null;
}

async function rememberCustomer(
  env: Env,
  project: string,
  link: StripeCustomerLink,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stripe_customers (project, customer, person, grp, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project, customer) DO UPDATE SET person = COALESCE(excluded.person, stripe_customers.person),
       grp = COALESCE(excluded.grp, stripe_customers.grp), updated_at = excluded.updated_at`,
  )
    .bind(project, link.id, link.person ?? null, link.group ?? null, Date.now())
    .run();
}

/** Who a customer is: the stored link, else (with an API key) a lookup, else nothing. */
async function customerLink(
  env: Env,
  project: string,
  id: string,
  config: StripeConfig,
  secrets: StripeSecrets,
): Promise<StripeCustomerLink | null> {
  const known = await env.DB.prepare(
    'SELECT person, grp FROM stripe_customers WHERE project = ? AND customer = ?',
  )
    .bind(project, id)
    .first<{ person: string | null; grp: string | null }>();
  if (known?.person) return { id, person: known.person, group: known.grp };
  if (!secrets.apiKey) return known ? { id, person: known.person, group: known.grp } : null;
  const res = await revenueFetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${secrets.apiKey}` },
  });
  if (!res.ok) return null;
  const customer = (await res.json()) as Record<string, unknown>;
  const link = linkFromCustomer(customer, config);
  if (!link.person && config.linkByEmail)
    link.person = await personByEmail(env, project, customer.email as string | undefined);
  await rememberCustomer(env, project, link);
  return link;
}

/** `POST /hooks/stripe/<project>`: a signed Stripe event becomes Dataflare events. */
export async function handleStripeWebhook(
  request: Request,
  env: Env,
  store: EventStore,
  projectId: string,
  base: string,
  now = Date.now(),
): Promise<{ received: boolean; events: number }> {
  const a = await account(env, projectId);
  if (!a?.secrets?.webhookSecret)
    throw new HttpError(404, `Stripe is not connected for project "${projectId}"`);
  const body = await readText(request, 1_000_000);
  if (
    !(await verifyStripeSignature(
      request.headers.get('Stripe-Signature'),
      body,
      a.secrets.webhookSecret,
      now,
    ))
  ) {
    throw new HttpError(
      400,
      'Invalid Stripe signature',
      'Check the webhook signing secret (connect_stripe).',
    );
  }
  const event = JSON.parse(body) as Parameters<typeof stripeEvents>[0];
  const object = event.data?.object ?? {};
  if (event.type === 'customer.created' || event.type === 'customer.updated') {
    const link = linkFromCustomer(object, a.config);
    if (!link.person && a.config.linkByEmail)
      link.person = await personByEmail(env, projectId, object.email as string | undefined);
    await rememberCustomer(env, projectId, link);
    return { received: true, events: 0 };
  }
  const customerId =
    typeof object.customer === 'string'
      ? object.customer
      : (object.customer as { id?: string } | undefined)?.id;
  const link = customerId
    ? await customerLink(env, projectId, customerId, a.config, a.secrets)
    : null;
  const wire = stripeEvents(event, link, a.config);
  if (wire.length) {
    const project = await getProject(env.DB, projectId);
    if (!project) throw new HttpError(404, `Unknown project "${projectId}"`);
    await ingestBatch(
      { project: projectId, lib: 'stripe', sent_at: now, events: wire },
      project,
      requestInfo(request),
      env,
      store,
      now,
      {
        trusted: true,
        skipDestinations: false,
        base,
      },
    );
  }
  await env.DB.prepare(
    'UPDATE stripe_accounts SET events = events + 1, last_event_at = ?, last_error = NULL WHERE project = ?',
  )
    .bind(now, projectId)
    .run();
  return { received: true, events: wire.length };
}
