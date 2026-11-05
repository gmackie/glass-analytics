import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_ROW_LIMIT, type JourneysResult, runJourneys } from '../src/insights/journeys.ts';
import { context, createDb, DAY, insert, NOW } from './helpers.ts';

function conserved(r: JourneysResult) {
  const first = r.nodes.filter((n) => n.step === 0).reduce((n, x) => n + x.count, 0);
  assert.equal(first, r.sessions);
  assert.equal(
    Object.values(r.terminations).reduce((n, x) => n + x, 0),
    r.sessions,
  );
  for (const n of r.nodes) {
    if (n.step > 0)
      assert.equal(
        r.edges.filter((e) => e.target === n.id).reduce((v, e) => v + e.count, 0),
        n.count,
      );
    if (n.kind !== 'termination')
      assert.equal(
        r.edges.filter((e) => e.source === n.id).reduce((v, e) => v + e.count, 0),
        n.count,
      );
  }
}
const base = NOW - 2 * 3_600_000;
describe('session journeys', () => {
  it('selects session cohorts without hiding subsequent steps and reports source delay', async () => {
    const db = createDb();
    insert(db, [
      { event: '$pageview', path: '/pricing', ts_ms: base, session_id: 'qualified' },
      { event: 'purchase', ts_ms: base + 1000, session_id: 'qualified' },
      { event: '$pageview', path: '/other', ts_ms: base, session_id: 'other' },
    ]);
    const r = await runJourneys(
      { from: '-1d', filters: [{ property: 'session.path', value: '/pricing' }] },
      { ...context(db), freshnessSeconds: 60 },
    );
    assert.equal(r.sessions, 1);
    assert.ok(r.nodes.some((n) => n.label === 'purchase'));
    assert.equal(r.observation.asOf, new Date(NOW - 60_000).toISOString());
    conserved(r);
  });
  it('keeps loops layered, chooses first anchor, collapses repeats and conserves pruned flows', async () => {
    const db = createDb();
    for (let i = 0; i < 4; i++)
      insert(
        db,
        ['start', 'start', i % 2 ? 'branch' : 'Other', 'start', 'finish'].map((event, j) => ({
          event,
          session_id: `s${i}`,
          ts_ms: base + j * 1000,
        })),
      );
    const r = await runJourneys(
      { from: '-1d', anchor: { event: 'start' }, collapseConsecutive: true, maxLabels: 1 },
      context(db),
    );
    assert.equal(r.sessions, 4);
    assert.equal(r.terminations.observed_end, 4);
    assert.ok(r.nodes.some((n) => n.step === 2 && n.label === 'start'));
    assert.ok(r.limits.pruned);
    conserved(r);
    assert.equal(new Set(r.nodes.map((n) => n.id)).size, r.nodes.length);
  });
  it('retrieves context outside the anchor interval and reverses before the first anchor', async () => {
    const db = createDb();
    insert(db, [
      { id: 'a', event: 'before', ts_ms: base - 1000 },
      { id: 'b', event: 'anchor', ts_ms: base },
      { id: 'c', event: 'after', ts_ms: base + 1000 },
    ]);
    const forward = await runJourneys(
      { from: base, to: base + 1, anchor: { event: 'anchor' } },
      context(db),
    );
    assert.ok(forward.nodes.some((n) => n.label === 'after'));
    conserved(forward);
    const backward = await runJourneys(
      { from: base, to: base + 1, anchor: { event: 'anchor' }, direction: 'backward' },
      context(db),
    );
    assert.deepEqual(
      backward.nodes.filter((n) => n.kind === 'event').map((n) => n.label),
      ['anchor', 'before'],
    );
    assert.equal(backward.terminations.observed_start, 1);
    conserved(backward);
  });
  it('selects sessions using cohort filters without dropping other steps and separates reused session ids by person/project', async () => {
    const db = createDb();
    insert(db, [
      { event: 'anchor', ts_ms: base, props: { plan: 'pro' } },
      { event: 'later', ts_ms: base + 1 },
      { event: 'leak', ts_ms: base, project: 'other' },
      { event: 'other-person', ts_ms: base, distinct_id: 'd2', session_id: 's-d1' },
    ]);
    const r = await runJourneys(
      { from: '-1d', anchor: { event: 'anchor' }, filters: [{ property: 'plan', value: 'pro' }] },
      context(db),
    );
    assert.equal(r.sessions, 1);
    assert.ok(r.nodes.some((n) => n.label === 'later'));
    assert.ok(!r.nodes.some((n) => n.label.includes('leak') || n.label === 'other-person'));
    conserved(r);
  });
  it('labels observation, duration and step caps without claiming abandonment', async () => {
    const db = createDb();
    insert(db, [
      { event: 'anchor', ts_ms: NOW - 1000 },
      { event: 'finish', ts_ms: NOW - 500 },
    ]);
    let r = await runJourneys({ from: '-1d', anchor: { event: 'anchor' } }, context(db));
    assert.equal(r.terminations.observation_pending, 1);
    r = await runJourneys({ from: '-1d', anchor: { event: 'anchor' }, maxSteps: 1 }, context(db));
    assert.equal(r.terminations.step_limit, 1);
    conserved(r);
    const old = createDb();
    insert(old, [
      { event: 'anchor', ts_ms: base },
      { event: 'out', ts_ms: base + 60 * 60 * 1000 + 1 },
    ]);
    // The context scan may not include a later event beyond the bounded range; report a bounded observed end, never abandonment.
    r = await runJourneys(
      { from: base, to: base + 2, anchor: { event: 'anchor' }, maxDuration: '30m' },
      context(old),
    );
    assert.equal(r.terminations.observed_end, 1);
  });
  it('uses deterministic id ordering, supports page nodes and excludes process events', async () => {
    const db = createDb();
    insert(db, [
      { id: 'b', event: '$pageview', path: '/second', ts_ms: base },
      { id: 'a', event: '$pageview', path: '/first', ts_ms: base },
      { id: 'c', event: 'case', props: { $event_class: 'process' }, ts_ms: base + 1 },
    ]);
    const r = await runJourneys({ from: '-1d', node: 'page' }, context(db));
    assert.deepEqual(
      r.nodes.filter((n) => n.kind === 'event').map((n) => n.label),
      ['/first', '/second'],
    );
    conserved(r);
  });
  it('deduplicates repeated lake rows, rejects conflicts and refuses overflow rather than slicing', async () => {
    const db = createDb();
    insert(db, [{ event: 'start', ts_ms: base }]);
    const ctx = context(db);
    const execute = ctx.execute;
    ctx.execute = async (sql) => {
      const rows = await execute(sql);
      return [...rows, ...rows];
    };
    assert.equal((await runJourneys({ from: '-1d' }, ctx)).sessions, 1);
    ctx.execute = async (sql) => {
      const rows = await execute(sql);
      return [...rows, { ...rows[0], label: 'conflict' }];
    };
    await assert.rejects(runJourneys({ from: '-1d' }, ctx), /Conflicting/);
    ctx.execute = async () => Array.from({ length: JOURNEY_ROW_LIMIT + 1 }, () => ({}));
    await assert.rejects(runJourneys({ from: '-1d' }, ctx), /no partial graph/);
    await assert.rejects(runJourneys({ from: NOW - 8 * DAY }, context(db)), /7 days/);
    await assert.rejects(runJourneys({ maxDuration: '25h' }, context(db)), /24 hours/);
  });
});
