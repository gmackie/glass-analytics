/**
 * The formula editor: series letters drawn as chips in their series colour, the mistake
 * underlined where it is, suggestions for what can come next (series, functions, operators),
 * and a live preview computed in the browser from the results already on screen, so typing
 * never waits for a query. Enter or leaving the field runs it for real.
 */

import {
  checkFormula,
  evaluateFormula,
  FORMULA_FUNCTIONS,
  type FormulaFunction,
  type FormulaNode,
  formulaContext,
  lexFormula,
} from '@dataflare/core/formula';
import { type Child, h } from '../dom.ts';
import { count, percent } from '../format.ts';
import { SERIES, sparkline } from './charts.ts';
import { type CodeField, type CodeToken, codeField } from './code-field.ts';
import { iconButton, tabs } from './ui.ts';

export interface FormulaRow {
  expr: string;
  label?: string;
  format?: 'number' | 'percent';
}

interface FormulaSeries {
  /** "Pageview · Unique people". */
  label: string;
}

/** The latest results, per spec series: one value per bucket, and the total. */
export interface FormulaData {
  values: number[][];
  totals: number[];
}

export interface FormulaEditorOptions {
  row: FormulaRow;
  /** 0 for ƒ1. */
  index: number;
  series: () => FormulaSeries[];
  data: () => FormulaData | null;
  onCommit: (row: FormulaRow) => void;
  onRemove: () => void;
  /** The caret is on a series letter (or none): highlight that series. */
  onSeries?: (index: number | null) => void;
  autofocus?: boolean;
}

const letter = (i: number) => String.fromCharCode(65 + i);

interface Hint {
  label: Child;
  detail?: string;
  insert: string;
  /** Characters before the caret the insert replaces (the word being typed). */
  replace?: { start: number; end: number };
}

const TOKEN_CLASS: Record<string, string | undefined> = {
  num: 't-num',
  fn: 't-fn',
  op: 't-op',
  paren: 't-punct',
  comma: 't-punct',
  bad: 't-bad',
};

function formulaTokens(count: () => number) {
  return (text: string): CodeToken[] =>
    lexFormula(text).map((t) => {
      const raw = text.slice(t.start, t.end);
      if (t.kind !== 'var') return { text: raw, cls: TOKEN_CLASS[t.kind] };
      const i = t.text.charCodeAt(0) - 65;
      return { text: raw, cls: i < count() ? `t-var t-s${i % SERIES.length}` : 't-bad' };
    });
}

const OPERATORS: [string, string, string][] = [
  ['+', ' + ', 'plus'],
  ['−', ' - ', 'minus'],
  ['×', ' * ', 'times'],
  ['÷', ' / ', 'divided by'],
];

function valueHints(series: FormulaSeries[], word: string): Hint[] {
  const w = word.toLowerCase();
  const seriesHints = series
    .map(
      (s, i): Hint => ({
        label: h(
          'span',
          { class: `series-tag`, style: `--tag:${SERIES[i % SERIES.length]}` },
          letter(i),
        ),
        detail: s.label,
        insert: letter(i),
      }),
    )
    .filter(
      (hint, i) =>
        !w || letter(i).toLowerCase() === w || series[i]!.label.toLowerCase().includes(w),
    );
  const fnHints = (Object.keys(FORMULA_FUNCTIONS) as FormulaFunction[])
    .filter((name) => !w || name.startsWith(w))
    .map(
      (name): Hint => ({
        label: h('code', {}, FORMULA_FUNCTIONS[name].signature),
        detail: FORMULA_FUNCTIONS[name].description,
        insert: `${name}(`,
      }),
    );
  return [...seriesHints, ...fnHints];
}

function operatorHints(depth: number): Hint[] {
  const ops = OPERATORS.map(
    ([shown, insert, detail]): Hint => ({ label: h('code', {}, shown), detail, insert }),
  );
  if (depth === 0) return ops;
  return [
    ...ops,
    { label: h('code', {}, ')'), detail: 'close the bracket', insert: ')' },
    { label: h('code', {}, ','), detail: 'next value', insert: ', ' },
  ];
}

