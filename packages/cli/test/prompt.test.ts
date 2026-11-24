/**
 * The interactive prompts, driven through a fake terminal: a secret is read
 * without being echoed (DATFLR-25: on Node 24 the old readline patch threw
 * "Cannot read properties of undefined (reading 'bind')").
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { ask, type PromptIO } from '../src/prompt.ts';

function fakeTerminal(): { io: PromptIO; input: PassThrough; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { io: { input, output, isInteractive: () => true }, input, written: () => text };
}

describe('ask (DATFLR-25)', () => {
  it('reads a secret without echoing it', async () => {
    const t = fakeTerminal();
    const answer = ask('Cloudflare API token', { flag: '--token', secret: true }, t.io);
    t.input.write('s3cr3t-token\r');
    assert.equal(await answer, 's3cr3t-token');
    assert.match(t.written(), /Cloudflare API token: /);
    assert.doesNotMatch(t.written(), /s3cr3t/);
  });

  it('echoes an ordinary answer and falls back to the default', async () => {
    const t = fakeTerminal();
    const typed = ask('Project name', { flag: '--project' }, t.io);
    t.input.write('shop\r');
    assert.equal(await typed, 'shop');
    assert.match(t.written(), /shop/);

    const blank = fakeTerminal();
    const fallback = ask('Region', { flag: '--region', default: 'auto' }, blank.io);
    blank.input.write('\r');
    assert.equal(await fallback, 'auto');
    assert.match(blank.written(), /Region \(auto\): /);
  });

  it('asks for the flag instead when the terminal is not interactive', async () => {
    const t = fakeTerminal();
    await assert.rejects(
      ask(
        'Cloudflare API token',
        { flag: '--token', secret: true },
        { ...t.io, isInteractive: () => false },
      ),
      /Missing --token/,
    );
  });
});
