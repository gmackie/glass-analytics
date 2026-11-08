import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(
  new URL('../../../deployments/observe/journey-loader/dataflare.js', import.meta.url),
  'utf8',
);

interface Loaded {
  // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
  api: Record<string, (...args: unknown[]) => unknown> & { _internal: Record<string, any> };
  appended: { src: string; fire: () => void }[];
  calls: unknown[][];
  // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
  initOptions: Record<string, any> | null;
  location: URL;
  navigate: (path: string) => void;
}

function load(
  path: string,
  config: Record<string, unknown> = {},
  opts: { enabled?: string; dnt?: boolean } = {},
): Loaded {
  let source = SOURCE.replace("'__PROJECT__'", "'demo'");
  for (const [k, v] of Object.entries(config)) {
    source = source.replace(new RegExp(`(\\n    ${k}: )[^\\n]*`), `$1${JSON.stringify(v)},`);
  }
  const location = new URL(`https://app.example.com${path}`);
  const appended: Loaded['appended'] = [];
  const calls: unknown[][] = [];
  // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
  let initOptions: Record<string, any> | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
  const window: Record<string, any> = { doNotTrack: null };
  const document = {
    currentScript: { dataset: { enabled: opts.enabled ?? 'true' } },
    head: {
      append(el: { src: string; listeners: Record<string, () => void> }) {
        appended.push({ src: el.src, fire: () => el.listeners.load?.() });
      },
    },
    createElement() {
      return {
        src: '',
        listeners: {} as Record<string, () => void>,
        addEventListener(name: string, fn: () => void) {
          this.listeners[name] = fn;
        },
      };
    },
  };
  window.glass = {
    // biome-ignore lint/suspicious/noExplicitAny: objects from the vm sandbox are untyped
    init(o: Record<string, any>) {
      initOptions = o;
    },
    capture: (...a: unknown[]) => calls.push(['capture', ...a]),
    identify: (...a: unknown[]) => calls.push(['identify', ...a]),
    reset: () => calls.push(['reset']),
    flush: () => {
      calls.push(['flush']);
      return Promise.resolve();
    },
  };
  const navigator = { doNotTrack: opts.dnt ? '1' : null, globalPrivacyControl: false };
  const locProxy = {
    get pathname() {
      return location.pathname;
    },
    get search() {
      return location.search;
    },
    get origin() {
      return location.origin;
    },
    get href() {
      return location.href;
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    navigator,
    location: locProxy,
    URL,
    URLSearchParams,
    decodeURIComponent,
  });
  return {
    api: window.dataflare,
    appended,
    calls,
    get initOptions() {
      return initOptions;
    },
    location,
    navigate(p: string) {
      const next = new URL(p, location);
      location.pathname = next.pathname;
      location.search = next.search;
    },
  } as Loaded;
}

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  id: 'x',
  event,
  ts: 1,
  url: 'ignored',
  referrer: null,
  title: 'Secret document title',
  props: {},
  ...extra,
});

test('id-like path segments become :id, readable ones stay', () => {
  const { normalizePath } = load('/').api._internal;
  assert.equal(normalizePath('/trips/123/edit'), '/trips/:id/edit');
  assert.equal(normalizePath('/t/0b5c2e7a-1f2d-4e6a-9b1c-2d3e4f5a6b7c'), '/t/:id');
  assert.equal(normalizePath('/u/someone@example.com'), '/u/:id');
  assert.equal(normalizePath('/invite/aB3dE5gH7jK9'), '/invite/:id');
  assert.equal(normalizePath('/pricing'), '/pricing');
  assert.equal(normalizePath('/event-types/new'), '/event-types/new');
  assert.equal(normalizePath('/'), '/');
});

test('route templates name dynamic pages, including slugs', () => {
  const { normalizePath } = load('/', { routes: ['/blog/:slug'] }).api._internal;
  assert.equal(normalizePath('/blog/how-we-built-it'), '/blog/:slug');
  assert.equal(normalizePath('/blog'), '/blog');
});

