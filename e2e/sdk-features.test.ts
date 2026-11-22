/**
 * End to end, the SDK features beyond capture: flag payloads, web experiments
 * changing the page, overrides (in code and, when the project allows it, in the
 * URL), bootstrapped flags for server-side rendering, early-access opt-in, and
 * captureException landing in an issue. A real browser runs the built SDK
 * against the real Worker.
 *
 * Run with `pnpm test:e2e` (builds first).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium, type Page } from 'playwright';
import { type DevServer, startDevServer } from '../packages/worker/test/server.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ESM = new URL('../packages/web/dist/index.js', import.meta.url);

let server: DevServer;
let browser: Browser;

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${server.glassUrl}${path}`, {
    method,
    headers: { Authorization: 'Bearer dev-admin-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data as T;
}

async function eventually<T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() - start < timeoutMs);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 500)}`);
}

/** A fresh visitor on a demo page, once the script-tag SDK has its flags. */
async function visit(path: string): Promise<Page> {
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  await page.goto(`${server.demoUrl}${path}`);
  await page.waitForFunction(
    () => {
      const g = (window as unknown as { glass?: { flags?: () => Record<string, string> } }).glass;
      return typeof g?.flags === 'function' && Object.keys(g.flags()).length > 0;
    },
    undefined,
    { timeout: 10_000 },
  );
  return page;
}

describe('SDK features end to end', { timeout: 120_000 }, () => {
  before(async () => {
    server = await startDevServer({ port: 0, demoPort: 0, memory: true });
    browser = await chromium.launch({ args: [`--user-agent=${UA}`] });
    // A flag with a JSON payload, on for everyone.
    await api('PUT', '/api/flags/pricing-copy', {
      project: 'demo',
      rollout: 100,
      payloads: { on: { headline: 'Write faster', discount: 20 } },
    });
    // A web experiment: everyone gets a new home page headline, without code.
    await api('PUT', '/api/flags/hero-test', {
      project: 'demo',
      rollout: 100,
      payloads: {
        on: { type: 'web', transforms: [{ selector: 'h1', text: 'Inkwell, rewritten' }] },
      },
    });
    // A multivariate flag to override.
    await api('PUT', '/api/flags/new-cta', {
      project: 'demo',
      rollout: 100,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'test', weight: 50 },
      ],
    });
    // An early-access feature nobody has yet.
    await api('PUT', '/api/flags/beta-reports', {
      project: 'demo',
      rollout: 0,
      earlyAccess: { name: 'Beta reports', description: 'Reports on every page', stage: 'beta' },
    });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  it('reads a flag payload', async () => {
    const page = await visit('/');
    const payload = await page.evaluate(() =>
      (window as unknown as { glass: { flagPayload: (k: string) => unknown } }).glass.flagPayload(
        'pricing-copy',
      ),
    );
    assert.deepEqual(payload, { headline: 'Write faster', discount: 20 });
    await page.context().close();
  });

  it('applies a web experiment to the page', async () => {
    const page = await visit('/');
    await page.waitForFunction(
      () => document.querySelector('h1')?.textContent === 'Inkwell, rewritten',
      undefined,
      { timeout: 5_000 },
    );
    // The anti-flicker hide is lifted once the change is in.
    const visible = await page.evaluate(
      () => getComputedStyle(document.querySelector('h1')!).visibility,
    );
    assert.equal(visible, 'visible');
    await page.context().close();
  });

  it('overrides flags in code, and in the URL only when the project allows it', async () => {
    const page = await visit('/');
    const overridden = await page.evaluate(() => {
      const g = (
        window as unknown as {
          glass: {
            overrideFlags: (o: Record<string, string>) => void;
            flag: (k: string) => string;
          };
        }
      ).glass;
      g.overrideFlags({ 'new-cta': 'qa-variant' });
      return g.flag('new-cta');
    });
    assert.equal(overridden, 'qa-variant');
    await page.context().close();

    const readFromUrl = async () => {
      const p = await visit('/?__glass_flags=new-cta:from-url');
      const value = await p.evaluate(() =>
        (window as unknown as { glass: { flag: (k: string) => string } }).glass.flag('new-cta'),
      );
      await p.context().close();
      return value;
    };
    assert.notEqual(await readFromUrl(), 'from-url', 'ignored while the project disallows it');
    await api('PATCH', '/api/settings', {
      project: 'demo',
      settings: { allowFlagOverrides: true },
    });
    assert.equal(await readFromUrl(), 'from-url');
  });

  it('starts from bootstrapped flags before the Worker answers', async () => {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    // A page on the demo origin without the script tag, so only this SDK instance runs.
    await page.goto(`${server.demoUrl}/blank`);
    const source = `data:text/javascript;base64,${readFileSync(ESM).toString('base64')}`;
    const seen = await page.evaluate(
      async ({ source, host }) => {
        const { glass } = await import(source);
        glass.init({
          host,
          project: 'demo',
          autocapture: false,
          bootstrap: {
            distinctId: 'ssr-visitor',
            flags: { 'new-cta': 'test', 'pricing-copy': true },
            payloads: { 'pricing-copy': { headline: 'From the server' } },
          },
        });
        // Synchronously, before any network round trip.
        return {
          id: glass.distinctId(),
          cta: glass.flag('new-cta'),
          on: glass.isEnabled('pricing-copy'),
          payload: glass.flagPayload('pricing-copy'),
        };
      },
      { source, host: server.glassUrl },
    );
    assert.deepEqual(seen, {
      id: 'ssr-visitor',
      cta: 'test',
      on: true,
      payload: { headline: 'From the server' },
    });
    await context.close();
  });

  it('lists early-access features and opts a person in', async () => {
    const page = await visit('/');
    const result = await page.evaluate(async () => {
      const g = (
        window as unknown as {
          glass: {
            identify: (id: string) => void;
            earlyAccessFeatures: () => Promise<{ key: string; name: string; enrolled: boolean }[]>;
            optIn: (key: string) => Promise<void>;
            isEnabled: (key: string) => boolean;
          };
        }
      ).glass;
      g.identify('early-adopter');
      const before = await g.earlyAccessFeatures();
      const was = g.isEnabled('beta-reports');
      await g.optIn('beta-reports');
      return { before, was, now: g.isEnabled('beta-reports') };
    });
    const feature = result.before.find((f) => f.key === 'beta-reports');
    assert.ok(feature, 'the feature is listed');
    assert.equal(feature.name, 'Beta reports');
    assert.equal(result.was, false);
    assert.equal(result.now, true, 'opting in turns the flag on for this person');
    await page.context().close();
  });

  it('turns captureException into an issue', async () => {
    const page = await visit('/');
    await page.evaluate(async () => {
      const g = (
        window as unknown as {
          glass: {
            captureException: (e: unknown, p?: Record<string, unknown>) => void;
            flush: () => Promise<void>;
          };
        }
      ).glass;
      g.captureException(new TypeError('e2e: cart total is NaN'), { where: 'checkout' });
      await g.flush();
    });
    const found = await eventually(
      () =>
        api<{ issues: { type: string; message: string; events: number }[] }>(
          'GET',
          '/api/issues?project=demo&from=-1h',
        ),
      (r) => r.issues.some((i) => i.message.includes('cart total is NaN')),
      'an issue for the captured exception',
    );
    const issue = found.issues.find((i) => i.message.includes('cart total is NaN'))!;
    assert.equal(issue.type, 'TypeError');
    await page.context().close();
  });
});
