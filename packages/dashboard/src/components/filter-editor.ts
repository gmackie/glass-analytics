/**
 * Amplitude-style "where" clauses: property → operator → values. The property
 * picker lists event, person and built-in properties (and cohorts where
 * allowed); operators follow the property's type; values come from a
 * typeahead of what has actually been seen. Shared by Insights and cohorts.
 */

import { COLUMN_OPTIONS, loadEventDetail, loadPersonProperties } from '../catalog.ts';
import { h } from '../dom.ts';
import { icon } from './icons.ts';
import { propertyPicker } from './picker.ts';
import { valueInput } from './value-input.ts';

export interface FilterRow {
  property: string;
  op?: string;
  value?: string | number | boolean | (string | number)[];
}

export interface FilterEditorOptions {
  /** Prefer properties of this event and suggest its values. */
  event?: string;
  project?: string;
  label?: string;
  /** Offer saved-cohort membership as a filter. */
  cohorts?: boolean;
  /** Only person properties (cohort definitions). */
  personOnly?: boolean;
  /** Exactly one row: no joiner, no remove or add buttons (the caller owns those). */
  single?: boolean;
}

type Kind = 'cohort' | 'string' | 'number' | 'boolean';

const OPS: Record<Kind, [string, string][]> = {
  cohort: [
    ['eq', 'is in'],
    ['neq', 'is not in'],
  ],
  string: [
    ['eq', 'is'],
    ['neq', 'is not'],
    ['contains', 'contains'],
    ['not_contains', 'does not contain'],
    ['is_set', 'is set'],
    ['is_not_set', 'is not set'],
  ],
  number: [
    ['eq', '='],
    ['neq', '≠'],
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
    ['lte', '≤'],
    ['is_set', 'is set'],
    ['is_not_set', 'is not set'],
  ],
  boolean: [
    ['eq', 'is'],
    ['neq', 'is not'],
    ['is_set', 'is set'],
    ['is_not_set', 'is not set'],
  ],
};

const NO_VALUE = new Set(['is_set', 'is_not_set']);
const MULTI = new Set(['eq', 'neq']);
const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte']);
const COLUMNS = new Set(COLUMN_OPTIONS.map((c) => c.name));

/** Best guess before the catalog loads, so the row renders immediately. */
function guessKind(f: FilterRow): Kind {
  if (f.property === 'cohort') return 'cohort';
  const first = Array.isArray(f.value) ? f.value[0] : f.value;
  if (typeof first === 'number' || NUMERIC.has(f.op ?? '')) return 'number';
  if (typeof first === 'boolean') return 'boolean';
  return 'string';
}

async function resolveKind(
  property: string,
  event: string | undefined,
  project: string | undefined,
): Promise<Kind> {
  if (property === 'cohort') return 'cohort';
  if (!property || COLUMNS.has(property)) return 'string';
  const props = property.startsWith('person.')
    ? await loadPersonProperties(project)
    : event
      ? (await loadEventDetail(event, project)).properties
      : [];
  const name = property.startsWith('props.') ? property.slice(6) : property;
  const types = props.find((p) => p.name === name)?.types ?? [];
  if (types.length && types.every((t) => t === 'number' || t === 'null')) return 'number';
  if (types.length && types.every((t) => t === 'boolean' || t === 'null')) return 'boolean';
  return 'string';
}

