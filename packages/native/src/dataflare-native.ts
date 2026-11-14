// Dataflare client for React Native / Expo apps (observe.gmac.io, DATFLR-14).
// Canonical source: gmackie/glass-analytics packages/native/src/dataflare-native.ts.
// Copy this one file into an app (for example lib/dataflare-native.ts) and don't edit it there;
// configure it through createDataflare(). It has no dependencies: pass AsyncStorage (or any
// store with the same three async methods) so ids survive restarts.
//
//   const analytics = createDataflare({
//     project: 'latchflow',
//     storage: AsyncStorage,
//     app: { version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion },
//     platform: { os: Platform.OS, osVersion: Platform.Version, device: isTablet ? 'tablet' : 'mobile' },
//   });
//   analytics.screen(pathname);                       // on every route change
//   analytics.track('booking_created', { rooms: 2 }); // product events: small enums and counts
//   analytics.identify(user.id, { plan: 'pro' });     // opaque internal id, never an email
//   analytics.reset();                                // on sign-out
//   analytics.flush();                                // when AppState goes to background

export const LIB_VERSION = '0.1.0';
const DEFAULT_HOST = 'https://observe.gmac.io';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_QUEUE = 500;

/** AsyncStorage-compatible key/value store. */
export interface DataflareStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type DataflareProps = Record<string, string | number | boolean | null | undefined>;

export interface DataflareNativeConfig {
  /** Dataflare project id, e.g. 'latchflow'. */
  project: string;
  /** Collector origin. Default https://observe.gmac.io. */
  host?: string;
  /** Persists the device id and user id. Without it they last for this process only. */
  storage?: DataflareStorage;
  app?: { version?: string | null; build?: string | null };
  platform: { os: string; osVersion?: string | number | null; device?: 'mobile' | 'tablet' };
  /** Set false for apps that must not link activity to accounts. Default true. */
  identify?: boolean;
  /** Kill switch. Default true. */
  enabled?: boolean;
  /** How often queued events are sent. Default 10 s; 0 disables the timer. */
  flushIntervalMs?: number;
  /** Send as soon as this many events are queued. Default 20. */
  maxBatch?: number;
  /** Injected for tests. */
  fetch?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  now?: () => number;
  debug?: boolean;
}

export interface DataflareClient {
  /** Resolves once stored ids are loaded. Calls made earlier are queued, not lost. */
  ready: Promise<void>;
  track(event: string, props?: DataflareProps): void;
  /** Record a screen view; sent as $pageview with url app://<project>/<route>. */
  screen(route: string, props?: DataflareProps): void;
  identify(userId: string | number, personProps?: DataflareProps): void;
  reset(): void;
  /** Send everything queued now. Never throws. */
  flush(): Promise<void>;
  /** Stop the flush timer (tests, or app teardown). */
  shutdown(): void;
  distinctId(): string | null;
}

interface WireEvent {
  id: string;
  event: string;
  ts: number;
  distinct_id: string | null;
  user_id: string | null;
  session_id: string | null;
  url: string | null;
  referrer: null;
  title: null;
  props: Record<string, unknown>;
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** RFC 9562 UUIDv7 (time-ordered), the same format the web SDK sends. */
export function uuidv7(now: number): string {
  const bytes = randomBytes(16);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ID_LIKE = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})$/i;

/**
 * Turn a route into a stable path: drops expo-router groups like "(tabs)", keeps
 * "[param]" templates as ":param", and replaces id-like segments with ":id".
 */
