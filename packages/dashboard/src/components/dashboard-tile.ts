/**
 * A dashboard tile's body: the analysis run with the dashboard's range and filters, drawn
 * compactly for its kind (a line or bars, a big number, funnel steps, a retention curve, the
 * top paths), and text tiles in a small, safe Markdown.
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { PathsResult } from '@dataflare/core/insights/paths';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import { api } from '../api.ts';
import { type Child, h } from '../dom.ts';
import { count, percent } from '../format.ts';
import { scope } from '../state.ts';
import { lineChart } from './charts.ts';
import { empty, later } from './ui.ts';

export interface TileView {
  id: string;
  kind: 'insight' | 'text';
  text: string | null;
  width: number;
  height: number;
  ignoreFilters: boolean;
  overrides: Record<string, unknown>;
  insight?: { key: string; name: string; kind: string; spec: Record<string, unknown> } | null;
  runSpec?: Record<string, unknown>;
}

const chartHeight = (t: TileView) => (t.height === 2 ? 380 : 200);

/** Views that compare totals (by breakdown value) rather than show time. */
const TOTAL_VIEWS = new Set(['bar_value', 'world_map', 'pie', 'table']);

function totalsList(lines: TrendsResult['series']): Child {
  const sorted = [...lines].sort((a, b) => b.total - a.total).slice(0, 8);
  const max = Math.max(1, ...sorted.map((s) => s.total));
  return h(
    'ol',
    { class: 'tile-funnel' },
    sorted.map((s) =>
      h(
        'li',
        {},
        h('span', { class: 'tile-funnel-bar', style: `width:${(s.total / max) * 100}%` }),
        h('span', { class: 'tile-funnel-label' }, s.breakdown || '(none)'),
        h('span', { class: 'tile-funnel-value' }, count(s.total)),
      ),
    ),
  );
}

function trendsBody(r: TrendsResult, t: TileView, display: string): Child {
  const lines = [...r.series, ...(r.formulas ?? [])].slice(0, 6);
  const first = lines[0];
  if (!first) return empty('No data in this range.');
  const percentLine = first.format === 'percent';
  if (TOTAL_VIEWS.has(display)) return totalsList(lines);
  if (display === 'number')
    return h(
      'div',
      { class: 'tile-number' },
      percentLine ? percent(first.values.at(-1) ?? 0) : count(first.total),
      h('span', { class: 'muted small' }, first.breakdown ?? first.label),
    );
  return lineChart(
    r.buckets,
    lines.map((s) => ({
      label: s.breakdown ?? s.label,
      values: s.values,
      ...(s.format ? { format: (n: number) => percent(n, 1) } : {}),
    })),
    r.interval,
    {
      height: chartHeight(t),
      type:
        display === 'bar' || display === 'bar_value' ? 'bar' : display === 'area' ? 'area' : 'line',
      legend: lines.length > 1,
    },
  );
}

function funnelBody(r: FunnelResult): Child {
  const first = r.steps[0]?.count ?? 0;
  if (!first) return empty('No one started the funnel in this range.');
  return h(
    'ol',
    { class: 'tile-funnel' },
    r.steps.map((s) =>
      h(
        'li',
        {},
        h('span', { class: 'tile-funnel-bar', style: `width:${(s.count / first) * 100}%` }),
        h('span', { class: 'tile-funnel-label' }, s.label),
        h(
          'span',
          { class: 'tile-funnel-value' },
          `${percent(s.count / first, 1)} · ${count(s.count)}`,
        ),
      ),
    ),
  );
}

function retentionBody(r: RetentionResult, t: TileView): Child {
  if (r.average.length < 2) return empty('Not enough periods yet.');
  return lineChart(
    r.average.map((_, k) => k),
    [{ label: 'Retained', values: r.average }],
    'day',
    {
      height: chartHeight(t),
      type: 'area',
      yMax: 1,
      format: (n) => percent(n, 0),
      labels: r.average.map((_, k) => `${r.period[0]!.toUpperCase()}${k}`),
    },
  );
}

function pathsBody(r: PathsResult, t: TileView): Child {
  const top = r.topPaths.slice(0, t.height === 2 ? 10 : 5);
  if (!top.length) return empty('No paths in this range.');
  return h(
    'ol',
    { class: 'tile-paths' },
    top.map((p) =>
      h(
        'li',
        {},
        h('span', { class: 'tile-path' }, p.items.join(' → ')),
        h('span', { class: 'muted' }, count(p.count)),
      ),
    ),
  );
}

function resultBody(kind: string, r: unknown, t: TileView, display: string): Child {
  if (kind === 'funnel') return funnelBody(r as FunnelResult);
  if (kind === 'retention') return retentionBody(r as RetentionResult, t);
  if (kind === 'paths') return pathsBody(r as PathsResult, t);
  return trendsBody(r as TrendsResult, t, display);
}

/** The tile's result, run now (or again after `refresh`). */
export function tileBody(t: TileView, onComputed: (at: Date) => void): HTMLElement {
  if (t.kind === 'text') return h('div', { class: 'tile-text' }, markdownLite(t.text ?? ''));
  if (!t.insight) return empty('This analysis was deleted.', undefined, { icon: 'alert' });
  const insight = t.insight;
  const sc = scope();
  const spec = { ...(t.runSpec ?? insight.spec) };
  const body = {
    kind: insight.kind,
    ...spec,
    from: (spec.from as string | undefined) ?? sc.from,
    to: (spec.to as string | undefined) ?? sc.to,
    project: sc.project,
  };
  const display = String(t.overrides.display ?? insight.spec.display ?? 'line');
  return later(
    async () => {
      const r = await api.post<unknown>('/api/query', body);
      onComputed(new Date());
      return resultBody(insight.kind, r, t, display);
    },
    'Running',
    'chart',
  );
}

// ── Markdown-lite ───────────────────────────────────────────────────────────

const INLINE = /(\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/;

/** Bold, italics and http(s) links, as DOM nodes (never HTML strings). */
function inline(text: string): Child[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) return h('strong', {}, part.slice(2, -2));
      if (part.startsWith('_') && part.endsWith('_') && part.length > 2)
        return h('em', {}, part.slice(1, -1));
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
      if (link)
        return h('a', { href: link[2]!, target: '_blank', rel: 'noopener noreferrer' }, link[1]!);
      return part;
    });
}

/** Headings (#, ##), lists (- or *), and paragraphs. */
function markdownLite(source: string): Child[] {
  const out: Child[] = [];
  let list: HTMLElement | null = null;
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      list ??= h('ul', {});
      list.append(h('li', {}, inline(item[1]!)));
      continue;
    }
    if (list) out.push(list);
    list = null;
    if (!line.trim()) continue;
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    out.push(
      heading
        ? h(heading[1]!.length === 1 ? 'h3' : 'h4', {}, inline(heading[2]!))
        : h('p', {}, inline(line)),
    );
  }
  if (list) out.push(list);
  return out;
}
