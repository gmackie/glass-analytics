/**
 * The data and flag commands against a real Worker (the dev server): what
 * they print, as text and with --json.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TEST_ASSETS } from '../../worker/test/harness.ts';
import { type DevServer, startDevServer } from '../../worker/test/server.ts';
import { group, groups, person, projects, query, sql } from '../src/commands/data.ts';
import { experiments, flags } from '../src/commands/flags.ts';

let server: DevServer;

/**
 * Run a command and return what it wrote to stdout. Only text is captured: the
 * test runner talks to its parent over stdout in binary, which passes through.
 */
async function output(run: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (typeof chunk !== 'string') return write(chunk, ...rest);
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${server.glassUrl}${path}`, {
    method,
    headers: { Authorization: 'Bearer dev-admin-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${await r.text()}`);
  return r.json();
};

describe('data and flag commands', () => {
  before(async () => {
    // Only the API is used, so the stub bundles do: this runs before `pnpm build` in CI.
    server = await startDevServer({ port: 0, demoPort: 0, memory: true, assets: TEST_ASSETS });
    process.env.GLASS_HOST = server.glassUrl;
    process.env.GLASS_API_KEY = 'dev-admin-key';
    process.env.GLASS_PROJECT = 'demo';
    await api('POST', '/api/import', {
      project: 'demo',
      events: [
        {
          id: 'c1',
          event: '$groupidentify',
          ts: Date.now() - 60_000,
          distinct_id: 'ann',
          props: { $group_type: 'company', $group_key: 'acme', $group_set: { plan: 'pro' } },
        },
        {
          id: 'c2',
          event: 'report_run',
          ts: Date.now() - 50_000,
          distinct_id: 'ann',
          props: { $groups: { company: 'acme' } },
        },
      ],
    });
  });

  after(async () => {
    delete process.env.GLASS_HOST;
    delete process.env.GLASS_API_KEY;
    delete process.env.GLASS_PROJECT;
    await server?.close();
  });

  it('lists group types, groups and one group, then erases it', async () => {
    assert.match(await output(() => groups(undefined, {})), /company/);
    assert.match(await output(() => groups('company', {})), /acme/);
    const one = await output(() => group('company', 'acme', {}));
    assert.match(one, /plan: "pro"/);
    assert.match(one, /ann/);
    const json = JSON.parse(await output(() => group('company', 'acme', { json: true })));
    assert.equal(json.key, 'acme');
    assert.match(await output(() => group('company', 'acme', { delete: true })), /acme/);
    await assert.rejects(() => group(undefined, undefined, {}), /Usage/);
  });

  it('runs queries, SQL, a person and projects', async () => {
    assert.match(
      await output(() => query('trends', { event: 'report_run', from: '-1d' })),
      /report_run/,
    );
    const paths = await output(() => query('paths', { from: '-1d', steps: '3', events: true }));
    assert.match(paths, /Path/);
    assert.match(paths, /report_run/);
    await assert.rejects(() => query('journeys', {}), /Unknown query/);
    assert.match(await output(() => sql('SELECT COUNT(*) AS n FROM events', {})), /n/);
    assert.match(await output(() => person('ann', {})), /ann/);
    assert.match(await output(() => projects(undefined, undefined, {})), /demo/);
  });

  it('sets, lists and deletes flags', async () => {
    assert.match(await output(() => flags('list', undefined, {})), /No flags yet/);
    await output(() => flags('set', 'beta', { rollout: '10' }));
    const list = await output(() => flags('list', undefined, {}));
    assert.match(list, /beta/);
    assert.match(list, /10%/);
    await output(() => flags('delete', 'beta', {}));
    assert.match(await output(() => flags('list', undefined, {})), /No flags yet/);
  });

  it('lists experiments created with metrics and no single goal', async () => {
    await api('POST', '/api/experiments', {
      project: 'demo',
      key: 'checkout-v2',
      metrics: [{ kind: 'conversion', event: 'report_run', name: 'Ran a report' }],
    });
    await output(() => experiments('create', 'pricing-v2', [], { goal: 'signup_completed' }));
    const list = await output(() => experiments('list', undefined, [], {}));
    assert.match(list, /checkout-v2.*Ran a report/);
    assert.match(list, /pricing-v2.*signup_completed/);
    assert.match(
      await output(() => experiments('results', 'checkout-v2', [], {})),
      /checkout-v2|exposed|No exposures/i,
    );
  });

  // Runs last: a second project makes the other commands ask which project to use.
  it('adds a project, sets and reads its policy, and shows its audit log', async () => {
    await assert.rejects(() => projects('add', undefined, {}), /Pass an id/);
    await assert.rejects(() => projects('policy', undefined, {}), /Pass an id/);
    await assert.rejects(() => projects('audit', undefined, {}), /Pass an id/);
    await output(() => projects('add', 'school', { name: 'School' }));
    assert.match(await output(() => projects(undefined, undefined, {})), /school/);
    // An unknown subcommand, even an Object.prototype key, lists projects.
    assert.match(await output(() => projects('toString', undefined, {})), /school/);
    await output(() =>
      projects('policy', 'school', {
        audience: 'minors',
        'pseudonym-pattern': '^s[0-9]+$',
        'event-props': 'step, score',
        'person-props': 'cohort',
        replay: 'off',
        'retention-days': '90',
      }),
    );
    const policy = JSON.parse(await output(() => projects('policy', 'school', { json: true })));
    assert.match(JSON.stringify(policy), /minors/);
    assert.match(JSON.stringify(policy), /score/);
    assert.match(await output(() => projects('audit', 'school', {})), /When/);
  });
});
