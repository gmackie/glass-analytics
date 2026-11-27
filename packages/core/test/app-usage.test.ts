import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppUsage, dashboardScreen } from '../src/app-usage.ts';

test('app usage counts visible visits and completed reports, keeping selections private', () => {
  const events: { event: string; props: Record<string, unknown> }[] = [];
  const usage = createAppUsage('ios', 'verification', (event, props) =>
    events.push({ event, props }),
  );
  usage.reportResult()('paths', true);
  usage.detail('step');
  usage.open('demo');
  usage.open('live');
  usage.visit('overview', 'demo', 'private-project');
  const first = usage.reportResult();
  first('overview', false);
  usage.visit('overview', 'demo', 'private-project');
  usage.reportResult()('overview', true);
  usage.visit('paths', 'live', 'private-project');
  first('paths', true);
  usage.reportResult()('paths', true);
  usage.detail('transition');
  usage.connection('live', 'failed');
  usage.visit('paths', 'live', 'private-second-project');
  const late = usage.reportResult();
  usage.leave();
  late('paths', true);
  assert.deepEqual(
    events.map((e) => e.event),
    [
      'app_opened',
      '$pageview',
      'report_viewed',
      '$pageview',
      'report_viewed',
      'path_detail_opened',
      'worker_connection',
      '$pageview',
    ],
  );
  assert.deepEqual(events[4]?.props, {
    surface: 'ios',
    traffic: 'verification',
    mode: 'live',
    screen: 'paths',
    report: 'paths',
    has_data: true,
  });
  assert.equal(events[2]?.props.has_data, false);
  assert.equal(events[5]?.props.target, 'transition');
  assert.equal(events[6]?.props.outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /private-/);
});

test('dashboard route names are bounded even for deep links to customer records', () => {
  assert.equal(dashboardScreen('web', []), 'overview');
  assert.equal(dashboardScreen('reports', ['segment']), 'overview');
  assert.equal(dashboardScreen('insights', ['new', 'paths']), 'paths');
  assert.equal(dashboardScreen('insights', ['paths']), 'paths');
  assert.equal(dashboardScreen('insights', ['a-private-saved-analysis']), 'insights');
  assert.equal(dashboardScreen('users', ['private-person']), 'users');
  assert.equal(dashboardScreen('private-unrecognised', []), 'other');
});
