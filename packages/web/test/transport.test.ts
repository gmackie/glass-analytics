import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Transport } from '../src/transport.ts';

it('stops pending transport without flushing or retrying and aborts active requests', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  let aborted = false;
  globalThis.fetch = async (_url, init) => {
    requests++;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  };
  try {
    const t = new Transport('https://example.com/e', 'test', 'test', 50_000);
    const event = { id: 'one', event: 'start', ts: Date.now() };
    t.push(event);
    const flushing = t.flush();
    t.stop();
    await flushing;
    t.push(event);
    await t.flush();
    t.beacon();
    assert.equal(requests, 1);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = original;
  }
});
