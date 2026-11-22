/**
 * Shared building blocks: panels (with their SQL pane), buttons, states.
 *
 * Every panel that shows a number can show the SQL that produced it. With
 * "Show SQL" on (top bar, or press "s"), the queries appear under each panel.
 */

import { STAGE_NOTES, type Stage } from '@dataflare/core/stages';
import { ApiError } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { type IconName, icon } from './icons.ts';

export interface PanelOptions {
  /** Queries behind this panel, shown in the SQL pane. */
  sql?: string[];
  /** Extra controls in the panel header. */
  actions?: Child;
  class?: string;
  /** Small muted line under the title. */
  subtitle?: Child;
  icon?: IconName;
}

export function panel(title: string, body: Child, options: PanelOptions = {}): HTMLElement {
  return h(
    'section',
    { class: `panel ${options.class ?? ''}` },
    title || options.actions
      ? h(
          'header',
          { class: 'panel-head' },
          h(
            'div',
            { class: 'panel-title' },
            options.icon ? h('span', { class: 'panel-icon' }, icon(options.icon)) : null,
            h(
              'div',
              {},
              title ? h('h2', {}, title) : null,
              options.subtitle ? h('p', { class: 'panel-subtitle' }, options.subtitle) : null,
            ),
          ),
          options.actions ? h('div', { class: 'panel-actions' }, options.actions) : null,
        )
      : null,
    h('div', { class: 'panel-body' }, body),
    options.sql?.length ? sqlPane(options.sql) : null,
  );
}

export function sqlPane(queries: string[]): HTMLElement {
  return h(
    'div',
    { class: 'sql-pane' },
    h(
      'div',
      { class: 'sql-pane-head' },
      h('span', {}, icon('code', 14), queries.length === 1 ? 'Query' : `${queries.length} queries`),
      copyButton(queries.join(';\n\n'), 'Copy SQL'),
    ),
    ...queries.map((q) => h('pre', { class: 'sql' }, h('code', {}, q.trim()))),
  );
}

export function copyButton(
  text: string | (() => string),
  label = 'Copy',
  iconName: IconName = 'copy',
): HTMLButtonElement {
  const text_ = h('span', {}, label);
  const button = h('button', { class: 'ghost small', type: 'button' }, icon(iconName, 14), text_);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      text_.textContent = 'Copied';
      button.classList.add('copied');
    } catch {
      text_.textContent = 'Copy failed';
    }
    setTimeout(() => {
      text_.textContent = label;
      button.classList.remove('copied');
    }, 1500);
  });
  return button;
}

export type SkeletonShape = 'block' | 'kpis' | 'chart' | 'table' | 'cards' | 'report';

function bar(width: string, height = 12): HTMLElement {
  return h('span', { class: 'sk', style: `width:${width};height:${height}px` });
}

/** Grey shimmering placeholders shaped like the content that is loading. */
export function skeleton(shape: SkeletonShape = 'block'): HTMLElement {
  const kpis = () =>
    h(
      'div',
      { class: 'sk-kpis' },
      Array.from({ length: 4 }, () =>
        h('div', { class: 'sk-kpi' }, bar('45%', 10), bar('70%', 22)),
      ),
    );
  const chart = () =>
    h(
      'div',
      { class: 'sk-panel' },
      bar('22%', 12),
      h(
        'div',
        { class: 'sk-chart' },
        Array.from({ length: 18 }, (_, i) =>
          h('span', {
            class: 'sk',
            style: `height:${30 + Math.round(45 * Math.abs(Math.sin(i * 0.7)))}%`,
          }),
        ),
      ),
    );
  const tableRows = () =>
    h(
      'div',
      { class: 'sk-panel' },
      bar('18%', 12),
      Array.from({ length: 6 }, (_, i) =>
        h('div', { class: 'sk-row' }, bar(`${55 - i * 5}%`), bar('10%')),
      ),
    );
  let body: Child;
  switch (shape) {
    case 'kpis':
      body = kpis();
      break;
    case 'chart':
      body = chart();
      break;
    case 'table':
      body = tableRows();
      break;
    case 'cards':
      body = h(
        'div',
        { class: 'sk-cards' },
        Array.from({ length: 6 }, () =>
          h(
            'div',
            { class: 'sk-panel' },
            bar('60%', 14),
            bar('90%'),
            bar('40%'),
            h('div', { class: 'sk-spark' }),
          ),
        ),
      );
      break;
    case 'report':
      body = [kpis(), chart(), h('div', { class: 'sk-grid' }, tableRows(), tableRows())];
      break;
    default:
      body = h('div', { class: 'sk-panel' }, bar('30%', 14), bar('90%'), bar('75%'), bar('60%'));
  }
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, body);
}

export function loading(label = 'Loading', shape: SkeletonShape = 'block'): HTMLElement {
  return h(
    'div',
    { class: 'state loading', role: 'status' },
    h('span', { class: 'visually-hidden' }, label),
    skeleton(shape),
  );
}

export interface EmptyOptions {
  icon?: IconName;
  title?: string;
}

