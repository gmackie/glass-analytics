/**
 * A flag's payloads: one JSON editor per value the flag returns ("on", or each variant),
 * each in its own fold. Payloads for values the flag no longer returns stay visible with a
 * warning, and can be moved to another value or removed, instead of silently failing to save.
 */

import { MAX_PAYLOAD_BYTES, payloadBytes, webPayloadProblems } from '@dataflare/core/flags';
import { h } from '../dom.ts';
import { type JsonEditor, type JsonSnippet, jsonEditor } from './json-editor.ts';

const SNIPPETS: JsonSnippet[] = [
  {
    label: 'Web experiment change',
    hint: 'Change the page without code',
    value: { type: 'web', transforms: [{ selector: 'h1', text: 'A new headline' }] },
  },
  {
    label: 'Copy and price',
    hint: 'Read with glass.flagPayload(key)',
    value: { headline: 'Write faster', price: 12, currency: 'GBP' },
  },
  { label: 'Feature settings', hint: 'Remote config', value: { limit: 10, beta: true } },
];

interface Entry {
  value: string;
  editor: JsonEditor;
  fold: HTMLDetailsElement;
  status: HTMLElement;
}

type PayloadsResult =
  | { ok: true; payloads: Record<string, unknown> | null }
  | { ok: false; message: string; focus: () => void };

export interface PayloadEditors {
  el: HTMLElement;
  /** The values the flag returns now (after the variants change). */
  sync(values: string[]): void;
  collect(): PayloadsResult;
}

/** No payload typed (an invalid one still counts as something typed). */
function isEmpty(entry: Entry | undefined): boolean {
  const s = entry?.editor.state();
  return Boolean(s?.ok && s.empty);
}

function statusOf(editor: JsonEditor): { text: string; cls: string } {
  const s = editor.state();
  if (!s.ok) return { text: 'Invalid', cls: 'badge bad' };
  return s.empty ? { text: 'No payload', cls: 'badge' } : { text: 'Payload', cls: 'badge good' };
}

export function payloadEditors(
  initial: Record<string, unknown> | undefined,
  values: string[],
): PayloadEditors {
  const entries = new Map<string, Entry>();
  let current = values;
  const list = h('div', { class: 'payload-list' });

  const paintStatus = (entry: Entry) => {
    const orphan = !current.includes(entry.value);
    const s = statusOf(entry.editor);
    entry.status.replaceChildren(
      h('span', { class: s.cls }, s.text),
      orphan ? h('span', { class: 'badge bad' }, 'Not returned any more') : '',
    );
    entry.fold.classList.toggle('orphan', orphan);
  };

  const make = (value: string, payload: unknown): Entry => {
    const status = h('span', { class: 'payload-status' });
    const entry: Entry = {
      value,
      status,
      fold: h('details', {
        class: 'payload-fold',
        open: payload !== undefined,
      }) as HTMLDetailsElement,
      editor: jsonEditor({
        emptyText: 'Empty: no payload',
        value: payload,
        label: `Payload for ${value}`,
        placeholder: 'Any JSON, e.g. {"headline": "Write faster"}',
        maxBytes: MAX_PAYLOAD_BYTES,
        validate: webPayloadProblems,
        snippets: SNIPPETS,
        onChange: () => paintStatus(entry),
      }),
    };
    entry.fold.append(h('summary', {}, h('code', {}, value), status), entry.editor.el);
    paintStatus(entry);
    return entry;
  };

  const orphanTools = (entry: Entry): HTMLElement | null => {
    if (current.includes(entry.value)) return null;
    // Only values with no payload yet, so moving never overwrites one.
    const targets = current.filter((v) => isEmpty(entries.get(v)));
    const move = h(
      'select',
      { 'aria-label': `Move the payload for ${entry.value} to` },
      h('option', { value: '' }, 'Move to…'),
      targets.map((v) => h('option', { value: v }, v)),
    );
    move.addEventListener('change', () => {
      const state = entry.editor.state();
      const target = entries.get(move.value);
      if (!target || !state.ok) return;
      target.editor.set(state.value);
      target.fold.open = true;
      entries.delete(entry.value);
      render();
    });
    const remove = h('button', { type: 'button', class: 'small ghost' }, 'Remove');
    remove.addEventListener('click', () => {
      entries.delete(entry.value);
      render();
    });
    return h(
      'div',
      { class: 'payload-orphan' },
      h('span', { class: 'muted small' }, `This flag doesn't return "${entry.value}" any more.`),
      move,
      remove,
    );
  };

  function render(): void {
    for (const v of current) if (!entries.has(v)) entries.set(v, make(v, undefined));
    // An empty editor for a value the flag no longer returns has nothing worth keeping.
    for (const e of [...entries.values()])
      if (!current.includes(e.value) && isEmpty(e)) entries.delete(e.value);
    const shown = [...entries.values()];
    list.replaceChildren(
      ...shown.map((e) => {
        paintStatus(e);
        return h('div', { class: 'payload-item' }, e.fold, orphanTools(e));
      }),
    );
  }

  for (const [value, payload] of Object.entries(initial ?? {}))
    entries.set(value, make(value, payload));
  render();

  return {
    el: list,
    sync(next) {
      current = next.length ? next : ['on'];
      render();
    },
    collect() {
      const payloads: Record<string, unknown> = {};
      for (const e of entries.values()) {
        const s = e.editor.state();
        const focus = () => {
          e.fold.open = true;
          e.editor.focus();
        };
        if (!s.ok) return { ok: false, message: `Payload for "${e.value}": ${s.message}`, focus };
        if (s.empty) continue;
        if (!current.includes(e.value))
          return {
            ok: false,
            message: `There's a payload for "${e.value}", which this flag doesn't return: move it or remove it.`,
            focus,
          };
        payloads[e.value] = s.value;
      }
      if (payloadBytes(payloads) > MAX_PAYLOAD_BYTES)
        return {
          ok: false,
          message: 'Payloads must be at most 10 KB of JSON altogether.',
          focus: () => entries.values().next().value?.editor.focus(),
        };
      return { ok: true, payloads: Object.keys(payloads).length ? payloads : null };
    },
  };
}
