import { EVENT_COLUMNS, type StoredEvent } from '@dataflare/core/events';
import type { Row } from '@dataflare/core/insights/types';
import { sqlite } from '@dataflare/core/sql/dialect';
import type { D1Database } from '../env.ts';
import type { EventStore, IdentityLink } from './types.ts';

const INSERT = `INSERT OR IGNORE INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')})`;
const BATCH_SIZE = 50;

/** Events stored in D1 alongside Dataflare's other tables. */
export class D1Store implements EventStore {
  readonly kind = 'd1';
  readonly dialect = sqlite;
  readonly freshnessSeconds = 0;
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async write(events: StoredEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const statements = events
        .slice(i, i + BATCH_SIZE)
        .map((e) => this.db.prepare(INSERT).bind(...EVENT_COLUMNS.map((c) => e[c])));
      await this.db.batch(statements);
    }
  }

  async writeIdentity(_link: IdentityLink): Promise<void> {
    // The identities table lives in D1 already; nothing to mirror.
  }

  readonly userTables =
    'events, identities, persons, cohorts, insights, flags, experiments, replays, event_definitions';

  userSql(sql: string): string {
    return sql;
  }

  async query(sql: string): Promise<Row[]> {
    const { results, meta } = await this.db.prepare(sql).all<Row>();
    // Every caller reads, and people's own SQL is guarded before it gets here. This can't undo
    // a write, but if something ever slips past the guard it fails loudly instead of quietly.
    if (meta?.changed_db) {
      throw new Error('A read-only query changed the database. Please report this as a bug.');
    }
    return results;
  }

  async deletePersonEvents(project: string, ids: string[]): Promise<'deleted'> {
    if (ids.length === 0) return 'deleted';
    // One JSON parameter rather than one per id: D1 binds at most 100, and a person can have
    // any number of devices. One statement also means all of their events go, or none do.
    await this.db
      .prepare(
        `DELETE FROM events WHERE project = ?1 AND (person_id IN (SELECT value FROM json_each(?2)) OR distinct_id IN (SELECT value FROM json_each(?2)) OR user_id IN (SELECT value FROM json_each(?2)))`,
      )
      .bind(project, JSON.stringify(ids))
      .run();
    return 'deleted';
  }
}
