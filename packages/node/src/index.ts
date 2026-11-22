/**
 * dataflare-node — the Dataflare server SDK.
 *
 * ```ts
 * import { Dataflare } from 'dataflare-node';
 *
 * const dataflare = new Dataflare({
 *   host: 'https://glass.acme.workers.dev',
 *   project: 'acme',
 *   serverKey: process.env.DATAFLARE_SERVER_KEY, // `npx dataflare-cli key --server`
 * });
 *
 * dataflare.capture({ distinctId: user.id, event: 'invoice_paid', properties: { amount: 49 } });
 * if (await dataflare.isFeatureEnabled('new-billing', user.id)) { … }
 * await dataflare.shutdown(); // before the process (or a Worker request) ends
 * ```
 *
 * Fetch-only with no dependencies, so it runs on Node 18+, Bun, Deno and
 * Cloudflare Workers. With a server key, flags are evaluated in-process from
 * definitions it polls (the same code the Worker runs), falling back to the
 * Worker when a flag needs something it doesn't know.
 */

import type { EvaluationContext } from '@dataflare/core/filters';
import { parseProperty } from '@dataflare/core/filters';
import {
  evaluateFlagsDetailed,
  type FlagDefinition,
  type FlagEvaluation,
  payloadsFor,
} from '@dataflare/core/flags';
import { trimTrailingSlashes } from '@dataflare/core/url';
import { GLASS_VERSION } from '@dataflare/core/version';

export type Properties = Record<string, unknown>;

export interface DataflareOptions {
  /** Your Dataflare Worker, e.g. "https://glass.acme.workers.dev". */
  host: string;
  /** Project id. */
  project: string;
  /**
   * The server key (`npx dataflare-cli key --server`). Enables local flag evaluation, imports
   * with historical timestamps, and trusted context (country, browser) on events. Optional:
   * without it events still send and flags are evaluated by the Worker.
   */
  serverKey?: string;
  /** Send when this many events are queued. Default 20. */
  flushAt?: number;
  /** Send at least this often, in ms. Default 10000. 0 sends every event immediately. */
  flushIntervalMs?: number;
  /** Evaluate flags in-process (needs serverKey). Default true when there is a server key. */
  localEvaluation?: boolean;
  /** How often to refresh flag definitions, in ms. Default 30000. */
  pollIntervalMs?: number;
  /** Record a `$exposure` the first time each flag is read per user (what experiments count). Default true. */
  sendExposures?: boolean;
  /** A fetch to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
  /** Called when a request fails, instead of failing silently. */
  onError?: (error: unknown) => void;
  /** Your app's version (a git SHA, say), attached to exceptions so their stacks map to source. */
  release?: string;
}

export interface CaptureInput {
  /** The device or user id the event belongs to. For server events, usually your user id. */
  distinctId: string;
  event: string;
  properties?: Properties;
  /** Your user id, when distinctId is a device id. */
  userId?: string;
  /** Groups the event belongs to, e.g. { company: 'acme' }. */
  groups?: Record<string, string>;
  /** When it happened. Default now. Older than 7 days needs a server key (sent as an import). */
  timestamp?: Date | number;
  /** A unique id, so retries don't double count. Default random. */
  uuid?: string;
  /** Where it happened, when you know (needs a server key): country code, browser… */
  context?: {
    country?: string;
    region?: string;
    city?: string;
    browser?: string;
    os?: string;
    device?: string;
  };
}

export interface FlagOptions {
  /** Your user id, when distinctId is a device id. */
  userId?: string;
  /** Person properties for targeting rules, as local evaluation can't read them from the Worker. */
  personProperties?: Properties;
  /** Groups, for flags bucketed by or targeting a group. */
  groups?: Record<string, string>;
  /** Group properties for targeting rules, by group type. */
  groupProperties?: Record<string, Properties>;
  /** Request context for country/device/browser/os rules. */
  context?: {
    country?: string;
    region?: string;
    city?: string;
    device?: string;
    browser?: string;
    os?: string;
  };
  /** Never ask the Worker: return null when local evaluation can't decide. */
  onlyEvaluateLocally?: boolean;
  /** Record a `$exposure` for this read. Default: the client's sendExposures. */
  sendExposure?: boolean;
}

/** A thrown error or anything else, as an `$exception` event. */
export interface ExceptionInput {
  distinctId?: string;
  properties?: Properties;
  /** Defaults to "error". */
  level?: 'fatal' | 'error' | 'warning' | 'info';
  /** Whether your code caught it (true) or it was uncaught (false). Default true. */
  handled?: boolean;
}

interface WireEvent {
  id: string;
  event: string;
  ts: number;
  distinct_id: string;
  user_id?: string | null;
  props: Properties;
  context?: CaptureInput['context'];
}

