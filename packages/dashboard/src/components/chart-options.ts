/**
 * How a trends chart is drawn, as a popover on the chart toolbar: cumulative, smoothing,
 * trend line, log scale, 100% stacking, values on the points, and showing only the
 * formulas. The button carries a count while any of them is on.
 */

import { h } from '../dom.ts';
import { icon } from './icons.ts';
import type { Spec } from './insight-rail.ts';
import { setOption } from './insight-rail.ts';
import { popover, selectMenu, toggle } from './menu.ts';

interface ChartContext {
  /** Line, area or bar: the options that draw on a time axis apply. */
  timeChart: boolean;
  /** More than one line: stacking to 100% makes sense. */
  lines: number;
  hasFormulas: boolean;
}

const FLAGS: { key: string; label: string; when: (c: ChartContext) => boolean }[] = [
  { key: 'cumulative', label: 'Cumulative', when: () => true },
  { key: 'formulaOnly', label: 'Only the formulas', when: (c) => c.hasFormulas },
  { key: 'trendLine', label: 'Trend line', when: (c) => c.timeChart },
  { key: 'logScale', label: 'Log scale', when: (c) => c.timeChart },
  { key: 'percentStack', label: 'Stack to 100%', when: (c) => c.timeChart && c.lines > 1 },
  { key: 'showValues', label: 'Show values', when: (c) => c.timeChart },
];

/** How many chart options are on, among those that apply. */
function chartOptionsSet(spec: Spec, ctx: ChartContext): number {
  const flags = FLAGS.filter((f) => f.when(ctx) && spec[f.key]).length;
  return flags + (spec.smoothing ? 1 : 0);
}

function body(spec: Spec, update: () => void, ctx: ChartContext): HTMLElement {
  return h(
    'div',
    { class: 'stack tight chart-options' },
    selectMenu({
      value: String(spec.smoothing ?? 0),
      label: 'Smoothing',
      options: [
        { value: '0', label: 'No smoothing' },
        { value: '7', label: '7-interval average' },
        { value: '28', label: '28-interval average' },
      ],
      width: 220,
      onChange: (v) => {
        setOption(spec, 'smoothing', Number(v), 0);
        update();
      },
    }),
    FLAGS.filter((f) => f.when(ctx)).map((f) =>
      toggle({
        checked: Boolean(spec[f.key]),
        label: f.label,
        onChange: (c) => {
          setOption(spec, f.key, c);
          update();
        },
      }),
    ),
  );
}

export function chartOptionsButton(spec: Spec, update: () => void, ctx: ChartContext): HTMLElement {
  const on = chartOptionsSet(spec, ctx);
  const trigger = h(
    'button',
    {
      type: 'button',
      class: 'select-trigger chart-options-trigger',
      'aria-label': 'Chart options',
    },
    icon('sliders', 14),
    'Options',
    on ? h('span', { class: 'fold-count' }, String(on)) : '',
  );
  popover(trigger, () => body(spec, update, ctx), { align: 'end', width: 260 });
  return trigger;
}