function coerce(raw: string, kind: Kind): string | number | boolean {
  if (kind === 'number' && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (kind === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

const valuesOf = (f: FilterRow): string[] =>
  f.value === undefined || f.value === null || f.value === ''
    ? []
    : (Array.isArray(f.value) ? f.value : [f.value]).map(String);

function select(
  value: string,
  options: [string, string][],
  onChange: (v: string) => void,
  label: string,
): HTMLElement {
  const el = h(
    'select',
    { class: 'filter-op', 'aria-label': label },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** The value part of a filter row: a number field, a value picker, or nothing (is set…). */
function valueControl(
  f: FilterRow,
  op: string,
  kind: Kind,
  options: FilterEditorOptions,
  onChange: () => void,
): HTMLElement | null {
  if (NO_VALUE.has(op)) return null;
  if (NUMERIC.has(op)) {
    const input = h('input', {
      type: 'number',
      class: 'filter-number',
      value: valuesOf(f)[0] ?? '',
      placeholder: 'Number',
      'aria-label': 'Filter value',
      step: 'any',
    });
    // Mutate in place only — remounting would steal focus from the value field.
    input.addEventListener('input', () => {
      f.value = input.value === '' ? '' : Number(input.value);
    });
    input.addEventListener('change', onChange);
    return input;
  }
  return valueInput({
    property: f.property,
    event: options.personOnly ? undefined : options.event,
    project: options.project,
    values: valuesOf(f),
    multiple: MULTI.has(op),
    placeholder: kind === 'cohort' ? 'Select cohorts' : undefined,
    onChange: (values) => {
      const typed = values.map((v) => coerce(v, kind)) as (string | number)[];
      f.value = typed.length > 1 ? typed : (typed[0] ?? '');
      onChange();
    },
  });
}

/** Editable list of filters. Mutates `filters` in place, repaints itself, then calls `onChange`. */
export function filterEditor(
  filters: FilterRow[],
  onChange: () => void,
  options: FilterEditorOptions = {},
): HTMLElement {
  const root = h('div', { class: 'filter-editor' });
  // Saved specs may carry in/not_in; the UI shows those as is / is not with several values.
  for (const f of filters) {
    if (f.op === 'in') f.op = 'eq';
    if (f.op === 'not_in') f.op = 'neq';
  }

  const changed = () => {
    paint();
    onChange();
  };

  const row = (f: FilterRow, i: number, kind: Kind): HTMLElement => {
    const ops = OPS[kind];
    if (!ops.some(([v]) => v === (f.op ?? 'eq'))) f.op = 'eq';
    const op = f.op ?? 'eq';
    const el = h(
      'div',
      { class: 'filter-row' },
      options.single ? null : h('span', { class: 'filter-joiner' }, i === 0 ? 'where' : 'and'),
    );
    el.append(
      propertyPicker({
        value: f.property,
        event: options.personOnly ? undefined : options.event,
        project: options.project,
        columns: !options.personOnly,
        eventProperties: !options.personOnly,
        cohorts: options.cohorts === true,
        customPrefix: options.personOnly ? 'person.' : undefined,
        placeholder: options.personOnly ? 'Person property' : 'Property',
        label: 'Filter property',
        onChange: (v) => {
          if (v === f.property) return;
          f.property = v;
          f.op = 'eq';
          f.value = '';
          changed();
        },
      }),
      select(
        op,
        ops,
        (v) => {
          const wasMulti = MULTI.has(f.op ?? 'eq');
          f.op = v;
          if (NO_VALUE.has(v)) delete f.value;
          else if (wasMulti && !MULTI.has(v)) f.value = valuesOf(f)[0] ?? '';
          changed();
        },
        'Operator',
      ),
    );
    const value = valueControl(f, op, kind, options, onChange);
    if (value) el.append(value);
    if (options.single) return el;
    el.append(
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button filter-remove',
          'aria-label': 'Remove filter',
          title: 'Remove filter',
          onclick: () => {
            filters.splice(i, 1);
            changed();
          },
        },
        icon('x', 14),
      ),
    );
    return el;
  };

  const paint = () => {
    root.replaceChildren();
    if (options.label) root.append(h('div', { class: 'filter-editor-label' }, options.label));
    filters.forEach((f, i) => {
      const guess = guessKind(f);
      let el = row(f, i, guess);
      root.append(el);
      void resolveKind(f.property, options.event, options.project).then((kind) => {
        if (kind === guess || !el.isConnected) return;
        const next = row(f, i, kind);
        el.replaceWith(next);
        el = next;
      });
    });
    if (options.single) return;
    root.append(
      h(
        'div',
        { class: 'filter-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'link-button add-button',
            onclick: () => {
              filters.push({ property: '', op: 'eq', value: '' });
              changed();
            },
          },
          icon('filter', 13),
          options.personOnly ? 'Person property' : 'Filter',
        ),
        options.cohorts
          ? h(
              'button',
              {
                type: 'button',
                class: 'link-button add-button',
                onclick: () => {
                  filters.push({ property: 'cohort', op: 'eq', value: '' });
                  changed();
                },
              },
              icon('layers', 13),
              'Cohort',
            )
          : null,
      ),
    );
  };

  paint();
  return root;
}

/** Drop incomplete filters and turn multi-value is / is not into in / not_in before sending to the API. */
export function cleanFilters(filters: FilterRow[] | undefined): FilterRow[] | undefined {
  if (!filters?.length) return undefined;
  const out: FilterRow[] = [];
  for (const f of filters) {
    const property = f.property?.trim();
    if (!property) continue;
    const op = f.op && f.op !== 'eq' ? f.op : undefined;
    if (op && NO_VALUE.has(op)) {
      out.push({ property, op });
      continue;
    }
    const list = (Array.isArray(f.value) ? f.value : [f.value]).filter(
      (v) => v !== undefined && v !== null && v !== '',
    ) as (string | number | boolean)[];
    if (list.length === 0) continue;
    if (list.length > 1 && (op === undefined || op === 'neq')) {
      out.push({
        property,
        op: op === 'neq' ? 'not_in' : 'in',
        value: list.map((v) => (typeof v === 'boolean' ? String(v) : v)),
      });
      continue;
    }
    const value = list[0]!;
    out.push(op ? { property, op, value } : { property, value });
  }
  return out.length ? out : undefined;
}