const BACKLOG_MS = 6 * 86_400_000;

function uuid(): string {
  return crypto.randomUUID();
}

export class Dataflare {
  readonly version = GLASS_VERSION;
  private readonly host: string;
  private readonly project: string;
  private readonly serverKey?: string;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly local: boolean;
  private readonly pollIntervalMs: number;
  private readonly sendExposures: boolean;
  private readonly fetcher: typeof fetch;
  private readonly onError: (error: unknown) => void;
  private readonly release: string | undefined;
  private queue: WireEvent[] = [];
  private imports: WireEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private definitions: {
    flags: FlagDefinition[];
    cohorts: Map<string, Set<string>>;
    etag: string | null;
  } | null = null;
  private loading: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private exposed = new Set<string>();

  constructor(options: DataflareOptions) {
    if (!options?.host || !options?.project)
      throw new TypeError('Dataflare needs { host, project }');
    this.host = trimTrailingSlashes(options.host);
    this.project = options.project;
    this.serverKey = options.serverKey;
    this.flushAt = Math.max(1, options.flushAt ?? 20);
    this.flushIntervalMs = options.flushIntervalMs ?? 10_000;
    this.local = (options.localEvaluation ?? true) && Boolean(options.serverKey);
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.sendExposures = options.sendExposures ?? true;
    // Not `this.fetcher = fetch`: Workers throw "Illegal invocation" when fetch is called as a method.
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.onError = options.onError ?? (() => {});
    this.release = options.release;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /** Queue an event. Returns its id. */
  capture(input: CaptureInput): string {
    const ts =
      input.timestamp instanceof Date ? input.timestamp.getTime() : (input.timestamp ?? Date.now());
    const props: Properties = { ...(input.properties ?? {}) };
    if (input.groups && Object.keys(input.groups).length) props.$groups = input.groups;
    const event: WireEvent = {
      id: input.uuid ?? uuid(),
      event: input.event,
      ts,
      distinct_id: String(input.distinctId),
      ...(input.userId ? { user_id: String(input.userId) } : {}),
      props,
      ...(input.context ? { context: input.context } : {}),
    };
    // Old events and trusted context go through the import endpoint, which needs the server key.
    if (this.serverKey && (Date.now() - ts > BACKLOG_MS || input.context)) this.imports.push(event);
    else this.queue.push(event);
    if (this.queue.length + this.imports.length >= this.flushAt || this.flushIntervalMs === 0)
      void this.flush();
    else this.schedule();
    return event.id;
  }

  /** Link a device to a user and set their properties. */
  identify(input: {
    distinctId: string;
    userId?: string;
    properties?: Properties;
    setOnce?: Properties;
  }): void {
    const userId = input.userId ?? input.distinctId;
    this.capture({
      distinctId: input.distinctId,
      userId,
      event: '$identify',
      properties: {
        ...(input.properties ? { $set: input.properties } : {}),
        ...(input.setOnce ? { $set_once: input.setOnce } : {}),
      },
    });
  }

  /** Set person properties. With `once`, existing values are kept. */
  setPersonProperties(distinctId: string, properties: Properties, once = false): void {
    this.capture({
      distinctId,
      userId: distinctId,
      event: '$set',
      properties: once ? { $set_once: properties } : { $set: properties },
    });
  }

  /** Create or update a group (company, workspace…) and its properties. */
  groupIdentify(input: {
    groupType: string;
    groupKey: string;
    properties?: Properties;
    distinctId?: string;
  }): void {
    this.capture({
      distinctId: input.distinctId ?? `$group_${input.groupType}_${input.groupKey}`,
      event: '$groupidentify',
      properties: {
        $group_type: input.groupType,
        $group_key: String(input.groupKey),
        ...(input.properties ? { $group_set: input.properties } : {}),
      },
    });
  }

  /** Record an error as an `$exception` (error tracking groups them into issues). */
  captureException(error: unknown, input: ExceptionInput = {}): string {
    const e =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    return this.capture({
      distinctId: input.distinctId ?? '$server',
      event: '$exception',
      properties: {
        type: e.name || 'Error',
        message: e.message,
        stack: e.stack ?? '',
        handled: input.handled ?? true,
        level: input.level ?? 'error',
        $lib: 'node',
        ...(this.release ? { $release: this.release } : {}),
        ...(input.properties ?? {}),
      },
    });
  }

  /**
   * Send events with their own timestamps (a history from another tool). Needs the server key.
   * Sent in chunks of 1,000; ids de-duplicate retries.
   */
  async import(events: CaptureInput[]): Promise<{ accepted: number; dropped: number }> {
    if (!this.serverKey)
      throw new Error('import() needs the server key (npx dataflare-cli key --server)');
    let accepted = 0;
    let dropped = 0;
    const wire = events.map((input) => ({
      id: input.uuid ?? uuid(),
      event: input.event,
      ts:
        input.timestamp instanceof Date
          ? input.timestamp.getTime()
          : (input.timestamp ?? Date.now()),
      distinct_id: String(input.distinctId),
      ...(input.userId ? { user_id: String(input.userId) } : {}),
      props: { ...(input.properties ?? {}), ...(input.groups ? { $groups: input.groups } : {}) },
      ...(input.context ? { context: input.context } : {}),
    }));
    for (let i = 0; i < wire.length; i += 1000) {
      const res = await this.post(
        '/api/import',
        { project: this.project, events: wire.slice(i, i + 1000) },
        true,
      );
      const body = (await res.json()) as { accepted: number; dropped: number };
      accepted += body.accepted;
      dropped += body.dropped;
    }
    return { accepted, dropped };
  }

  private schedule(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep a Node process alive just to flush.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async post(path: string, body: unknown, auth = false): Promise<Response> {
    const res = await this.fetcher(`${this.host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': auth ? 'application/json' : 'text/plain',
        'User-Agent': `dataflare-node/${GLASS_VERSION}`,
        ...(auth && this.serverKey ? { Authorization: `Bearer ${this.serverKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Dataflare ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  /** Send everything queued now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) await this.flushing;
    const events = this.queue.splice(0);
    const imports = this.imports.splice(0);
    if (events.length === 0 && imports.length === 0) return;
    this.flushing = (async () => {
      try {
        for (let i = 0; i < events.length; i += 200) {
          await this.post('/e', {
            project: this.project,
            sent_at: Date.now(),
            lib: `node/${GLASS_VERSION}`,
            events: events.slice(i, i + 200),
          });
        }
        for (let i = 0; i < imports.length; i += 1000) {
          await this.post(
            '/api/import',
            { project: this.project, events: imports.slice(i, i + 1000) },
            true,
          );
        }
      } catch (err) {
        this.onError(err);
        // Put them back for the next flush; ids make the retry safe.
        this.queue.unshift(...events);
        this.imports.unshift(...imports);
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
  }

  /** Flush and stop polling. Call before your process exits (or at the end of a Worker request). */
  async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.flush();
  }

  // ── Flags ────────────────────────────────────────────────────────────────

  /** Fetch flag definitions now (they are also polled every pollIntervalMs). */
  async reloadFeatureFlags(): Promise<void> {
    if (!this.local) return;
    this.loading ??= (async () => {
      try {
        const res = await this.fetcher(
          `${this.host}/api/flags/definitions?project=${encodeURIComponent(this.project)}`,
          {
            headers: {
              Authorization: `Bearer ${this.serverKey}`,
              ...(this.definitions?.etag ? { 'If-None-Match': this.definitions.etag } : {}),
            },
          },
        );
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`Dataflare flag definitions: HTTP ${res.status}`);
        const body = (await res.json()) as {
          flags: FlagDefinition[];
          cohorts: Record<string, string[]>;
          etag?: string;
        };
        this.definitions = {
          flags: body.flags,
          cohorts: new Map(Object.entries(body.cohorts ?? {}).map(([k, ids]) => [k, new Set(ids)])),
          etag: res.headers.get('ETag') ?? body.etag ?? null,
        };
      } catch (err) {
        this.onError(err);
      } finally {
        this.loading = null;
      }
    })();
    await this.loading;
    if (!this.pollTimer && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.reloadFeatureFlags(), this.pollIntervalMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
  }

  private localContext(
    distinctId: string,
    o: FlagOptions,
  ): { ctx: EvaluationContext; isKnown: (p: string) => boolean } {
    const person = o.personProperties ?? {};
    const groupProps = o.groupProperties ?? {};
    const c = o.context ?? {};
    const personId = o.userId ?? distinctId;
    const cohorts = [...(this.definitions?.cohorts ?? new Map())]
      .filter(([, ids]) => ids.has(personId) || ids.has(distinctId))
      .map(([k]) => k);
    const ctx: EvaluationContext = {
      distinct_id: distinctId,
      user_id: o.userId ?? null,
      person,
      groups: o.groups ?? {},
      groupProps,
      cohorts,
      country: c.country ?? '',
      region: c.region ?? '',
      city: c.city ?? '',
      device: c.device ?? '',
      browser: c.browser ?? '',
      os: c.os ?? '',
    };
    // What local evaluation knows: the properties it was given, cohorts it has members for, flags.
    const isKnown = (property: string): boolean => {
      if (property === 'cohort') return true;
      const ref = parseProperty(property);
      if (ref.kind === 'flag') return true;
      if (ref.kind === 'person' || ref.kind === 'event') {
        return Object.hasOwn(person, ref.path[0]!);
      }
      if (ref.kind === 'group') {
        return ref.path.length === 0
          ? Object.hasOwn(o.groups ?? {}, ref.type)
          : Object.hasOwn(groupProps[ref.type] ?? {}, ref.path[0]!);
      }
      return (
        Object.hasOwn(c, ref.column) || ref.column === 'distinct_id' || ref.column === 'user_id'
      );
    };
    return { ctx, isKnown };
  }

  private async remote(
    distinctId: string,
    o: FlagOptions,
  ): Promise<{ flags: Record<string, string>; payloads: Record<string, unknown> }> {
    const res = await this.post('/f', {
      project: this.project,
      distinct_id: distinctId,
      user_id: o.userId ?? null,
      groups: o.groups ?? {},
    });
    const body = (await res.json()) as {
      flags?: Record<string, string>;
      payloads?: Record<string, unknown>;
    };
    return { flags: body.flags ?? {}, payloads: body.payloads ?? {} };
  }

  /** Every flag's value for a user, with payloads. Locally when possible. */
  /**
   * Every flag from the polled definitions, or null when the Worker has to answer: no
   * definitions, or a rule needs what local evaluation doesn't know (unless told to stay local).
   */
  private evaluateLocally(distinctId: string, o: FlagOptions) {
    if (!this.local || !this.definitions) return null;
    const { ctx, isKnown } = this.localContext(distinctId, o);
    const results: Record<string, FlagEvaluation> = evaluateFlagsDetailed(
      this.definitions.flags,
      ctx,
      { isKnown },
    );
    if (Object.values(results).some((r) => r.inconclusive) && !o.onlyEvaluateLocally) return null;
    const flags: Record<string, string> = {};
    for (const [k, r] of Object.entries(results)) if (r.value !== null) flags[k] = r.value;
    return { flags, payloads: payloadsFor(this.definitions.flags, flags), evaluatedLocally: true };
  }

  async getAllFlagsAndPayloads(
    distinctId: string,
    o: FlagOptions = {},
  ): Promise<{
    flags: Record<string, string>;
    payloads: Record<string, unknown>;
    evaluatedLocally: boolean;
  }> {
    if (this.local && !this.definitions) await this.reloadFeatureFlags();
    const local = this.evaluateLocally(distinctId, o);
    if (local) return local;
    if (o.onlyEvaluateLocally) return { flags: {}, payloads: {}, evaluatedLocally: true };
    try {
      return { ...(await this.remote(distinctId, o)), evaluatedLocally: false };
    } catch (err) {
      this.onError(err);
      return { flags: {}, payloads: {}, evaluatedLocally: false };
    }
  }

  async getAllFlags(distinctId: string, o: FlagOptions = {}): Promise<Record<string, string>> {
    return (await this.getAllFlagsAndPayloads(distinctId, o)).flags;
  }

  /** A flag's value for a user: "on", a variant key, or null. Records an exposure (once per user and flag). */
  async getFeatureFlag(
    key: string,
    distinctId: string,
    o: FlagOptions = {},
  ): Promise<string | null> {
    const { flags } = await this.getAllFlagsAndPayloads(distinctId, o);
    const value = flags[key] ?? null;
    const send = o.sendExposure ?? this.sendExposures;
    const id = `${distinctId}\u0000${key}`;
    if (value !== null && send && !this.exposed.has(id)) {
      this.exposed.add(id);
      if (this.exposed.size > 50_000) this.exposed.clear();
      this.capture({
        distinctId,
        userId: o.userId,
        event: '$exposure',
        properties: { flag: key, variant: value },
        groups: o.groups,
      });
    }
    return value;
  }

  async isFeatureEnabled(key: string, distinctId: string, o: FlagOptions = {}): Promise<boolean> {
    // "holdout" (an experiment holdout) means the default experience.
    const value = await this.getFeatureFlag(key, distinctId, o);
    return value !== null && value !== 'holdout';
  }

  /** The JSON payload of a flag's value for a user, or null. Records no exposure. */
  async getFeatureFlagPayload<T = unknown>(
    key: string,
    distinctId: string,
    o: FlagOptions = {},
  ): Promise<T | null> {
    const { payloads } = await this.getAllFlagsAndPayloads(distinctId, o);
    return (payloads[key] as T | undefined) ?? null;
  }

  /**
   * Values to hand the browser SDK so the first render needs no request:
   * `glass.init({ …, bootstrap })`.
   */
  async bootstrap(distinctId: string, o: FlagOptions = {}) {
    const { flags, payloads } = await this.getAllFlagsAndPayloads(distinctId, o);
    return { distinctId, ...(o.userId ? { userId: o.userId } : {}), flags, payloads };
  }
}