export function empty(message: string, action?: Child, options: EmptyOptions = {}): HTMLElement {
  return h(
    'div',
    { class: 'state empty' },
    h('span', { class: 'empty-icon' }, icon(options.icon ?? 'inbox', 22)),
    options.title ? h('h3', {}, options.title) : null,
    h('p', {}, message),
    action ? h('div', { class: 'empty-actions' }, action) : null,
  );
}

export function errorState(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof ApiError ? err.hint : undefined;
  return h(
    'div',
    { class: 'state error', role: 'alert' },
    h('span', { class: 'error-icon' }, icon('alert', 18)),
    h('div', {}, h('p', {}, message), hint ? h('p', { class: 'hint' }, hint) : null),
  );
}

/** Render a page section asynchronously: shows a skeleton, then the result or an error. */
export function later(
  render: () => Promise<Child>,
  label?: string,
  shape: SkeletonShape = 'block',
): HTMLElement {
  const holder = h('div', { class: 'later' }, loading(label, shape));
  render().then(
    (content) => {
      mount(holder, content);
      holder.classList.add('ready');
    },
    (err: unknown) => mount(holder, errorState(err)),
  );
  return holder;
}

export function pageHeader(title: string, description?: string, actions?: Child): HTMLElement {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-title' },
      h('h1', {}, title),
      description ? h('p', { class: 'muted' }, description) : null,
    ),
    actions ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function table(
  headers: string[],
  rows: Child[][],
  options: { numeric?: number[]; class?: string } = {},
): HTMLElement {
  const numeric = new Set(options.numeric ?? []);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: options.class ?? '' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          headers.map((x, i) => h('th', { class: numeric.has(i) ? 'num' : '' }, x)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            r.map((cell, i) => h('td', { class: numeric.has(i) ? 'num' : '' }, cell)),
          ),
        ),
      ),
    ),
  );
}

/** A segmented control for switching between a few views of the same data. */
export function tabs<T extends string>(
  options: { value: T; label: string; icon?: IconName }[],
  selected: T,
  onSelect: (value: T) => void,
  className = '',
): HTMLElement {
  return h(
    'div',
    { class: `tabs ${className}`, role: 'tablist' },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(o.value === selected),
          class: o.value === selected ? 'tab active' : 'tab',
          onclick: () => onSelect(o.value),
        },
        o.icon ? icon(o.icon, 14) : null,
        o.label,
      ),
    ),
  );
}

/** A small button with an icon and optional text. */
export function iconButton(
  name: IconName,
  label: string,
  onClick: () => void,
  options: { text?: boolean; class?: string } = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: `${options.text ? 'ghost small' : 'icon-button'} ${options.class ?? ''}`,
      'aria-label': label,
      title: label,
      onclick: onClick,
    },
    icon(name, options.text ? 14 : 16),
    options.text ? label : null,
  );
}

/** A short message at the bottom of the screen, with an optional action such as Undo. */
export function toast(
  message: string,
  kind: 'ok' | 'error' = 'ok',
  action?: { label: string; run: () => void },
): void {
  for (const old of document.querySelectorAll('.toast')) old.remove();
  const el = h(
    'div',
    { class: `toast ${kind}`, role: 'status' },
    icon(kind === 'ok' ? 'check' : 'alert', 16),
    message,
    action
      ? h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: () => {
              el.remove();
              action.run();
            },
          },
          action.label,
        )
      : null,
  );
  document.body.appendChild(el);
  // A toast with an action stays long enough to use it.
  const stay = action ? 6000 : 2800;
  setTimeout(() => el.classList.add('leaving'), stay);
  setTimeout(() => el.remove(), stay + 400);
}

/** An initials avatar with a stable colour. */
export function avatar(
  text: string,
  initialsText: string,
  hueValue: number,
  size = 28,
): HTMLElement {
  return h(
    'span',
    {
      class: 'avatar',
      style: `--hue:${hueValue};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`,
      'aria-hidden': 'true',
      title: text,
    },
    initialsText,
  );
}

/** A small "Alpha" or "Beta" pill for a feature that isn't stable yet (see core/stages.ts). */
export function stagePill(stage: Exclude<Stage, 'stable'>): HTMLElement {
  return h(
    'span',
    { class: `stage-pill stage-${stage}`, title: STAGE_NOTES[stage] },
    stage === 'alpha' ? 'Alpha' : 'Beta',
  );
}

/**
 * The stage note for a feature, as a banner the reader can dismiss (remembered in this browser).
 * `key` names the banner, so dismissing one doesn't hide another.
 */
export function stageBanner(stage: Exclude<Stage, 'stable'>, key: string): HTMLElement | null {
  const storageKey = `glass.stage-banner.${key}`;
  try {
    if (localStorage.getItem(storageKey)) return null;
  } catch {
    // No storage (private mode, blocked): show the banner every time.
  }
  const banner = h(
    'div',
    { class: 'stage-banner', role: 'note' },
    stagePill(stage),
    h('span', {}, STAGE_NOTES[stage].replace(/^\w+: /, '')),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': 'Dismiss',
        title: 'Dismiss',
        onclick: () => {
          banner.remove();
          try {
            localStorage.setItem(storageKey, '1');
          } catch {
            // Nothing to remember it in; it is gone for this visit.
          }
        },
      },
      icon('x', 14),
    ),
  );
  return banner;
}
