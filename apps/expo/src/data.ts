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
}) satisfies z.ZodType<Totals>;

export const reportSchema = z.object({
  kind: z.literal('web'),
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  totals,
  previous: totals.nullable(),
  timeseries: z.object({ buckets: z.array(z.number()), visitors: z.array(z.number()) }),
  breakdowns: z.object({ pages: z.array(z.object({ value: z.string(), count: z.number() })) }),
});
export type Report = z.infer<typeof reportSchema>;

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
