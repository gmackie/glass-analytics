/**
 * Building blocks of the insight query rail, shared by the trends, funnel and retention
 * rails: section headings, series letters, a menu on each card, drag (or Alt+arrow) to
 * reorder, breakdowns, "Count by", and the internal traffic chip.
 */

import { loadEventDetail, loadPersonProperties, loadPropertyValues } from '../catalog.ts';
import { type Child, h, mount } from '../dom.ts';
import { SERIES } from './charts.ts';
import type { FilterRow } from './filter-editor.ts';
import type { AdvancedOption } from './fold.ts';
import { type IconName, icon } from './icons.ts';
import { knownGroupTypes } from './insight-options.ts';
import { popover, selectMenu } from './menu.ts';
import { propertyPicker } from './picker.ts';
import { iconButton } from './ui.ts';

export type Spec = Record<string, unknown>;

export type SeriesSpec = {
  event: string;
  math?: string;
  property?: string;
  groupType?: string;
  filters?: FilterRow[];
  label?: string;
};

export type StepSpec = { event: string; filters?: FilterRow[]; label?: string; optional?: boolean };

export const letter = (i: number) => String.fromCharCode(65 + (i % 26));

export function seriesTag(i: number): HTMLElement {
  return h('span', { class: 'series-tag', style: `--tag:${SERIES[i % SERIES.length]}` }, letter(i));
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'rail-section' }, h('div', { class: 'rail-label' }, title), ...children);
}

export function addButton(
  label: string,
  onClick: () => void,
  iconName: IconName = 'plus',
): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'link-button add-button', onclick: onClick },
    icon(iconName, 14),
    label,
  );
}

export function readBreakdowns(spec: Spec): string[] {
  const b = spec.breakdown;
  if (Array.isArray(b)) return b.filter((x): x is string => typeof x === 'string');
  if (typeof b === 'string' && b) return [b];
  return [];
}

function writeBreakdowns(spec: Spec, values: string[]): void {
  if (values.length === 0) delete spec.breakdown;
  else spec.breakdown = values;
}

export function ensureFilters(target: { filters?: FilterRow[] }): FilterRow[] {
  target.filters ??= [];
  return target.filters;
}

/** Remove `key` when the value is the default (or nothing), so specs stay short. */
export function setOption(spec: Spec, key: string, value: unknown, fallback?: unknown): void {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === false ||
    value === fallback
  )
    delete spec[key];
  else spec[key] = value;
}

// ── Card menu and reordering ────────────────────────────────────────────────

export interface CardAction {
  label: string;
  icon?: IconName;
  run: () => void;
  danger?: boolean;
}

/** The ⋯ menu on a series or step card. */
export function cardMenu(label: string, actions: (CardAction | null)[]): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button', class: 'icon-button card-menu', 'aria-label': label, title: label },
    icon('more', 15),
  );
  popover(
    trigger,
    (close) =>
      h(
        'div',
        { class: 'menu' },
        actions
          .filter((a): a is CardAction => a !== null)
          .map((a) =>
            h(
              'button',
              {
                type: 'button',
                class: `menu-item ${a.danger ? 'danger' : ''}`,
                onclick: () => {
                  close();
                  a.run();
                },
              },
              a.icon ? icon(a.icon, 14) : null,
              a.label,
            ),
          ),
      ),
    { align: 'end', width: 200 },
  );
  return trigger;
}

/** Move `list[from]` to `to` (both in range). */
function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
}

/** Up, down, duplicate and remove, for a card at `i` of `list`. */
export function cardActions<T>(
  list: T[],
  i: number,
  update: () => void,
  options: { noun: string; min: number; onRemove?: (item: T) => void },
): (CardAction | null)[] {
  return [
    i > 0
      ? { label: 'Move up', icon: 'arrowUp', run: () => (move(list, i, i - 1), update()) }
      : null,
    i < list.length - 1
      ? { label: 'Move down', icon: 'arrowDown', run: () => (move(list, i, i + 1), update()) }
      : null,
    {
      label: `Duplicate ${options.noun}`,
      icon: 'copy',
      run: () => {
        list.splice(i + 1, 0, structuredClone(list[i]!));
        update();
      },
    },
    list.length > options.min
      ? {
          label: `Remove ${options.noun}`,
          icon: 'trash',
          danger: true,
          run: () => {
            const [removed] = list.splice(i, 1);
            update();
            options.onRemove?.(removed!);
          },
        }
      : null,
  ];
}

