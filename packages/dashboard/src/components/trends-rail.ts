/**
 * The trends query rail. Always shown: the series (event, measure, filters), formulas,
 * filters on everything and the breakdown. Everything else sits in "More options", which
 * shows a chip for each setting that isn't at its default while it's closed.
 */

import { h } from '../dom.ts';
import { type FilterRow, filterEditor } from './filter-editor.ts';
import { type AdvancedOption, moreOptions } from './fold.ts';
import {
  type FormulaData,
  type FormulaRow,
  formulaEditor,
  formulaTemplates,
} from './formula-editor.ts';
import { knownGroupTypes, PROPERTY_MATHS } from './insight-options.ts';
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
  type SeriesSpec,
  type Spec,
  section,
  seriesTag,
  setOption,
} from './insight-rail.ts';
import { measureLabel, measurePicker } from './measure-picker.ts';
import { selectMenu } from './menu.ts';
import { eventPicker, propertyPicker } from './picker.ts';
import { toast } from './ui.ts';

/** UI state that lives across re-renders of the rail but isn't part of the query. */
export interface RailState {
  /** A new formula row is open but not committed yet. */
  addingFormula: boolean;
}

export interface RailContext {
  project?: string;
  /** The structure changed: draw the rail again and run. */
  update: () => void;
  /** A value changed in place (the rail already shows it): just run. */
  changed: () => void;
  ui: RailState;
  /** The latest results, for the formula preview. */
  data: () => FormulaData | null;
}

const seriesName = (s: SeriesSpec) =>
  s.label || `${s.event || 'No event yet'} · ${measureLabel(s.math ?? 'total')}`;

function seriesMath(s: SeriesSpec, ctx: RailContext): HTMLElement {
  const groupPicker = () =>
    needsInput(
      selectMenu({
        value: s.groupType ?? '',
        label: 'Group type',
        options: knownGroupTypes(ctx.project, ctx.update).map((t) => ({ value: t, label: t })),
        fallback: s.groupType ?? 'Pick a group type',
        width: 180,
        onChange: (v) => {
          s.groupType = v;
          ctx.update();
        },
      }),
      !s.groupType,
    );
  const propertyChooser = () =>
    needsInput(
      propertyPicker({
        value: s.property ?? '',
        event: s.event,
        project: ctx.project,
        columns: false,
        placeholder: 'Which number?',
        onChange: (v) => {
          s.property = v;
          ctx.update();
        },
      }),
      !s.property,
    );
  return h(
    'div',
    { class: 'query-card-row' },
    measurePicker({
      value: s.math ?? 'total',
      onChange: (v) => {
        s.math = v;
        ctx.update();
      },
    }),
    s.math === 'unique_groups' ? groupPicker() : null,
    PROPERTY_MATHS.has(s.math ?? '') ? propertyChooser() : null,
  );
}

function seriesCard(series: SeriesSpec[], i: number, ctx: RailContext): HTMLElement {
  const s = series[i]!;
  ensureFilters(s);
  const card = h('div', { class: 'query-card', 'data-series': String(i) });
  const rename = () => {
    const name = prompt('Name this series (shown on the chart):', s.label ?? '');
    if (name === null) return;
    setOption(s as Spec, 'label', name.trim());
    ctx.update();
  };
  card.append(
    h(
      'div',
      { class: 'query-card-head' },
      series.length > 1 ? reorderable(card, series, i, ctx.update) : null,
      seriesTag(i),
      needsInput(
        eventPicker({
          value: s.event,
          project: ctx.project,
          label: `Event ${String.fromCharCode(65 + i)}`,
          onChange: (v) => {
            s.event = v;
            ctx.update();
          },
        }),
        !s.event,
      ),
      cardMenu('Series options', [
        { label: s.label ? 'Rename' : 'Name it', icon: 'edit', run: rename },
        ...cardActions(series, i, ctx.update, {
          noun: 'series',
          min: 1,
          onRemove: (removed) =>
            toast(`Removed ${seriesName(removed)}`, 'ok', {
              label: 'Undo',
              run: () => {
                series.splice(i, 0, removed);
                ctx.update();
              },
            }),
        }),
      ]),
    ),
    s.label ? h('div', { class: 'muted small series-name' }, `Shown as “${s.label}”`) : '',
    seriesMath(s, ctx),
    filterEditor(s.filters as FilterRow[], ctx.update, {
      event: s.event,
      project: ctx.project,
      cohorts: true,
    }),
  );
  return card;
}

