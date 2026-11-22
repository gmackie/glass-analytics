/**
 * The e2e suite checks the browser renders before it clicks anything: Playwright waits for
 * animation frames before every click, so a browser that has stopped rendering would otherwise
 * show up as one 30-second timeout per click.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium } from 'playwright';
import { assertRendersFrames } from './render-check.ts';

describe('render check', () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
  });

  it('passes when the page renders frames', async () => {
    const page = await browser.newPage();
    await assertRendersFrames(page, 2000);
    await page.close();
  });

  it('fails fast, saying how to fix it, when no frame arrives', async () => {
    const page = await browser.newPage();
    // What a browser that has stopped rendering looks like to the page: frames never come.
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await page.goto('about:blank');
    const started = Date.now();
    await assert.rejects(assertRendersFrames(page, 500), (err: Error) => {
      assert.match(err.message, /isn't rendering/);
      assert.match(err.message, /caffeinate/);
      return true;
    });
    assert.ok(Date.now() - started < 5000, 'fails within its timeout, not a click timeout');
    await page.close();
  });
});
