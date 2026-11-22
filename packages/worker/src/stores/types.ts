/**
 * Event stores.
 *
 * An EventStore is where events are written and how SQL against them is run.
 * Dataflare ships two:
 *
 * - `D1Store` (default): events in the same D1 database as everything else.
 *   Free-plan friendly, real-time, simple. Good to a few million events a month.
 * - `LakeStore`: events streamed through Cloudflare Pipelines into Iceberg
 *   tables in R2, queried with Basin SQL. Unbounded history, open format,
 *   ~1-5 minutes of ingest delay.
 *
 * Both expose the same `events` / `identities` columns, so every insight
 * compiler works unchanged. To add a backend (ClickHouse, Tinybird, DuckDB…)
 * implement this interface and a `Dialect`; see docs/extending.md.
 */

import type { StoredEvent } from '@dataflare/core/events';
import type { Row } from '@dataflare/core/insights/types';
import type { Dialect } from '@dataflare/core/sql/dialect';

export interface IdentityLink {
  project: string;
  distinct_id: string;
  person_id: string;
  created_at: number;
}

export interface EventStore {
  readonly kind: string;
  readonly dialect: Dialect;
  /** Roughly how long until written events are queryable. */
  readonly freshnessSeconds: number;
  write(events: StoredEvent[]): Promise<void>;
  /** Mirror a new identity link into the store (D1 already has it). */
  writeIdentity(link: IdentityLink): Promise<void>;
  /** Table names to show people writing their own SQL. */
  readonly userTables: string;
  /** Rewrite people's own SQL for this store (the lake reads every table version). */
  userSql(sql: string): string;
  /** Run one read-only statement. */
  query(sql: string): Promise<Row[]>;
  /**
   * Delete every event of these persons/devices: 'deleted' when they are gone now, 'queued' when
   * a later job removes them (the lake: see `dataflare lake maintain`).
   */
  deletePersonEvents(project: string, ids: string[]): Promise<'deleted' | 'queued'>;
  /**
   * Remove a group from stored events (its key in `$groups` and its property snapshot in
   * `$group_props`); the events themselves stay with their people.
   */
  deleteGroupData(project: string, type: string, key: string): Promise<'deleted' | 'queued'>;
}