let dragging: { list: unknown[]; from: number } | null = null;

/** Drag a card by its handle to reorder `list`, or press Alt+↑/↓ on the card. */
export function reorderable(
  card: HTMLElement,
  list: unknown[],
  i: number,
  update: () => void,
): HTMLElement {
  const handle = h(
    'span',
    {
      class: 'drag-handle',
      draggable: 'true',
      title: 'Drag to reorder (or Alt+↑/↓)',
      'aria-hidden': 'true',
    },
    icon('grip', 14),
  );
  handle.addEventListener('dragstart', (e) => {
    dragging = { list, from: i };
    e.dataTransfer?.setData('text/plain', String(i));
    card.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', (e) => {
    if (dragging?.list !== list) return;
    e.preventDefault();
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drop-target');
    if (dragging?.list === list) move(list, dragging.from, i);
    dragging = null;
    update();
  });
  card.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(list, i, e.key === 'ArrowUp' ? i - 1 : i + 1);
    update();
  });
  return handle;
}

// ── Breakdowns ──────────────────────────────────────────────────────────────

/** Show `build()` once the catalog says `property` holds numbers (props.* or person.*). */
function numericOnly(
  property: string,
  event: string | undefined,
  project: string | undefined,
  build: () => HTMLElement,
): HTMLElement {
  const holder = h('div', { class: 'row' });
  const name = property.replace(/^(props|person)\./, '');
  let source: Promise<{ name: string; types?: string[] }[]> = Promise.resolve([]);
  if (property.startsWith('person.')) source = loadPersonProperties(project);
  else if (property.startsWith('props.') && event)
    source = loadEventDetail(event, project).then((d) => d.properties);
  void source.then((props) => {
    const types = props.find((p) => p.name === name)?.types ?? [];
    if (types.length && types.every((t) => t === 'number' || t === 'null')) mount(holder, build());
  });
  return holder;
}

/** Saved cohorts to compare, as toggles. */
function cohortChooser(spec: Spec, project: string | undefined, update: () => void): HTMLElement {
  const holder = h(
    'div',
    { class: 'chip-list cohort-chooser' },
    h('span', { class: 'muted small' }, 'Loading cohorts…'),
  );
  const chosen = new Set((spec.breakdownCohorts as string[] | undefined) ?? []);
  const toggleCohort = (value: string) => {
    if (chosen.has(value)) chosen.delete(value);
    else chosen.add(value);
    setOption(spec, 'breakdownCohorts', chosen.size ? [...chosen] : undefined);
    update();
  };
  void loadPropertyValues('cohort', { project }).then((cohorts) =>
    mount(
      holder,
      cohorts.length
        ? cohorts.map((c) =>
            h(
              'button',
              {
                type: 'button',
                class: 'chip-toggle',
                'aria-pressed': String(chosen.has(c.value)),
                onclick: () => toggleCohort(c.value),
              },
              c.label,
            ),
          )
        : h('span', { class: 'muted small' }, 'No saved cohorts yet: make one on the People page.'),
    ),
  );
  return holder;
}

/** Breakdowns after one is changed or removed: cohorts stand alone, ranges need one property. */
function setBreakdowns(spec: Spec, next: string[]): void {
  writeBreakdowns(spec, next);
  if (!next.includes('cohort')) delete spec.breakdownCohorts;
  if (next.length !== 1) delete spec.breakdownBins;
}

function breakdownRow(spec: Spec, i: number, ctx: BreakdownContext): HTMLElement {
  const value = readBreakdowns(spec)[i] ?? '';
  return h(
    'div',
    { class: 'breakdown-row' },
    propertyPicker({
      value,
      event: ctx.event,
      project: ctx.project,
      cohorts: true,
      placeholder: i === 0 ? 'browser, utm_source, plan…' : 'Add another property',
      onChange: (v) => {
        // Cohorts are compared on their own, not combined with properties.
        const next = readBreakdowns(spec);
        if (v === 'cohort') next.splice(0, next.length, 'cohort');
        else if (v) next[i] = v;
        else next.splice(i, 1);
        setBreakdowns(spec, next);
        ctx.update();
      },
    }),
    iconButton('x', 'Remove breakdown', () => {
      const next = readBreakdowns(spec);
      next.splice(i, 1);
      setBreakdowns(spec, next);
      ctx.update();
    }),
  );
}

