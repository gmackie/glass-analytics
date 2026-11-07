import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSites, siteTrend } from '../src/insights/sites.ts';
import { context, createDb, insert, type TestEvent } from './helpers.ts';

/** `n` visitors with one pageview each, `daysAgo` days before NOW. */
function visitors(project: string, n: number, daysAgo: number, prefix = 'v'): TestEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    project,
    distinct_id: `${project}-${prefix}${daysAgo}-${i}`,
    daysAgo,
  }));
}

describe('all sites', () => {
  it('compares every project with its previous period in one pass', async () => {
    const db = createDb();
    insert(db, [
      // grows: 10 visitors before, 20 now
      ...visitors('grows', 10, 10),
      ...visitors('grows', 20, 1),
      // shrinks: 30 before, 12 now; one visitor with three pageviews
      ...visitors('shrinks', 30, 9),
      ...visitors('shrinks', 11, 2),
      { project: 'shrinks', distinct_id: 'repeat', daysAgo: 3 },
      { project: 'shrinks', distinct_id: 'repeat', daysAgo: 3 },
      { project: 'shrinks', distinct_id: 'repeat', daysAgo: 4 },
      // stopped: traffic last period only
      ...visitors('stopped', 5, 12),
      // other events and other projects don't count
      { project: 'grows', event: 'signup', distinct_id: 'x', daysAgo: 1 },
      ...visitors('unlisted', 50, 1),
    ]);
    const ctx = context(db);
    const r = await runSites({ from: '-7d' }, ['grows', 'shrinks', 'stopped', 'empty'], ctx);

    assert.deepEqual(
      r.sites.map((s) => [s.project, s.visitors, s.pageviews, s.previous.visitors, s.trend]),
      [
        ['grows', 20, 20, 10, 'up'],
        ['shrinks', 12, 14, 30, 'down'],
        ['empty', 0, 0, 0, 'none'],
        ['stopped', 0, 0, 5, 'stopped'],
      ],
    );
    const grows = r.sites[0]!;
    assert.equal(grows.change, 1);
    assert.equal(grows.series.length, r.buckets.length);
    assert.equal(
      grows.series.reduce((a, b) => a + b, 0),
      20,
    );
    assert.equal(
      r.sites.find((s) => s.project === 'stopped')!.lastPageview?.slice(0, 10),
      '2026-10-19',
    );
    assert.equal(r.sites.find((s) => s.project === 'empty')!.lastPageview, null);
    assert.equal(ctx.queries.length, 2);
    assert.match(
      r.summary,
      /^32 visitors across 4 sites\. Gaining: grows \+100\.0%\. Losing: shrinks -60\.0%\./,
    );
    assert.match(r.summary, /check the tag\): stopped\./);
  });

  it('returns no rows and runs no query without projects', async () => {
    const ctx = context(createDb());
    const r = await runSites({ from: '-7d' }, [], ctx);
    assert.deepEqual(r.sites, []);
    assert.equal(ctx.queries.length, 0);
  });

  it('only calls a trend on enough traffic', () => {
    assert.equal(siteTrend(0, 0), 'none');
    assert.equal(siteTrend(3, 0), 'new');
    assert.equal(siteTrend(0, 3), 'stopped');
    assert.equal(siteTrend(8, 4), 'quiet');
    assert.equal(siteTrend(23, 20), 'steady');
    assert.equal(siteTrend(16, 20), 'down');
    assert.equal(siteTrend(25, 20), 'up');
  });
});
