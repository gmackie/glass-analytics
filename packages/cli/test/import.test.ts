/**
 * `dataflare import`: files from other tools land with their timestamps, in
 * batches, and running the same import twice doesn't double count.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ADMIN, type TestApp, testApp } from '../../worker/test/harness.ts';
import { importEvents } from '../src/commands/import.ts';

let t: TestApp;
const saved = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), 'dataflare-import-'));
const fetcher: typeof fetch = (input, init) => t.app.fetch(new Request(input, init), t.env);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  process.stderr.write = () => true;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
    console.log = log;
  }
};

async function count(sql = 'SELECT COUNT(*) AS n FROM events'): Promise<number> {
  return Number((await t.db.prepare(sql).first<{ n: number }>())?.n);
}

describe('dataflare import', () => {
  before(async () => {
    t = testApp();
    await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
    Object.assign(process.env, {
      GLASS_HOST: 'https://glass.test',
      GLASS_API_KEY: ADMIN,
      GLASS_PROJECT: 'acme',
    });
  });
  after(() => {
    process.env = saved;
  });

  it('imports a PostHog export with its timestamps, once', async () => {
    const file = join(dir, 'posthog.ndjson');
    const lines = [];
    for (let i = 0; i < 1500; i++) {
      lines.push(
        JSON.stringify({
          uuid: `ph-${i}`,
          event: i % 3 ? '$pageview' : 'signup',
          timestamp: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
          distinct_id: `user-${i % 40}`,
          properties: { $current_url: 'https://acme.com/', plan: i % 2 ? 'pro' : 'free' },
        }),
      );
    }
    lines.push('not json');
    writeFileSync(file, `${lines.join('\n')}\n`);
    await quiet(() => importEvents(file, { preset: 'posthog', json: true }, { fetcher }));
    assert.equal(await count(), 1500);
    const oldest = await t.db.prepare('SELECT MIN(ts_ms) AS n FROM events').first<{ n: number }>();
    assert.equal(oldest?.n, Date.UTC(2025, 0, 1));
    // The same file again: stable ids, nothing doubles.
    await quiet(() => importEvents(file, { preset: 'posthog', json: true }, { fetcher }));
    assert.equal(await count(), 1500);
  });

  it('imports CSV, and a dry run sends nothing', async () => {
    const file = join(dir, 'orders.csv');
    writeFileSync(
      file,
      'event,timestamp,distinct_id,amount,properties\norder_paid,2025-02-01T10:00:00Z,u1,49,"{""plan"":""pro""}"\norder_paid,2025-02-02T10:00:00Z,u2,99,\n',
    );
    const before = await count();
    await quiet(() => importEvents(file, { dryRun: true, json: true }, { fetcher }));
    assert.equal(await count(), before);
    await quiet(() => importEvents(file, { json: true }, { fetcher }));
    assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE event = 'order_paid'"), 2);
    const row = await t.db
      .prepare("SELECT props FROM events WHERE distinct_id = 'u1' AND event = 'order_paid'")
      .first<{ props: string }>();
    assert.deepEqual(JSON.parse(row!.props), { plan: 'pro', amount: 49 });
  });

  it('refuses unknown presets and missing files', async () => {
    await assert.rejects(importEvents(join(dir, 'nope.json'), {}, { fetcher }), /Can't read/);
    writeFileSync(join(dir, 'x.json'), '[]');
    await assert.rejects(
      importEvents(join(dir, 'x.json'), { preset: 'heap' }, { fetcher }),
      /Unknown preset/,
    );
  });
});
