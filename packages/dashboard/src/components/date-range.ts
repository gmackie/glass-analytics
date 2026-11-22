/**
 * The date range control in the top bar: presets, a custom range, and the
 * "compare to previous period" switch. The range lives in the URL (`from`,
 * `to`) so every view stays a shareable link.
 */

import { DAY_MS, resolveRange } from '@dataflare/core/time';
import { h } from '../dom.ts';
import { currentRoute, go, prefs, type Route } from '../state.ts';
import { icon } from './icons.ts';
import { popover, toggle } from './menu.ts';

export const PRESETS: { from: string; to?: string; label: string; short: string }[] = [
  { from: 'today', label: 'Today', short: 'Today' },
  { from: 'yesterday', to: 'today', label: 'Yesterday', short: 'Yesterday' },
  { from: '-24h', label: 'Last 24 hours', short: '24h' },
  { from: '-7d', label: 'Last 7 days', short: '7d' },
  { from: '-14d', label: 'Last 14 days', short: '14d' },
  { from: '-30d', label: 'Last 30 days', short: '30d' },
  { from: '-90d', label: 'Last 90 days', short: '90d' },
  { from: '-12mo', label: 'Last 12 months', short: '12mo' },
];

const UNITS: Record<string, [string, string]> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
  mo: ['month', 'months'],
  y: ['year', 'years'],
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "-14d" → "Last 14 days"; ISO pairs → "1 Oct – 15 Oct". */
export function rangeLabel(from: string, to?: string | null): string {
  const preset = PRESETS.find((p) => p.from === from && (p.to ?? null) === (to ?? null));
  if (preset) return preset.label;
  const m = /^-(\d+)(mo|m|h|d|w|y)$/.exec(from);
  if (m && !to) {
    const n = Number(m[1]);
    const [one, many] = UNITS[m[2]!]!;
    return n === 1 ? `Last ${one}` : `Last ${n} ${many}`;
  }
  try {
    const r = resolveRange(from, to ?? undefined);
    const end = to ? r.to - 1 : r.to;
    return day(r.from) === day(end) ? day(r.from) : `${day(r.from)} – ${day(end)}`;
  } catch {
    return to ? `${from} – ${to}` : `Since ${from}`;
  }
}

/** The equally long period immediately before the current one, as ISO timestamps. */
export function previousRange(
  from: string,
  to?: string | null,
): { from: string; to: string } | null {
  try {
    const r = resolveRange(from, to ?? undefined);
    return {
      from: new Date(r.from - (r.to - r.from)).toISOString(),
      to: new Date(r.from).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Number of whole days in the range (at least 1), for APIs that take `days`. */
export function rangeDays(from: string, to?: string | null): number {
  try {
    const r = resolveRange(from, to ?? undefined);
    return Math.max(1, Math.ceil((r.to - r.from) / DAY_MS));
  } catch {
    return 30;
  }
}

/**
 * Every parameter of the page as it is now (an open analysis keeps its spec in the URL), so
 * changing the dates keeps the page's own state instead of resetting it.
 */
const pageParams = () => Object.fromEntries(currentRoute().params);

export function dateRangeControl(route: Route, onCompareChange: () => void): HTMLElement {
  const from = route.params.get('from') ?? '-30d';
  const to = route.params.get('to');
  const target = [route.page, ...route.rest].join('/');
  const trigger = h(
    'button',
    { type: 'button', class: 'select-trigger date-trigger', 'aria-label': 'Date range' },
    icon('calendar'),
    h('span', { class: 'select-value' }, rangeLabel(from, to)),
    prefs.compare
      ? h('span', { class: 'compare-dot', title: 'Comparing to the previous period' })
      : null,
    icon('chevronDown', 14),
  );
  popover(
    trigger,
    (close) => {
      let start = '';
      let end = '';
      try {
        const r = resolveRange(from, to ?? undefined);
        start = isoDay(r.from);
        end = isoDay(to ? r.to - 1 : r.to);
      } catch {
        // leave empty
      }
      const fromInput = h('input', {
        type: 'date',
        value: start,
        'aria-label': 'Start date',
        max: isoDay(Date.now()),
      });
      const toInput = h('input', {
        type: 'date',
        value: end,
        'aria-label': 'End date',
        max: isoDay(Date.now()),
      });
      const apply = h('button', { type: 'submit', class: 'primary small' }, 'Apply');
      const custom = h(
        'form',
        { class: 'date-custom' },
        h('label', { class: 'field' }, h('span', {}, 'From'), fromInput),
        h('label', { class: 'field' }, h('span', {}, 'To (inclusive)'), toInput),
        apply,
      );
      custom.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!fromInput.value) return;
        const endDay = toInput.value || isoDay(Date.now());
        const exclusive = isoDay(Date.parse(endDay) + DAY_MS);
        close();
        go(target, { ...pageParams(), from: fromInput.value, to: exclusive });
      });
      return h(
        'div',
        { class: 'date-pop' },
        h(
          'div',
          { class: 'date-presets menu', role: 'listbox', 'aria-label': 'Presets' },
          PRESETS.map((p) => {
            const selected = p.from === from && (p.to ?? null) === (to ?? null);
            return h(
              'button',
              {
                type: 'button',
                role: 'option',
                class: `menu-item ${selected ? 'selected' : ''}`,
                'aria-selected': String(selected),
                onclick: () => {
                  close();
                  go(target, { ...pageParams(), from: p.from, to: p.to ?? null });
                },
              },
              h('span', { class: 'menu-label' }, p.label),
              selected ? icon('check', 14) : h('span', { class: 'menu-check-space' }),
            );
          }),
        ),
        h(
          'div',
          { class: 'date-side' },
          custom,
          h(
            'div',
            { class: 'date-compare' },
            toggle({
              checked: prefs.compare,
              label: 'Compare to previous period',
              onChange: (v) => {
                prefs.compare = v;
                close();
                onCompareChange();
              },
            }),
          ),
        ),
      );
    },
    { width: 470, align: 'end', class: 'date-popover' },
  );
  return trigger;
}
