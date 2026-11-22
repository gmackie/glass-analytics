/**
 * Alerts: value thresholds, increases and decreases (absolute and percent), the last complete
 * bucket vs the ongoing one, every breakdown value, funnel conversion, and the words.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alertConditionSchema, describeCondition, evaluateAlert } from '../src/alerts.ts';
import type { FunnelResult } from '../src/insights/funnel.ts';
import type { TrendsResult } from '../src/insights/trends.ts';

const trends = (
  lines: { breakdown: string | null; values: number[]; seriesIndex?: number }[],
): TrendsResult => ({
  kind: 'trends',
  interval: 'day',
  buckets: [1, 2, 3, 4],
  series: lines.map((l) => ({
    label: 'Pageview',
    breakdown: l.breakdown,
    values: l.values,
    total: 0,
    seriesIndex: l.seriesIndex ?? 0,
    math: 'total',
  })),
  summary: '',
  sql: [],
  range: { from: '', to: '' },
});

const step = (count: number, conv: number) => ({
  label: 's',
  event: 'e',
  count,
  conversionFromStart: conv,
  conversionFromPrevious: conv,
  avgSecondsFromPrevious: null,
  medianSecondsFromPrevious: null,
});

describe('alerts', () => {
  it('checks the last complete bucket against a value, or the ongoing one', () => {
    const r = trends([{ breakdown: null, values: [10, 20, 1200, 5] }]);
    const done = evaluateAlert(r, {}, { type: 'value', above: 1000 });
    assert.equal(done.at, 3);
    assert.equal(done.value, 1200);
    assert.equal(done.breaches.length, 1);
    const live = evaluateAlert(r, {}, { type: 'value', above: 1000 }, true);
    assert.equal(live.value, 5);
    assert.equal(live.breaches.length, 0);
    assert.equal(evaluateAlert(r, {}, { type: 'value', below: 15 }, true).breaches.length, 1);
  });

  it('compares with the bucket before, by a count or a percent', () => {
    const r = trends([{ breakdown: null, values: [0, 100, 70, 0] }]);
    assert.equal(evaluateAlert(r, {}, { type: 'decrease', by: 30 }).breaches.length, 1);
    assert.equal(evaluateAlert(r, {}, { type: 'decrease', by: 31 }).breaches.length, 0);
    assert.equal(
      evaluateAlert(r, {}, { type: 'decrease', by: 30, unit: 'percent' }).breaches.length,
      1,
    );
    assert.equal(evaluateAlert(r, {}, { type: 'increase', by: 1 }).breaches.length, 0);
    // From zero there is no percent change.
    const z = trends([{ breakdown: null, values: [0, 0, 50, 0] }]);
    assert.equal(
      evaluateAlert(z, {}, { type: 'increase', by: 10, unit: 'percent' }).breaches.length,
      0,
    );
  });

  it('checks every breakdown value of the chosen series', () => {
    const r = trends([
      { breakdown: 'Chrome', values: [0, 0, 50, 0] },
      { breakdown: 'Safari', values: [0, 0, 500, 0] },
      { breakdown: null, values: [0, 0, 9999, 0], seriesIndex: 1 },
    ]);
    const e = evaluateAlert(r, { series: 0 }, { type: 'value', above: 100 });
    assert.deepEqual(
      e.breaches.map((b) => b.breakdown),
      ['Safari'],
    );
    assert.equal(e.value, 500);
    assert.match(
      evaluateAlert(r, { series: 5 }, { type: 'value', above: 1 }).note ?? '',
      /no data/,
    );
  });

  it('needs enough buckets', () => {
    const r = { ...trends([{ breakdown: null, values: [3] }]), buckets: [1] };
    assert.match(evaluateAlert(r, {}, { type: 'value', above: 1 }).note ?? '', /Not enough/);
  });

  it('alerts on funnel conversion, per breakdown value', () => {
    const r = {
      kind: 'funnel',
      steps: [step(100, 1), step(40, 0.4), step(10, 0.1)],
      breakdowns: [
        { value: 'google', steps: [step(50, 1), step(30, 0.6), step(10, 0.2)] },
        { value: 'direct', steps: [step(50, 1), step(10, 0.2), step(0, 0)] },
      ],
    } as unknown as FunnelResult;
    const e = evaluateAlert(r, {}, { type: 'value', below: 0.05 });
    assert.deepEqual(
      e.breaches.map((b) => b.breakdown),
      ['direct'],
    );
    assert.equal(evaluateAlert(r, { step: 2 }, { type: 'value', below: 0.3 }).breaches.length, 1);
    assert.match(evaluateAlert(r, {}, { type: 'increase', by: 1 }).note ?? '', /value/);
  });

  it('validates and describes conditions', () => {
    assert.throws(() => alertConditionSchema.parse({ type: 'value' }));
    assert.throws(() => alertConditionSchema.parse({ type: 'increase' }));
    assert.equal(describeCondition({ type: 'value', above: 1000 }), 'above 1,000');
    assert.equal(describeCondition({ type: 'value', below: 0.05 }, true), 'below 5%');
    assert.equal(
      describeCondition({ type: 'decrease', by: 20, unit: 'percent' }),
      'down by 20% or more',
    );
  });
});
