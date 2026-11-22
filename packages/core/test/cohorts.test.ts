/**
 * Cohort definitions compile to person-id SQL that runs on SQLite (and Basin SQL,
 * see the lake conformance suite). One test per condition type.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CohortCondition,
  type CohortContext,
  type CohortDefinition,
  compileCohort,
  describeCohort,
  normaliseCohort,
} from '../src/cohorts.ts';
import { sqlite } from '../src/sql/dialect.ts';
import { context, createDb, DAY, insert, NOW, type TestEvent } from './helpers.ts';

const ev = (
  distinct: string,
  event: string,
  daysAgo: number,
  extra: Partial<TestEvent> = {},
): TestEvent => ({
  distinct_id: distinct,
  event,
  daysAgo,
  ...extra,
});

function db() {
  const d = createDb();
  insert(d, [
    // power: reports on 4 of the last 5 days, plan pro.
    ...[0, 1, 2, 4].map((n) => ev('power', 'report', n, { person_props: { plan: 'pro' } })),
    // casual: one report 3 days ago, plan free.
    ev('casual', 'report', 3, { person_props: { plan: 'free' } }),
    // lapsed: reports 20 and 18 days ago, nothing since.
    ev('lapsed', 'report', 20),
    ev('lapsed', 'report', 18),
    ev('lapsed', 'visit', 1),
    // newbie: first ever report yesterday, then an invite an hour later.
    ev('newbie', 'report', 1),
    { distinct_id: 'newbie', event: 'invite', ts_ms: NOW - DAY + 3_600_000 },
    // veteran: first report 60 days ago, again today.
    ev('veteran', 'report', 60),
    ev('veteran', 'report', 0),
    // idle: only visits.
    ev('idle', 'visit', 2),
  ]);
  return d;
}

function ctx(
  cohorts: Record<string, CohortDefinition | 'static'> = {},
  members: Record<string, string[]> = {},
): CohortContext {
  return {
    dialect: sqlite,
    project: 'p',
    now: NOW,
    lookup: (key) => cohorts[key],
    staticMembers: (key) =>
      `SELECT column1 AS pid FROM (VALUES ${(members[key] ?? ['__none__']).map((id) => `('${id}')`).join(', ')}) v`,
  };
}

async function members(def: CohortDefinition, c = ctx()): Promise<string[]> {
  const q = context(db());
  const rows = await q.execute(compileCohort(def, c));
  return rows.map((r) => String(r.pid)).sort();
}

const one = (condition: CohortCondition): CohortDefinition => ({
  groups: [{ conditions: [condition] }],
});

describe('cohort conditions', () => {
  it('property', async () => {
    assert.deepEqual(
      await members(one({ type: 'property', property: 'person.plan', value: 'pro' })),
      ['power'],
    );
    assert.ok(
      !(
        await members(
          one({ type: 'property', property: 'person.plan', value: 'pro', negate: true }),
        )
      ).includes('power'),
    );
  });

  it('performed N times within a window', async () => {
    const atLeast3 = one({
      type: 'performed',
      event: 'report',
      count: { op: 'gte', value: 3 },
      within: '7d',
    });
    assert.deepEqual(await members(atLeast3), ['power']);
    const exactly1 = one({
      type: 'performed',
      event: 'report',
      count: { op: 'eq', value: 1 },
      within: '7d',
    });
    assert.deepEqual(await members(exactly1), ['casual', 'newbie', 'veteran']);
    // "At most once" includes people who never did it in the window.
    const atMost1 = one({
      type: 'performed',
      event: 'report',
      count: { op: 'lte', value: 1 },
      within: '7d',
    });
    assert.deepEqual(await members(atMost1), ['casual', 'idle', 'lapsed', 'newbie', 'veteran']);
  });

  it('not performed', async () => {
    assert.deepEqual(await members(one({ type: 'not_performed', event: 'report', within: '7d' })), [
      'idle',
      'lapsed',
    ]);
  });

  it('performed regularly', async () => {
    const regular = one({
      type: 'performed_regularly',
      event: 'report',
      period: 'day',
      periods: 5,
      minPeriods: 3,
    });
    assert.deepEqual(await members(regular), ['power']);
  });

  it('first performed within a window', async () => {
    // veteran first reported 60 days ago, so they're not new even though they reported today.
    assert.deepEqual(
      await members(one({ type: 'first_performed', event: 'report', within: '3d' })),
      ['newbie'],
    );
  });

  it('stopped and started', async () => {
    assert.deepEqual(
      await members(one({ type: 'stopped', event: 'report', within: '14d', before: '14d' })),
      ['lapsed'],
    );
    // Started in the last 3 days, not in the 30 before: newbie (and veteran, whose last was 60 days ago).
    assert.deepEqual(
      await members(one({ type: 'started', event: 'report', within: '3d', before: '30d' })),
      ['newbie', 'veteran'],
    );
  });

  it('sequence within a gap', async () => {
    const seq = one({
      type: 'sequence',
      event: 'report',
      followedBy: { event: 'invite' },
      gap: '2h',
      within: '7d',
    });
    assert.deepEqual(await members(seq), ['newbie']);
  });

  it('nested cohorts, static members and loops', async () => {
    const pro = one({ type: 'property', property: 'person.plan', value: 'pro' });
    const c = ctx({ pro, vip: 'static' }, { vip: ['casual'] });
    assert.deepEqual(await members(one({ type: 'cohort', key: 'pro' }), c), ['power']);
    assert.deepEqual(await members(one({ type: 'cohort', key: 'vip' }), c), ['casual']);
    const loop = ctx({
      a: one({ type: 'cohort', key: 'b' }),
      b: one({ type: 'cohort', key: 'a' }),
    });
    const a = loop.lookup('a') as CohortDefinition;
    assert.throws(() => compileCohort(a, loop, ['a']), /loop: a → b → a/);
    assert.throws(
      () => compileCohort(one({ type: 'cohort', key: 'nope' }), ctx()),
      /No cohort "nope"/,
    );
  });

  it('combines conditions with all/any in groups', async () => {
    const def: CohortDefinition = {
      match: 'any',
      groups: [
        { conditions: [{ type: 'property', property: 'person.plan', value: 'free' }] },
        {
          match: 'all',
          conditions: [
            { type: 'performed', event: 'report', within: '2d' },
            { type: 'not_performed', event: 'invite', within: '7d' },
          ],
        },
      ],
    };
    assert.deepEqual(await members(def), ['casual', 'power', 'veteran']);
    assert.match(
      describeCohort(def),
      /person\.plan is "free".* or .*did report in the last 2 days and didn't do invite in the last 7 days/,
    );
  });
});

describe('version 1 cohorts', () => {
  it('keep their meaning: one event in the look-back matching every filter', async () => {
    const v2 = normaliseCohort(
      { filters: [{ property: 'person.plan', value: 'pro' }], didEvent: 'report', from: '-30d' },
      NOW,
    );
    assert.equal(v2.groups[0]!.conditions[0]!.type, 'performed');
    assert.deepEqual(await members(v2), ['power']);
    const everyone = normaliseCohort({ filters: [], from: '-7d' }, NOW);
    assert.deepEqual(await members(everyone), [
      'casual',
      'idle',
      'lapsed',
      'newbie',
      'power',
      'veteran',
    ]);
  });
});
