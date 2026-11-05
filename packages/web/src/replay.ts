/**
 * Session replay recorder, built separately as `replay.js` and served by the
 * Worker. The SDK loads it on demand, so rrweb (~70 KB) is only downloaded for
 * sessions that are actually recorded.
 *
 * Uploads go to `POST /r`, gzipped with CompressionStream. They are shaped by
 * one browser limit: a request that must outlive the page (`sendBeacon`, or
 * `fetch` with `keepalive`) can carry about 64 KB, shared with the SDK's own
 * last batch. Real pages' DOM snapshots are usually bigger than that, so:
 *
 * - the full snapshot that starts each page load is uploaded straight away;
 * - after that, events are uploaded once more than a beacon's worth is waiting
 *   (at most once a second), and every 10 seconds regardless;
 * - so when the page is hidden, what's left fits in one `sendBeacon`, which is
 *   sent uncompressed because compression is asynchronous and a page that is
 *   going away can't wait for it.
 *
 * Besides the DOM, the recording carries rrweb custom events the player and
 * transcript read: `glass:url` (client-side navigation), `glass:console`
 * (console messages, warn and error by default) and `glass:network` (method,
 * URL without query string, status and timing of fetch/XHR requests; never
 * headers or bodies).
 *
 * Privacy defaults: every input is masked; `maskAllText` masks all text too,
 * and elements matching `maskTextSelector` have their text masked; elements
 * matching `blockSelector` are not recorded at all.
 */

import { record } from 'rrweb';
import type { ConsoleLevel, ReplayController, ReplayModule, ReplayStartOptions } from './types.ts';

const CHUNK_MS = 10_000;
/** What one beacon can carry, leaving room for the SDK's own batch (browsers allow 64 KB in flight). */
const BEACON_CHARS = 48_000;
/** Size-triggered uploads happen at most this often, so a busy page can't create thousands of chunks. */
const MIN_UPLOAD_GAP_MS = 1_000;
const BUFFER_CHECKOUT_MS = 30_000;
const RETRY_MS = 3_000;
const FULL_SNAPSHOT = 2;
const RAGE_GAP_MS = 1500;
/** Per page load, so a logging loop or polling can't flood a recording. */
const MAX_CONSOLE = 300;
const MAX_REQUESTS = 500;

interface RecordedEvent {
  type: number;
  timestamp: number;
  // biome-ignore lint/suspicious/noExplicitAny: rrweb payloads are heterogeneous
  data?: any;
}

const isClick = (e: RecordedEvent) => e.type === 3 && e.data?.source === 2 && e.data?.type === 2;

/** origin + path: query strings hold tokens and personal data more often than they help. */
function bare(url: string): string {
  try {
    const u = new URL(url, location.href);
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return String(url).split('?')[0]!.slice(0, 500);
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Wrap console methods; returns a function that restores them. */
function watchConsole(
  levels: ConsoleLevel[],
  report: (level: ConsoleLevel, message: string, stack?: string) => void,
): () => void {
  const originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};
  let busy = false;
  for (const level of levels) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    originals[level] = original;
    console[level] = function (this: Console, ...args: unknown[]) {
      if (!busy) {
        busy = true;
        try {
          const error = args.find((a): a is Error => a instanceof Error);
          report(level, args.map(stringify).join(' ').slice(0, 1000), error?.stack?.slice(0, 2000));
        } catch {
          // Never let recording break the page's logging.
        }
        busy = false;
      }
      return original.apply(this, args);
    };
  }
  return () => {
    for (const [level, fn] of Object.entries(originals))
      console[level as ConsoleLevel] = fn as never;
  };
}

