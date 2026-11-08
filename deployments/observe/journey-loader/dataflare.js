// Dataflare journey loader v2 for observe.gmac.io.
// Canonical source: gmackie/glass-analytics deployments/observe/journey-loader/dataflare.js (DATFLR-9).
// Copy this file to the app's public/dataflare.js and edit ONLY the CONFIG block.
// Load it once from the root document: <script defer src="/dataflare.js" data-enabled="true"></script>
//
// App code records journeys through window.dataflare (safe to call before this script loads
// if the app guards with optional chaining, and safe on pages where collection is off):
//   window.dataflare?.track("trip_created", { mode: "group" })   // snake_case, past tense
//   window.dataflare?.identify(user.id, { plan: "pro" })         // opaque internal id, never an email
//   window.dataflare?.reset()                                     // on sign-out
(() => {
  const CONFIG = {
    project: '__PROJECT__',
    // Path prefixes that are never collected: no SDK, no events.
    exclude: ['/admin', '/api'],
    // When non-empty, ONLY these path prefixes are collected ("/" means the home page only).
    only: [],
    // "localStorage" links a visitor's pages into sessions and journeys.
    // "cookieless" stores nothing on the device (child- or privacy-sensitive sites).
    persistence: 'localStorage',
    // Allow identify(). Turn off for sites that must not link visits to accounts.
    identify: true,
    // Optional route templates for dynamic pages, e.g. "/trips/:id/edit".
    // Segments that look like ids are replaced with ":id" even without a template.
    routes: [],
  };

  const HOST = 'https://observe.gmac.io';
  const script = document.currentScript;
  const pending = [];
  let ready = null;

  const api = {
    track(event, props) {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(String(event))) return;
      call(['capture', event, props || {}]);
    },
    identify(id, props) {
      if (!CONFIG.identify || CONFIG.persistence === 'cookieless') return;
      const value = typeof id === 'number' ? String(id) : id;
      if (typeof value !== 'string' || !value || value.length > 128 || value.includes('@')) return;
      call(['identify', value, props || {}]);
    },
    reset() {
      call(['reset']);
    },
  };

  function call(args) {
    if (ready) invoke(ready, args);
    else if (pending.length < 100) pending.push(args);
  }

  function invoke(glass, [method, ...args]) {
    try {
      if (method === 'capture') glass.capture(args[0], sanitizeProps(args[1]));
      else if (method === 'identify') glass.identify(args[0], sanitizeProps(args[1]));
      else if (method === 'reset') glass.reset();
    } catch {
      // Analytics must never break the app.
    }
  }

  const matches = (path, prefix) =>
    prefix === '/'
      ? path === '/'
      : path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`);

  function allowed(path) {
    if (CONFIG.exclude.some((p) => matches(path, p))) return false;
    return CONFIG.only.length === 0 || CONFIG.only.some((p) => matches(path, p));
  }

  function idLike(segment) {
    let s = segment;
    try {
      s = decodeURIComponent(segment);
    } catch {
      // keep raw
    }
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^\d{2,}$/.test(s) ||
      (/^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s)) ||
      s.length >= 24 ||
      s.includes('@') ||
      (/^[A-Za-z0-9_-]{10,}$/.test(s) && (s.match(/\d/g) || []).length >= 3)
    );
  }

  function normalizePath(path) {
    const segments = path.split('/').filter(Boolean);
    for (const template of CONFIG.routes) {
      const parts = template.split('/').filter(Boolean);
      if (parts.length !== segments.length) continue;
      if (parts.every((p, i) => p.startsWith(':') || p === segments[i]))
        return `/${parts.join('/')}`;
    }
    return `/${segments.map((s) => (idLike(s) ? ':id' : s)).join('/')}`;
  }

  function utmQuery(search) {
    const params = new URLSearchParams(search);
    const kept = new URLSearchParams();
    for (const [k, v] of params)
      if (/^utm_(source|medium|campaign|term|content)$/.test(k)) kept.set(k, v.slice(0, 100));
    const q = kept.toString();
    return q ? `?${q}` : '';
  }

  function cleanUrl(href) {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin) return `${u.origin}/`;
      return u.origin + normalizePath(u.pathname);
    } catch {
      return null;
    }
  }

  const BLOCKED_KEY =
    /(email|e_mail|phone|password|passwd|token|secret|ssn|address|first_?name|last_?name|full_?name|^name$|card|iban|dob|birth)/i;

  function cleanValue(v) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (typeof v === 'string') {
      if (v.includes('@') || /\d{6,}/.test(v)) return undefined;
      return v.slice(0, 120);
    }
    if (Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x !== 'object' || x === null)) {
      return v.map(cleanValue).filter((x) => x !== undefined);
    }
    return undefined;
  }

  function sanitizeProps(props) {
    const out = {};
    if (!props || typeof props !== 'object') return out;
    for (const [k, v] of Object.entries(props).slice(0, 40)) {
      if (k === '$set' || k === '$set_once') {
        out[k] = sanitizeProps(v);
        continue;
      }
      if (BLOCKED_KEY.test(k)) continue;
      const clean = cleanValue(v);
      if (clean !== undefined) out[k.slice(0, 64)] = clean;
    }
    return out;
  }

  // The SDK records $pageleave after the URL has already changed, so remember the page being left.
  let lastPath = null;

  function beforeSend(event) {
    const leaving = event.event === '$pageleave' && lastPath !== null;
    const rawPath = leaving ? lastPath : location.pathname;
    if (event.event === '$pageview') lastPath = location.pathname;
    if (!allowed(rawPath)) return null;
    const props = { ...(event.props || {}) };
    if (event.event === '$click') {
      const text = typeof props.text === 'string' ? props.text : '';
      props.text =
        text && text.length <= 40 && !text.includes('@') && !/\d{4,}/.test(text) ? text : undefined;
      if (typeof props.href === 'string') props.href = cleanUrl(props.href) || undefined;
      if (typeof props.id === 'string' && idLike(props.id)) delete props.id;
    } else if (event.event === '$exception') {
      for (const k of Object.keys(props))
        if (typeof props[k] === 'string') props[k] = props[k].replace(/\d{4,}/g, '#').slice(0, 300);
    }
    // Custom events (including declarative data-glass-event clicks) are sanitised here too.
    const finalProps = event.event.startsWith('$') ? dropUndefined(props) : sanitizeProps(props);
    return {
      ...event,
      url: location.origin + normalizePath(rawPath) + (leaving ? '' : utmQuery(location.search)),
      referrer: event.referrer ? cleanUrl(event.referrer) : null,
      title: null,
      props: finalProps,
      flags: undefined,
    };
  }

  function dropUndefined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return out;
  }

  // Exposed for the loader's unit tests; harmless in production.
  api._internal = { normalizePath, sanitizeProps, cleanUrl, allowed, beforeSend, CONFIG };
  window.dataflare = api;

  if (script && script.dataset.enabled !== 'true') return;
  if (
    window.doNotTrack === '1' ||
    navigator.doNotTrack === '1' ||
    navigator.globalPrivacyControl === true
  )
    return;
  // Fail closed: a page that is not collected never loads the SDK.
  if (!allowed(location.pathname) || !document.head) return;

  const sdk = document.createElement('script');
  sdk.src = `${HOST}/s.js`;
  sdk.addEventListener('load', () => {
    const glass = window.glass;
    if (!glass || typeof glass.init !== 'function') return;
    glass.init({
      host: HOST,
      project: CONFIG.project,
      persistence: CONFIG.persistence,
      autocapture: { pageviews: true, clicks: true, errors: true, webVitals: true },
      flags: false,
      replay: false,
      beforeSend,
    });
    ready = glass;
    for (const args of pending.splice(0)) invoke(glass, args);
    // Send the landing pageview now so short visits are not lost.
    if (typeof glass.flush === 'function') void glass.flush();
  });
  document.head.append(sdk);
})();