/** What can come at the caret. */
function hintsAt(field: CodeField, series: FormulaSeries[]): Hint[] {
  const caret = field.input.selectionStart;
  const ctx = formulaContext(field.value, caret);
  if (ctx.expect === 'operator') return operatorHints(ctx.depth);
  const hints = valueHints(series, ctx.word?.text ?? '');
  if (!ctx.word) return hints;
  return hints.map((hint) => ({
    ...hint,
    replace: { start: ctx.word!.start, end: ctx.word!.end },
  }));
}

function formatValue(n: number, format: FormulaRow['format']): string {
  if (!Number.isFinite(n)) return '–';
  if (format === 'percent') return percent(n, 1);
  return Math.abs(n) < 100 && !Number.isInteger(n) ? n.toFixed(2) : count(n);
}

function preview(
  node: FormulaNode,
  data: FormulaData | null,
  format: FormulaRow['format'],
  index: number,
): Child {
  if (!data?.values.length) return h('span', { class: 'muted' }, 'Press Enter to run it');
  const buckets = data.values[0]?.length ?? 0;
  const values = Array.from({ length: buckets }, (_, b) =>
    evaluateFormula(
      node,
      data.values.map((v) => v[b] ?? 0),
    ),
  );
  const total = evaluateFormula(node, data.totals);
  return [
    h(
      'span',
      {},
      '= ',
      h('strong', {}, formatValue(total, format)),
      h('span', { class: 'muted' }, ' over the range'),
    ),
    values.length > 1
      ? sparkline(values, { color: SERIES[(index + 3) % SERIES.length], height: 18 })
      : null,
  ];
}

const TEMPLATES: { title: string; row: FormulaRow }[] = [
  {
    title: 'Conversion: B ÷ A as %',
    row: { expr: 'B / A', label: 'Conversion', format: 'percent' },
  },
  { title: 'Difference: A − B', row: { expr: 'A - B', label: 'Difference' } },
  {
    title: 'Share: A ÷ (A + B) as %',
    row: { expr: 'A / (A + B)', label: 'Share of A', format: 'percent' },
  },
];

export function formulaTemplates(onPick: (row: FormulaRow) => void): HTMLElement {
  return h(
    'div',
    { class: 'formula-templates' },
    TEMPLATES.map((t) =>
      h('button', { type: 'button', class: 'chip', onclick: () => onPick(t.row) }, t.title),
    ),
  );
}

