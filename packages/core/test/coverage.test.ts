import assert from 'node:assert/strict';
import { it } from 'node:test';
import { coverageTotals, runCoverage } from '../src/insights/coverage.ts';
import { context, createDb, insert } from './helpers.ts';

it('reconciles the registry, observed events, role definitions and quiet funnel steps', async () => {
  const db = createDb();
  insert(db, [
    { project: 'quiet', daysAgo: 45 },
    { project: 'another-install' },
    { project: 'system' },
    { project: 'probe', event: 'journey_verified' },
    { project: 'review', event: 'answered' },
    { project: 'marked', event: 'played' },
  ]);
  const projects = ['quiet', 'system', 'probe', 'review', 'marked'];
  const definitions = ['probe', 'marked'].map((project, i) => ({
    project,
    event: ['journey_verified', 'played'][i]!,
    role: 'important',
    description: 'documented',
  }));
  const result = await runCoverage({}, projects, definitions, context(db), [
    { project: 'quiet', event: 'created', name: 'Main journey' },
  ]);
  assert.deepEqual(coverageTotals(result), {
    registered: 5,
    active: 4,
    custom: 3,
    systemOnly: 1,
    quiet: 1,
  });
  assert.deepEqual(
    result.map((p) => p.status),
    [
      'No observed traffic',
      'System events only',
      'Operational probes only among custom events',
      'Custom events to review',
      'Marked action observed',
    ],
  );
  assert.deepEqual(
    result.map((p) => p.configured),
    [0, 0, 0, 0, 1],
  );
  assert.equal(result[0]?.events[0]?.count, 0);
  assert.deepEqual(result[0]?.events[0]?.funnels, ['Main journey']);
});
