/**
 * Client for the Dataflare JSON API. The dashboard uses exactly the endpoints an
 * agent would, so anything you can see here, an agent can query too.
 */

import { fixtureName } from './demo.ts';
import { config, prefs } from './state.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

/** POST endpoints that only read, so the demo can answer them from recordings. */
const READ_POSTS = /\/api\/(query|sql|cohorts\/count|reports\/[a-z-]+)$/;

async function demoRequest<T>(method: string, url: URL, body?: unknown): Promise<T> {
  if (method !== 'GET' && !(method === 'POST' && READ_POSTS.test(url.pathname)))
    throw new ApiError(
      403,
      'The demo is read-only.',
      'Install Dataflare with `npx @gmacko/dataflare-cli init` to save insights, flags and experiments.',
    );
  const path = url.pathname.slice(config.base.length) + url.search;
  const name = fixtureName(method, path, body === undefined ? null : JSON.stringify(body));
  const res = await fetch(`${config.demo}/${name}.json`);
  if (!res.ok)
    throw new ApiError(
      404,
      "This view isn't part of the demo.",
      'The demo has a fixed set of views. Install Dataflare to explore your own data any way you like.',
    );
  return (await res.json()) as T;
}

function apiUrl(path: string, params: Params = {}): URL {
  const prefix = config.access && (path === '/api' || path.startsWith('/api/')) ? '/app' : '';
  const url = new URL(`${config.base}${prefix}${path}`, location.origin);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url;
}

async function fetchApi(url: URL, method: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    redirect: config.access ? 'manual' : 'follow',
    headers: {
      ...(config.access ? {} : { Authorization: `Bearer ${prefs.key ?? ''}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // An expired Access cookie is challenged at the edge, before the Worker sees the request.
  if (
    config.access &&
    (res.type === 'opaqueredirect' ||
      (res.status === 403 && res.headers.get('Content-Type')?.includes('text/html')))
  ) {
    window.dispatchEvent(new Event('glass:unauthorized'));
    throw new ApiError(401, 'Sign in with Cloudflare Access to continue.');
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('glass:unauthorized'));
    const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.hint);
  }
  return res;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Params,
): Promise<T> {
  const url = apiUrl(path, params);
  if (config.demo) return demoRequest<T>(method, url, body);
  const res = await fetchApi(url, method, body);
  return res.json() as Promise<T>;
}

/** Fetch a file the API returns (CSV, for example) and save it in the browser. */
async function download(
  path: string,
  params: Params,
  filename: string,
  body?: unknown,
): Promise<void> {
  if (config.demo) throw new ApiError(403, 'Downloads are not part of the demo.');
  const res = await fetchApi(apiUrl(path, params), body === undefined ? 'GET' : 'POST', body);
  const blob = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = blob;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}

export const api = {
  download,
  get: <T>(path: string, params?: Params) => request<T>('GET', path, undefined, params),
  post: <T>(path: string, body: unknown = {}, params?: Params) =>
    request<T>('POST', path, body, params),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, params?: Params) => request<T>('DELETE', path, undefined, params),
};