/** Wrap fetch and XMLHttpRequest to time requests; returns a function that restores them. */
function watchNetwork(
  ignore: (url: string) => boolean,
  report: (r: {
    method: string;
    url: string;
    status: number;
    duration: number;
    error?: string;
  }) => void,
): () => void {
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (ignore(url)) return originalFetch.call(this, input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const started = performance.now();
      try {
        const res = await originalFetch.call(this, input, init);
        report({ method, url, status: res.status, duration: performance.now() - started });
        return res;
      } catch (err) {
        report({
          method,
          url,
          status: 0,
          duration: performance.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } as typeof fetch;
  }
  const proto = typeof XMLHttpRequest === 'undefined' ? null : XMLHttpRequest.prototype;
  const originalOpen = proto?.open;
  const originalSend = proto?.send;
  type Tracked = XMLHttpRequest & { __glass?: { method: string; url: string } };
  if (proto && originalOpen && originalSend) {
    proto.open = function (this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
      this.__glass = { method, url: String(url) };
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      const info = this.__glass;
      if (info && !ignore(info.url)) {
        const started = performance.now();
        this.addEventListener(
          'loadend',
          () =>
            report({
              method: info.method,
              url: info.url,
              status: this.status,
              duration: performance.now() - started,
            }),
          { once: true },
        );
      }
      return originalSend.call(this, body);
    };
  }
  return () => {
    if (typeof originalFetch === 'function') window.fetch = originalFetch;
    if (proto && originalOpen && originalSend) {
      proto.open = originalOpen;
      proto.send = originalSend;
    }
  };
}

function startReplay(options: ReplayStartOptions): ReplayController {
  let discarded = false;
  const activeUploads = new Set<AbortController>();
  let mode = options.mode;
  // A session spans page loads, and each load restarts `seq`; the page id keeps chunk keys unique.
  const page = Math.random().toString(36).slice(2, 10);
  const pageStart = Date.now();
  let seq = 0;
  // Events waiting to be uploaded, as JSON: each event is serialised once, and the size is exact.
  let pending: string[] = [];
  let pendingChars = 0;
  let firstTs = 0;
  let lastTs = 0;
  // Counts for the session list, reset with every chunk.
  const counts = { clicks: 0, errors: 0, rage: 0, console: 0, failed: 0 };
  let lastClick = { id: -1, ts: 0, run: 0 };
  let consoleCount = 0;
  let requestCount = 0;
  let lastHref = bare(location.href);
  let lastUpload = 0;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  // In buffer mode, keep the current and previous 30s segments (each starts with a full snapshot).
  let segments: RecordedEvent[][] = [[]];
  const glassHost = bare(options.host);

  function count(event: RecordedEvent): void {
    if (isClick(event)) {
      counts.clicks++;
      const id = event.data.id;
      const run =
        id === lastClick.id && event.timestamp - lastClick.ts < RAGE_GAP_MS ? lastClick.run + 1 : 1;
      // Count a burst once, when it reaches three clicks.
      if (run === 3) counts.rage++;
      lastClick = { id, ts: event.timestamp, run };
    } else if (event.type === 5) {
      const tag = event.data?.tag;
      if (tag === 'glass:console' && event.data.payload?.level === 'error') counts.console++;
      if (tag === 'glass:network') {
        const status = event.data.payload?.status;
        if (!status || status >= 400) counts.failed++;
      }
    }
  }

  function append(event: RecordedEvent): void {
    const json = JSON.stringify(event);
    if (pending.length === 0) firstTs = event.timestamp;
    lastTs = event.timestamp;
    pending.push(json);
    pendingChars += json.length;
    count(event);
  }

  /** Upload as soon as the rate limit allows. */
  function uploadSoon(): void {
    if (uploadTimer !== undefined) return;
    const wait = lastUpload + MIN_UPLOAD_GAP_MS - Date.now();
    if (wait <= 0) void upload(false);
    else uploadTimer = setTimeout(() => void upload(false), wait);
  }

  async function send(
    target: (enc: 'gzip' | 'json') => string,
    body: string,
    pageIsHidden: boolean,
  ): Promise<void> {
    if (discarded) return;
    const controller = new AbortController();
    activeUploads.add(controller);
    try {
      // sendBeacon returns false when the body is over the browser's limit; then try the slower ways.
      if (
        pageIsHidden &&
        body.length <= BEACON_CHARS &&
        navigator.sendBeacon?.(target('json'), new Blob([body], { type: 'text/plain' }))
      )
        return;
      let res: Response;
      if (typeof CompressionStream === 'undefined') {
        res = await originalFetch(target('json'), {
          signal: controller.signal,
          method: 'POST',
          body,
          headers: { 'Content-Type': 'text/plain' },
          keepalive: body.length <= BEACON_CHARS,
        });
      } else {
        const gz = await new Response(
          new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
        ).blob();
        if (discarded) return;
        // keepalive lets the upload finish if the page navigates away, but only small bodies may use it.
        res = await originalFetch(target('gzip'), {
          signal: controller.signal,
          method: 'POST',
          body: new Blob([gz], { type: 'text/plain' }),
          keepalive: gz.size <= BEACON_CHARS,
        });
      }
      if (res.status >= 500 || res.status === 429) throw new Error(`upload failed: ${res.status}`);
    } finally {
      activeUploads.delete(controller);
    }
  }

  async function upload(pageIsHidden: boolean): Promise<void> {
    if (discarded) return;
    if (uploadTimer !== undefined) clearTimeout(uploadTimer);
    uploadTimer = undefined;
    if (pending.length === 0) return;
    // Take the chunk and reset the counters before anything asynchronous, so events
    // and errors that arrive during the upload count towards the next chunk.
    const body = `[${pending.join(',')}]`;
    const q = new URLSearchParams({
      project: options.project,
      session: options.sessionId,
      seq: String(seq++),
      page,
      start: String(firstTs),
      end: String(lastTs),
      clicks: String(counts.clicks),
      errors: String(counts.errors),
      rage: String(counts.rage),
      console: String(counts.console),
      failed: String(counts.failed),
      href: location.href.split('?')[0]!.slice(0, 500),
    });
    if (options.cookieless) {
      q.set('cl', '1');
      q.set('ps', String(pageStart));
    }
    if (options.distinctId) q.set('d', options.distinctId);
    if (options.userId) q.set('u', options.userId);
    pending = [];
    pendingChars = 0;
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0;
    lastUpload = Date.now();
    const target = (enc: 'gzip' | 'json') => `${options.host}/r?${q}&enc=${enc}`;

    try {
      await send(target, body, pageIsHidden);
    } catch {
      // One retry for a flaky network or a busy Worker; then drop the chunk rather than grow memory without bound.
      if (pageIsHidden) return;
      await new Promise((r) => setTimeout(r, RETRY_MS));
      await send(target, body, false).catch(() => {});
    }
  }

  /** Add one of our custom events; rrweb routes it through `onEvent` like any other. */
  function custom(tag: string, payload: Record<string, unknown>): void {
    try {
      record.addCustomEvent(tag, payload);
    } catch {
      // Not recording (stopped): ignore.
    }
  }

  function checkUrl(): void {
    const href = bare(location.href);
    if (href === lastHref) return;
    lastHref = href;
    custom('glass:url', { href });
  }

  function onEvent(event: RecordedEvent, isCheckout?: boolean): void {
    if (discarded) return;
    if (mode === 'buffer') {
      if (isCheckout) {
        segments.push([]);
        if (segments.length > 2) segments.shift();
      }
      segments[segments.length - 1]!.push(event);
      return;
    }
    append(event);
    // The snapshot is usually the biggest thing on the page: send it now, while the page is still open.
    if (event.type === FULL_SNAPSHOT) void upload(false);
    else if (pendingChars > BEACON_CHARS) uploadSoon();
  }

  const onHide = () => {
    if (document.visibilityState === 'hidden') void upload(true);
  };

  // Keep an unwrapped fetch for our own uploads, so they never show up as recorded requests.
  const originalFetch = window.fetch.bind(window);

  // Everything above must exist before record(): it emits the first snapshot synchronously.
  const maskSelectors = [options.maskAllText ? '*' : '', options.maskTextSelector]
    .filter(Boolean)
    .join(', ');
  const stopRecording = record({
    emit: onEvent,
    checkoutEveryNms: mode === 'buffer' ? BUFFER_CHECKOUT_MS : undefined,
    maskAllInputs: true,
    maskTextSelector: maskSelectors || undefined,
    blockSelector: options.blockSelector,
    recordCanvas: false,
    collectFonts: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last' },
  });

  const restore: (() => void)[] = [];
  if (options.console.length) {
    restore.push(
      watchConsole(options.console, (level, message, stack) => {
        if (++consoleCount > MAX_CONSOLE) return;
        custom('glass:console', { level, message, stack });
      }),
    );
  }
  if (options.network) {
    restore.push(
      watchNetwork(
        (url) => bare(url).startsWith(glassHost),
        (r) => {
          if (++requestCount > MAX_REQUESTS) return;
          custom('glass:network', {
            method: r.method.toUpperCase(),
            url: bare(r.url),
            status: r.status,
            duration: Math.round(r.duration),
            error: r.error,
          });
          checkUrl();
        },
      ),
    );
  }
  // Client-side navigation: history changes don't produce a new rrweb Meta event.
  const urlTimer = setInterval(checkUrl, 500);
  addEventListener('popstate', checkUrl);

  const timer = setInterval(() => void upload(false), CHUNK_MS);
  addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', onHide);

  return {
    stop(stopOptions = {}) {
      if (stopOptions.discard) {
        discarded = true;
        pending = [];
        segments = [[]];
        if (uploadTimer !== undefined) clearTimeout(uploadTimer);
        for (const controller of activeUploads) controller.abort();
      }
      for (const fn of restore) fn();
      stopRecording?.();
      clearInterval(timer);
      clearInterval(urlTimer);
      removeEventListener('popstate', checkUrl);
      removeEventListener('visibilitychange', onHide);
      removeEventListener('pagehide', onHide);
      if (!discarded) void upload(true);
    },
    flushBuffer() {
      if (mode !== 'buffer') return;
      mode = 'record';
      for (const event of segments.flat()) append(event);
      segments = [[]];
      void upload(false);
    },
    noteError() {
      counts.errors++;
    },
  };
}

const module: ReplayModule = { startReplay };
window.__glassReplay = module;
