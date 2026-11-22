/**
 * The funnel query rail. Always shown: the steps, the conversion window, filters and the
 * breakdown. Step order, exclusions, where a breakdown value comes from and what to count
 * are in "More options".
 */

import { h } from '../dom.ts';
import { type FilterRow, filterEditor } from './filter-editor.ts';
import { type AdvancedOption, moreOptions, optionGroup } from './fold.ts';
import {
  addButton,
  breakdownEditor,
  cardActions,
  cardMenu,
  countByOption,
  ensureFilters,
  internalTrafficChip,
  needsInput,
  readBreakdowns,
  reorderable,
  type Spec,
  type StepSpec,
  section,
  setOption,
} from './insight-rail.ts';
import { selectMenu } from './menu.ts';
import { eventPicker } from './picker.ts';
import type { RailContext } from './trends-rail.ts';
import { iconButton, tabs, toast } from './ui.ts';

type Exclusion = { event: string; filters?: FilterRow[]; fromStep: number; toStep: number };

const WINDOWS = ['1h', '1d', '3d', '7d', '14d', '30d', '90d'].map((w) => ({
  value: w,
  label: w
    .replace(/^(\d+)h$/, '$1 hour')
    .replace(/^1d$/, '1 day')
    .replace(/^(\d+)d$/, '$1 days'),
}));

const ORDER_LABEL: Record<string, string> = {
  strict: 'Strict order',
  unordered: 'Any order',
};

/** Middle steps may be skipped, unless the order doesn't matter. */
const canBeOptional = (spec: Spec, i: number, n: number) =>
  i > 0 && i < n - 1 && spec.order !== 'unordered';

function stepCard(spec: Spec, steps: StepSpec[], i: number, ctx: RailContext): HTMLElement {
  const step = steps[i]!;
  ensureFilters(step);
  const card = h('li', { class: 'query-card step-card' });
  const optional = canBeOptional(spec, i, steps.length)
    ? {
        label: step.optional ? 'Make it required' : 'Make it optional',
        run: () => {
          setOption(step as Spec, 'optional', !step.optional);
          ctx.update();
        },
      }
    : null;
  card.append(
    h(
      'div',
      { class: 'query-card-head' },
      reorderable(card, steps, i, ctx.update),
      h('span', { class: 'funnel-step-index' }, String(i + 1)),
      needsInput(
        eventPicker({
          value: step.event,
          project: ctx.project,
          label: `Step ${i + 1}`,
          placeholder: `Step ${i + 1} event`,
          onChange: (v) => {
            step.event = v;
            ctx.update();
          },
        }),
        !step.event,
      ),
      step.optional ? h('span', { class: 'badge' }, 'Optional') : '',
      cardMenu('Step options', [
        optional,
        ...cardActions(steps, i, ctx.update, {
          noun: 'step',
          min: 2,
          onRemove: (removed) =>
            toast(`Removed step ${i + 1}`, 'ok', {
              label: 'Undo',
              run: () => {
                steps.splice(i, 0, removed);
                ctx.update();
              },
            }),
        }),
      ]),
    ),
    filterEditor(step.filters as FilterRow[], ctx.update, {
      event: step.event,
      project: ctx.project,
      cohorts: true,
    }),
  );
  return card;
}

function windowPicker(spec: Spec, ctx: RailContext): HTMLElement {
  const value = String(spec.window ?? '7d');
  const options = WINDOWS.some((w) => w.value === value)
    ? WINDOWS
    : [...WINDOWS, { value, label: value }];
  return selectMenu({
    value,
    label: 'Conversion window',
    options,
    width: 200,
    onChange: (v) => {
      spec.window = v;
      ctx.update();
    },
  });
}

const ORDER: AdvancedOption = {
  key: 'order',
  isSet: (spec) => Boolean(spec.order) && spec.order !== 'ordered',
  chip: (spec) => ORDER_LABEL[String(spec.order)] ?? String(spec.order),
  clear: (spec) => delete spec.order,
  render: (spec, update) =>
    optionGroup(
      'Step order',
      tabs(
        [
          { value: 'ordered', label: 'In order' },
          { value: 'strict', label: 'Strict' },
          { value: 'unordered', label: 'Any order' },
        ],
        String(spec.order ?? 'ordered'),
        (v) => {
          setOption(spec, 'order', v, 'ordered');
          update();
        },
        'tabs-small',
      ),
    ),
};

function stepSelect(
  value: number,
  steps: number,
  label: string,
  onChange: (n: number) => void,
): HTMLElement {
  return selectMenu({
    value: String(value),
    label,
    options: Array.from({ length: steps }, (_, i) => ({
      value: String(i + 1),
      label: `step ${i + 1}`,
    })),
    width: 120,
    onChange: (v) => onChange(Number(v)),
  });
}

function exclusionRow(list: Exclusion[], i: number, steps: number, ctx: RailContext): HTMLElement {
  const x = list[i]!;
  ensureFilters(x);
  return h(
    'div',
    { class: 'exclusion' },
    h(
      'div',
      { class: 'row' },
      eventPicker({
        value: x.event,
        project: ctx.project,
        label: `Exclusion ${i + 1}`,
        onChange: (v) => {
          x.event = v;
          ctx.update();
        },
      }),
      iconButton('x', 'Remove exclusion', () => {
        list.splice(i, 1);
        ctx.update();
      }),
    ),
    h(
      'div',
      { class: 'row exclusion-range' },
      h('span', { class: 'muted small' }, 'between'),
      stepSelect(x.fromStep, steps - 1, 'From step', (n) => {
        x.fromStep = n;
        x.toStep = Math.max(x.toStep, n + 1);
        ctx.update();
      }),
      h('span', { class: 'muted small' }, 'and'),
      stepSelect(x.toStep, steps, 'To step', (n) => {
        x.toStep = Math.max(n, x.fromStep + 1);
        ctx.update();
      }),
    ),
    filterEditor(x.filters as FilterRow[], ctx.update, { event: x.event, project: ctx.project }),
  );
}

