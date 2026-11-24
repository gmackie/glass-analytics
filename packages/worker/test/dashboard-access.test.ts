import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { sha256Hex } from '@dataflare/core/hash';
import type { WorkerAccess } from '../src/env.ts';
import { READ, type TestApp, testApp, wire } from './harness.ts';

const origin = 'https://glass.test';
const admin = 'owner@example.test';
const owner: WorkerAccess = {
  aud: 'observe',
  getIdentity: async () => ({ email: admin.toUpperCase() }),
};
const session = { access: owner, key: null };
let t: TestApp;

describe('Cloudflare Access dashboard', () => {
  beforeEach(async () => {
    t = testApp({
      GLASS_PUBLIC_URL: origin,
      GLASS_ACCESS_AUD: owner.aud,
      GLASS_ACCESS_ADMIN_EMAIL_SHA256: await sha256Hex(admin),
    });
  });

  it('serves the signed-in dashboard and API on both mounts, without an API key', async () => {
    for (const prefix of ['', '/_glass']) {
      const shell = await t.call('GET', prefix + '/app', session);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /name="glass-auth" content="access"/);
      const api = await t.call('GET', prefix + '/app/api', session);
      assert.equal((await api.json()).scope, 'admin');
      for (const res of [shell, api]) {
        assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
      }
      for (const path of ['/app/', '/app/app.js', '/app/app.css', '/app/api/projects'])
        assert.equal((await t.call('GET', prefix + path, session)).status, 200);
    }
    assert.equal((await t.call('GET', '/app/missing', session)).status, 404);
    assert.equal(
      (await t.call('POST', '/app', { ...session, headers: { Origin: origin } })).status,
      405,
    );
  });

  it('requires a runtime-authenticated user for this application and the configured administrator', async () => {
    // These headers carry no authority outside a Cloudflare-authenticated invocation.
    const headers = {
      'Cf-Access-Authenticated-User-Email': admin,
      'Cf-Access-Jwt-Assertion': 'invalid',
    };
    for (const path of ['/app', '/app/api/projects', '/_glass/app/api']) {
      const anonymous = await t.call('GET', path, { headers });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get('Cache-Control'), 'private, no-store');
      const unrelated = { ...owner, aud: 'elsewhere' };
      assert.equal((await t.call('GET', path, { access: unrelated })).status, 401);
    }
    for (const identity of [
      undefined,
      { email: 'someone@example.test' },
      { email: admin, service_token_status: true },
    ]) {
      const access = { ...owner, getIdentity: async () => identity };
      assert.equal((await t.call('GET', '/app', { access, headers })).status, 403);
    }
    delete t.env.GLASS_ACCESS_ADMIN_EMAIL_SHA256;
    assert.equal((await t.call('GET', '/app', session)).status, 503);
  });

  it('fails closed if Access identity lookup is unavailable while bearer clients can still use their key', async () => {
    const access = {
      ...owner,
      getIdentity: async () => {
        throw new Error('unavailable');
      },
    };
    assert.equal((await t.call('GET', '/app', { access })).status, 503);
    assert.equal((await t.call('GET', '/api/projects', { access, key: READ })).status, 200);
  });

  it('restricts browser writes to their own origin and audits the authenticated identity', async () => {
    const path = '/_glass/app/api/projects';
    const body = { id: 'school' };
    const disallowed: Record<string, string>[] = [
      {},
      { Origin: 'https://another.test' },
      { Origin: 'null' },
    ];
    for (const headers of disallowed) {
      assert.equal((await t.call('POST', path, { ...session, headers, body })).status, 403);
    }
    const headers = {
      Origin: origin,
      'X-Glass-Actor': 'other',
      'Cf-Access-Authenticated-User-Email': 'other@example.test',
    };
    assert.equal((await t.call('POST', path, { ...session, headers, body })).status, 201);
    const policy = await t.call('PUT', path + '/school/policy', {
      ...session,
      headers,
      body: { audience: 'minors', event_properties: [], person_properties: [] },
    });
    assert.equal(policy.status, 200);
    assert.equal(
      (await t.call('GET', '/app/api/persons?project=school', { ...session, headers })).status,
      200,
    );
    const { entries } = await t.json<{
      entries: { actor: string; surface: string; scope: string; operation: string }[];
    }>('GET', '/api/projects/school/audit');
    for (const op of ['set_project_policy', 'GET /api/persons']) {
      const entry = entries.find((e) => e.operation === op);
      assert.deepEqual([entry?.actor, entry?.surface, entry?.scope], [admin, 'dashboard', 'admin']);
    }
  });

  it('keeps the public collector and bearer clients independent of the browser session', async () => {
    assert.equal((await t.call('GET', '/api', session)).status, 401);
    assert.equal((await t.call('POST', '/mcp', session)).status, 401);
    assert.equal((await t.call('GET', '/api/projects', { key: READ })).status, 200);
    assert.equal((await t.call('GET', '/s.js', { key: null })).status, 200);
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    assert.equal((await t.ingest([wire('$pageview')])).status, 204);
    const opts = await t.call('OPTIONS', '/app/api/projects', session);
    assert.equal(opts.status, 403);
    assert.equal(opts.headers.get('Access-Control-Allow-Origin'), null);
    const legacy = testApp();
    assert.doesNotMatch(await (await legacy.call('GET', '/app', session)).text(), /glass-auth/);
    assert.equal((await legacy.call('GET', '/app/api', session)).status, 404);
  });

  it('sends alternate dashboard links to the protected hostname and serves no browser data there', async () => {
    t.env.GLASS_PUBLIC_URL = 'https://observe.example.test';
    const redirect = await t.call('GET', '/_glass/app/?view=shared', { key: null });
    assert.equal(redirect.status, 302);
    assert.equal(
      redirect.headers.get('Location'),
      'https://observe.example.test/_glass/app/?view=shared',
    );
    assert.equal((await t.call('GET', '/app/api/projects', session)).status, 403);
  });
});
