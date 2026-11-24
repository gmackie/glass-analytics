/**
 * The fork's packages live on the ForgeGraph registry as @gmacko/dataflare-* (DATFLR-27), so the
 * projects `dataflare init` sets up get the scope line in their .npmrc.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NPMRC_SCOPE_LINE } from '@dataflare/core/version';
import { upsertNpmrc } from '../src/agent-files.ts';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'dataflare-npmrc-')), '.npmrc');

describe('upsertNpmrc (DATFLR-27)', () => {
  it('creates .npmrc with the @gmacko scope line', () => {
    const path = fresh();
    assert.equal(upsertNpmrc(path), true);
    assert.equal(readFileSync(path, 'utf8'), `${NPMRC_SCOPE_LINE}\n`);
    assert.equal(NPMRC_SCOPE_LINE, '@gmacko:registry=https://npm.forgegraf.com/');
  });

  it('keeps existing settings and adds the line once', () => {
    const path = fresh();
    writeFileSync(path, 'auto-install-peers=true');
    assert.equal(upsertNpmrc(path), true);
    assert.equal(upsertNpmrc(path), false);
    assert.equal(readFileSync(path, 'utf8'), `auto-install-peers=true\n${NPMRC_SCOPE_LINE}\n`);
  });

  it('leaves a project that already points @gmacko somewhere alone', () => {
    const path = fresh();
    writeFileSync(path, '@gmacko:registry=https://registry.example.test/\n');
    assert.equal(upsertNpmrc(path), false);
    assert.equal(readFileSync(path, 'utf8'), '@gmacko:registry=https://registry.example.test/\n');
  });
});