export function normalizeRoute(route: string): string {
  const path = route.split(/[?#]/)[0] ?? '';
  const segments = path
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => {
      const template = /^\[\.{0,3}(.+)\]$/.exec(s);
      if (template) return `:${template[1]}`;
      return ID_LIKE.test(s) ? ':id' : s;
    });
  return `/${segments.join('/')}`;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function sanitizeProps(props: DataflareProps | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('$') || v === undefined) continue;
    if (typeof v === 'string') {
      if (v.length > 200 || EMAIL.test(v)) continue;
      out[k] = v;
    } else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  return out;
}

/** A User-Agent that Dataflare parses as an iOS/Android phone or tablet, never a bot. */
export function userAgentFor(platform: DataflareNativeConfig['platform']): string {
  const version = String(platform.osVersion ?? '').replace(/[^0-9.]/g, '');
  const tablet = platform.device === 'tablet';
  if (platform.os === 'ios') {
    const model = tablet ? 'iPad' : 'iPhone';
    return `Dataflare-RN/${LIB_VERSION} (${model}; CPU ${model} OS ${version.replace(/\./g, '_')} like Mac OS X)`;
  }
  if (platform.os === 'android') {
    return `Dataflare-RN/${LIB_VERSION} (Linux; Android ${version}${tablet ? '' : '; Mobile'})`;
  }
  return `Dataflare-RN/${LIB_VERSION} (${platform.os})`;
}

export function createDataflare(config: DataflareNativeConfig): DataflareClient {
  const enabled = config.enabled !== false && Boolean(config.project);
  const host = (config.host ?? DEFAULT_HOST).replace(/\/+$/, '');
  const now = config.now ?? (() => Date.now());
  const send = config.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const allowIdentify = config.identify !== false;
  const maxBatch = config.maxBatch ?? 20;
  const storage = config.storage;
  const keys = {
    distinct: `dataflare:${config.project}:distinct_id`,
    user: `dataflare:${config.project}:user_id`,
  };
  const base: Record<string, unknown> = {
    $lib: `react-native/${LIB_VERSION}`,
    $os: config.platform.os,
    $os_version: config.platform.osVersion == null ? null : String(config.platform.osVersion),
    $app_version: config.app?.version ?? null,
    $app_build: config.app?.build ?? null,
  };
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': userAgentFor(config.platform),
  };

  let distinctId: string | null = null;
  let userId: string | null = null;
  let session: { id: string; last: number } | null = null;
  let queue: WireEvent[] = [];
  let sending: Promise<void> | null = null;
  let chain: Promise<void>;

  const log = (...args: unknown[]) => {
    if (config.debug) console.debug('[dataflare]', ...args);
  };
  const persist = (key: string, value: string | null) => {
    if (!storage) return;
    const op = value === null ? storage.removeItem(key) : storage.setItem(key, value);
    op.catch(() => {});
  };

  const ready: Promise<void> = (async () => {
    if (!enabled) return;
    try {
      if (storage) {
        distinctId = await storage.getItem(keys.distinct);
        userId = allowIdentify ? await storage.getItem(keys.user) : null;
      }
    } catch {
      // Storage can fail; fall back to process-lifetime ids.
    }
    if (!distinctId) {
      distinctId = uuidv7(now());
      persist(keys.distinct, distinctId);
    }
  })();
  chain = ready;

  // Every call runs in order after the stored ids load.
  const enqueue = (fn: () => void) => {
    if (!enabled) return;
    chain = chain.then(fn).catch((err) => log('dropped call', err));
  };

  const sessionId = (t: number): string => {
    if (!session || t - session.last > SESSION_IDLE_MS) session = { id: uuidv7(t), last: t };
    session.last = t;
    return session.id;
  };

  const capture = (event: string, props: Record<string, unknown>, url: string | null) => {
    const t = now();
    queue.push({
      id: uuidv7(t),
      event,
      ts: t,
      distinct_id: distinctId,
      user_id: userId,
      session_id: sessionId(t),
      url,
      referrer: null,
      title: null,
      props: { ...base, ...props },
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    log(event, props);
    if (queue.length >= maxBatch) void flush();
  };

  const flush = async (): Promise<void> => {
    if (!enabled) return;
    await chain;
    if (sending) return sending;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    sending = (async () => {
      try {
        const res = await send(`${host}/e`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            project: config.project,
            sent_at: now(),
            lib: `react-native/${LIB_VERSION}`,
            events: batch,
          }),
        });
        // 4xx means the batch itself is unacceptable; retrying would loop forever.
        if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) log('batch rejected', res.status);
      } catch (err) {
        log('send failed, will retry', err);
        queue = batch.concat(queue).slice(-MAX_QUEUE);
      } finally {
        sending = null;
      }
    })();
    return sending;
  };

  const interval = config.flushIntervalMs ?? 10_000;
  const timer = enabled && interval > 0 ? setInterval(() => void flush(), interval) : null;
  (timer as { unref?: () => void } | null)?.unref?.();

  return {
    ready,
    track(event, props) {
      if (!event || event.startsWith('$')) return;
      enqueue(() => capture(event, sanitizeProps(props), null));
    },
    screen(route, props) {
      const path = normalizeRoute(route);
      enqueue(() =>
        capture(
          '$pageview',
          { ...sanitizeProps(props), $screen: path },
          `app://${config.project}${path}`,
        ),
      );
    },
    identify(id, personProps) {
      if (!allowIdentify || id === '' || id == null) return;
      enqueue(() => {
        userId = String(id);
        persist(keys.user, userId);
        capture('$identify', { $set: sanitizeProps(personProps) }, null);
      });
    },
    reset() {
      enqueue(() => {
        userId = null;
        distinctId = uuidv7(now());
        session = null;
        persist(keys.user, null);
        persist(keys.distinct, distinctId);
      });
    },
    flush,
    shutdown() {
      if (timer) clearInterval(timer);
    },
    distinctId: () => distinctId,
  };
}
