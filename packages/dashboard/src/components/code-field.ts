/**
 * A small code editor: a transparent textarea over a highlighted copy of its text.
 * The textarea keeps native editing, selection, undo and accessibility; the copy
 * underneath draws the colours and error squiggles. The SQL, JSON and formula editors
 * are built on it, each with its own tokenizer.
 */

import { h } from '../dom.ts';

/** A run of text and the class that colours it (`t-kw`, `t-str`, `t-num`…), if any. */
export interface CodeToken {
  text: string;
  cls?: string;
}

/** An error to underline, from `start` to `end` (character offsets), with what's wrong. */
interface CodeMarker {
  start: number;
  end: number;
  message: string;
}

export interface CodeFieldOptions {
  value: string;
  /** The accessible name of the field. */
  label: string;
  /** Splits the text into tokens that, joined, give the text back exactly. */
  tokenize: (text: string) => CodeToken[];
  /** A modifier class for the wrapper, e.g. `code-json`. */
  className?: string;
  rows?: number;
  placeholder?: string;
  /** Line numbers down the side; lines then scroll sideways instead of wrapping. */
  lineNumbers?: boolean;
  /** Grow with the text, up to this many pixels tall. */
  autoGrow?: number;
  onInput?: (value: string) => void;
  /** Return true when the key was handled (and its default prevented). */
  onKeyDown?: (event: KeyboardEvent, field: CodeField) => boolean | undefined;
  /** The caret moved (typing, clicking or arrow keys). */
  onCaret?: (field: CodeField) => void;
  onBlur?: () => void;
}

export interface CodeField {
  /** The element to put on the page. */
  el: HTMLElement;
  input: HTMLTextAreaElement;
  readonly value: string;
  set(value: string): void;
  /** Replace the selection with `text` and put the caret after it. */
  insert(text: string): void;
  /** Replace `start`–`end` with `text`; the caret goes to `caret` (default: after the text). */
  replace(start: number, end: number, text: string, caret?: number): void;
  setMarkers(markers: CodeMarker[]): void;
  /** Extra classes for character ranges, e.g. the bracket matching the one at the caret. */
  setHighlights(ranges: { start: number; end: number; cls: string }[]): void;
  repaint(): void;
  focus(): void;
}

let fieldIds = 0;

interface Range {
  start: number;
  end: number;
  cls: string;
}

/** Split tokens at range boundaries so each piece gets the token's class plus any range's. */
function paintTokens(tokens: CodeToken[], ranges: Range[]): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    const cuts = new Set([at, end]);
    for (const r of ranges) {
      if (r.start > at && r.start < end) cuts.add(r.start);
      if (r.end > at && r.end < end) cuts.add(r.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      out.push(piece(token, token.text.slice(from - at, to - at), from, to, ranges));
    }
    at = end;
  }
  return out;
}

function piece(token: CodeToken, text: string, from: number, to: number, ranges: Range[]): Node {
  const classes = [
    token.cls,
    ...ranges.filter((r) => r.start < to && r.end > from).map((r) => r.cls),
  ]
    .filter(Boolean)
    .join(' ');
  return classes ? h('span', { class: classes }, text) : document.createTextNode(text);
}

/** A zero-width error (at the end of the text, say) still needs something to underline. */
function widen(m: CodeMarker, length: number): Range {
  if (m.end > m.start) return { start: m.start, end: m.end, cls: 'code-error' };
  const start = Math.min(m.start, Math.max(0, length - 1));
  return { start, end: start + 1, cls: 'code-error' };
}

export function codeField(options: CodeFieldOptions): CodeField {
  const id = `code-${++fieldIds}`;
  const input = h('textarea', {
    class: 'code-input',
    rows: options.rows ?? 4,
    spellcheck: false,
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': options.label,
    'aria-describedby': `${id}-message`,
    placeholder: options.placeholder ?? '',
    wrap: options.lineNumbers ? 'off' : 'soft',
  });
  input.value = options.value;
  const mirror = h('pre', { class: 'code-highlight', 'aria-hidden': 'true' });
  const gutter = options.lineNumbers
    ? h('div', { class: 'code-gutter', 'aria-hidden': 'true' })
    : null;
  const message = h('div', { class: 'code-message', id: `${id}-message`, 'aria-live': 'polite' });
  let markers: CodeMarker[] = [];
  let highlights: Range[] = [];

  const syncScroll = () => {
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
    if (gutter) gutter.scrollTop = input.scrollTop;
  };
  const grow = () => {
    if (!options.autoGrow) return;
    // Not on the page yet: there's nothing to measure, so measure once it is.
    if (!input.isConnected) {
      requestAnimationFrame(() => input.isConnected && grow());
      return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.min(options.autoGrow, input.scrollHeight + 2)}px`;
  };
  const repaint = () => {
    const ranges = [...highlights, ...markers.map((m) => widen(m, input.value.length))];
    // The trailing newline keeps the copy as tall as the textarea when the text ends in one.
    mirror.replaceChildren(...paintTokens(options.tokenize(input.value), ranges), '\n');
    if (gutter) {
      const lines = input.value.split('\n').length;
      gutter.replaceChildren(
        ...Array.from({ length: lines }, (_, i) => h('span', {}, String(i + 1))),
      );
    }
    message.textContent = markers[0]?.message ?? '';
    wrap.classList.toggle('invalid', markers.length > 0);
    input.setAttribute('aria-invalid', String(markers.length > 0));
    grow();
    syncScroll();
  };

  const field: CodeField = {
    el: h('div', {}),
    input,
    get value() {
      return input.value;
    },
    set(value) {
      input.value = value;
      repaint();
    },
    insert(text) {
      field.replace(input.selectionStart, input.selectionEnd, text);
    },
    replace(start, end, text, caret) {
      input.focus();
      input.setSelectionRange(start, end);
      // execCommand keeps the browser's undo history; fall back to setting the value.
      if (!document.execCommand?.('insertText', false, text)) {
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.dispatchEvent(new Event('input'));
      }
      const at = caret ?? start + text.length;
      input.setSelectionRange(at, at);
    },
    setMarkers(next) {
      markers = next;
      repaint();
    },
    setHighlights(next) {
      highlights = next;
      repaint();
    },
    repaint,
    focus: () => input.focus(),
  };

  const wrap = h(
    'div',
    {
      class: `code-field ${options.lineNumbers ? 'numbered' : ''} ${options.className ?? ''}`,
    },
    gutter,
    h('div', { class: 'code-stack' }, mirror, input),
  );
  field.el = h('div', { class: 'code-field-wrap' }, wrap, message);

  input.addEventListener('input', () => {
    repaint();
    options.onInput?.(input.value);
    options.onCaret?.(field);
  });
  input.addEventListener('scroll', syncScroll);
  input.addEventListener('keydown', (e) => {
    if (options.onKeyDown?.(e, field)) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      field.insert('  ');
    }
  });
  for (const type of ['keyup', 'click'] as const)
    input.addEventListener(type, () => options.onCaret?.(field));
  if (options.onBlur) input.addEventListener('blur', options.onBlur);
  repaint();
  return field;
}
