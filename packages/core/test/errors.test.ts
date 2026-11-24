/**
 * Error tracking's pure parts: stack parsing for each engine, fingerprints that
 * survive data and rebuilds, and source map decoding checked against esbuild.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';
import { exceptionInfo, fingerprint, normaliseMessage, stableFile } from '../src/issues.ts';
import { decodeVlq, originalPositionFor, parseSourceMap } from '../src/sourcemap.ts';
import { markInApp, parseStack } from '../src/stack.ts';

describe('stack parsing', () => {
  it('reads Chrome and Node traces', () => {
    const frames = parseStack(`TypeError: Cannot read properties of undefined (reading 'price')
    at total (https://acme.com/assets/index-BxT8QXh2.js:1:2345)
    at async Checkout.submit (https://acme.com/assets/index-BxT8QXh2.js:1:999)
    at https://cdn.example.com/vendor.js:12:3
    at new Promise (<anonymous>)
    at eval (eval at run (https://acme.com/app.js:4:5), <anonymous>:1:1)
    at Module._compile (node:internal/modules/cjs/loader:1105:14)`);
    assert.deepEqual(
      frames.map((f) => [f.function, f.file, f.line, f.column]),
      [
        ['total', 'https://acme.com/assets/index-BxT8QXh2.js', 1, 2345],
        ['Checkout.submit', 'https://acme.com/assets/index-BxT8QXh2.js', 1, 999],
        ['', 'https://cdn.example.com/vendor.js', 12, 3],
        ['new Promise', '<anonymous>', null, null],
        ['eval', 'https://acme.com/app.js', 4, 5],
        ['Module._compile', 'node:internal/modules/cjs/loader', 1105, 14],
      ],
    );
  });

  it('reads Firefox and Safari traces', () => {
    const firefox = parseStack(`total@https://acme.com/assets/app.js:1:2345
submit/<@https://acme.com/assets/app.js:1:999
@https://acme.com/assets/app.js line 2 > eval:1:1`);
    assert.deepEqual(
      firefox.map((f) => [f.function, f.file, f.line, f.column]),
      [
        ['total', 'https://acme.com/assets/app.js', 1, 2345],
        ['submit/<', 'https://acme.com/assets/app.js', 1, 999],
        ['', 'https://acme.com/assets/app.js', 2, null],
      ],
    );
    const safari = parseStack(`total@https://acme.com/assets/app.js:1:2345
global code@https://acme.com/:10:3
[native code]`);
    assert.deepEqual(
      safari.map((f) => [f.function, f.file, f.line]),
      [
        ['total', 'https://acme.com/assets/app.js', 1],
        ['global code', 'https://acme.com/', 10],
        ['', '[native code]', null],
      ],
    );
  });

  it('marks in-app frames by host, or by the inAppIncludes setting', () => {
    const frames = parseStack(`Error: x
    at a (https://acme.com/assets/app.js:1:1)
    at b (https://cdn.example.com/lib.js:1:1)
    at c (https://acme.com/node_modules/react/index.js:1:1)
    at d (chrome-extension://abc/content.js:1:1)
    at e (/srv/app/server.js:1:1)`);
    assert.deepEqual(
      markInApp(frames, 'acme.com').map((f) => f.inApp),
      [true, false, false, false, true],
    );
    assert.deepEqual(
      markInApp(frames, 'acme.com', ['cdn.example.com']).map((f) => f.inApp),
      [false, true, false, false, false],
    );
  });
});

describe('fingerprints', () => {
  const info = (message: string, stack: string, props: Record<string, unknown> = {}) =>
    exceptionInfo({ type: 'TypeError', message, stack, ...props }, 'acme.com');
  const stackOf = (bundle: string, fn = 'loadCart') =>
    `TypeError: x\n    at ${fn} (https://acme.com/assets/${bundle}:1:2345)\n    at https://acme.com/assets/${bundle}:1:99`;

  it('takes the variable parts out of messages', () => {
    assert.equal(
      normaliseMessage(
        'Order 12345 for ann@example.com failed at https://acme.com/x?id=9 (3f2a9c1e-1b2c-4d5e-8f90-123456789abc) "Ann"',
      ),
      'Order <n> for <email> failed at <url> (<uuid>) <str>',
    );
    assert.equal(stableFile('https://acme.com/assets/index-BxT8QXh2.js?v=2'), '/assets/index.js');
    assert.equal(
      stableFile('/_next/static/chunks/app/page-5f3c2e1a9b0d.js'),
      '/_next/static/chunks/app/page.js',
    );
    assert.equal(stableFile('/static/js/main.3f2a1b4c.chunk.js'), '/static/js/main.chunk.js');
  });

  it('groups the same bug across data, rebuilds and minified names', async () => {
    const a = await fingerprint(info('Cart 12 not found', stackOf('index-BxT8QXh2.js')));
    const b = await fingerprint(info('Cart 98 not found', stackOf('index-Zq81LmP0.js')));
    assert.equal(a, b);
    // Minified function names are ignored, real ones count.
    assert.equal(
      await fingerprint(info('x', stackOf('app.js', 'Xe'))),
      await fingerprint(info('x', stackOf('app.js', 'q'))),
    );
    assert.notEqual(
      await fingerprint(info('x', stackOf('app.js', 'loadCart'))),
      await fingerprint(info('x', stackOf('app.js', 'saveCart'))),
    );
    assert.notEqual(a, await fingerprint(info('Cart 12 not found', stackOf('checkout.js'))));
    // $fingerprint overrides.
    assert.equal(
      await fingerprint(info('one', stackOf('a.js')), ['payments', 'timeout']),
      await fingerprint(info('two', stackOf('b.js')), ['payments', 'timeout']),
    );
  });

  it('reads window.onerror locations and PostHog-style properties', () => {
    const e = exceptionInfo(
      {
        $exception_type: 'ReferenceError',
        $exception_message: 'foo is not defined',
        source: 'https://acme.com/app.js',
        line: 3,
        column: 7,
        $release: 'v1.2.0',
      },
      'acme.com',
    );
    assert.deepEqual(
      [e.type, e.frames[0]?.file, e.frames[0]?.line, e.frames[0]?.inApp, e.release],
      ['ReferenceError', 'https://acme.com/app.js', 3, true, 'v1.2.0'],
    );
  });
});

describe('source maps', () => {
  it('decodes VLQ values', () => {
    const out: number[] = [];
    decodeVlq('AAgBC', 0, out);
    assert.deepEqual(out, [0, 0, 16, 1]);
    decodeVlq('D', 0, out);
    assert.deepEqual(out, [-1]);
  });

  it('maps minified positions back to the source, as esbuild wrote them', () => {
    const source = [
      'interface Item { price: number }',
      'export function checkout(items: Item[], limit: number): number {',
      '  const total = items.reduce((sum, item) => sum + item.price, 0);',
      '  if (total > limit) {',
      "    throw new RangeError('over the limit');",
      '  }',
      '  return total;',
      '}',
      // oxlint-disable-next-line no-template-curly-in-string -- this is source code for esbuild to compile
      'export const label = (n: number) => `£${n.toFixed(2)}`;',
    ].join('\n');
    const out = transformSync(source, {
      loader: 'ts',
      minify: true,
      sourcemap: 'external',
      sourcefile: 'src/checkout.ts',
      sourcesContent: true,
    });
    const map = parseSourceMap(out.map);
    const code = out.code;
    const at = (needle: string, inSource = needle) => {
      const gen = code.indexOf(needle);
      assert.ok(gen >= 0, `${needle} in ${code}`);
      const lines = source.split('\n');
      const line = lines.findIndex((l) => l.includes(inSource));
      return {
        gen: {
          line: code.slice(0, gen).split('\n').length,
          column: gen - code.lastIndexOf('\n', gen - 1),
        },
        src: { line: line + 1, column: lines[line]!.indexOf(inSource) + 1 },
      };
    };
    const thrown = at('throw new RangeError', 'throw new RangeError');
    const pos = originalPositionFor(map, thrown.gen.line, thrown.gen.column)!;
    assert.equal(pos.source, 'src/checkout.ts');
    assert.deepEqual([pos.line, pos.column], [thrown.src.line, thrown.src.column]);
    assert.equal(pos.context?.line.trim(), "throw new RangeError('over the limit');");
    assert.equal(pos.context?.pre.at(-1), '  if (total > limit) {');
    const fixed = at('toFixed', 'toFixed');
    const pos2 = originalPositionFor(map, fixed.gen.line, fixed.gen.column)!;
    assert.deepEqual([pos2.line, pos2.column], [fixed.src.line, fixed.src.column]);
    // Past the end: no mapping.
    assert.equal(originalPositionFor(map, 99, 1), null);
  });

  it('refuses things that are not version 3 maps', () => {
    assert.throws(() => parseSourceMap('{"version":2}'), /version 3/);
    assert.throws(() => parseSourceMap('{"version":3,"sections":[]}'), /Index source maps/);
  });
});