export function formulaEditor(options: FormulaEditorOptions): HTMLElement {
  const row: FormulaRow = { ...options.row };
  const seriesCount = () => options.series().length;
  const hintList = h('ul', { class: 'formula-hints', role: 'listbox', hidden: true });
  const previewLine = h('div', { class: 'formula-preview', 'aria-live': 'polite' });
  let hints: Hint[] = [];
  let active = 0;
  let committed = row.expr;

  const check = () =>
    checkFormula(
      field.value,
      options.series().map((s) => s.label),
    );

  const paintPreview = () => {
    const r = check();
    if (!field.value.trim()) previewLine.replaceChildren();
    else if (r.ok)
      previewLine.replaceChildren(
        ...([preview(r.node, options.data(), row.format, options.index)].flat() as Node[]),
      );
    else previewLine.replaceChildren();
  };

  const mark = () => {
    const r = check();
    field.setMarkers(
      !field.value.trim() || r.ok ? [] : [{ start: r.at, end: r.end, message: r.message }],
    );
  };

  const paintHints = () => {
    hintList.hidden = hints.length === 0 || document.activeElement !== field.input;
    hintList.replaceChildren(
      ...hints.map((hint, i) =>
        h(
          'li',
          {
            role: 'option',
            class: i === active ? 'active' : '',
            'aria-selected': String(i === active),
            // Keep the focus in the field while clicking a suggestion.
            onmousedown: (e: Event) => {
              e.preventDefault();
              accept(i);
            },
          },
          hint.label,
          hint.detail ? h('span', { class: 'muted small' }, hint.detail) : null,
        ),
      ),
    );
  };

  const refreshHints = () => {
    hints = hintsAt(field, options.series());
    active = 0;
    paintHints();
  };

  function accept(i: number): void {
    const hint = hints[i];
    if (!hint) return;
    const caret = field.input.selectionStart;
    const range = hint.replace ?? { start: caret, end: caret };
    // No double spaces around operators.
    const before = field.value.slice(0, range.start);
    const insert = before.endsWith(' ') ? hint.insert.replace(/^ /, '') : hint.insert;
    field.replace(range.start, range.end, insert);
    refreshHints();
  }

  const commit = () => {
    const expr = field.value.trim();
    if (expr === committed) return;
    if (!expr) return options.onRemove();
    if (!check().ok) return;
    committed = expr;
    options.onCommit({ ...row, expr });
  };

  const caretSeries = () => {
    const caret = field.input.selectionStart;
    const t = lexFormula(field.value).find(
      (x) => x.kind === 'var' && x.start <= caret && caret <= x.end,
    );
    options.onSeries?.(t ? t.text.charCodeAt(0) - 65 : null);
  };

  const onKey = (e: KeyboardEvent): boolean => {
    const open = !hintList.hidden && hints.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      active = (active + (e.key === 'ArrowDown' ? 1 : hints.length - 1)) % hints.length;
      paintHints();
    } else if (open && (e.key === 'Tab' || (e.key === 'Enter' && hints[active]?.replace)))
      accept(active);
    else if (open && e.key === 'Escape') {
      hints = [];
      paintHints();
    } else if (e.key === 'Enter') {
      hints = [];
      paintHints();
      commit();
    } else return false;
    e.preventDefault();
    return true;
  };

  const field = codeField({
    value: row.expr,
    label: `Formula ${options.index + 1}`,
    tokenize: formulaTokens(seriesCount),
    className: 'code-formula',
    rows: 1,
    autoGrow: 96,
    placeholder: seriesCount() > 1 ? 'e.g. B / A' : 'e.g. A * 2, or add a second series',
    onInput: () => {
      mark();
      paintPreview();
    },
    onKeyDown: onKey,
    onCaret: () => {
      refreshHints();
      caretSeries();
    },
    onBlur: () => {
      hints = [];
      paintHints();
      options.onSeries?.(null);
      commit();
    },
  });
  field.input.addEventListener('focus', refreshHints);

  const label = h('input', {
    type: 'text',
    value: row.label ?? '',
    placeholder: 'Name, e.g. Signup rate',
    'aria-label': `Name of formula ${options.index + 1}`,
    class: 'formula-label',
  });
  label.addEventListener('change', () => {
    row.label = label.value.trim() || undefined;
    if (check().ok) options.onCommit({ ...row, expr: field.value.trim() });
  });

  const format = tabs(
    [
      { value: 'number', label: '123' },
      { value: 'percent', label: '%' },
    ],
    row.format ?? 'number',
    (v) => {
      row.format = v === 'percent' ? 'percent' : undefined;
      paintPreview();
      if (check().ok) options.onCommit({ ...row, expr: field.value.trim() });
    },
    'tabs-small formula-format',
  );

  mark();
  paintPreview();
  if (options.autofocus) queueMicrotask(() => field.focus());
  return h(
    'div',
    { class: 'formula-row' },
    h(
      'div',
      { class: 'formula-head' },
      // The same tag the formula's line gets in the results.
      h(
        'span',
        { class: 'series-tag formula-tag', title: `Formula ${options.index + 1}` },
        `ƒ${options.index + 1}`,
      ),
      label,
      format,
      iconButton('x', 'Remove formula', options.onRemove),
    ),
    h('div', { class: 'formula-field' }, field.el, hintList),
    previewLine,
  );
}