/** Highlight the card of series `i` (or none), e.g. while the caret is on its letter. */
function highlightSeries(root: HTMLElement, i: number | null): void {
  for (const card of root.querySelectorAll<HTMLElement>('.query-card[data-series]'))
    card.classList.toggle('highlighted', card.dataset.series === String(i));
}

function formulaRows(
  spec: Spec,
  series: SeriesSpec[],
  ctx: RailContext,
  root: HTMLElement,
): HTMLElement[] {
  const formulas = (spec.formulas as FormulaRow[] | undefined) ?? [];
  const save = (next: FormulaRow[]) => {
    setOption(spec, 'formulas', next.length ? next : undefined);
    if (!next.length) delete spec.formulaOnly;
  };
  const common = {
    series: () => series.map((s) => ({ label: seriesName(s) })),
    data: ctx.data,
    onSeries: (i: number | null) => highlightSeries(root, i),
  };
  const rows = formulas.map((f, i) =>
    formulaEditor({
      ...common,
      row: f,
      index: i,
      onCommit: (row) => {
        formulas[i] = row;
        save(formulas);
        ctx.changed();
      },
      onRemove: () => {
        formulas.splice(i, 1);
        save(formulas);
        ctx.update();
      },
    }),
  );
  if (!ctx.ui.addingFormula) return rows;
  const add = (row: FormulaRow) => {
    ctx.ui.addingFormula = false;
    save([...formulas, row]);
    ctx.update();
  };
  const cancel = () => {
    ctx.ui.addingFormula = false;
    ctx.update();
  };
  return [
    ...rows,
    formulaEditor({
      ...common,
      row: { expr: '' },
      index: formulas.length,
      onCommit: add,
      onRemove: cancel,
      autofocus: true,
    }),
    series.length > 1 && !formulas.length ? formulaTemplates(add) : null,
  ].filter((x): x is HTMLElement => x !== null);
}

const BREAKDOWN_LIMIT: AdvancedOption = {
  key: 'breakdownLimit',
  applies: (spec) => readBreakdowns(spec).length > 0 && !readBreakdowns(spec).includes('cohort'),
  isSet: (spec) => spec.breakdownLimit !== undefined && spec.breakdownLimit !== 10,
  chip: (spec) => `Top ${spec.breakdownLimit} values`,
  clear: (spec) => delete spec.breakdownLimit,
  render: (spec, update) =>
    h(
      'div',
      { class: 'option-group' },
      h('div', { class: 'option-label' }, 'Breakdown values'),
      selectMenu({
        value: String(spec.breakdownLimit ?? 10),
        label: 'How many values',
        options: [5, 10, 25, 50, 100].map((n) => ({
          value: String(n),
          label: `Top ${n}, the rest as Other`,
        })),
        width: 240,
        onChange: (v) => {
          setOption(spec, 'breakdownLimit', Number(v), 10);
          update();
        },
      }),
    ),
};

export function trendsRail(spec: Spec, ctx: RailContext): HTMLElement {
  const series = spec.series as SeriesSpec[];
  const root = h('div', { class: 'builder-stack' });
  root.append(
    section(
      'Measure',
      series.map((_, i) => seriesCard(series, i, ctx)),
      h(
        'div',
        { class: 'row add-row' },
        addButton('Add series', () => {
          series.push({ event: '', math: 'total', filters: [] });
          ctx.update();
        }),
        ctx.ui.addingFormula
          ? null
          : addButton(
              'Add formula',
              () => {
                ctx.ui.addingFormula = true;
                ctx.update();
              },
              'sigma',
            ),
      ),
      formulaRows(spec, series, ctx, root),
    ),
    section(
      'Filters',
      filterEditor(spec.filters as FilterRow[], ctx.update, {
        event: series[0]?.event,
        project: ctx.project,
        cohorts: true,
      }),
      internalTrafficChip(spec, ctx.update),
    ),
    section(
      'Break down by',
      breakdownEditor(spec, {
        event: series[0]?.event,
        project: ctx.project,
        update: ctx.update,
        bins: true,
      }),
    ),
    moreOptions('trends', spec, [countByOption(ctx.project), BREAKDOWN_LIMIT], ctx.update) ?? '',
  );
  return root;
}
