/**
 * `dataflare sourcemaps`: a build's maps land under the paths their files are
 * served at, for the release given, and can be listed and deleted.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { transformSync } from 'esbuild';
import { ADMIN, type TestApp, testApp } from '../../worker/test/harness.ts';
import { servedPath, sourcemaps } from '../src/commands/sourcemaps.ts';

let t: TestApp;
const saved = { ...process.env };
const fetcher: typeof fetch = (input, init) => t.app.fetch(new Request(input, init), t.env);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

describe('dataflare sourcemaps', () => {
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

  it('files maps under the served path of their files', () => {
    assert.equal(servedPath('/b/dist', '/b/dist/assets/index-Bx.js.map'), '/assets/index-Bx.js');
    assert.equal(servedPath('/b/dist', '/b/dist/app.js.map', '/static/'), '/static/app.js');
  });

  it('uploads, lists and deletes a release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dataflare-maps-'));
    mkdirSync(join(dir, 'assets'));
    const built = transformSync('export const f = (x) => x.y.z;', {
      minify: true,
      sourcemap: 'external',
      sourcefile: 'src/f.js',
    });
    writeFileSync(join(dir, 'assets', 'index-Bx.js'), built.code);
    writeFileSync(join(dir, 'assets', 'index-Bx.js.map'), built.map);
    writeFileSync(join(dir, 'assets', 'vendor-Q1.js.map'), built.map);
    await assert.rejects(sourcemaps('upload', dir, {}, { fetcher }), /--release/);
    await quiet(() => sourcemaps('upload', dir, { release: 'v9', json: true }, { fetcher }));
    const listed = await t.json<{ sourcemaps: { release: string; path: string }[] }>(
      'GET',
      '/api/sourcemaps?project=acme',
    );
    assert.deepEqual(listed.sourcemaps.map((m) => [m.release, m.path]).sort(), [
      ['v9', '/assets/index-Bx.js'],
      ['v9', '/assets/vendor-Q1.js'],
    ]);
    await quiet(() => sourcemaps('delete', undefined, { release: 'v9', json: true }, { fetcher }));
    assert.equal(
      (await t.json<{ sourcemaps: unknown[] }>('GET', '/api/sourcemaps?project=acme')).sourcemaps
        .length,
      0,
    );
  });
});
