import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserClientSource } from '../src/client-files.ts';

function start(project: string, pathname: string, enabled = 'true', privacy = false) {
  const loaded: { src?: string; onload?: () => void }[] = [];
  let loadedHandler: (() => void) | undefined;
  let options: Record<string, unknown> | undefined;
  const sandbox = {
    window: {
      glass: {
        init: (o: Record<string, unknown>) => {
          options = o;
        },
      },
    },
    navigator: { globalPrivacyControl: privacy },
    document: {
      currentScript: { dataset: { enabled } },
      createElement: () => ({
        addEventListener: (_name: string, fn: () => void) => {
          loadedHandler = fn;
        },
      }),
      head: { append: (s: (typeof loaded)[number]) => loaded.push(s) },
    },
    location: { origin: 'https://app.example', pathname },
  };
  runInNewContext(browserClientSource('https://observe.gmac.io', project), sandbox);
  loadedHandler?.();
  return { loaded, options };
}

describe('app browser bootstrap', () => {
  it('stays off by default and honors privacy signals before loading remote code', () => {
    assert.equal(start('forgegraph', '/', 'false').loaded.length, 0);
    assert.equal(start('forgegraph', '/', 'true', true).loaded.length, 0);
  });
  it('never loads on education demo, intake, operator, district or unknown pages', () => {
    for (const path of [
      '/demo/',
      '/interest/a',
      '/app',
      '/registry/abc',
      '/clever/launch',
      '/stripe/webhook',
      '/district/student',
      '/teachers/student-123',
    ])
      assert.equal(start('educateos-site', path).loaded.length, 0, path);
    assert.equal(start('educateos-site', '/teachers/').options?.persistence, 'cookieless');
  });
  it('records fixed screen categories without titles, referrers, query text, entity IDs or arbitrary events', () => {
    const { options, loaded } = start('kanbanger', '/issues/secret-123');
    assert.equal(loaded[0]?.src, 'https://observe.gmac.io/s.js');
    assert.equal(options?.replay, false);
    assert.equal(options?.flags, false);
    const filter = options?.beforeSend as (
      e: Record<string, unknown>,
    ) => Record<string, unknown> | null;
    const event = filter({
      event: '$pageview',
      url: 'sensitive',
      title: 'Private issue',
      referrer: 'private',
      props: { query: 'private' },
    });
    assert.equal(event?.url, 'https://app.example/issues');
    assert.equal(event?.title, null);
    assert.equal(event?.referrer, null);
    assert.equal(JSON.stringify(event?.props), '{}');
    assert.equal(filter({ event: '$click', props: { text: 'private' } }), null);
  });
});
