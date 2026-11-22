/**
 * A JSON editor: highlighting, line numbers, live checking with the exact line and column of
 * any mistake (core/json-check.ts), brackets and quotes that close themselves, indentation that
 * follows the structure, a Format button, a size meter, and snippets to start from.
 */

import { checkJson, type JsonToken, lexJson } from '@dataflare/core/json-check';
import { type Child, h } from '../dom.ts';
import { type CodeField, type CodeToken, codeField } from './code-field.ts';
import { icon } from './icons.ts';
import { popover } from './menu.ts';

export interface JsonSnippet {
  label: string;
  hint?: string;
  value: unknown;
}

export interface JsonEditorOptions {
  /** The starting value; undefined starts empty. */
  value?: unknown;
  label: string;
  placeholder?: string;
  /** Show a size meter against this many bytes of compact JSON. */
  maxBytes?: number;
  /** Problems with the shape of a valid value (e.g. a web experiment missing a selector). */
  validate?: (value: unknown) => string[];
  snippets?: JsonSnippet[];
  onChange?: () => void;
  /** What the status line says while it's empty (default "Empty"). */
  emptyText?: string;
}

/** What the editor holds: nothing, a valid value, or a problem to show. */
type JsonState = { ok: true; empty: boolean; value: unknown } | { ok: false; message: string };

export interface JsonEditor {
  el: HTMLElement;
  state(): JsonState;
  set(value: unknown): void;
  focus(): void;
}

const CLASSES: Record<JsonToken['kind'], string | undefined> = {
  key: 't-key',
  str: 't-str',
  num: 't-num',
  lit: 't-lit',
  punct: 't-punct',
  space: undefined,
  bad: 't-bad',
};

function jsonTokens(text: string): CodeToken[] {
  return lexJson(text).map((t) => ({ text: text.slice(t.start, t.end), cls: CLASSES[t.kind] }));
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '"': '"' };
const CLOSERS = new Set(['}', ']', '"']);

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** Sizes as people read them: 820 B, 1.2 KB, 10 KB (thousands, as the limit is set). */
const bytes = (n: number) =>
  n < 1000 ? `${n} B` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')} KB`;

/** Positions of matching brackets outside strings, both ways. */
function bracketPairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (const t of lexJson(text)) {
    if (t.kind !== 'punct') continue;
    const c = text[t.start]!;
    if (c === '{' || c === '[') stack.push(t.start);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (open === undefined) continue;
      pairs.set(open, t.start);
      pairs.set(t.start, open);
    }
  }
  return pairs;
}

/** The bracket next to the caret and its partner, highlighted. */
function caretMatch(field: CodeField): { start: number; end: number; cls: string }[] {
  const text = field.value;
  const at = field.input.selectionStart;
  const pairs = bracketPairs(text);
  const here = [at - 1, at].find((i) => pairs.has(i));
  if (here === undefined) return [];
  const other = pairs.get(here)!;
  return [here, other].map((i) => ({ start: i, end: i + 1, cls: 't-match' }));
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function indentAt(text: string, at: number): string {
  const start = lineStart(text, at);
  return /^ */.exec(text.slice(start))![0];
}

/** Enter keeps the line's indentation, one level deeper after { or [, splitting {} apart. */
function newline(field: CodeField): void {
  const text = field.value;
  const at = field.input.selectionStart;
  const indent = indentAt(text, at);
  const before = text.slice(0, at).trimEnd().slice(-1);
  const after = text[field.input.selectionEnd];
  if (before !== '{' && before !== '[') {
    field.insert(`\n${indent}`);
    return;
  }
  const inner = `${indent}  `;
  if (after === PAIRS[before]) {
    field.replace(at, field.input.selectionEnd, `\n${inner}\n${indent}`, at + 1 + inner.length);
    return;
  }
  field.insert(`\n${inner}`);
}

/** Inside a string on this line? Counts the unescaped quotes before the caret. */
function inString(text: string, at: number): boolean {
  const line = text.slice(lineStart(text, at), at).replace(/\\./g, '');
  return (line.match(/"/g)?.length ?? 0) % 2 === 1;
}

/** Type the closing bracket or quote too, when nothing follows that it would swallow. */
function autoClose(field: CodeField, key: string): boolean {
  const text = field.value;
  const at = field.input.selectionStart;
  const next = text[field.input.selectionEnd] ?? '';
  if (CLOSERS.has(key) && next === key && field.input.selectionStart === field.input.selectionEnd) {
    field.input.setSelectionRange(at + 1, at + 1);
    return true;
  }
  if (!PAIRS[key] || (key === '"' && inString(text, at))) return false;
  if (next && !/[\s,}\]:]/.test(next)) return false;
  field.replace(at, field.input.selectionEnd, key + PAIRS[key], at + 1);
  return true;
}

/** Backspace between an empty pair removes both halves. */
function deletePair(field: CodeField): boolean {
  const at = field.input.selectionStart;
  if (at !== field.input.selectionEnd || at === 0) return false;
  const text = field.value;
  if (PAIRS[text[at - 1]!] !== text[at]) return false;
  field.replace(at - 1, at + 1, '');
  return true;
}

/** Shift+Tab: take up to two spaces off the start of the line. */
function outdent(field: CodeField): void {
  const text = field.value;
  const at = field.input.selectionStart;
  const start = lineStart(text, at);
  const spaces = /^ {1,2}/.exec(text.slice(start))?.[0].length ?? 0;
  if (spaces) field.replace(start, start + spaces, '', Math.max(start, at - spaces));
}

function onKey(e: KeyboardEvent, field: CodeField, format: () => void): boolean {
  if (e.metaKey || e.ctrlKey) return false;
  if (e.key === 'F' && e.shiftKey && e.altKey) format();
  else if (e.key === 'Enter') newline(field);
  else if (e.key === 'Tab' && e.shiftKey) outdent(field);
  else if (e.key === 'Backspace') {
    if (!deletePair(field)) return false;
  } else if (!autoClose(field, e.key)) return false;
  e.preventDefault();
  return true;
}

function sizeMeter(size: number, max: number): HTMLElement {
  const level = size > max ? 'over' : size > max * 0.8 ? 'near' : '';
  return h('span', { class: `json-size ${level}` }, `${bytes(size)} of ${bytes(max)}`);
}

function snippetMenu(snippets: JsonSnippet[], use: (value: unknown) => void): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button', class: 'small ghost', title: 'Start from an example' },
    icon('plus', 13),
    'Insert',
  );
  popover(
    trigger,
    (close) =>
      h(
        'div',
        { class: 'menu' },
        snippets.map((s) =>
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item',
              onclick: () => {
                use(s.value);
                close();
              },
            },
            h('span', {}, s.label),
            s.hint ? h('span', { class: 'muted small' }, s.hint) : null,
          ),
        ),
      ),
    { align: 'end', width: 280 },
  );
  return trigger;
}

