/**
 * The Dataflare browser client.
 */

import { uuidv7 } from '@dataflare/core/ids';
import { trimTrailingSlashes } from '@dataflare/core/url';
import { GLASS_VERSION } from '@dataflare/core/version';
import { trackClicks, trackErrors, trackPageviews } from './autocapture.ts';
import { Store } from './storage.ts';
import { Transport } from './transport.ts';
import type {
  AutocaptureOptions,
  EarlyAccessFeature,
  GlassOptions,
  ReplayController,
  ReplayModule,
  ReplayOptions,
  WireEvent,
} from './types.ts';
import { observeVitals } from './vitals.ts';
import {
  applyTransforms,
  hideUntilApplied,
  isWebPayload,
  watchTransforms,
} from './web-experiments.ts';

type FlagListener = (flags: Readonly<Record<string, string>>) => void;

declare global {
  interface Window {
    /** Set by replay.js when it loads. */
    __glassReplay?: ReplayModule;
  }
}

/** Keys that would reach `Object.prototype` if written into a plain object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Flag overrides, as a Map. They come from the URL (`?__glass_flags=`) and `localStorage`, so
 * their keys are never written into an ordinary object (a key such as `__proto__` would reach
 * `Object.prototype`).
 */
function overrideMap(entries: Iterable<[string, string | null]>): Map<string, string | null> {
  return new Map([...entries].filter(([k]) => !UNSAFE_KEYS.has(k)));
}

/** Saved overrides: `[key, value]` pairs, or an object (as saved before 0.9). */
function storedOverrides(raw: string | null): [string, string | null][] {
  const saved = JSON.parse(raw ?? '[]') as
    | [string, string | null][]
    | Record<string, string | null>;
  return Array.isArray(saved) ? saved : Object.entries(saved ?? {});
}

/** Which autocapture is on: everything by default, nothing with `false`, or the options given. */
function autocaptureOf(option: GlassOptions['autocapture']): AutocaptureOptions {
  if (option === false) return { pageviews: false, clicks: false, errors: false, webVitals: false };
  return option === true || !option ? {} : option;
}

