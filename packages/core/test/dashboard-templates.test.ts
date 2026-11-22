import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_TEMPLATES, guessEvents, templateTiles } from '../src/dashboard-templates.ts';
import { INSIGHTS } from '../src/insights/index.ts';

describe('dashboard templates', () => {
  it('every tile is a valid spec for its kind', () => {
    const events = { signup: 'signup_completed', purchase: 'order_paid' };
    for (const t of DASHBOARD_TEMPLATES)
      for (const tile of templateTiles(t.id, events)) {
        if (!tile.insight) continue;
        const { kind, spec } = tile.insight;
        assert.doesNotThrow(
          () => INSIGHTS[kind].schema.parse(spec),
          `${t.id}: ${tile.insight.name}`,
        );
      }
  });

  it('guesses the signup and purchase events, and says which is missing', () => {
    assert.deepEqual(guessEvents(['$pageview', 'signup_completed', 'order_paid', 'report_run']), {
      signup: 'signup_completed',
      purchase: 'order_paid',
    });
    assert.throws(() => templateTiles('revenue', {}), /purchase event/);
    assert.throws(() => templateTiles('nope', {}), /Unknown template/);
    assert.equal(templateTiles('website', {}).length, 5);
  });
});