const BIN_OPTIONS = [
  { value: '', label: 'One line per value' },
  { value: '5', label: 'Numbers in 5 ranges' },
  { value: '10', label: 'Numbers in 10 ranges' },
  { value: '20', label: 'Numbers in 20 ranges' },
];

interface BreakdownContext {
  event: string | undefined;
  project: string | undefined;
  update: () => void;
  /** Numeric ranges (trends and funnels; retention breaks down by value only). */
  bins: boolean;
}

export function breakdownEditor(spec: Spec, ctx: BreakdownContext): HTMLElement {
  const values = readBreakdowns(spec);
  const byCohort = values.includes('cohort');
  const single = values.length === 1 && values[0] && !byCohort;
  return h(
    'div',
    { class: 'breakdown-editor' },
    values.map((_, i) => breakdownRow(spec, i, ctx)),
    byCohort ? cohortChooser(spec, ctx.project, ctx.update) : null,
    single && ctx.bins
      ? numericOnly(values[0]!, ctx.event, ctx.project, () =>
          selectMenu({
            value: String(spec.breakdownBins ?? ''),
            label: 'Numeric ranges',
            options: BIN_OPTIONS,
            width: 220,
            onChange: (v) => {
              setOption(spec, 'breakdownBins', v ? Number(v) : undefined);
              ctx.update();
            },
          }),
        )
      : null,
    values.length < 4 && !byCohort
      ? addButton(values.length ? 'Add another' : 'Add breakdown', () => {
          writeBreakdowns(spec, [...values, '']);
          ctx.update();
        })
      : null,
    values.length > 1
      ? h('p', { class: 'muted small' }, 'Values are combined with “ · ”, e.g. Chrome · google.')
      : null,
  );
}

// ── Shared options ──────────────────────────────────────────────────────────

/** Leave out the project's internal and test traffic: a chip that toggles, next to the filters. */
export function internalTrafficChip(spec: Spec, update: () => void): HTMLElement {
  const on = Boolean(spec.filterTestAccounts);
  return h(
    'button',
    {
      type: 'button',
      class: 'chip-toggle traffic-chip',
      'aria-pressed': String(on),
      title: 'Uses the internal traffic filters in Settings',
      onclick: () => {
        setOption(spec, 'filterTestAccounts', !on);
        update();
      },
    },
    icon(on ? 'check' : 'filter', 12),
    on ? 'Internal traffic hidden' : 'Hide internal traffic',
  );
}

const countedBy = (spec: Spec) => String(spec.aggregateBy ?? 'person');

/** People, sessions or a group type: what every number counts. */
export function countByOption(project: string | undefined): AdvancedOption {
  return {
    key: 'aggregateBy',
    isSet: (spec) => countedBy(spec) !== 'person',
    chip: (spec) =>
      countedBy(spec) === 'session' ? 'Counting sessions' : `Counting ${countedBy(spec)} groups`,
    clear: (spec) => delete spec.aggregateBy,
    render: (spec, update) =>
      h(
        'div',
        { class: 'option-group' },
        h('div', { class: 'option-label' }, 'Count by'),
        selectMenu({
          value: countedBy(spec),
          label: 'What to count',
          options: [
            { value: 'person', label: 'People' },
            { value: 'session', label: 'Sessions' },
            ...knownGroupTypes(project, update).map((t) => ({ value: t, label: `${t} (group)` })),
          ],
          fallback: countedBy(spec),
          width: 200,
          onChange: (v) => {
            setOption(spec, 'aggregateBy', v, 'person');
            update();
          },
        }),
      ),
  };
}

/** A required control with nothing chosen yet: marked so "Almost there" can point at it. */
export function needsInput(el: HTMLElement, missing: boolean): HTMLElement {
  if (missing) el.dataset.needsInput = 'true';
  return el;
}
