/**
 * Features that hook into ingest and maintenance, registered in one place and in order.
 *
 * Ingest enrichers run on rows before they are written: transformations first, so
 * nothing they remove reaches the store, the later enrichers or any destination;
 * error tracking last, so exceptions are grouped into issues as they'll be stored.
 * After the write, matching events are queued for destinations. The five-minute
 * task drains the delivery outbox and advances batch exports.
 */

import { FREQUENT_TASKS } from './cron.ts';
import { drainOutbox, enqueueDeliveries } from './destinations.ts';
import { runExports } from './exports.ts';
import { AFTER_WRITE, ENRICHERS } from './ingest.ts';
import { assignIssues } from './issues.ts';
import { convertRevenue, refreshRates } from './revenue.ts';
import { transformRows } from './transformations.ts';

let registered = false;

export function registerExtensions(): void {
  if (registered) return;
  registered = true;
  ENRICHERS.unshift((rows, ctx) => transformRows(rows, ctx.env, ctx.project.id));
  // After transformations (a redacted message fingerprints as redacted), before the write.
  ENRICHERS.push(assignIssues, convertRevenue);
  AFTER_WRITE.push(async (rows, ctx) => {
    await enqueueDeliveries(rows, ctx.env, ctx.project.id);
  });
  FREQUENT_TASKS.push(
    { name: 'deliveries', run: (env, _store, now) => drainOutbox(env, now) },
    { name: 'exports', run: (env, store, now) => runExports(env, store, now) },
    { name: 'fxRates', run: (env, _store, now) => refreshRates(env, now) },
  );
}
