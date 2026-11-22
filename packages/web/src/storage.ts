/**
 * Device-side state: the anonymous id, the identified user, the current session
 * and cached flags. In cookieless mode everything lives in memory only.
 */

import { uuidv7 } from '@dataflare/core/ids';
import type { Persistence } from './types.ts';

const SESSION_IDLE_MS = 30 * 60_000;

interface Session {
  id: string;
  /** Last activity, ms. */
  last: number;
  /** Replay decision for this session, made once. */
  replay?: 'record' | 'buffer' | 'off';
}

export class Store {
  private memory = new Map<string, string>();
  private readonly project: string;
  private persistence: Persistence;

  constructor(project: string, persistence: Persistence) {
    this.project = project;
    this.persistence = persistence;
  }

  setPersistence(persistence: Persistence): void {
    if (persistence === 'cookieless') this.clear();
    this.persistence = persistence;
  }

  get cookieless(): boolean {
    return this.persistence === 'cookieless';
  }

  private key(name: string): string {
    return `glass:${this.project}:${name}`;
  }

  get(name: string): string | null {
    if (!this.cookieless) {
      try {
        return localStorage.getItem(this.key(name));
      } catch {
        // Storage blocked (private mode, sandboxed iframe): fall back to memory.
      }
    }
    return this.memory.get(name) ?? null;
  }

  set(name: string, value: string | null): void {
    if (value === null) this.memory.delete(name);
    else this.memory.set(name, value);
    if (this.cookieless) return;
    try {
      if (value === null) localStorage.removeItem(this.key(name));
      else localStorage.setItem(this.key(name), value);
    } catch {
      // ignore
    }
  }

  clear(): void {
    for (const name of ['id', 'user', 'session', 'flags', 'flag_payloads', 'groups'])
      this.set(name, null);
    this.memory.clear();
  }

  /** The anonymous device id, created on first use. Null in cookieless mode (the server derives one). */
  distinctId(): string | null {
    if (this.cookieless) return null;
    let id = this.get('id');
    if (!id) {
      id = uuidv7();
      this.set('id', id);
    }
    return id;
  }

  userId(): string | null {
    return this.get('user');
  }

  setUserId(id: string | null): void {
    this.set('user', id);
  }

  /** The current session, rolled over after 30 minutes of inactivity. `touch` marks activity. */
  session(touch = true): Session & { isNew: boolean } {
    const now = Date.now();
    let session: Session | null = null;
    try {
      session = JSON.parse(this.get('session') ?? 'null') as Session | null;
    } catch {
      session = null;
    }
    const isNew = !session || now - session.last > SESSION_IDLE_MS;
    if (!session || isNew) session = { id: uuidv7(now), last: now };
    if (touch) session.last = now;
    this.set('session', JSON.stringify(session));
    return { ...session, isNew };
  }

  setReplayDecision(decision: Session['replay']): void {
    const s = this.session(false);
    this.set('session', JSON.stringify({ id: s.id, last: s.last, replay: decision }));
  }
}
