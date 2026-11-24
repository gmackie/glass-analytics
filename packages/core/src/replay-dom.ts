/**
 * A model of one page load's DOM, rebuilt from rrweb's serialized snapshot and
 * mutations. It is enough to name elements ("Pay now" (button)), give them a
 * selector a coding agent can grep for, and describe what was on screen.
 *
 * rrweb serializes the first snapshot as a tree, but nodes added later arrive
 * one at a time (`adds`, each with a `parentId`), with text changes (`texts`),
 * attribute changes (`attributes`) and removals (`removes`) alongside. Single
 * page apps render almost everything that way, so all four are applied here;
 * reading only the snapshot tree would leave most controls unnamed.
 */

/** The subset of rrweb's event format we read. See rrweb's `EventType` / `IncrementalSource`. */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  // oxlint-disable-next-line no-explicit-any -- rrweb event payloads are heterogeneous
  data?: any;
}

export const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4, Custom: 5 } as const;
export const Source = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
} as const;
export const NodeType = { Document: 0, Element: 2, Text: 3 } as const;

export interface SerializedNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

/** Elements people click on purpose. A click on an icon or span inside one is reported as a click on it. */
const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  'option',
]);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'switch',
  'option',
]);
/** Elements whose text is never visible, so never part of a label or a snapshot. */
const HIDDEN_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'meta',
  'link',
  'title',
]);
/** The page itself. Labelling a click on <body> with the page's text would be misleading. */
const PAGE_TAGS = new Set(['html', 'body']);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
  'br',
]);

export const tagOf = (node: SerializedNode | undefined) => (node?.tagName ?? '').toLowerCase();

