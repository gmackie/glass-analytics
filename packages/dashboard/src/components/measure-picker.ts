/**
 * The measure picker for a trends series: every math, grouped by what it counts, each with a
 * line saying what it means, the common ones first, and a search box.
 */

import { h } from '../dom.ts';
import { icon } from './icons.ts';
import { listKeys, popover } from './menu.ts';

interface Measure {
  value: string;
  label: string;
  hint: string;
}

const MEASURE_GROUPS: { title: string; measures: Measure[] }[] = [
  {
    title: 'Common',
    measures: [
      { value: 'total', label: 'Total count', hint: 'Every time it happened' },
      { value: 'unique_persons', label: 'Unique people', hint: 'Each person once per interval' },
      { value: 'unique_sessions', label: 'Unique sessions', hint: 'Each visit once per interval' },
      {
        value: 'wau',
        label: 'Weekly active',
        hint: 'People active in the 7 days up to each point',
      },
    ],
  },
  {
    title: 'Active and new',
    measures: [
      { value: 'dau', label: 'Daily active', hint: 'People active on each day' },
      {
        value: 'mau',
        label: 'Monthly active',
        hint: 'People active in the 30 days up to each point',
      },
      {
        value: 'first_time',
        label: 'First time ever',
        hint: 'People doing it for the very first time',
      },
      { value: 'unique_groups', label: 'Unique groups', hint: 'Companies, workspaces… once each' },
    ],
  },
  {
    title: 'A property’s value',
    measures: [
      { value: 'sum', label: 'Sum', hint: 'Add up a number, e.g. order value' },
      { value: 'avg', label: 'Average', hint: 'The mean of a number' },
      { value: 'median', label: 'Median', hint: 'The middle value' },
      { value: 'min', label: 'Minimum', hint: 'The smallest value' },
      { value: 'max', label: 'Maximum', hint: 'The largest value' },
      { value: 'p75', label: '75th percentile', hint: '3 in 4 values are below it' },
      { value: 'p90', label: '90th percentile', hint: '9 in 10 values are below it' },
      { value: 'p95', label: '95th percentile', hint: '19 in 20 values are below it' },
      { value: 'p99', label: '99th percentile', hint: 'The slowest or largest 1%' },
    ],
  },
  {
    title: 'Times per person',
    measures: [
      {
        value: 'avg_count_per_actor',
        label: 'Average per person',
        hint: 'How often a typical person does it',
      },
      { value: 'median_count_per_actor', label: 'Median per person', hint: 'The middle person' },
      { value: 'min_count_per_actor', label: 'Fewest per person', hint: 'The least anyone did it' },
      { value: 'max_count_per_actor', label: 'Most per person', hint: 'Your heaviest user' },
      { value: 'p90_count_per_actor', label: '90th percentile per person', hint: 'Power users' },
      { value: 'p99_count_per_actor', label: '99th percentile per person', hint: 'The top 1%' },
    ],
  },
  {
    title: 'Revenue',
    measures: [
      { value: 'revenue', label: 'Revenue', hint: 'Your revenue events, in your currency' },
    ],
  },
];

const ALL = MEASURE_GROUPS.flatMap((g) => g.measures);

/** The label of a math value, e.g. "Unique people". */
export function measureLabel(value: string): string {
  return ALL.find((m) => m.value === value)?.label ?? value;
}

function list(current: string, query: string, pick: (v: string) => void): HTMLElement {
  const q = query.trim().toLowerCase();
  const matches = (m: Measure) => !q || `${m.label} ${m.hint} ${m.value}`.toLowerCase().includes(q);
  const groups = MEASURE_GROUPS.map((g) => ({ ...g, measures: g.measures.filter(matches) })).filter(
    (g) => g.measures.length,
  );
  if (!groups.length) return h('p', { class: 'muted small picker-empty' }, 'Nothing matches.');
  return h(
    'div',
    { class: 'measure-list', role: 'listbox' },
    groups.map((g) => [
      h('div', { class: 'picker-group-label' }, g.title),
      g.measures.map((m) =>
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            'aria-selected': String(m.value === current),
            class: `menu-item menu-item-rich ${m.value === current ? 'selected' : ''}`,
            onclick: () => pick(m.value),
          },
          h(
            'span',
            { class: 'menu-rich-text' },
            h('strong', {}, m.label),
            h('span', { class: 'muted small' }, m.hint),
          ),
        ),
      ),
    ]),
  );
}

/** A button showing the current measure that opens the grouped, searchable list. */
export function measurePicker(options: {
  value: string;
  onChange: (value: string) => void;
}): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button', class: 'select-trigger measure-trigger', 'aria-label': 'Measure' },
    h('span', { class: 'select-value' }, measureLabel(options.value)),
    icon('chevronDown', 14),
  );
  popover(
    trigger,
    (close) => {
      const search = h('input', {
        type: 'search',
        placeholder: 'Search measures',
        'aria-label': 'Search measures',
      });
      const holder = h('div', {});
      const pick = (v: string) => {
        close();
        if (v !== options.value) options.onChange(v);
      };
      const paint = () => holder.replaceChildren(list(options.value, search.value, pick));
      listKeys(holder);
      search.addEventListener('input', paint);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') holder.querySelector<HTMLElement>('.menu-item')?.focus();
        if (e.key === 'Enter') {
          e.preventDefault();
          holder.querySelector<HTMLElement>('.menu-item')?.click();
        }
      });
      paint();
      queueMicrotask(() => search.focus());
      return h('div', { class: 'measure-pop' }, search, holder);
    },
    { width: 320 },
  );
  return trigger;
}
