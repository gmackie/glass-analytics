/**
 * Batching and delivery.
 *
 * Events are queued and sent every few seconds, when 20 are waiting, or when
 * the page is hidden (via `sendBeacon`, which survives navigation). Bodies are
 * sent as `text/plain` so browsers skip the CORS preflight request.
 */

import type { WireBatch, WireEvent } from '@dataflare/core/events';

const MAX_BATCH = 20;
const MAX_QUEUE = 500;

export class Transport {
  private queue: WireEvent[] = [];
  private stopped = false;
  private readonly active = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly endpoint: string;
  private readonly project: string;
  private readonly lib: string;
  private readonly intervalMs: number;

  constructor(endpoint: string, project: string, lib: string, intervalMs: number) {
    this.endpoint = endpoint;
    this.project = project;
    this.lib = lib;
    this.intervalMs = intervalMs;
  }

  push(event: WireEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= MAX_BATCH) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.intervalMs);
  }

  private body(events: WireEvent[]): string {
    const batch: WireBatch = { project: this.project, sent_at: Date.now(), lib: this.lib, events };
    return JSON.stringify(batch);
  }

  /** Send everything queued. Failed batches are put back for the next attempt. */
  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (!this.stopped && this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      const controller = new AbortController();
      this.active.add(controller);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          signal: controller.signal,
          body: this.body(batch),
          headers: { 'Content-Type': 'text/plain' },
          keepalive: true,
        });
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      } catch {
        if (this.stopped) return;
        this.queue.unshift(...batch);
        this.schedule();
        return;
      } finally {
        this.active.delete(controller);
      }
    }
  }

  /** Discard queued collection, cancel pending transport and prevent future retries. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.active) controller.abort();
  }

  /** Last-chance delivery when the page is going away. */
  beacon(): void {
    if (this.stopped) return;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = this.body(batch);
    const sent =
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'text/plain' }));
    if (!sent) {
      void fetch(this.endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
      }).catch(() => {});
    }
  }
}
