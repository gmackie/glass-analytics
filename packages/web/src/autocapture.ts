/**
 * Automatic capture: pageviews (including client-side navigation), clicks and errors.
 *
 * Declarative tracking for plain HTML (and for agents adding tracking without
 * touching JavaScript):
 *
 *   <button data-glass-event="pricing_cta_clicked" data-glass-prop-plan="pro">Buy</button>
 *
 * Add `data-glass-no-capture` to any element to exclude it (and its children)
 * from click capture.
 */

const CLICKABLE =
  'a, button, [role="button"], input[type="submit"], input[type="button"], [data-glass-event]';
const MAX_ERRORS_PER_PAGE = 10;
/** How often to check the URL in browsers without the Navigation API. */
const NAVIGATION_POLL_MS = 1000;

export interface AutocaptureHooks {
  pageview(): void;
  pageleave(): void;
  capture(event: string, props: Record<string, unknown>): void;
}

export function trackPageviews(hooks: AutocaptureHooks): () => void {
  let lastUrl = location.href;
  const onChange = () => {
    if (location.href === lastUrl) return;
    hooks.pageleave();
    lastUrl = location.href;
    hooks.pageview();
  };
  // Single-page apps navigate with the History API; wrap it to notice.
  const push = history.pushState;
  const replace = history.replaceState;
  history.pushState = function (...args: Parameters<History['pushState']>) {
    push.apply(this, args);
    queueMicrotask(onChange);
  };
  history.replaceState = function (...args: Parameters<History['replaceState']>) {
    replace.apply(this, args);
    queueMicrotask(onChange);
  };
  addEventListener('popstate', onChange);
  // Routers that saved a reference to pushState before this script loaded (Next.js does) bypass
  // the wrapper above. The Navigation API sees those navigations; elsewhere, check the URL often.
  const nav = (globalThis as { navigation?: EventTarget }).navigation;
  const onNavigated = () => queueMicrotask(onChange);
  nav?.addEventListener('navigatesuccess', onNavigated);
  const poll = nav ? null : setInterval(onChange, NAVIGATION_POLL_MS);
  hooks.pageview();
  return () => {
    history.pushState = push;
    history.replaceState = replace;
    removeEventListener('popstate', onChange);
    nav?.removeEventListener('navigatesuccess', onNavigated);
    if (poll) clearInterval(poll);
  };
}

function elementText(el: Element): string {
  if (el instanceof HTMLInputElement)
    return el.value && el.type !== 'password' ? el.value.slice(0, 60) : '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function trackClicks(hooks: AutocaptureHooks): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target.closest(CLICKABLE) : null;
    if (!target || target.closest('[data-glass-no-capture]')) return;
    const custom = target.getAttribute('data-glass-event');
    if (custom) {
      const props: Record<string, unknown> = {};
      for (const attr of Array.from(target.attributes)) {
        if (attr.name.startsWith('data-glass-prop-'))
          props[attr.name.slice(16).replace(/-/g, '_')] = attr.value;
      }
      hooks.capture(custom, props);
      return;
    }
    const props: Record<string, unknown> = {
      tag: target.tagName.toLowerCase(),
      text: elementText(target),
    };
    if (target.id) props.id = target.id;
    if (target instanceof HTMLAnchorElement && target.href) {
      props.href = target.href.split('?')[0];
      props.outbound = target.host !== location.host;
    }
    hooks.capture('$click', props);
  };
  addEventListener('click', onClick, { capture: true });
  return () => removeEventListener('click', onClick, { capture: true });
}

export function trackErrors(hooks: AutocaptureHooks, onError: () => void): () => void {
  let count = 0;
  const seen = new Set<string>();
  const report = (
    type: string,
    message: string,
    stack?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const key = `${type}:${message}`;
    if (count >= MAX_ERRORS_PER_PAGE || seen.has(key)) return;
    seen.add(key);
    count++;
    hooks.capture('$exception', {
      type,
      message: message.slice(0, 500),
      stack: stack?.slice(0, 2000),
      ...extra,
    });
    onError();
  };
  const onWindowError = (e: ErrorEvent) => {
    const err = e.error instanceof Error ? e.error : null;
    report(err?.name ?? 'Error', err?.message ?? e.message ?? 'Unknown error', err?.stack, {
      source: e.filename,
      line: e.lineno,
      column: e.colno,
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    if (reason instanceof Error)
      report(reason.name, reason.message, reason.stack, { unhandled_rejection: true });
    else report('UnhandledRejection', String(reason), undefined, { unhandled_rejection: true });
  };
  addEventListener('error', onWindowError);
  addEventListener('unhandledrejection', onRejection);
  return () => {
    removeEventListener('error', onWindowError);
    removeEventListener('unhandledrejection', onRejection);
  };
}
