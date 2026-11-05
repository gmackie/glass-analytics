/**
 * The Dataflare browser client.
 */

import { uuidv7 } from '@dataflare/core/ids';
import { GLASS_VERSION } from '@dataflare/core/version';
import { trackClicks, trackErrors, trackPageviews } from './autocapture.ts';
import { Store } from './storage.ts';
import { Transport } from './transport.ts';
import type {
  AutocaptureOptions,
  GlassOptions,
  ReplayController,
  ReplayModule,
  ReplayOptions,
  WireEvent,
} from './types.ts';
import { observeVitals } from './vitals.ts';

type FlagListener = (flags: Readonly<Record<string, string>>) => void;

declare global {
  interface Window {
    /** Set by replay.js when it loads. */
    __glassReplay?: ReplayModule;
  }
}

export class Dataflare {
  readonly version = GLASS_VERSION;
  private options: GlassOptions | null = null;
  private collectionStopped = false;
  private flagController: AbortController | null = null;
  private host = '';
  private store: Store | null = null;
  private transport: Transport | null = null;
  private flagValues: Record<string, string> = {};
  private flagsLoaded = false;
  private flagListeners = new Set<FlagListener>();
  private exposed = new Set<string>();
  private replay: ReplayController | null = null;
  private replayMode: 'record' | 'buffer' | null = null;
  private replaySession: string | null = null;
  /** Set by `consent(false)`: no more replay on this page, cookieless or not. */
  private replayDeclined = false;
  private teardown: (() => void)[] = [];
  private pageStart = Date.now();

  /** Start Dataflare. Safe to call once; later calls are ignored. */
  init(options: GlassOptions): this {
    if (this.options || this.collectionStopped) return this;
    if (!options?.host || !options?.project) {
      console.warn('[glass] init() needs { host, project }');
      return this;
    }
    if (typeof window === 'undefined') return this; // SSR: no-op.
    this.options = options;
    this.host = new URL(options.host.replace(/\/+$/, ''), location.href).href.replace(/\/+$/, '');
    this.store = new Store(options.project, options.persistence ?? 'localStorage');
    this.transport = new Transport(
      `${this.host}/e`,
      options.project,
      `web/${GLASS_VERSION}`,
      options.flushIntervalMs ?? 5000,
    );

    try {
      this.flagValues = JSON.parse(this.store.get('flags') ?? '{}') as Record<string, string>;
    } catch {
      this.flagValues = {};
    }
    if (options.flags !== false) void this.reloadFlags();

    const auto: AutocaptureOptions =
      options.autocapture === false
        ? { pageviews: false, clicks: false, errors: false, webVitals: false }
        : options.autocapture === true || !options.autocapture
          ? {}
          : options.autocapture;
    const hooks = {
      pageview: () => {
        this.pageStart = Date.now();
        this.capture('$pageview');
      },
      pageleave: () => this.capture('$pageleave', { duration_ms: Date.now() - this.pageStart }),
      capture: (event: string, props: Record<string, unknown>) => this.capture(event, props),
    };
    let reportVitals: (() => void) | null = null;
    if (auto.webVitals !== false) {
      reportVitals = observeVitals((metric, value) =>
        this.capture('$web_vitals', { metric, value }),
      );
    }
    if (auto.pageviews !== false) this.teardown.push(trackPageviews(hooks));
    if (auto.clicks !== false) this.teardown.push(trackClicks(hooks));
    if (auto.errors !== false) {
      // An error uploads a buffered replay, so sessions with errors can be watched.
      const onError = () => {
        this.replay?.noteError();
        this.replay?.flushBuffer();
        if (this.replayMode === 'buffer') this.replayMode = 'record';
      };
      this.teardown.push(trackErrors(hooks, onError));
    }

    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      reportVitals?.();
      reportVitals = null;
      if (auto.pageviews !== false) hooks.pageleave();
      this.transport?.beacon();
    };
    addEventListener('visibilitychange', onHide);
    addEventListener('pagehide', onHide);
    this.teardown.push(() => {
      removeEventListener('visibilitychange', onHide);
      removeEventListener('pagehide', onHide);
    });

