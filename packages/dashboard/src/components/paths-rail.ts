/**
 * The paths query rail. Always shown: what counts as a step, where paths start and end, how
 * many steps, and filters. Repeats, exclusions, wildcard groups, the boundary, steps per
 * column, the people-per-link floor, cleaning and what to count are in "More options".
 */

import { h } from '../dom.ts';
import { href } from '../state.ts';
import { type FilterRow, filterEditor } from './filter-editor.ts';
import { type AdvancedOption, moreOptions, optionGroup } from './fold.ts';
import { icon } from './icons.ts';
import {
  addButton,
  internalTrafficChip,
  needsInput,
  type Spec,
  section,
  setOption,
} from './insight-rail.ts';
import { selectMenu, toggle } from './menu.ts';
import { eventPicker } from './picker.ts';
import type { RailContext } from './trends-rail.ts';
import { iconButton, tabs } from './ui.ts';
import { valueInput } from './value-input.ts';

type Point = { type?: 'page' | 'event'; value: string };
type FunnelSource = { spec: Spec; step: number; mode: string };
type FunnelStep = {
  event: string;
  label?: string;
  filters?: { property: string; value?: unknown }[];
};

/** "$pageview · /pricing": a step's label, or its event and the page it is filtered to. */
function stepName(step: FunnelStep | undefined): string {
  if (!step) return '';
  if (step.label) return step.label;
  const page = step.filters?.find((x) => x.property === 'path')?.value;
  return page ? `${step.event} · ${String(page)}` : step.event;
}

const INCLUDE = [
  { value: 'pages', label: 'Pages' },
  { value: 'events', label: 'Events' },
  { value: 'both', label: 'Both' },
];

function includeValue(spec: Spec): string {
  const inc = spec.include as { pages?: boolean; events?: unknown } | undefined;
  if (!inc?.events) return 'pages';
  return inc.pages === false ? 'events' : 'both';
}

const INCLUDE_SPEC: Record<string, Spec | undefined> = {
  pages: undefined,
  events: { pages: false, events: true },
  both: { events: true },
};

function includeTabs(spec: Spec, ctx: RailContext): HTMLElement {
  return tabs(
    INCLUDE,
    includeValue(spec),
    (v) => {
      setOption(spec, 'include', INCLUDE_SPEC[v]);
      ctx.update();
    },
    'tabs-small',
  );
}

function pointValue(spec: Spec, key: 'start' | 'end', ctx: RailContext, point: Point): HTMLElement {
  const set = (value: string) => {
    spec[key] = { ...point, value };
    ctx.update();
  };
  if (point.type === 'event')
    return needsInput(
      eventPicker({
        value: point.value,
        project: ctx.project,
        label: key === 'start' ? 'Start event' : 'End event',
        onChange: set,
      }),
      !point.value,
    );
  return needsInput(
    valueInput({
      property: 'path',
      values: point.value ? [point.value] : [],
      multiple: false,
      project: ctx.project,
      placeholder: '/pricing, or /blog/* for a group',
      onChange: (values) => set(values[0] ?? ''),
    }),
    !point.value,
  );
}

/** "Anywhere", a page or an event; with a page or event, the picker for it. */
function pointEditor(spec: Spec, key: 'start' | 'end', ctx: RailContext): HTMLElement {
  const point = spec[key] as Point | undefined;
  const kind = point ? (point.type ?? 'page') : 'any';
  const pick = selectMenu({
    value: kind,
    label: key === 'start' ? 'Where paths start' : 'Where paths end',
    options: [
      { value: 'any', label: key === 'start' ? 'Anywhere' : 'Wherever they stop' },
      { value: 'page', label: 'A page' },
      { value: 'event', label: 'An event' },
    ],
    width: 180,
    onChange: (v) => {
      if (v === 'any') delete spec[key];
      else spec[key] = { type: v, value: '' };
      ctx.update();
    },
  });
  return h(
    'div',
    { class: 'row path-point' },
    pick,
    point ? pointValue(spec, key, ctx, { type: point.type ?? 'page', value: point.value }) : null,
  );
}

function stepsMenu(spec: Spec, ctx: RailContext): HTMLElement {
  return selectMenu({
    value: String(spec.steps ?? 5),
    label: 'Steps',
    options: [2, 3, 4, 5, 6, 7, 8, 10].map((n) => ({ value: String(n), label: `${n} steps` })),
    width: 120,
    onChange: (v) => {
      setOption(spec, 'steps', Number(v), 5);
      ctx.update();
    },
  });
}