export function jsonEditor(options: JsonEditorOptions): JsonEditor {
  let state: JsonState = { ok: true, empty: true, value: undefined };
  const status = h('div', { class: 'json-status' });
  const format = () => {
    if (state.ok && !state.empty) field.set(pretty(state.value));
    check();
  };
  const field = codeField({
    value: options.value === undefined ? '' : pretty(options.value),
    label: options.label,
    tokenize: jsonTokens,
    className: 'code-json',
    rows: 3,
    autoGrow: 320,
    lineNumbers: true,
    placeholder: options.placeholder,
    onInput: () => {
      check();
      options.onChange?.();
    },
    onKeyDown: (e, f) => onKey(e, f, format),
    onCaret: (f) => f.setHighlights(caretMatch(f)),
  });

  const paintStatus = (message: Child, size?: number) =>
    status.replaceChildren(
      h('span', { class: state.ok ? 'muted' : 'json-problem' }, message),
      size !== undefined && options.maxBytes ? sizeMeter(size, options.maxBytes) : '',
    );

  function check(): void {
    const text = field.value;
    if (!text.trim()) {
      state = { ok: true, empty: true, value: undefined };
      field.setMarkers([]);
      paintStatus(options.emptyText ?? 'Empty');
      return;
    }
    const r = checkJson(text);
    if (!r.ok) {
      const message = `Line ${r.line}, column ${r.col}: ${r.message}`;
      state = { ok: false, message };
      field.setMarkers([{ start: r.at, end: r.end, message: '' }]);
      paintStatus(message);
      return;
    }
    const size = new TextEncoder().encode(JSON.stringify(r.value)).length;
    const shape = options.validate?.(r.value) ?? [];
    const tooBig = options.maxBytes !== undefined && size > options.maxBytes;
    state =
      shape.length || tooBig
        ? { ok: false, message: shape[0] ?? `Too big: at most ${bytes(options.maxBytes!)}` }
        : { ok: true, empty: false, value: r.value };
    field.setMarkers([]);
    paintStatus(state.ok ? 'Valid JSON' : state.message, size);
  }

  const tools = h(
    'div',
    { class: 'json-tools' },
    options.snippets?.length
      ? snippetMenu(options.snippets, (v) => {
          field.set(pretty(v));
          check();
          options.onChange?.();
          field.focus();
        })
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'small ghost',
        title: 'Format (Shift+Alt+F)',
        onclick: format,
      },
      icon('code', 13),
      'Format',
    ),
  );
  const el = h(
    'div',
    { class: 'json-editor' },
    field.el,
    h('div', { class: 'json-foot' }, status, tools),
  );
  check();
  return {
    el,
    state: () => state,
    set: (value) => {
      field.set(value === undefined ? '' : pretty(value));
      check();
    },
    focus: () => field.focus(),
  };
}
