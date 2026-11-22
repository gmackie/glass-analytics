/**
 * The retention query rail. Always shown: the start and return events, the period,
 * filters and the breakdown. Who counts as a cohort, cumulative counting, averaging and
 * what to count are in "More options".
 */

import { h } from '../dom.ts';
import { type FilterRow, filterEditor } from './filter-editor.ts';
import { type AdvancedOption, moreOptions, optionGroup } from './fold.ts';
import {
  breakdownEditor,
  countByOption,
  ensureFilters,
  internalTrafficChip,
  needsInput,
  type Spec,
  type StepSpec,
  section,
  seriesTag,
  setOption,
} from './insight-rail.ts';
import { selectMenu, toggle } from './menu.ts';
import { eventPicker } from './picker.ts';
import type { RailContext } from './trends-rail.ts';
import { tabs } from './ui.ts';

function eventCard(step: StepSpec, tag: number, label: string, ctx: RailContext): HTMLElement {
  ensureFilters(step);
  return h(
    'div',
    { class: 'query-card' },
    h(
      'div',
      { class: 'query-card-head' },
      seriesTag(tag),
      needsInput(
        eventPicker({
          value: step.event,
          project: ctx.project,
          anyEvent: true,
          label,
          onChange: (v) => {
            step.event = v;
            ctx.update();
          },
        }),
        !step.event,
      ),
    ),
    filterEditor(step.filters as FilterRow[], ctx.update, {
      event: step.event,
      project: ctx.project,
      cohorts: true,
    }),
  );
}

const PERIODS = [
  { value: 'hour', label: 'Hours' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
];

function periodControls(spec: Spec, ctx: RailContext): HTMLElement {
  const periods = Number(spec.periods ?? 8);
  return h(
    'div',
    { class: 'query-card-row' },
    tabs(
      PERIODS,
      String(spec.period ?? 'week'),
      (v) => {
        spec.period = v;
        ctx.update();
      },
      'tabs-small',
    ),
    selectMenu({
      value: String(periods),
      label: 'Number of periods',
      options: [4, 6, 8, 10, 12, 16, 24].map((n) => ({ value: String(n), label: `${n} periods` })),
      fallback: `${periods} periods`,
      width: 160,
      onChange: (v) => {
        spec.periods = Number(v);
        ctx.update();
      },
    }),
  );
}

const RECURRING: AdvancedOption = {
  key: 'retentionType',
  isSet: (spec) => spec.retentionType === 'recurring',
  chip: () => 'Every time, not just the first',
  clear: (spec) => delete spec.retentionType,
  render: (spec, update) =>
    optionGroup(
      'Who starts a cohort',
      tabs(
        [
          { value: 'first_time', label: 'First time' },
          { value: 'recurring', label: 'Every time' },
        ],
        String(spec.retentionType ?? 'first_time'),
        (v) => {
          setOption(spec, 'retentionType', v, 'first_time');
          update();
        },
        'tabs-small',
      ),
    ),
};

const CUMULATIVE: AdvancedOption = {
  key: 'cumulative',
  isSet: (spec) => Boolean(spec.cumulative),
  chip: () => 'On or after',
  clear: (spec) => delete spec.cumulative,
  render: (spec, update) =>
    toggle({
      checked: Boolean(spec.cumulative),
      label: 'Count a return on or after each period (cumulative)',
      onChange: (c) => {
        setOption(spec, 'cumulative', c);
        update();
      },
    }),
};

const MEAN: AdvancedOption = {
  key: 'meanMethod',
  isSet: (spec) => spec.meanMethod === 'simple',
  chip: () => 'Simple average',
  clear: (spec) => delete spec.meanMethod,
  render: (spec, update) =>
    optionGroup(
      'Average',
      selectMenu({
        value: String(spec.meanMethod ?? 'weighted'),
        label: 'Average',
        options: [
          { value: 'weighted', label: 'Weighted by cohort size' },
          { value: 'simple', label: 'Simple average' },
        ],
        width: 220,
        onChange: (v) => {
          setOption(spec, 'meanMethod', v, 'weighted');
          update();
        },
      }),
    ),
};

export function retentionRail(spec: Spec, ctx: RailContext): HTMLElement {
  const cohort = spec.cohortEvent as StepSpec;
  const ret = spec.returnEvent as StepSpec;
  return h(
    'div',
    { class: 'builder-stack' },
    section('First did', eventCard(cohort, 0, 'Cohort event', ctx)),
    section('Came back and did', eventCard(ret, 1, 'Return event', ctx)),
    section('Measured in', periodControls(spec, ctx)),
    section(
      'Filters',
      filterEditor(spec.filters as FilterRow[], ctx.update, {
        event: cohort.event,
        project: ctx.project,
        cohorts: true,
      }),
      internalTrafficChip(spec, ctx.update),
    ),
    section(
      'Break down by',
      breakdownEditor(spec, {
        event: cohort.event,
        project: ctx.project,
        update: ctx.update,
        bins: false,
      }),
    ),
    moreOptions(
      'retention',
      spec,
      [RECURRING, CUMULATIVE, MEAN, countByOption(ctx.project)],
      ctx.update,
    ) ?? '',
  );
}
