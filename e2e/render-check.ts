import type { Page } from 'playwright';

/**
 * Fail fast when the browser isn't rendering. Playwright waits for two animation frames before
 * every click (to see the target is stable), so without frames each click times out after 30s
 * and the suite reports a cascade of unrelated-looking failures. Headless Chromium on macOS stops
 * delivering frames once the Mac has been idle with its display off for a while.
 */
export async function assertRendersFrames(page: Page, timeoutMs = 5000): Promise<void> {
  const rendered = await page.evaluate(
    (ms) =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), ms);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }),
    timeoutMs,
  );
  if (rendered) return;
  throw new Error(
    `The browser isn't rendering: no animation frame arrived within ${timeoutMs}ms, so every ` +
      'click would time out. On macOS this happens when the Mac has been idle with its display ' +
      'off. Wake the display, or run the suite as `caffeinate -u pnpm test:e2e`.',
  );
}
