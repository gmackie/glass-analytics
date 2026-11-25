import assert from 'node:assert/strict';
import { it } from 'node:test';
import { activationKey, activationMapping, activationPair } from '../src/activation.ts';

it('requires observed signup and first value in the same project catalog', () => {
  const names = ['signup_started', 'project_created'];
  assert.equal(activationMapping('levelforge', [], names), undefined);
  names.push('signup');
  assert.deepEqual(
    activationMapping('levelforge', [], names),
    activationPair('signup', 'project_created'),
  );
  assert.equal(activationMapping('power-grid', [], names), undefined);
});

it('uses the window of a matching saved journey and requires both catalog events', () => {
  const names = ['signup_completed', 'gateway_connected'];
  const spec = activationPair(names[0]!, names[1]!, '30d');
  const journeys = [{ key: 'controlsfoundry-activation', kind: 'funnel', spec }];
  assert.deepEqual(activationMapping('controlsfoundry', journeys, names), spec);
  assert.equal(activationMapping('controlsfoundry', journeys, names.slice(0, 1)), undefined);
  assert.equal(activationMapping('controlsfoundry', [], names), undefined);
});

it('explicit configuration wins and incompatible specs never produce rates', () => {
  const names = ['registered', 'deployed'];
  const spec = activationPair(names[0]!, names[1]!);
  const read = (overrides: Record<string, unknown>) =>
    activationMapping(
      'custom',
      [{ key: activationKey, kind: 'funnel', spec: { ...spec, ...overrides } }],
      names,
    );
  assert.deepEqual(read({}), spec);
  for (const changes of [
    { steps: [] },
    { steps: [{ event: 'registered' }, { event: 'registered' }] },
    { aggregateBy: 'session' },
    { filters: [] },
    { order: 'unordered' },
    { steps: [{ event: 'registered' }, { event: 'never_seen' }] },
    { steps: [{ event: 'registered' }, { event: 'deployed', optional: true }] },
  ])
    assert.equal(read(changes), undefined);
});
