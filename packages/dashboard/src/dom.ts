/**
 * A tiny hyperscript helper. The dashboard renders by rebuilding DOM from
 * data; there is no framework, so contributors only need to know the DOM.
 *
 *   h('button', { class: 'primary', onclick: save }, 'Save flag')
 */

export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (event: Event) => void;
export type Attrs = Record<string, string | number | boolean | Handler | null | undefined>;

/** Strings and numbers go in as text (`append` makes a text node, never markup). */
function append(parent: ParentNode, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.append(typeof child === 'object' ? child : String(child));
}

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as Handler);
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === 'checked' && el instanceof HTMLInputElement) {
      el.checked = Boolean(value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

const isAttrs = (v: unknown): v is Attrs =>
  !!v && typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | Child,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (isAttrs(attrs)) applyAttrs(el, attrs);
  else append(el, attrs as Child);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(
  tag: string,
  attrs: Record<string, string | number | null | undefined> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  append(el, children);
  return el;
}

/** Replace the contents of `el`. */
export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}