export function attr(node: SerializedNode | undefined, name: string): string {
  const value = node?.attributes?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** What an element is, in words: "link" rather than "a", "button" for `<input type="submit">`. */
export function kindOf(node: SerializedNode): string {
  const role = attr(node, 'role');
  if (INTERACTIVE_ROLES.has(role)) return role;
  const tag = tagOf(node);
  const type = attr(node, 'type').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return type;
  return tag || 'element';
}

export const isInteractive = (node: SerializedNode) =>
  INTERACTIVE_TAGS.has(tagOf(node)) ||
  INTERACTIVE_ROLES.has(attr(node, 'role')) ||
  'onclick' in (node.attributes ?? {});

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** Ids and classes that frameworks generate (React `:r1:`, CSS-in-JS hashes) change between builds: useless to grep for. */
const generatedId = (id: string) => /[:]|\d{4,}|^[a-f0-9-]{16,}$/i.test(id);
const usefulClass = (c: string) =>
  /^[a-zA-Z][\w-]{1,40}$/.test(c) && !/^(css|sc|jsx|svelte|emotion|tw)-|\d{3,}|^_/.test(c);

/** What a click resolved to: a readable label, a selector, and whether it was a control. */
export interface Target {
  id: number;
  label: string;
  selector: string;
  /** The control (button, link, …) around the clicked node, if any. */
  control?: SerializedNode;
}

export class DomModel {
  private nodes = new Map<number, SerializedNode>();
  private parents = new Map<number, number>();
  private children = new Map<number, number[]>();
  /** Current values of inputs, from Input events (already masked by the recorder). */
  readonly values = new Map<number, { text?: string; checked?: boolean }>();

  /** A full snapshot describes the whole DOM, so it replaces everything we knew. */
  reset(root: SerializedNode): void {
    this.nodes.clear();
    this.parents.clear();
    this.children.clear();
    this.values.clear();
    this.add(root);
  }

  get(id: number): SerializedNode | undefined {
    return this.nodes.get(id);
  }

  private detach(id: number): void {
    const parent = this.parents.get(id);
    if (parent === undefined) return;
    const list = this.children.get(parent);
    const i = list?.indexOf(id) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    this.parents.delete(id);
  }

  /**
   * Add a node (and any serialized children) under `parentId`, before `nextId` when given.
   * Never clears an existing child list: mutation adds can name a child before its parent.
   */
  add(node: SerializedNode, parentId?: number, nextId?: number | null): void {
    // Keep our own copy without the child array: the tree lives in `children`.
    const { childNodes, ...own } = node;
    this.nodes.set(node.id, own);
    if (parentId !== undefined) {
      this.detach(node.id);
      this.parents.set(node.id, parentId);
      const list = this.children.get(parentId) ?? [];
      const at = nextId != null ? list.indexOf(nextId) : -1;
      if (at >= 0) list.splice(at, 0, node.id);
      else list.push(node.id);
      this.children.set(parentId, list);
    }
    for (const child of childNodes ?? []) this.add(child, node.id);
  }

  remove(id: number): void {
    this.detach(id);
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      for (const child of this.children.get(current) ?? []) stack.push(child);
      this.nodes.delete(current);
      this.children.delete(current);
      this.parents.delete(current);
      this.values.delete(current);
    }
  }

  /** Apply one rrweb mutation in the order the rrweb player does: removes, adds, texts, attributes. */
  // oxlint-disable-next-line no-explicit-any -- rrweb mutation payload
  mutate(data: any): void {
    for (const r of data.removes ?? []) if (r && typeof r.id === 'number') this.remove(r.id);
    for (const a of data.adds ?? []) if (a?.node) this.add(a.node, a.parentId, a.nextId);
    for (const t of data.texts ?? []) {
      const node = this.nodes.get(t?.id);
      if (node) this.nodes.set(node.id, { ...node, textContent: t.value ?? '' });
    }
    for (const a of data.attributes ?? []) {
      const node = this.nodes.get(a?.id);
      if (!node) continue;
      const attributes = { ...(node.attributes ?? {}) };
      for (const [k, v] of Object.entries(a.attributes ?? {})) {
        if (v === null) delete attributes[k];
        else attributes[k] = v;
      }
      this.nodes.set(node.id, { ...node, attributes });
    }
  }

  // oxlint-disable-next-line no-explicit-any -- rrweb input payload
  input(data: any): void {
    if (typeof data?.id !== 'number') return;
    this.values.set(data.id, {
      text: typeof data.text === 'string' ? data.text : undefined,
      checked: typeof data.isChecked === 'boolean' ? data.isChecked : undefined,
    });
  }

  childIds(id: number): number[] {
    return this.children.get(id) ?? [];
  }

  parentOf(id: number): number | undefined {
    return this.parents.get(id);
  }

  /** The visible text inside a node, whitespace collapsed, at most `budget` characters. */
  text(id: number, budget = 80): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    if (node.type === NodeType.Text) return (node.textContent ?? '').trim();
    if (HIDDEN_TAGS.has(tagOf(node))) return '';
    if (tagOf(node) === 'img') return attr(node, 'alt');
    let out = '';
    for (const child of this.childIds(id)) {
      if (out.length >= budget) break;
      const t = this.text(child, budget - out.length);
      if (t) out += (out ? ' ' : '') + t;
    }
    return out.replace(/\s+/g, ' ').slice(0, budget);
  }

  /** The accessible name of an element: aria-label, title, alt, placeholder, name, or a <label for>. */
  private name(node: SerializedNode): string {
    return (
      attr(node, 'aria-label') ||
      attr(node, 'title') ||
      attr(node, 'alt') ||
      attr(node, 'placeholder') ||
      attr(node, 'name')
    );
  }

  /** `"Pay now" (button)` from the element's accessible name or text, or `button #pay` from its id. */
  private describe(node: SerializedNode): string | null {
    const text = this.name(node) || this.text(node.id, 61);
    if (text) return `"${clip(text)}" (${kindOf(node)})`;
    const id = attr(node, 'id');
    return id ? `${kindOf(node)} #${id}` : null;
  }

  /** A CSS selector for an element that is likely to appear in the source: test ids, ids, names, then a short class path. */
  selector(id: number): string {
    const node = this.nodes.get(id);
    if (!node || node.type !== NodeType.Element) return '';
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-glass']) {
      const v = attr(node, a);
      if (v) return `[${a}="${v}"]`;
    }
    const own = attr(node, 'id');
    if (own && !generatedId(own)) return `#${own}`;
    const tag = tagOf(node);
    const nameAttr = attr(node, 'name');
    if (nameAttr && ['input', 'select', 'textarea', 'button'].includes(tag))
      return `${tag}[name="${nameAttr}"]`;
    const parts: string[] = [];
    for (
      let current: number | undefined = id;
      current !== undefined && parts.length < 3;
      current = this.parents.get(current)
    ) {
      const n = this.nodes.get(current);
      if (!n || n.type !== NodeType.Element || PAGE_TAGS.has(tagOf(n))) break;
      const nid = attr(n, 'id');
      if (nid && !generatedId(nid) && current !== id) {
        parts.unshift(`#${nid}`);
        break;
      }
      const classes = attr(n, 'class').split(/\s+/).filter(usefulClass).slice(0, 2);
      parts.unshift(tagOf(n) + classes.map((c) => `.${c}`).join(''));
    }
    // A bare `div > button` matches half the codebase: only return paths with something specific in them.
    return parts.some((p) => /[.#[]/.test(p)) ? parts.join(' > ') : '';
  }

  /** A readable label and selector for a click or input target: the control around it if there is one, else the element itself. */
  target(id: number): Target {
    const chain: SerializedNode[] = [];
    for (
      let current: number | undefined = id;
      current !== undefined && chain.length < 8;
      current = this.parents.get(current)
    ) {
      const node = this.nodes.get(current);
      if (!node) break;
      if (node.type === NodeType.Element) chain.push(node);
    }
    const control = chain.slice(0, 6).find(isInteractive);
    if (control) {
      const kind = kindOf(control);
      return {
        id: control.id,
        label: this.describe(control) ?? `${article(kind)} ${kind}`,
        selector: this.selector(control.id),
        control,
      };
    }
    for (const node of chain.slice(0, 6)) {
      if (PAGE_TAGS.has(tagOf(node))) break;
      const described = this.describe(node);
      if (described) return { id: node.id, label: described, selector: this.selector(node.id) };
    }
    const first = chain[0];
    if (!first) return { id, label: 'an element', selector: '' };
    if (PAGE_TAGS.has(tagOf(first)))
      return { id: first.id, label: 'the page background', selector: '' };
    return { id: first.id, label: `<${tagOf(first)}>`, selector: this.selector(first.id) };
  }

  /** Is this element (or an ancestor) hidden from view by markup? */
  private hidden(node: SerializedNode): boolean {
    if (HIDDEN_TAGS.has(tagOf(node))) return true;
    if ('hidden' in (node.attributes ?? {}) || attr(node, 'aria-hidden') === 'true') return true;
    if (tagOf(node) === 'input' && attr(node, 'type').toLowerCase() === 'hidden') return true;
    const style = attr(node, 'style').replace(/\s+/g, '').toLowerCase();
    return style.includes('display:none') || style.includes('visibility:hidden');
  }

  /**
   * What the page showed, as readable text: headings, links, buttons, form fields
   * (with the recorder's masked values) and dialogs. Not pixel-perfect: CSS can
   * still hide things this can't see, but it is what an agent needs to reason about.
   */
  render(maxChars = 8000): string {
    const root =
      [...this.nodes.values()].find((n) => n.type === NodeType.Document) ??
      this.nodes.values().next().value;
    if (!root) return '';
    const out: string[] = [];
    let line = '';
    const flush = () => {
      const t = line.replace(/[ \t]+/g, ' ').trim();
      if (t) out.push(t);
      line = '';
    };
    const inline = (s: string) => {
      if (s) line += (line && !line.endsWith(' ') ? ' ' : '') + s;
    };
    let size = 0;
    const walk = (id: number, listDepth: number): void => {
      if (size > maxChars) return;
      const node = this.nodes.get(id);
      if (!node) return;
      if (node.type === NodeType.Text) {
        inline((node.textContent ?? '').replace(/\s+/g, ' ').trim());
        return;
      }
      if (node.type !== NodeType.Element) {
        for (const c of this.childIds(id)) walk(c, listDepth);
        return;
      }
      if (this.hidden(node)) return;
      const tag = tagOf(node);
      const role = attr(node, 'role');
      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        flush();
        out.push(`${'#'.repeat(Number(heading[1]))} ${this.text(id, 200)}`);
        size += 200;
        return;
      }
      if (tag === 'a') {
        const label = this.name(node) || this.text(id, 100);
        if (label) inline(`[${clip(label, 100)}](${attr(node, 'href') || '#'})`);
        return;
      }
      if (
        tag === 'button' ||
        role === 'button' ||
        (tag === 'input' &&
          ['submit', 'button', 'reset'].includes(attr(node, 'type').toLowerCase()))
      ) {
        const label =
          this.name(node) || this.text(id, 80) || attr(node, 'value') || attr(node, 'id');
        const disabled =
          'disabled' in (node.attributes ?? {}) || attr(node, 'aria-disabled') === 'true';
        inline(`[button: ${clip(label || '(no label)', 80)}${disabled ? ', disabled' : ''}]`);
        return;
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const type = tag === 'input' ? attr(node, 'type').toLowerCase() || 'text' : tag;
        const label = this.name(node) || attr(node, 'id') || type;
        const state = this.values.get(id);
        if (type === 'checkbox' || type === 'radio') {
          const checked = state?.checked ?? 'checked' in (node.attributes ?? {});
          inline(`[${checked ? 'x' : ' '}] ${clip(label, 60)}`);
          return;
        }
        const value = tag === 'select' ? this.text(id, 60) : (state?.text ?? attr(node, 'value'));
        const invalid = attr(node, 'aria-invalid') === 'true' ? ', invalid' : '';
        inline(`[${type} "${clip(label, 60)}": ${value ? clip(value, 40) : 'empty'}${invalid}]`);
        return;
      }
      if (tag === 'img') {
        const alt = attr(node, 'alt');
        if (alt) inline(`[image: ${clip(alt, 80)}]`);
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      const dialog =
        tag === 'dialog' || role === 'dialog' || role === 'alertdialog' || role === 'alert';
      if (block || dialog) flush();
      if (dialog) out.push(`[${role || 'dialog'}]`);
      const list = tag === 'ul' || tag === 'ol';
      if (tag === 'li') line = `${'  '.repeat(Math.max(0, listDepth - 1))}- `;
      for (const c of this.childIds(id)) walk(c, listDepth + (list ? 1 : 0));
      if (block || dialog) flush();
      if (dialog) out.push(`[/${role || 'dialog'}]`);
      size = out.reduce((n, l) => n + l.length + 1, 0);
    };
    walk(root.id, 0);
    flush();
    const text = out.filter((l, i) => !(l === '-' || (l === '' && out[i - 1] === ''))).join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
  }
}
