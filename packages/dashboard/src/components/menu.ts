/**
 * Popovers, select menus, switches and modals: the controls that replace
 * native <select> and checkbox widgets in the dashboard chrome.
 */

import { type Child, h, mount } from '../dom.ts';
import { type IconName, icon } from './icons.ts';

let openPop: { el: HTMLElement; close: () => void } | null = null;

export function closePopover(): void {
  openPop?.close();
}

export interface PopoverOptions {
  align?: 'start' | 'end';
  /** Fixed width in px; default: at least the trigger's width. */
  width?: number;
  class?: string;
  onOpen?: (pop: HTMLElement) => void;
}

function place(trigger: HTMLElement, pop: HTMLElement, options: PopoverOptions): void {
  const r = trigger.getBoundingClientRect();
  const width = Math.min(options.width ?? Math.max(r.width, 200), window.innerWidth - 24);
  pop.style.width = `${width}px`;
  let left = options.align === 'end' ? r.right - width : r.left;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  const height = pop.offsetHeight || 300;
  let top = r.bottom + 6;
  if (top + height > window.innerHeight - 12 && r.top - height - 6 > 12) top = r.top - height - 6;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/** Attach a popover to `trigger`; `render(close)` builds its contents each time it opens. */
export function popover(
  trigger: HTMLElement,
  render: (close: () => void) => Child,
  options: PopoverOptions = {},
): void {
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  const open = () => {
    closePopover();
    const pop = h('div', { class: `pop ${options.class ?? ''}`, role: 'dialog' });
    const close = () => {
      pop.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('open');
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('hashchange', close);
      if (openPop?.el === pop) openPop = null;
    };
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!pop.contains(t) && !trigger.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        trigger.focus();
      }
    };
    const reposition = () => place(trigger, pop, options);
    mount(pop, render(close));
    document.body.appendChild(pop);
    place(trigger, pop, options);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('open');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('hashchange', close, { once: true });
    openPop = { el: pop, close };
    options.onOpen?.(pop);
  };
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    if (trigger.classList.contains('open')) closePopover();
    else open();
  });
}

/** Arrow-key navigation over the focusable items of a list. */
export function listKeys(list: HTMLElement, selector = '.menu-item'): void {
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll<HTMLElement>(selector)];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  });
}

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: IconName;
}

export interface SelectMenuOptions<T extends string> {
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  label: string;
  /** Icon shown before the current value. */
  icon?: IconName;
  class?: string;
  width?: number;
  align?: 'start' | 'end';
  /** Text shown when the value is not among the options. */
  fallback?: string;
}

/** A button that opens a list of options: a styled replacement for <select>. */
export function selectMenu<T extends string>(o: SelectMenuOptions<T>): HTMLButtonElement {
  const current = o.options.find((x) => x.value === o.value);
  const trigger = h(
    'button',
    {
      type: 'button',
      class: `select-trigger ${o.class ?? ''}`,
      'aria-label': o.label,
      title: o.label,
    },
    o.icon ? icon(o.icon) : current?.icon ? icon(current.icon) : null,
    h('span', { class: 'select-value' }, current?.label ?? o.fallback ?? o.value),
    icon('chevronDown', 14),
  );
  popover(
    trigger,
    (close) => {
      const list = h(
        'div',
        { class: 'menu', role: 'listbox', 'aria-label': o.label },
        o.options.map((opt) =>
          h(
            'button',
            {
              type: 'button',
              role: 'option',
              class: `menu-item ${opt.value === o.value ? 'selected' : ''}`,
              'aria-selected': String(opt.value === o.value),
              onclick: () => {
                close();
                if (opt.value !== o.value) o.onChange(opt.value);
              },
            },
            opt.icon ? icon(opt.icon) : null,
            h('span', { class: 'menu-label' }, opt.label),
            opt.hint ? h('span', { class: 'menu-hint' }, opt.hint) : null,
            opt.value === o.value ? icon('check', 14) : h('span', { class: 'menu-check-space' }),
          ),
        ),
      );
      listKeys(list);
      return list;
    },
    {
      width: o.width,
      align: o.align,
      onOpen: (pop) =>
        (
          pop.querySelector<HTMLElement>('.menu-item.selected') ??
          pop.querySelector<HTMLElement>('.menu-item')
        )?.focus(),
    },
  );
  return trigger;
}

export interface ToggleOptions {
  checked: boolean;
  label: Child;
  onChange: (checked: boolean) => void;
  title?: string;
  class?: string;
}

/** An on/off switch. The real checkbox stays in the DOM for forms, tests and screen readers. */
export function toggle(o: ToggleOptions): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: o.checked });
  input.addEventListener('change', () => o.onChange(input.checked));
  return h(
    'label',
    { class: `toggle ${o.class ?? ''}`, title: o.title ?? null },
    input,
    h(
      'span',
      { class: 'toggle-track', 'aria-hidden': 'true' },
      h('span', { class: 'toggle-thumb' }),
    ),
    h('span', { class: 'toggle-label' }, o.label),
  );
}

export interface ModalOptions {
  title: string;
  body: Child;
  actions?: Child;
  onClose?: () => void;
  width?: number;
}

/** A centred dialog over a dimmed page. Returns a function that closes it. */
export function modal(o: ModalOptions): () => void {
  closePopover();
  const dialog = h(
    'div',
    {
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': o.title,
      style: o.width ? `max-width:${o.width}px` : null,
    },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', {}, o.title),
      h(
        'button',
        { type: 'button', class: 'icon-button', 'aria-label': 'Close', onclick: () => close() },
        icon('x'),
      ),
    ),
    h('div', { class: 'modal-body' }, o.body),
    o.actions ? h('footer', { class: 'modal-foot' }, o.actions) : null,
  );
  const overlay = h('div', { class: 'modal-overlay' }, dialog);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    window.removeEventListener('glass:unauthorized', close);
    o.onClose?.();
  }
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close, { once: true });
  window.addEventListener('glass:unauthorized', close, { once: true });
  document.body.appendChild(overlay);
  requestAnimationFrame(() =>
    dialog.querySelector<HTMLElement>('input, textarea, button.primary')?.focus(),
  );
  return close;
}