const MODES = [
  { value: 'after', label: 'After' },
  { value: 'before', label: 'Before' },
  { value: 'between', label: 'To the next' },
  { value: 'dropoff', label: 'Drop-offs' },
];

/** Paths around a funnel step: which step, and which way. */
function funnelCard(spec: Spec, ctx: RailContext): HTMLElement {
  const f = spec.funnel as FunnelSource;
  const steps = (f.spec.steps as FunnelStep[]) ?? [];
  const name = (i: number) => stepName(steps[i - 1]) || `step ${i}`;
  return h(
    'div',
    { class: 'query-card path-funnel' },
    h(
      'div',
      { class: 'query-card-head' },
      icon('funnel', 14),
      h('span', {}, `Funnel step ${f.step}: `, h('strong', {}, name(f.step))),
      iconButton('x', 'Stop following the funnel', () => {
        delete spec.funnel;
        ctx.update();
      }),
    ),
    tabs(
      MODES.filter(
        (m) =>
          (m.value !== 'between' || f.step < steps.length) && (m.value !== 'dropoff' || f.step > 1),
      ),
      f.mode,
      (v) => {
        f.mode = v;
        ctx.update();
      },
      'tabs-small',
    ),
  );
}

/** A list of patterns (exclusions, groups), edited in place. */
function patternList(
  spec: Spec,
  key: string,
  placeholder: string,
  update: () => void,
): HTMLElement[] {
  const list = (spec[key] as string[] | undefined) ?? [];
  const rows = list.map((value, i) => {
    const input = h('input', { type: 'text', value, placeholder, 'aria-label': placeholder });
    input.addEventListener('change', () => {
      list[i] = input.value.trim();
      setOption(spec, key, list.filter(Boolean).length ? list.filter(Boolean) : undefined);
      update();
    });
    return h(
      'div',
      { class: 'row' },
      input,
      iconButton('x', 'Remove', () => {
        list.splice(i, 1);
        setOption(spec, key, list.length ? list : undefined);
        update();
      }),
    );
  });
  const add = addButton('Add', () => {
    spec[key] = [...list, ''];
    update();
  });
  return [...rows, list.length < 20 ? add : h('span', {})];
}

const patterns = (spec: Spec, key: string) =>
  ((spec[key] as string[] | undefined) ?? []).filter(Boolean);

const EXCLUDE: AdvancedOption = {
  key: 'exclude',
  isSet: (spec) => patterns(spec, 'exclude').length > 0,
  chip: (spec) => `Leaving out ${patterns(spec, 'exclude').join(', ')}`,
  clear: (spec) => delete spec.exclude,
  render: (spec, update) =>
    optionGroup('Leave out', ...patternList(spec, 'exclude', '/admin/* or an event', update)),
};

const GROUPS: AdvancedOption = {
  key: 'groups',
  isSet: (spec) => patterns(spec, 'groups').length > 0,
  chip: (spec) => `Grouping ${patterns(spec, 'groups').join(', ')}`,
  clear: (spec) => delete spec.groups,
  render: (spec, update) =>
    optionGroup('Show as one step', ...patternList(spec, 'groups', '/blog/*', update)),
};

const REPEATS: AdvancedOption = {
  key: 'collapseRepeats',
  isSet: (spec) => spec.collapseRepeats === false,
  chip: () => 'Repeats counted',
  clear: (spec) => delete spec.collapseRepeats,
  render: (spec, update) =>
    toggle({
      checked: spec.collapseRepeats === false,
      label: 'Count a step again when it repeats (e.g. reloading a page)',
      onChange: (c) => {
        setOption(spec, 'collapseRepeats', c ? false : undefined);
        update();
      },
    }),
};

const BOUNDARIES = [
  { value: 'session', label: 'The same visit' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '1440', label: '1 day' },
  { value: '10080', label: '7 days' },
];

const boundaryValue = (spec: Spec) => {
  const b = spec.boundary as { minutes: number } | undefined;
  return b ? String(b.minutes) : 'session';
};