    void this.maybeStartReplay();
    return this;
  }

  /** Record an event. Names starting with `$` are reserved for Dataflare. */
  capture(event: string, props: Record<string, unknown> = {}): void {
    const store = this.store;
    if (!store || !this.transport) return;
    const session = store.session();
    if (session.isNew && this.replay) void this.restartReplay();
    const wire: WireEvent = {
      id: uuidv7(),
      event,
      ts: Date.now(),
      distinct_id: store.distinctId(),
      user_id: store.userId(),
      session_id: store.cookieless ? null : session.id,
      url: location.href,
      referrer: document.referrer || null,
      title: document.title,
      props,
    };
    if (Object.keys(this.flagValues).length > 0) wire.flags = { ...this.flagValues };
    const final = this.options?.beforeSend ? this.options.beforeSend(wire) : wire;
    if (!final) return;
    if (this.options?.debug) console.debug('[glass]', final.event, final);
    this.transport.push(final);
  }

  /**
   * Link this device to your user id. Call after login or signup.
   * Events from before the call are attributed to the user in every report.
   */
  identify(userId: string, personProperties: Record<string, unknown> = {}): void {
    if (!this.store || !userId) return;
    this.store.setUserId(String(userId));
    this.capture('$identify', { $set: personProperties });
    void this.reloadFlags();
  }

  /** Set properties on the current person. With `once`, existing values are kept. */
  setPersonProperties(properties: Record<string, unknown>, once = false): void {
    this.capture('$set', once ? { $set_once: properties } : { $set: properties });
  }

  /** Forget the user and start a new anonymous device id (call on logout). */
  reset(): void {
    if (!this.store || this.collectionStopped) return;
    this.replay?.stop();
    this.replay = null;
    this.store.clear();
    this.flagValues = {};
    this.exposed.clear();
    void this.reloadFlags();
  }

  /**
   * The value of a feature flag for this user: `"on"`, a variant key, or null when off.
   * Records an `$exposure` the first time a flag is read on a page, which is what
   * experiment results count — so read flags where the variant is actually shown.
   */
  flag(key: string): string | null {
    const value = this.flagValues[key] ?? null;
    if (value !== null && !this.exposed.has(key)) {
      this.exposed.add(key);
      this.capture('$exposure', { flag: key, variant: value });
    }
    return value;
  }

  /** True when a flag has any value for this user. Records an exposure like `flag()`. */
  isEnabled(key: string): boolean {
    return this.flag(key) !== null;
  }

  /** All flag values, without recording exposures. */
  flags(): Readonly<Record<string, string>> {
    return { ...this.flagValues };
  }

  /** Called with flag values once they load and whenever they change. Returns an unsubscribe function. */
  onFlags(listener: FlagListener): () => void {
    this.flagListeners.add(listener);
    if (this.flagsLoaded) listener(this.flags());
    return () => this.flagListeners.delete(listener);
  }

  /** Re-fetch flags (after identify or a property change, for example). */
  async reloadFlags(): Promise<void> {
    if (this.collectionStopped) return;
    if (!this.store || !this.options) return;
    try {
      this.flagController?.abort();
      const controller = new AbortController();
      this.flagController = controller;
      const res = await fetch(`${this.host}/f`, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          project: this.options.project,
          distinct_id: this.store.distinctId(),
          user_id: this.store.userId(),
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { flags?: Record<string, string> };
      if (this.collectionStopped || !this.store) return;
      this.flagValues = data.flags ?? {};
      this.store.set('flags', JSON.stringify(this.flagValues));
    } catch {
      // Offline: keep cached values.
    } finally {
      if (!this.collectionStopped) {
        this.flagsLoaded = true;
        for (const listener of this.flagListeners) listener(this.flags());
      }
    }
  }

  /**
   * Record consent. `true` switches cookieless mode to a persistent device id;
   * `false` deletes stored ids, stops replay and switches to cookieless mode.
   */
  consent(granted: boolean): void {
    if (!this.store || this.collectionStopped) return;
    const wasCookieless = this.store.cookieless;
    this.store.setPersistence(granted ? 'localStorage' : 'cookieless');
    this.replayDeclined = !granted;
    if (!granted) {
      this.replay?.stop();
      this.replay = null;
    } else if (wasCookieless) {
      // A cookieless recording is filed under server-derived ids; start again under the stored session.
      void this.restartReplay();
    } else {
      void this.maybeStartReplay();
    }
  }

  /** Start recording this session now, regardless of sampling. */
  async startReplay(): Promise<void> {
    this.replayDeclined = false;
    this.store?.setReplayDecision('record');
    if (this.replay && this.replayMode === 'buffer') {
      this.replay.flushBuffer();
      this.replayMode = 'record';
      return;
    }
    if (!this.replay) await this.loadReplay('record');
  }

  stopReplay(): void {
    this.store?.setReplayDecision('off');
    this.replay?.stop();
    this.replay = null;
  }

  /** The anonymous device id (null in cookieless mode). */
  distinctId(): string | null {
    return this.store?.distinctId() ?? null;
  }

  sessionId(): string | null {
    return this.store && !this.store.cookieless ? this.store.session(false).id : null;
  }

  /** Send queued events now. */
  flush(): Promise<void> {
    return this.transport?.flush() ?? Promise.resolve();
  }

  /** Stop collection for this instance without flushing queued events. Reinitialize only with a new instance. */
  optOut(): void {
    this.collectionStopped = true;
    for (const fn of this.teardown.splice(0)) fn();
    this.replayDeclined = true;
    this.replay?.stop({ discard: true });
    this.replay = null;
    this.transport?.stop();
    this.transport = null;
    this.store?.setPersistence('cookieless');
    this.store = null;
    this.flagController?.abort();
    this.flagListeners.clear();
    this.flagsLoaded = false;
    this.flagValues = {};
    this.options = null;
  }

  /** Stop all autocapture and replay. Mainly for tests and hot reloading. */
  shutdown(): void {
    for (const fn of this.teardown.splice(0)) fn();
    this.replay?.stop();
    this.replay = null;
    this.transport?.beacon();
    this.options = null;
  }

  private async maybeStartReplay(): Promise<void> {
    const opts = this.options?.replay as ReplayOptions | false | undefined;
    if (!opts || !this.store || this.replay || this.replayDeclined) return;
    if (this.store.cookieless && !opts.cookieless) return;
    const session = this.store.session(false);
    let decision = session.replay;
    if (!decision) {
      decision =
        Math.random() < (opts.sampleRate ?? 0)
          ? 'record'
          : Math.random() < (opts.onErrorSampleRate ?? 0)
            ? 'buffer'
            : 'off';
      this.store.setReplayDecision(decision);
    }
    if (decision !== 'off') await this.loadReplay(decision);
  }

  private async restartReplay(): Promise<void> {
    this.replay?.stop();
    this.replay = null;
    await this.maybeStartReplay();
  }

  private async loadReplay(mode: 'record' | 'buffer'): Promise<void> {
    if (!this.store || !this.options) return;
    const module = await loadReplayModule(this.host);
    if (!module || !this.store || !this.options || this.replay || this.replayDeclined) return;
    const opts = (this.options.replay || {}) as ReplayOptions;
    const cookieless = this.store.cookieless;
    const session = this.store.session(false);
    this.replaySession = cookieless ? 'cookieless' : session.id;
    this.replayMode = mode;
    this.replay = module.startReplay({
      host: this.host,
      project: this.options.project,
      sessionId: this.replaySession,
      cookieless,
      distinctId: this.store.distinctId(),
      userId: this.store.userId(),
      mode,
      maskAllText: opts.maskAllText ?? false,
      maskTextSelector: opts.maskTextSelector ?? '[data-glass-mask]',
      blockSelector: opts.blockSelector ?? '[data-glass-block]',
      console:
        opts.console === true
          ? ['log', 'info', 'warn', 'error', 'debug']
          : opts.console === false
            ? []
            : (opts.console ?? ['warn', 'error']),
      network: opts.network ?? true,
    });
  }
}

let replayModule: Promise<ReplayModule | null> | null = null;

/**
 * Load replay.js from the Dataflare Worker with a script tag. A script tag (rather
 * than `import()`) works the same under every bundler and keeps rrweb out of
 * your app bundle; the recorder always matches your Worker's version.
 */
function loadReplayModule(host: string): Promise<ReplayModule | null> {
  if (window.__glassReplay) return Promise.resolve(window.__glassReplay);
  replayModule ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `${host}/replay.js`;
    script.async = true;
    script.onload = () => resolve(window.__glassReplay ?? null);
    script.onerror = () => {
      replayModule = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return replayModule;
}