test('pageviews keep UTMs but drop other query params, titles and referrer paths', () => {
  const l = load('/landing?utm_source=news&email=a%40b.c&q=secret');
  const out = l.api._internal.beforeSend(
    ev('$pageview', { referrer: 'https://news.example.org/story/42?x=1' }),
  );
  assert.equal(out.url, 'https://app.example.com/landing?utm_source=news');
  assert.equal(out.referrer, 'https://news.example.org/');
  assert.equal(out.title, null);
});

test('$pageleave is attributed to the page being left', () => {
  const l = load('/trips/123');
  const { beforeSend } = l.api._internal;
  beforeSend(ev('$pageview'));
  l.navigate('/settings');
  assert.equal(beforeSend(ev('$pageleave')).url, 'https://app.example.com/trips/:id');
  assert.equal(beforeSend(ev('$pageview')).url, 'https://app.example.com/settings');
});

test('excluded and non-listed paths drop every event', () => {
  const l = load('/', { exclude: ['/admin'], only: ['/', '/pricing'] });
  const { beforeSend } = l.api._internal;
  l.navigate('/admin/users');
  assert.equal(beforeSend(ev('$pageview')), null);
  l.navigate('/play');
  assert.equal(beforeSend(ev('trip_created')), null);
  l.navigate('/pricing');
  assert.ok(beforeSend(ev('$pageview')));
});

test('custom event properties lose personal data', () => {
  const { sanitizeProps } = load('/').api._internal;
  assert.deepEqual(
    plain(
      sanitizeProps({
        plan: 'pro',
        seats: 3,
        email: 'a@b.c',
        first_name: 'Ada',
        note: 'contact me at a@b.c',
        token: 'abc',
        phone_number: '555',
        ref: 'x'.repeat(500),
        nested: { a: 1 },
        tags: ['a', 'b'],
      }),
    ),
    { plan: 'pro', seats: 3, ref: 'x'.repeat(120), tags: ['a', 'b'] },
  );
});

test('click text with personal-looking content is removed', () => {
  const l = load('/');
  const { beforeSend } = l.api._internal;
  const keep = beforeSend(ev('$click', { props: { tag: 'button', text: 'Start free trial' } }));
  assert.equal(keep.props.text, 'Start free trial');
  const drop = beforeSend(
    ev('$click', {
      props: { tag: 'a', text: 'jane@example.com', href: 'https://app.example.com/u/99?x=1' },
    }),
  );
  assert.equal(drop.props.text, undefined);
  assert.equal(drop.props.href, 'https://app.example.com/u/:id');
});

test('calls made before the SDK loads are replayed after init, sanitised', () => {
  const l = load('/');
  l.api.track('signup_completed', { plan: 'pro', email: 'a@b.c' });
  l.api.track('Bad Name', {});
  l.api.identify('user_123', { plan: 'pro', email: 'a@b.c' });
  l.api.identify('someone@example.com');
  assert.equal(l.calls.length, 0);
  assert.equal(l.appended[0]?.src, 'https://observe.gmac.io/s.js');
  l.appended[0]!.fire();
  assert.equal(l.initOptions?.project, 'demo');
  assert.deepEqual(plain(l.calls), [
    ['capture', 'signup_completed', { plan: 'pro' }],
    ['identify', 'user_123', { plan: 'pro' }],
    ['flush'],
  ]);
  l.api.reset();
  assert.deepEqual(plain(l.calls.at(-1)), ['reset']);
});

test('cookieless sites never identify', () => {
  const l = load('/', { persistence: 'cookieless' });
  l.appended[0]!.fire();
  l.api.identify('user_1');
  assert.equal(l.initOptions?.persistence, 'cookieless');
  assert.ok(!l.calls.some((c) => c[0] === 'identify'));
});

test('the SDK is not loaded when disabled, on excluded pages, or with DNT', () => {
  assert.equal(load('/', {}, { enabled: 'false' }).appended.length, 0);
  assert.equal(load('/admin/x').appended.length, 0);
  assert.equal(load('/', {}, { dnt: true }).appended.length, 0);
  assert.equal(load('/play', { only: ['/', '/pricing'] }).appended.length, 0);
});
