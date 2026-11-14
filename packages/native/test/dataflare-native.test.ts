import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBot, parseUserAgent } from '../../core/src/ua.ts';
import {
  createDataflare,
  type DataflareNativeConfig,
  type DataflareStorage,
  normalizeRoute,
  userAgentFor,
} from '../src/dataflare-native.ts';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: {
    project: string;
    lib: string;
    events: Array<{
      id: string;
      event: string;
      distinct_id: string | null;
      user_id: string | null;
      session_id: string | null;
      url: string | null;
      props: Record<string, unknown>;
    }>;
  };
}

function memoryStorage(
  initial: Record<string, string> = {},
): DataflareStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    async getItem(k) {
      return data[k] ?? null;
    },
    async setItem(k, v) {
      data[k] = v;
    },
    async removeItem(k) {
      delete data[k];
    },
  };
}

function setup(overrides: Partial<DataflareNativeConfig> = {}, status = 204) {
  const sent: Sent[] = [];
  let t = 1_700_000_000_000;
  const client = createDataflare({
    project: 'latchflow',
    platform: { os: 'ios', osVersion: '18.2', device: 'mobile' },
    app: { version: '1.4.0', build: '42' },
    flushIntervalMs: 0,
    now: () => t,
    fetch: async (url, init) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return { ok: status < 400, status };
    },
    ...overrides,
  });
  return { client, sent, advance: (ms: number) => (t += ms) };
}

