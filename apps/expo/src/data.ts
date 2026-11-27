import type { PathsResult } from '@dataflare/core/insights/paths';
import type { SiteRow } from '@dataflare/core/insights/sites';
import type { WebResult } from '@dataflare/core/insights/web';
import { z } from 'zod/v4';

export const periods = [7, 30, 90] as const;
export type Period = (typeof periods)[number];
export type Connection = { url: string; key: string };
export type Site = Pick<SiteRow, 'project' | 'visitors' | 'pageviews'>;
type Totals = Pick<WebResult['totals'], 'visitors' | 'pageviews' | 'sessions' | 'bounceRate'>;

const totals = z.object({
  visitors: z.number(),
  pageviews: z.number(),
  sessions: z.number(),
  bounceRate: z.number(),
  avgSessionSeconds: z.number().optional(),
  viewsPerSession: z.number().optional(),
}) satisfies z.ZodType<Totals>;

const rows = z.array(
  z.object({ value: z.string(), count: z.number(), visitors: z.number().optional() }),
);

export const reportSchema = z.object({
  kind: z.literal('web'),
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  totals,
  previous: totals.nullable(),
  timeseries: z.object({
    buckets: z.array(z.number()),
    visitors: z.array(z.number()),
    pageviews: z.array(z.number()).optional(),
  }),
  breakdowns: z.object({
    pages: rows,
    entry_pages: rows.optional(),
    exit_pages: rows.optional(),
    referrers: rows.optional(),
    utm_source: rows.optional(),
    utm_medium: rows.optional(),
    utm_campaign: rows.optional(),
    countries: rows.optional(),
    devices: rows.optional(),
    browsers: rows.optional(),
    os: rows.optional(),
  }),
});
export type Report = z.infer<typeof reportSchema>;

export type Paths = Pick<PathsResult, 'kind' | 'steps' | 'total' | 'nodes' | 'links' | 'topPaths'>;
const count = z.number().int().nonnegative();
export const pathsSchema = z.object({
  kind: z.literal('paths'),
  steps: z.number().int().min(2).max(10),
  total: count,
  nodes: z.array(
    z.object({
      id: z.string(),
      column: z.number().int().positive(),
      label: z.string(),
      count,
      dropOff: count,
      other: z.boolean().optional(),
    }),
  ),
  links: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      count,
      avgSeconds: z.number().nullable(),
    }),
  ),
  topPaths: z.array(z.object({ items: z.array(z.string()), count })),
}) satisfies z.ZodType<Paths>;

const siteList = z.object({
  sites: z.array(
    z.object({
      project: z.string(),
      visitors: z.number(),
      pageviews: z.number(),
    }) satisfies z.ZodType<Site>,
  ),
});

export function connectionFrom(url: string, key: string): Connection {
  let address: URL;
  try {
    address = new URL(url.trim());
  } catch {
    throw new Error('Enter the full Worker URL, including https://.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.protocol !== 'https:' && !(loopback && address.protocol === 'http:'))
    throw new Error(
      'Use HTTPS for a deployed Worker. HTTP is supported on localhost for development.',
    );
  if (address.username || address.password || address.search)
    throw new Error('Enter the Worker URL without credentials or query parameters.');
  if (!key.trim()) throw new Error('Enter the read key from dataflare key --read.');
  const path = address.pathname.replace(/\/+$/, '').replace(/\/(app|api)$/, '');
  return { url: address.origin + path, key: key.trim() };
}

/** Accept the clipboard output of `dataflare key --read --json` in the read-key field. */
export function pastedConnection(text: string): Connection | null {
  if (!text.trimStart().startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const parsed = z.object({ host: z.string(), key: z.string() }).safeParse(value);
  if (!parsed.success)
    throw new Error('Paste the full output of dataflare key --read --json, or enter the read key.');
  return connectionFrom(parsed.data.host, parsed.data.key);
}

async function request<T>(
  connection: Connection,
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${connection.key}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(connection.url + path, {
    method: body ? 'POST' : 'GET',
    headers,
    signal,
    ...(body && { body: JSON.stringify(body) }),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error(
      'The Worker rejected the key. Reconnect using the read key from dataflare key --read.',
    );
  if (!response.ok)
    throw new Error(
      `The Worker returned HTTP ${response.status}. Check its address and try again.`,
    );
  const result = schema.safeParse(await response.json().catch(() => null));
  if (!result.success)
    throw new Error(
      'This address did not return the expected Dataflare API response. Check the Worker URL.',
    );
  return result.data;
}

export async function verifyConnection(connection: Connection, signal?: AbortSignal) {
  await request(
    connection,
    '/api',
    z.object({ name: z.literal('Dataflare'), scope: z.enum(['read', 'admin']) }),
    signal,
  );
}

export async function fetchSites(connection: Connection, days: Period, signal?: AbortSignal) {
  const result = await request(connection, `/api/sites?from=-${days}d`, siteList, signal);
  return result.sites;
}

export function fetchReport(
  connection: Connection,
  project: string,
  days: Period,
  signal?: AbortSignal,
) {
  return request(connection, '/api/query', reportSchema, signal, {
    kind: 'web',
    project,
    from: `-${days}d`,
    compare: true,
  });
}

export function fetchPaths(
  connection: Connection,
  project: string,
  days: Period,
  events: boolean,
  signal?: AbortSignal,
) {
  return request(connection, '/api/query', pathsSchema, signal, {
    kind: 'paths',
    project,
    from: `-${days}d`,
    steps: 4,
    perStep: 4,
    aggregateBy: 'person',
    include: { pages: true, events },
  });
}
