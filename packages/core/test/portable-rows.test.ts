/**
 * Basin SQL rejects any VALUES clause (DATFLR-24), so the insights that need an
 * inline table of literal rows build it with `literalRows()` instead. These tests
 * run that table on real SQLite, and check that no insight compiled for the lake
 * still emits VALUES (a lake-dialect specific, so a string check is the test).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFunnel } from '../src/insights/funnel.ts';
import { runPaths } from '../src/insights/paths.ts';
import { runRevenue } from '../src/insights/revenue.ts';
import { funnelSpec, pathsSpec, trendsSpec } from '../src/insights/schemas.ts';
import { runTrends } from '../src/insights/trends.ts';
import type { QueryContext } from '../src/insights/types.ts';
import { basin } from '../src/sql/dialect.ts';
import { literalRows } from '../src/sql/rows.ts';
import { createDb, NOW } from './helpers.ts';

describe('literalRows', () => {
  it('is a table SQLite can join, with VALUES-style column names', () => {
    const db = createDb();
    const rows = db
      .prepare(
        `SELECT v.column1 AS i, v.column2 AS e FROM (${literalRows([
          [0, 10],
          [1, 20],
          [2, 30],
        ])}) v ORDER BY v.column1`,
      )
      .all();
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { i: 0, e: 10 },
        { i: 1, e: 20 },
        { i: 2, e: 30 },
      ],
    );
  });

  it('refuses an empty or ragged table', () => {
    assert.throws(() => literalRows([]), /at least one row/);
    assert.throws(() => literalRows([[1, 2], [3]]), /one non-zero width/);
  });
});

/** A lake context that records each statement and returns no rows. */
function lakeContext(): QueryContext & { queries: string[] } {
  const queries: string[] = [];
  return {
    dialect: basin('glass'),
    project: 'p',
    now: NOW,
    queries,
    execute: async (sql: string) => {
      queries.push(sql);
      return [];
    },
  };
}

describe('lake SQL has no VALUES clause (DATFLR-24)', () => {
  const noValues = (queries: string[]) => {
    assert.ok(queries.length > 0, 'the insight ran at least one query');
    for (const sql of queries) assert.doesNotMatch(sql, /\bVALUES\b/i);
  };

  it('funnels (time to convert per step)', async () => {
    const ctx = lakeContext();
    await runFunnel(
      funnelSpec.parse({ from: '-7d', steps: [{ event: 'a' }, { event: 'b' }, { event: 'c' }] }),
      ctx,
    );
    noValues(ctx.queries);
  });

  it('paths (Sankey links)', async () => {
    const ctx = lakeContext();
    await runPaths(pathsSpec.parse({ from: '-7d' }), ctx);
    noValues(ctx.queries);
  });

  it('rolling-window trends (wau, mau)', async () => {
    const ctx = lakeContext();
    await runTrends(
      trendsSpec.parse({
        from: '-14d',
        series: [
          { event: 'visit', math: 'wau' },
          { event: 'visit', math: 'mau' },
        ],
      }),
      ctx,
    );
    noValues(ctx.queries);
  });

  it('revenue (MRR state at each bucket end)', async () => {
    const ctx = lakeContext();
    await runRevenue({ from: '2026-07-01', currency: 'GBP' }, ctx);
    noValues(ctx.queries);
  });
});