test('batches events to /e with the wire format the Worker expects', async () => {
  const { client, sent } = setup();
  client.screen('/(tabs)/rooms/[roomId]');
  client.track('booking_created', { rooms: 2, email: 'a@b.co', note: 'x'.repeat(300) });
  await client.flush();
  assert.equal(sent.length, 1);
  const [batch] = sent;
  assert.equal(batch?.url, 'https://observe.gmac.io/e');
  assert.equal(batch?.body.project, 'latchflow');
  assert.equal(batch?.body.lib, 'react-native/0.1.0');
  const [screen, booking] = batch?.body.events ?? [];
  assert.equal(screen?.event, '$pageview');
  assert.equal(screen?.url, 'app://latchflow/rooms/:roomId');
  assert.equal(screen?.props.$screen, '/rooms/:roomId');
  assert.equal(booking?.event, 'booking_created');
  assert.deepEqual(
    { rooms: booking?.props.rooms, email: booking?.props.email, note: booking?.props.note },
    { rooms: 2, email: undefined, note: undefined },
  );
  assert.equal(booking?.props.$os, 'ios');
  assert.equal(booking?.props.$app_version, '1.4.0');
  assert.match(
    booking?.id ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(screen?.session_id, booking?.session_id);
  assert.ok(screen?.distinct_id);
});

test('the User-Agent parses as a mobile device, never as a bot', () => {
  const cases: Array<[DataflareNativeConfig['platform'], string, string]> = [
    [{ os: 'ios', osVersion: '18.2', device: 'mobile' }, 'iOS', 'mobile'],
    [{ os: 'ios', osVersion: '18.2', device: 'tablet' }, 'iOS', 'tablet'],
    [{ os: 'android', osVersion: 35, device: 'mobile' }, 'Android', 'mobile'],
    [{ os: 'android', osVersion: 35, device: 'tablet' }, 'Android', 'tablet'],
  ];
  for (const [platform, os, device] of cases) {
    const ua = userAgentFor(platform);
    assert.equal(isBot(ua), false, ua);
    const parsed = parseUserAgent(ua);
    assert.equal(parsed.os, os, ua);
    assert.equal(parsed.device, device, ua);
  }
  const { client, sent } = setup();
  client.track('x_done');
  return client
    .flush()
    .then(() =>
      assert.equal(
        sent[0]?.headers['User-Agent'],
        userAgentFor({ os: 'ios', osVersion: '18.2', device: 'mobile' }),
      ),
    );
});

test('identify attaches the user id; reset starts a new anonymous device', async () => {
  const storage = memoryStorage();
  const { client, sent } = setup({ storage });
  client.track('before_login');
  client.identify(1234, { plan: 'pro', email: 'nope@example.com' });
  client.track('after_login');
  client.reset();
  client.track('after_logout');
  await client.flush();
  const events = sent.flatMap((s) => s.body.events);
  const byName = Object.fromEntries(events.map((e) => [e.event, e]));
  assert.equal(byName.before_login?.user_id, null);
  assert.equal(byName.$identify?.user_id, '1234');
  assert.deepEqual(byName.$identify?.props.$set, { plan: 'pro' });
  assert.equal(byName.after_login?.user_id, '1234');
  assert.equal(byName.after_logout?.user_id, null);
  assert.notEqual(byName.after_logout?.distinct_id, byName.before_login?.distinct_id);
  assert.equal(storage.data['dataflare:latchflow:user_id'], undefined);
  assert.equal(storage.data['dataflare:latchflow:distinct_id'], byName.after_logout?.distinct_id);
});

test('stored ids survive a restart', async () => {
  const storage = memoryStorage({
    'dataflare:latchflow:distinct_id': 'device-1',
    'dataflare:latchflow:user_id': 'user-9',
  });
  const { client, sent } = setup({ storage });
  client.track('opened');
  await client.flush();
  assert.equal(sent[0]?.body.events[0]?.distinct_id, 'device-1');
  assert.equal(sent[0]?.body.events[0]?.user_id, 'user-9');
});

test('identify: false never links activity to an account', async () => {
  const storage = memoryStorage({ 'dataflare:latchflow:user_id': 'user-9' });
  const { client, sent } = setup({ storage, identify: false });
  client.identify('user-1');
  client.track('opened');
  await client.flush();
  const events = sent.flatMap((s) => s.body.events);
  assert.deepEqual(
    events.map((e) => [e.event, e.user_id]),
    [['opened', null]],
  );
});

test('server errors keep the batch for the next flush; 4xx drops it', async () => {
  const failing = setup({}, 503);
  failing.client.track('a_done');
  await failing.client.flush();
  await failing.client.flush();
  assert.equal(failing.sent.length, 2);
  assert.equal(failing.sent[1]?.body.events[0]?.event, 'a_done');

  const rejected = setup({}, 400);
  rejected.client.track('b_done');
  await rejected.client.flush();
  await rejected.client.flush();
  assert.equal(rejected.sent.length, 1);
});

test('a new session starts after 30 idle minutes', async () => {
  const { client, sent, advance } = setup();
  client.track('one');
  await client.flush();
  advance(31 * 60 * 1000);
  client.track('two');
  await client.flush();
  assert.notEqual(sent[0]?.body.events[0]?.session_id, sent[1]?.body.events[0]?.session_id);
});

test('disabled, reserved names and maxBatch', async () => {
  const off = setup({ enabled: false });
  off.client.track('x_done');
  off.client.screen('/home');
  await off.client.flush();
  assert.equal(off.sent.length, 0);

  const { client, sent } = setup({ maxBatch: 2 });
  client.track('$pageview');
  client.track('one');
  client.track('two');
  await client.ready;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0]?.body.events.map((e) => e.event),
    ['one', 'two'],
  );
});

test('normalizeRoute', () => {
  assert.equal(normalizeRoute('/'), '/');
  assert.equal(normalizeRoute('/(tabs)/(home)/index'), '/index');
  assert.equal(normalizeRoute('/rooms/123?tab=a'), '/rooms/:id');
  assert.equal(normalizeRoute('/u/0f8fad5b-d9cb-469f-a165-70867728950e/edit'), '/u/:id/edit');
  assert.equal(normalizeRoute('/docs/[...slug]'), '/docs/:slug');
  assert.equal(normalizeRoute('settings/profile'), '/settings/profile');
});
