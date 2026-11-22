/**
 * HTTP helpers and a tiny router.
 *
 * Dataflare deliberately has no web framework dependency: the routing it needs is
 * a few dozen lines, and fewer dependencies make the Worker easier to audit.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

type Issue = { path?: PropertyKey[]; message: string };

export function isValidationError(err: unknown): err is Error & { issues: Issue[] } {
  return (
    err instanceof Error &&
    (err.name === 'ZodError' || err.name === '$ZodError') &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/** "steps: Too small: expected array to have >=2 items; window: …" */
export function describeIssues(err: { issues: Issue[]; message?: string }): string {
  const text = err.issues
    .map((i) => `${i.path?.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}`)
    .join('; ');
  return text || err.message || 'invalid input';
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json(
      { error: err.message, ...(err.hint ? { hint: err.hint } : {}) },
      { status: err.status },
    );
  }
  if (isValidationError(err)) {
    return json(
      { error: `Invalid request — ${describeIssues(err)}`, details: err.issues },
      { status: 400 },
    );
  }
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    (err instanceof Error && err.name === 'UnsafeSqlError')
  ) {
    return json({ error: err.message }, { status: 400 });
  }
  console.error('[glass] unhandled error', err);
  return json(
    // The message only: the stack (and whatever `String()` of a non-Error holds) stays in the log.
    { error: 'Internal error', ...(err instanceof Error ? { detail: err.message } : {}) },
    { status: 500 },
  );
}

/** The raw body, refusing anything over `maxBytes` (webhooks verify signatures over exact bytes). */
export async function readText(request: Request, maxBytes = 1_000_000): Promise<string> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, `Body too large (max ${maxBytes} bytes)`);
  return text;
}

export async function readJson<T = unknown>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, `Body too large (max ${maxBytes} bytes)`);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

export interface RouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Path patterns like `/api/flags/:key`. */
export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\/:([a-zA-Z_]+)/g, (_, key: string) => {
        keys.push(key);
        return '/([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.on('GET', path, handler);
  }
  post(path: string, handler: Handler): this {
    return this.on('POST', path, handler);
  }
  put(path: string, handler: Handler): this {
    return this.on('PUT', path, handler);
  }
  patch(path: string, handler: Handler): this {
    return this.on('PATCH', path, handler);
  }
  delete(path: string, handler: Handler): this {
    return this.on('DELETE', path, handler);
  }

  async handle(request: Request, url: URL, path: string): Promise<Response | null> {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]!);
      });
      return route.handler({ request, url, params });
    }
    return pathMatched
      ? json({ error: `Method ${request.method} not allowed` }, { status: 405 })
      : null;
  }
}
