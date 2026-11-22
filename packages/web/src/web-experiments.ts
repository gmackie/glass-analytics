/**
 * Web experiments: page changes per variant, defined in Dataflare (no code change).
 *
 * A flag whose payload is `{ type: "web", transforms: [...] }` changes the page for
 * people who get that value: text, HTML, inline style, attributes, or hiding an
 * element. Changes apply when flags load, to elements added later (for a few
 * seconds), and after client-side navigation. To avoid a flash of the original
 * page, elements a cached experiment changes are hidden briefly until it applies.
 */

export interface WebTransform {
  selector: string;
  text?: string;
  html?: string;
  css?: string;
  attributes?: Record<string, string>;
  hide?: boolean;
}

export interface WebPayload {
  type: 'web';
  transforms: WebTransform[];
}

export function isWebPayload(p: unknown): p is WebPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as WebPayload).type === 'web' &&
    Array.isArray((p as WebPayload).transforms)
  );
}

const APPLIED = 'glassApplied';

function applyOne(el: Element, t: WebTransform): void {
  const h = el as HTMLElement;
  if (h.dataset?.[APPLIED] === t.selector) return;
  if (t.text !== undefined) h.textContent = t.text;
  if (t.html !== undefined) h.innerHTML = t.html;
  if (t.css) h.setAttribute('style', `${h.getAttribute('style') ?? ''};${t.css}`);
  for (const [k, v] of Object.entries(t.attributes ?? {})) h.setAttribute(k, v);
  if (t.hide) h.style.display = 'none';
  if (h.dataset) h.dataset[APPLIED] = t.selector;
}

/** Apply transforms to the page; returns how many elements changed. */
export function applyTransforms(
  transforms: readonly WebTransform[],
  root: ParentNode = document,
): number {
  let n = 0;
  for (const t of transforms) {
    try {
      for (const el of root.querySelectorAll(t.selector)) {
        applyOne(el, t);
        n++;
      }
    } catch {
      // An invalid selector shouldn't break the page or the other changes.
    }
  }
  return n;
}

/** Keep applying to elements added in the next `ms` (single-page apps render late). */
export function watchTransforms(transforms: readonly WebTransform[], ms = 5000): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(() => applyTransforms(transforms));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setTimeout(() => observer.disconnect(), ms);
  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
}

const STYLE_ID = 'glass-anti-flicker';

/** Hide what cached experiments will change until they apply, for at most `ms`. */
export function hideUntilApplied(selectors: string[], ms: number): () => void {
  if (!selectors.length || typeof document === 'undefined' || document.getElementById(STYLE_ID))
    return () => {};
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${selectors.join(',')}{visibility:hidden !important}`;
  (document.head ?? document.documentElement).appendChild(style);
  const reveal = () => style.remove();
  setTimeout(reveal, ms);
  return reveal;
}
