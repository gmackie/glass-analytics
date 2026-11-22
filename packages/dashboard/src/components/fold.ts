/**
 * Progressive disclosure for the insight rail: advanced options live in a "More options"
 * fold, closed by default. Each option is declared as data, so the fold can show a chip for
 * every option that isn't at its default while it's closed: a hidden setting that changes the
 * result is always visible, and one click clears it.
 */

import { type Child, h } from '../dom.ts';
import { icon } from './icons.ts';

type Spec = Record<string, unknown>;

export interface AdvancedOption {
  key: string;
  /** Whether the option applies to this spec at all (e.g. attribution needs a breakdown). */
  applies?: (spec: Spec) => boolean;
  /** True when the option is set to something other than its default. */
  isSet: (spec: Spec) => boolean;
  /** The chip shown while the fold is closed, e.g. "Per session". */
  chip: (spec: Spec) => string;
  /** Back to the default. */
  clear: (spec: Spec) => void;
  /** The control, shown while the fold is open. */
  render: (spec: Spec, update: () => void) => Child;
}

const remembered = (id: string): boolean => {
  try {
    return localStorage.getItem(`glass.fold.${id}`) === 'open';
  } catch {
    return false;
  }
};

const remember = (id: string, open: boolean): void => {
  try {
    if (open) localStorage.setItem(`glass.fold.${id}`, 'open');
    else localStorage.removeItem(`glass.fold.${id}`);
  } catch {
    // No storage: the fold just starts closed next time.
  }
};

function chip(label: string, onClear: () => void): HTMLElement {
  return h(
    'span',
    { class: 'setting-chip' },
    label,
    h(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': `Clear ${label}`,
        title: 'Back to the default',
        onclick: (e: Event) => {
          // Inside <summary>: don't toggle the fold.
          e.preventDefault();
          e.stopPropagation();
          onClear();
        },
      },
      icon('x', 11),
    ),
  );
}

/** A "More options" fold for one kind's advanced options; `id` remembers whether it's open. */
export function moreOptions(
  id: string,
  spec: Spec,
  options: AdvancedOption[],
  update: () => void,
): HTMLElement | null {
  const applicable = options.filter((o) => o.applies?.(spec) ?? true);
  if (!applicable.length) return null;
  const set = applicable.filter((o) => o.isSet(spec));
  const fold = h('details', { class: 'fold', open: remembered(id) }) as HTMLDetailsElement;
  fold.addEventListener('toggle', () => remember(id, fold.open));
  fold.append(
    h(
      'summary',
      {},
      h(
        'span',
        { class: 'fold-title' },
        icon('chevronRight', 14),
        'More options',
        set.length ? h('span', { class: 'fold-count' }, String(set.length)) : null,
      ),
      set.length
        ? h(
            'span',
            { class: 'fold-chips' },
            set.map((o) =>
              chip(o.chip(spec), () => {
                o.clear(spec);
                update();
              }),
            ),
          )
        : null,
    ),
    h(
      'div',
      { class: 'fold-body' },
      applicable.map((o) => o.render(spec, update)),
    ),
  );
  return fold;
}

/** A labelled group inside the fold (or anywhere in the rail). */
export function optionGroup(title: string, ...children: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'option-group' },
    h('div', { class: 'option-label' }, title),
    ...children,
  );
}