function exclusionsOption(ctx: RailContext, steps: number): AdvancedOption {
  const list = (spec: Spec) => {
    spec.exclusions ??= [];
    return spec.exclusions as Exclusion[];
  };
  return {
    key: 'exclusions',
    isSet: (spec) => ((spec.exclusions as Exclusion[] | undefined) ?? []).some((x) => x.event),
    chip: (spec) => {
      const n = ((spec.exclusions as Exclusion[] | undefined) ?? []).filter((x) => x.event).length;
      return n === 1 ? '1 exclusion' : `${n} exclusions`;
    },
    clear: (spec) => delete spec.exclusions,
    render: (spec) =>
      optionGroup(
        'Leave out people who did',
        list(spec).map((_, i) => exclusionRow(list(spec), i, steps, ctx)),
        list(spec).length < 5
          ? addButton('Add exclusion', () => {
              list(spec).push({ event: '', fromStep: 1, toStep: steps, filters: [] });
              ctx.update();
            })
          : '',
      ),
  };
}

function attributionOption(steps: number): AdvancedOption {
  const value = (spec: Spec) => String(spec.breakdownAttribution ?? 'first_touch');
  const options = [
    { value: 'first_touch', label: 'The first step' },
    { value: 'last_touch', label: 'The last step reached' },
    { value: 'all_steps', label: 'Every step (must match)' },
    ...Array.from({ length: Math.max(0, steps - 1) }, (_, i) => ({
      value: String(i + 2),
      label: `Step ${i + 2}`,
    })),
  ];
  return {
    key: 'breakdownAttribution',
    applies: (spec) => readBreakdowns(spec).length > 0 && !readBreakdowns(spec).includes('cohort'),
    isSet: (spec) => value(spec) !== 'first_touch',
    chip: (spec) =>
      `Breakdown from ${options.find((o) => o.value === value(spec))?.label.toLowerCase() ?? value(spec)}`,
    clear: (spec) => delete spec.breakdownAttribution,
    render: (spec, update) =>
      optionGroup(
        'Breakdown value from',
        selectMenu({
          value: value(spec),
          label: 'Breakdown attribution',
          options,
          fallback: `Step ${value(spec)}`,
          width: 220,
          onChange: (v) => {
            setOption(spec, 'breakdownAttribution', /^\d+$/.test(v) ? Number(v) : v, 'first_touch');
            update();
          },
        }),
      ),
  };
}

export function funnelRail(spec: Spec, ctx: RailContext): HTMLElement {
  const steps = spec.steps as StepSpec[];
  return h(
    'div',
    { class: 'builder-stack' },
    section(
      'Steps',
      h(
        'ol',
        { class: 'steps-editor' },
        steps.map((_, i) => stepCard(spec, steps, i, ctx)),
      ),
      addButton('Add step', () => {
        steps.push({ event: '', filters: [] });
        ctx.update();
      }),
      h(
        'div',
        { class: 'row window-row' },
        h('span', { class: 'muted' }, 'Completed within'),
        windowPicker(spec, ctx),
      ),
    ),
    section(
      'Filters',
      filterEditor(spec.filters as FilterRow[], ctx.update, {
        event: steps[0]?.event,
        project: ctx.project,
        cohorts: true,
      }),
      internalTrafficChip(spec, ctx.update),
    ),
    section(
      'Break down by',
      breakdownEditor(spec, {
        event: steps[0]?.event,
        project: ctx.project,
        update: ctx.update,
        bins: true,
      }),
    ),
    moreOptions(
      'funnel',
      spec,
      [
        ORDER,
        exclusionsOption(ctx, steps.length),
        attributionOption(steps.length),
        countByOption(ctx.project),
      ],
      ctx.update,
    ) ?? '',
  );
}

/** The funnel's views, for the chart toolbar: steps, time to convert, conversion over time. */
export function funnelViewControls(spec: Spec, steps: number, update: () => void): HTMLElement[] {
  const viz = String(spec.viz ?? 'steps');
  const from = Number(spec.fromStep ?? 1);
  const to = Number(spec.toStep ?? steps);
  const range =
    viz === 'steps'
      ? []
      : [
          stepSelect(from, steps - 1, 'From step', (n) => {
            setOption(spec, 'fromStep', n, 1);
            if (to <= n) spec.toStep = n + 1;
            update();
          }),
          stepSelect(to, steps, 'To step', (n) => {
            setOption(spec, 'toStep', Math.max(n, from + 1), steps);
            update();
          }),
        ];
  return [
    tabs(
      [
        { value: 'steps', label: 'Steps' },
        { value: 'time_to_convert', label: 'Time to convert' },
        { value: 'trends', label: 'Over time' },
      ],
      viz,
      (v) => {
        setOption(spec, 'viz', v, 'steps');
        update();
      },
      'tabs-small',
    ),
    ...range,
  ];
}
