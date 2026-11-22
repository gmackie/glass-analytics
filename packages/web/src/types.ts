/**
 * One event as sent to the Worker. Mirrors `WireEvent` in @dataflare/core (kept as
 * a copy so the published type declarations are self-contained; a test fails
 * if the two drift apart).
 */
export interface WireEvent {
  id: string;
  event: string;
  ts: number;
  distinct_id?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  title?: string | null;
  props?: Record<string, unknown>;
  flags?: Record<string, string>;
  /** Server-side senders only (imports, dataflare-node with a key). */
  context?: {
    country?: string;
    region?: string;
    city?: string;
    browser?: string;
    os?: string;
    device?: string;
  };
}

/** Values to start with before the Worker answers, e.g. rendered by your server (no flicker). */
export interface Bootstrap {
  /** The device id your server used, so both sides bucket the same way. */
  distinctId?: string;
  /** The signed-in user, if your server knows them. */
  userId?: string;
  /** Flag values: "on", a variant key, or false/null for off. */
  flags?: Record<string, string | boolean | null>;
  /** Flag payloads, as `flagPayload()` returns them. */
  payloads?: Record<string, unknown>;
}

/** An early-access feature this person may opt into. */
export interface EarlyAccessFeature {
  key: string;
  name: string;
  description?: string;
  docsUrl?: string;
  stage: 'concept' | 'alpha' | 'beta';
  /** true: opted in; false: opted out; null: hasn't chosen. */
  enrolled: boolean | null;
}

export type Persistence = 'localStorage' | 'cookieless';

export interface AutocaptureOptions {
  /** `$pageview` on load and on client-side navigation. Default true. */
  pageviews?: boolean;
  /** `$click` on links, buttons and elements with `data-glass-event`. Default true. */
  clicks?: boolean;
  /** `$exception` for uncaught errors and unhandled promise rejections. Default true. */
  errors?: boolean;
  /** `$web_vitals` (LCP, CLS, INP, FCP, TTFB) sent when the page is hidden. Default true. */
  webVitals?: boolean;
}

export interface ReplayOptions {
  /** Share of sessions to record, 0–1. Default 0. */
  sampleRate?: number;
  /**
   * Share of sessions to keep a rolling in-memory buffer for, uploaded only if an
   * error happens. 0–1. Default 0. Costs CPU on every buffered session.
   */
  onErrorSampleRate?: number;
  /** Mask all text, not just inputs. Default false (inputs are always masked). */
  maskAllText?: boolean;
  /** CSS selector of elements whose text is masked. Default `[data-glass-mask]`. */
  maskTextSelector?: string;
  /** CSS selector of elements to leave out of recordings entirely. Default `[data-glass-block]`. */
  blockSelector?: string;
  /**
   * Console messages to record: `true` for every level, `false` for none, or a
   * list of levels. Default `['warn', 'error']`. Messages can contain personal
   * data your code logs, so leave routine levels off unless you need them.
   */
  console?: boolean | ConsoleLevel[];
  /**
   * Record fetch/XHR requests: method, URL without query string, status and
   * timing. Never headers or bodies. Default true.
   */
  network?: boolean;
  /**
   * Record in cookieless mode too. Nothing is stored on the device: the Worker
   * files each page load's recording under the same daily-rotating visitor and
   * session ids as its events. A sampling decision lasts one page load. Off by
   * default; `consent(false)` stops recording for the rest of the page.
   */
  cookieless?: boolean;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface GlassOptions {
  /** Base URL of your Dataflare Worker, e.g. "https://glass.acme.workers.dev" or "/_glass". */
  host: string;
  /** Project id, e.g. "acme-web". */
  project: string;
  /**
   * "localStorage" (default) keeps an anonymous device id so funnels, retention,
   * experiments and replay work. "cookieless" stores nothing on the device; the
   * Worker derives a daily-rotating id from IP + user agent, which is enough for
   * web analytics but not for product analytics. Call `consent(true)` to upgrade.
   */
  persistence?: Persistence;
  /** `false` disables all autocapture. */
  autocapture?: boolean | AutocaptureOptions;
  /** Session replay. Off unless a sample rate is set. */
  replay?: ReplayOptions | false;
  /** Fetch feature flags on init. Default true. */
  flags?: boolean;
  /** Start with these ids and flag values (server-side rendering), before the Worker answers. */
  bootstrap?: Bootstrap;
  /** Apply web experiments (page changes defined in Dataflare). Default true. */
  webExperiments?: boolean;
  /** Hide elements a web experiment changes for at most this long while flags load. Default 1000 ms. */
  antiFlickerMs?: number;
  /** Inspect or rewrite every event before it is queued. Return null to drop it. */
  beforeSend?: (event: WireEvent) => WireEvent | null;
  /** Send at most this often, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Log every event to the console. */
  debug?: boolean;
  /** Your app's version (a git SHA, say), attached to errors so their stacks map to source. */
  release?: string;
}

/** The interface implemented by `replay.js`, loaded on demand from the Worker. */
export interface ReplayModule {
  startReplay(options: ReplayStartOptions): ReplayController;
}

export interface ReplayStartOptions {
  host: string;
  project: string;
  sessionId: string;
  distinctId: string | null;
  userId: string | null;
  /** "record" uploads continuously; "buffer" keeps the last ~60s in memory until `flushBuffer()`. */
  mode: 'record' | 'buffer';
  maskAllText: boolean;
  maskTextSelector: string;
  blockSelector: string;
  /** Console levels to record; empty for none. */
  console: ConsoleLevel[];
  network: boolean;
  /** No device ids: the Worker derives the session from the request and `pageStart`. */
  cookieless?: boolean;
}

export interface ReplayController {
  /** Stop recording and upload what is pending. */
  stop(): void;
  /** Switch from buffer mode to recording: upload the buffer and keep going. */
  flushBuffer(): void;
  /** Count an error against the current chunk (shown in the replay list). */
  noteError(): void;
}
