import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackPageviews } from '../src/autocapture.ts';

type Globals = Record<string, unknown>;

/** Install a minimal browser: a URL, a History API and window-level listeners. */
function fakeBrowser(withNavigationApi: boolean) {
  const g = globalThis as Globals;
  const saved: Globals = {};
  for (const k of ['location', 'history', 'addEventListener', 'removeEventListener', 'navigation'])
    saved[k] = g[k];
  const url = new URL('https://app.example.com/');
  const listeners = new Map<string, Set<() => void>>();
  const navigation = new EventTarget();
  g.location = {
    get href() {
      return url.href;
    },
  };
  const history = {
    pushState(_s: unknown, _t: string, next: string) {
      url.href = new URL(next, url).href;
      if (withNavigationApi) navigation.dispatchEvent(new Event('navigatesuccess'));
    },
    replaceState(_s: unknown, _t: string, next: string) {
      url.href = new URL(next, url).href;
    },
  };
  // A router that keeps its own reference to pushState, taken before the SDK loads.
  const routerPush = history.pushState.bind(history);
  g.history = history;
  g.addEventListener = (n: string, fn: () => void) => {
    if (!listeners.has(n)) listeners.set(n, new Set());
    listeners.get(n)!.add(fn);
  };
  g.removeEventListener = (n: string, fn: () => void) => listeners.get(n)?.delete(fn);
  g.navigation = withNavigationApi ? navigation : undefined;
  return {
    routerPush: (path: string) => routerPush(null, '', path),
    restore() {
      for (const [k, v] of Object.entries(saved)) g[k] = v;
    },
  };
}

function recorder() {
  const seen: string[] = [];
  const href = () => (globalThis as unknown as { location: { href: string } }).location.href;
  return {
    seen,
    hooks: {
      pageview: () => seen.push(`view ${href()}`),
      pageleave: () => seen.push('leave'),
      capture: () => {},
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('history.pushState through the wrapper records a pageview', async () => {
  const b = fakeBrowser(false);
  const r = recorder();
  const stop = trackPageviews(r.hooks);
  history.pushState(null, '', '/pricing');
  await tick();
  stop();
  b.restore();
  assert.deepEqual(r.seen, [
    'view https://app.example.com/',
    'leave',
    'view https://app.example.com/pricing',
  ]);
});

test('a router holding the original pushState is caught by the Navigation API', async () => {
  const b = fakeBrowser(true);
  const r = recorder();
  const stop = trackPageviews(r.hooks);
  b.routerPush('/sign-in');
  await tick();
  stop();
  b.restore();
  assert.deepEqual(r.seen, [
    'view https://app.example.com/',
    'leave',
    'view https://app.example.com/sign-in',
  ]);
});

test('without the Navigation API, a URL check catches it within a second', async () => {
  const b = fakeBrowser(false);
  const r = recorder();
  const stop = trackPageviews(r.hooks);
  b.routerPush('/sign-in');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  stop();
  b.restore();
  assert.equal(r.seen.at(-1), 'view https://app.example.com/sign-in');
  assert.equal(r.seen.filter((s) => s.startsWith('view')).length, 2);
});