export class Dataflare {
  readonly version = GLASS_VERSION;
  private options: GlassOptions | null = null;
  private host = '';
  private store: Store | null = null;
  private transport: Transport | null = null;
  private flagValues: Record<string, string> = {};
  private flagPayloads: Record<string, unknown> = {};
  /** Local overrides (overrideFlags, or ?__glass_flags= when the project allows it). */
  private overrides: Map<string, string | null> = overrideMap([]);
  private allowUrlOverrides = false;
  private flagsLoaded = false;
  /** Web experiments applied on this page (their exposure is recorded once). */
  private appliedExperiments = new Set<string>();
  private reveal: () => void = () => {};
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
    if (this.options) return this;
    if (!options?.host || !options?.project) {
      console.warn('[glass] init() needs { host, project }');
      return this;
    }
    if (typeof window === 'undefined') return this; // SSR: no-op.
    this.options = options;
    this.host = trimTrailingSlashes(new URL(trimTrailingSlashes(options.host), location.href).href);
    this.store = new Store(options.project, options.persistence ?? 'localStorage');
    this.transport = new Transport(
      `${this.host}/e`,
      options.project,
      `web/${GLASS_VERSION}`,
      options.flushIntervalMs ?? 5000,
    );
    this.restoreFlags(options.bootstrap);
    if (options.webExperiments !== false) this.startWebExperiments(options.antiFlickerMs ?? 1000);
    if (options.flags !== false) void this.reloadFlags();
    this.startAutocapture(autocaptureOf(options.autocapture));
    void this.maybeStartReplay();
    return this;
  }

  /** Flags from the last visit, or from the server's bootstrap (usable at once). */
  private restoreFlags(boot: GlassOptions['bootstrap']): void {
    const store = this.store!;
    if (boot?.distinctId && !store.cookieless) store.set('id', boot.distinctId);
    if (boot?.userId) store.setUserId(boot.userId);
    try {
      this.flagValues = JSON.parse(store.get('flags') ?? '{}') as Record<string, string>;
      this.flagPayloads = JSON.parse(store.get('flag_payloads') ?? '{}') as Record<string, unknown>;
      this.overrides = overrideMap(storedOverrides(store.get('flag_overrides')));
    } catch {
      this.flagValues = {};
    }
    if (!boot?.flags) return;
    this.flagValues = {};
    for (const [k, v] of Object.entries(boot.flags)) {
      if (v === true) this.flagValues[k] = 'on';
      else if (typeof v === 'string') this.flagValues[k] = v;
    }
    this.flagPayloads = boot.payloads ?? {};
    // Bootstrapped values are usable at once; the Worker's answer replaces them when it arrives.
    this.flagsLoaded = true;
  }

  /** Hide what cached web experiments change until the fresh values apply (no flash). */
  private startWebExperiments(antiFlickerMs: number): void {
    const selectors = Object.values(this.flagPayloads)
      .filter(isWebPayload)
      .flatMap((p) => p.transforms.map((t) => t.selector));
    this.reveal = hideUntilApplied(selectors, antiFlickerMs);
    if (this.flagsLoaded) this.applyWebExperiments();
  }

  private startAutocapture(auto: AutocaptureOptions): void {
    const hooks = {
      pageview: () => {
        this.pageStart = Date.now();
        this.capture('$pageview');
        // Client-side navigation renders new elements: apply web experiments to them too.
        if (this.flagsLoaded) this.applyWebExperiments();
      },
      pageleave: () => this.capture('$pageleave', { duration_ms: Date.now() - this.pageStart }),
      capture: (event: string, props: Record<string, unknown>) => this.capture(event, props),
    };
    let reportVitals =
      auto.webVitals === false
        ? null
        : observeVitals((metric, value) => this.capture('$web_vitals', { metric, value }));
    if (auto.pageviews !== false) this.teardown.push(trackPageviews(hooks));
    if (auto.clicks !== false) this.teardown.push(trackClicks(hooks));
    if (auto.errors !== false) this.teardown.push(trackErrors(hooks, () => this.onError()));
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
  }

  /** An error uploads a buffered replay, so sessions with errors can be watched. */
  private onError(): void {
    this.replay?.noteError();
    this.replay?.flushBuffer();
    if (this.replayMode === 'buffer') this.replayMode = 'record';
  }

  /**
   * Record an event. Names starting with `$` are reserved for Dataflare. Returns the event's id
   * (for de-duplicating with other tools, e.g. the Meta Pixel's eventID), or null when not sent.
   */
  capture(event: string, props: Record<string, unknown> = {}): string | null {
    const store = this.store;
    if (!store || !this.transport) return null;
    const release = this.options?.release;
    if (event === '$exception' && release && props.$release === undefined)
      props = { ...props, $release: release };
    const groups = this.groupsNow();
    if (Object.keys(groups).length && props.$groups === undefined)
      props = { ...props, $groups: groups };
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
    const active = this.flags();
    if (Object.keys(active).length > 0) wire.flags = active;
    const final = this.options?.beforeSend ? this.options.beforeSend(wire) : wire;
    if (!final) return null;
    if (this.options?.debug) console.debug('[glass]', final.event, final);
    this.transport.push(final);
    return final.id;
  }

  /**
   * Record an error you caught, e.g. in a `catch` block or an error boundary. It groups into an
   * issue with uncaught errors of the same kind. Returns the event id.
   */
  captureException(
    error: unknown,
    props: Record<string, unknown> & { level?: 'fatal' | 'error' | 'warning' | 'info' } = {},
  ): string | null {
    const e =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    this.replay?.noteError();
    return this.capture('$exception', {
      type: e.name || 'Error',
      message: String(e.message).slice(0, 500),
      stack: e.stack?.slice(0, 4000),
      handled: true,
      level: 'error',
      ...props,
    });
  }

  // ── Groups ─────────────────────────────────────────────────────────────

  private groupsNow(): Record<string, string> {
    try {
      return JSON.parse(this.store?.get('groups') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * Associate this user's events with a group, e.g. `glass.group('company', 'acme', { plan: 'pro' })`.
   * Later events carry it, so insights can count companies and flags can target them.
   */
  group(type: string, key: string, properties?: Record<string, unknown>): void {
    if (!this.store || !type || key === undefined || key === null) return;
    const groups = { ...this.groupsNow(), [type]: String(key) };
    this.store.set('groups', JSON.stringify(groups));
    this.capture('$groupidentify', {
      $group_type: type,
      $group_key: String(key),
      ...(properties ? { $group_set: properties } : {}),
    });
    void this.reloadFlags();
  }

  /** Stop associating events with any group (e.g. when switching accounts). */
  resetGroups(): void {
    this.store?.set('groups', null);
    void this.reloadFlags();
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
    if (!this.store) return;
    this.replay?.stop();
    this.replay = null;
    this.store.clear();
    this.store.set('groups', null);
    this.flagValues = {};
    this.flagPayloads = {};
    this.exposed.clear();
    void this.reloadFlags();
  }

  /**
   * The value of a feature flag for this user: `"on"`, a variant key, or null when off.
   * Records an `$exposure` the first time a flag is read on a page, which is what
   * experiment results count — so read flags where the variant is actually shown.
   */
  flag(key: string): string | null {
    const value = this.flags()[key] ?? null;
    if (value !== null && !this.exposed.has(key)) {
      this.exposed.add(key);
      this.capture('$exposure', { flag: key, variant: value });
    }
    return value;
  }

  /** True when a flag has any value for this user. Records an exposure like `flag()`. */
  isEnabled(key: string): boolean {
    // People in an experiment holdout get "holdout": the default experience, so not enabled.
    const value = this.flag(key);
    return value !== null && value !== 'holdout';
  }

  /** All flag values (with any overrides), without recording exposures. */
  flags(): Readonly<Record<string, string>> {
    // Merged in a Map: override keys come from the URL, so they are never assigned into an object.
    const merged = new Map(Object.entries(this.flagValues));
    for (const [k, v] of this.overrides) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    return Object.fromEntries(merged);
  }

  /** The JSON payload of a flag's current value (remote config), or null. Records no exposure. */
  flagPayload<T = unknown>(key: string): T | null {
    const forced = this.overrides.get(key);
    if (forced !== undefined && forced !== this.flagValues[key]) return null;
    return (this.flagPayloads[key] as T | undefined) ?? null;
  }

  /**
   * Override flag values in this browser, for development and QA: `{ "new-checkout": "test" }`,
   * `null` to force a flag off, or `false` to clear every override. Persisted on the device.
   */
  overrideFlags(overrides: Record<string, string | boolean | null> | false): void {
    if (overrides === false) {
      this.setOverrides([], true);
      return;
    }
    const next = Object.entries(overrides).map(([k, v]): [string, string | null] => [
      k,
      v === true ? 'on' : v === false ? null : v,
    ]);
    this.setOverrides(next);
  }

  /** Merge (or with `replace`, replace) overrides, save them on the device and tell listeners. */
  private setOverrides(next: [string, string | null][], replace = false): void {
    this.overrides = overrideMap([...(replace ? [] : this.overrides), ...next]);
    this.store?.set(
      'flag_overrides',
      this.overrides.size ? JSON.stringify([...this.overrides]) : null,
    );
    for (const listener of this.flagListeners) listener(this.flags());
  }

  /** Early-access features this person can opt into, with their current choice. */
  async earlyAccessFeatures(): Promise<EarlyAccessFeature[]> {
    if (!this.store || !this.options) return [];
    try {
      const res = await fetch(`${this.host}/f`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ ...this.flagRequest(), early_access: true }),
      });
      if (!res.ok) return [];
      return ((await res.json()) as { earlyAccess?: EarlyAccessFeature[] }).earlyAccess ?? [];
    } catch {
      return [];
    }
  }

  /** Opt this person into an early-access feature (stored as a person property), then reload flags. */
  async optIn(key: string): Promise<void> {
    await this.setEarlyAccess(key, true);
  }

  /** Opt this person out of an early-access feature. */
  async optOut(key: string): Promise<void> {
    await this.setEarlyAccess(key, false);
  }

  private async setEarlyAccess(key: string, enrolled: boolean): Promise<void> {
    this.setPersonProperties({ $early_access: { [key]: enrolled } });
    await this.flush();
    await this.reloadFlags();
  }

  private flagRequest() {
    return {
      project: this.options!.project,
      distinct_id: this.store!.distinctId(),
      user_id: this.store!.userId(),
      groups: this.groupsNow(),
    };
  }

  /**
   * Apply the page changes of web experiments this person is in, and record their exposure
   * (every variant has a web payload, so control is counted too).
   */
  private applyWebExperiments(): void {
    if (typeof document === 'undefined') return;
    const values = this.flags();
    for (const [key, payload] of Object.entries(this.flagPayloads)) {
      if (!isWebPayload(payload)) continue;
      const value = values[key];
      if (!value || value === 'holdout') continue;
      if (payload.transforms.length) {
        applyTransforms(payload.transforms);
        this.teardown.push(watchTransforms(payload.transforms));
      }
      if (!this.appliedExperiments.has(key)) {
        this.appliedExperiments.add(key);
        this.flag(key);
      }
    }
    this.reveal();
  }

  /** ?__glass_flags=new-checkout:test,beta:off overrides flags here when the project allows it. */
  private applyUrlOverrides(): void {
    if (!this.allowUrlOverrides || typeof location === 'undefined') return;
    const raw = new URLSearchParams(location.search).get('__glass_flags');
    if (!raw) return;
    const pairs: [string, string | null][] = [];
    for (const pair of raw.split(',')) {
      const [k, v] = pair.split(':');
      if (!k) continue;
      pairs.push([
        k,
        !v || v === 'on' || v === 'true' ? 'on' : v === 'off' || v === 'false' ? null : v,
      ]);
    }
    this.setOverrides(pairs);
  }

  /** Called with flag values once they load and whenever they change. Returns an unsubscribe function. */
  onFlags(listener: FlagListener): () => void {
    this.flagListeners.add(listener);
    if (this.flagsLoaded) listener(this.flags());
    return () => this.flagListeners.delete(listener);
  }

  /** Re-fetch flags (after identify or a property change, for example). */
  async reloadFlags(): Promise<void> {
    if (!this.store || !this.options) return;
    try {
      const res = await fetch(`${this.host}/f`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(this.flagRequest()),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        flags?: Record<string, string>;
        payloads?: Record<string, unknown>;
        allowOverrides?: boolean;
      };
      this.flagValues = data.flags ?? {};
      this.flagPayloads = data.payloads ?? {};
      this.store.set('flags', JSON.stringify(this.flagValues));
      this.store.set('flag_payloads', JSON.stringify(this.flagPayloads));
      if (data.allowOverrides && !this.allowUrlOverrides) {
        this.allowUrlOverrides = true;
        this.applyUrlOverrides();
      }
    } catch {
      // Offline: keep cached values.
    } finally {
      this.flagsLoaded = true;
      if (this.options?.webExperiments !== false) this.applyWebExperiments();
      for (const listener of this.flagListeners) listener(this.flags());
    }
  }

  /**
   * Record consent. `true` switches cookieless mode to a persistent device id;
   * `false` deletes stored ids, stops replay and switches to cookieless mode.
   */
  consent(granted: boolean): void {
    if (!this.store) return;
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