const BOUNDARY: AdvancedOption = {
  key: 'boundary',
  isSet: (spec) => spec.boundary !== undefined && spec.boundary !== 'session',
  chip: (spec) =>
    `Within ${BOUNDARIES.find((b) => b.value === boundaryValue(spec))?.label ?? `${boundaryValue(spec)} minutes`}`,
  clear: (spec) => delete spec.boundary,
  render: (spec, update) =>
    optionGroup(
      'A path stays within',
      selectMenu({
        value: boundaryValue(spec),
        label: 'Path boundary',
        options: BOUNDARIES,
        fallback: `${boundaryValue(spec)} minutes`,
        width: 180,
        onChange: (v) => {
          setOption(spec, 'boundary', v === 'session' ? undefined : { minutes: Number(v) });
          update();
        },
      }),
    ),
};

const PER_STEP: AdvancedOption = {
  key: 'perStep',
  isSet: (spec) => spec.perStep !== undefined && spec.perStep !== 8,
  chip: (spec) => `Top ${spec.perStep} per step`,
  clear: (spec) => delete spec.perStep,
  render: (spec, update) =>
    optionGroup(
      'Steps shown per column',
      selectMenu({
        value: String(spec.perStep ?? 8),
        label: 'Steps per column',
        options: [3, 5, 8, 12, 20].map((n) => ({
          value: String(n),
          label: `Top ${n}, then Other`,
        })),
        width: 180,
        onChange: (v) => {
          setOption(spec, 'perStep', Number(v), 8);
          update();
        },
      }),
    ),
};

const MIN_PEOPLE: AdvancedOption = {
  key: 'minPeople',
  isSet: (spec) => Number(spec.minPeople ?? 0) > 1,
  chip: (spec) => `Links with ${spec.minPeople}+`,
  clear: (spec) => delete spec.minPeople,
  render: (spec, update) => {
    const input = h('input', {
      type: 'number',
      min: 1,
      value: spec.minPeople === undefined ? '' : Number(spec.minPeople),
      placeholder: '1',
      class: 'short',
    });
    input.addEventListener('change', () => {
      setOption(spec, 'minPeople', Number(input.value) > 1 ? Number(input.value) : undefined);
      update();
    });
    return optionGroup('Hide links followed by fewer than', input);
  },
};

const CLEANING: AdvancedOption = {
  key: 'projectCleaning',
  isSet: (spec) => spec.projectCleaning === false,
  chip: () => 'Raw paths',
  clear: (spec) => delete spec.projectCleaning,
  render: (spec, update) =>
    optionGroup(
      'Path cleaning',
      toggle({
        checked: spec.projectCleaning !== false,
        label: 'Merge paths with ids using the project’s rules',
        onChange: (c) => {
          setOption(spec, 'projectCleaning', c ? undefined : false);
          update();
        },
      }),
      h(
        'a',
        { class: 'small', href: href('settings', { tab: 'project' }) },
        'Edit the rules in Settings',
      ),
    ),
};

const COUNT: AdvancedOption = {
  key: 'aggregateBy',
  isSet: (spec) => spec.aggregateBy === 'session',
  chip: () => 'Every session',
  clear: (spec) => delete spec.aggregateBy,
  render: (spec, update) =>
    optionGroup(
      'Count',
      tabs(
        [
          { value: 'person', label: 'Each person’s first path' },
          { value: 'session', label: 'Every session' },
        ],
        String(spec.aggregateBy ?? 'person'),
        (v) => {
          setOption(spec, 'aggregateBy', v, 'person');
          update();
        },
        'tabs-small',
      ),
    ),
};

export function pathsRail(spec: Spec, ctx: RailContext): HTMLElement {
  const fromFunnel = Boolean(spec.funnel);
  return h(
    'div',
    { class: 'builder-stack' },
    section('Steps are', includeTabs(spec, ctx)),
    fromFunnel ? section('Around', funnelCard(spec, ctx)) : null,
    fromFunnel ? null : section('Starting at', pointEditor(spec, 'start', ctx)),
    fromFunnel ? null : section('Ending at', pointEditor(spec, 'end', ctx)),
    section('Follow', stepsMenu(spec, ctx)),
    section(
      'Filters',
      filterEditor(spec.filters as FilterRow[], ctx.update, {
        project: ctx.project,
        cohorts: true,
      }),
      internalTrafficChip(spec, ctx.update),
    ),
    moreOptions(
      'paths',
      spec,
      [REPEATS, EXCLUDE, GROUPS, BOUNDARY, PER_STEP, MIN_PEOPLE, CLEANING, COUNT],
      ctx.update,
    ) ?? '',
  );
}
