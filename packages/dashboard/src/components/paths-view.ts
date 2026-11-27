/**
 * Paths results: the flow chart (or the top whole paths), and what a step can do — start or
 * end paths there, leave it out, group its siblings, list who reached or left it, or turn the
 * way there into a funnel.
 */

import type { PathNode, PathsResult } from '@dataflare/core/insights/paths';
import { dashboardUsage } from '../app-usage.ts';
import { h } from '../dom.ts';
import { count } from '../format.ts';
import { go } from '../state.ts';
import { showActors } from './insight-options.ts';
import type { Spec } from './insight-rail.ts';
import { type PathAction, sankey, topPathsTable } from './sankey.ts';
import { empty } from './ui.ts';

export interface PathsViewOptions {
  display: string;
  noun: [string, string];
  /** The spec as it runs (for drill-downs). */
  shared: Spec;
  /** Change the analysis: the callback edits the spec, then it runs again. */
  edit: (change: (spec: Spec) => void) => void;
}

const isPage = (label: string) => label.startsWith('/');
/** A label that names one page or event (not a group, or a cleaned path with :ids). */
const isConcrete = (label: string) => !label.includes('*') && !/\/:[a-z]/i.test(label);

const pointOf = (label: string) => ({ type: isPage(label) ? 'page' : 'event', value: label });

/** "/blog/launch" → "/blog/*": the pages next to this one. */
function siblingsGlob(label: string): string | null {
  if (!isPage(label)) return null;
  const parts = label.split('/');
  if (parts.length < 3 || !parts[parts.length - 1]) return null;
  return `${parts.slice(0, -1).join('/')}/*`;
}

/** The busiest way into a step: its strongest incoming link, back to the first column. */
function wayTo(r: PathsResult, node: PathNode): PathNode[] {
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const way = [node];
  let at = node.id;
  for (;;) {
    const best = r.links.filter((l) => l.target === at).sort((a, b) => b.count - a.count)[0];
    const prev = best ? byId.get(best.source) : undefined;
    if (!prev || prev.other) return way;
    way.unshift(prev);
    at = prev.id;
  }
}

function funnelStep(label: string) {
  return isPage(label)
    ? { event: '$pageview', filters: [{ property: 'path', value: label }], label }
    : { event: label };
}

function openFunnel(labels: string[]): void {
  const steps = labels.filter(isConcrete).map(funnelStep);
  if (steps.length < 2) return;
  go('insights/new/funnel', { spec: JSON.stringify({ steps: steps.slice(0, 20), window: '1d' }) });
}

const list = (spec: Spec, key: string) =>
  ((spec[key] as string[] | undefined) ?? []).filter(Boolean);

function editActions(node: PathNode, o: PathsViewOptions): PathAction[] {
  const glob = siblingsGlob(node.label);
  const out: PathAction[] = [
    {
      label: 'Start paths here',
      run: () =>
        o.edit((spec) => {
          spec.start = pointOf(node.label);
          delete spec.funnel;
        }),
    },
    {
      label: 'End paths here',
      run: () =>
        o.edit((spec) => {
          spec.end = pointOf(node.label);
          delete spec.funnel;
        }),
    },
    {
      label: 'Leave this step out',
      run: () =>
        o.edit((spec) => {
          spec.exclude = [...list(spec, 'exclude'), node.label];
        }),
    },
  ];
  if (glob)
    out.push({
      label: `Show ${glob} as one step`,
      run: () =>
        o.edit((spec) => {
          spec.groups = [...list(spec, 'groups'), glob];
        }),
    });
  return out;
}

function nodeActions(r: PathsResult, node: PathNode, o: PathsViewOptions): PathAction[] {
  const who = (selection: Record<string, unknown>, title: string) => () =>
    showActors('paths', o.shared, selection, title);
  const out = editActions(node, o);
  out.push({
    label: `Who reached it (${count(node.count)})`,
    run: who({ node: node.id }, `Who reached ${node.label}`),
  });
  if (node.dropOff && r.direction === 'forward')
    out.push({
      label: `Who stopped here (${count(node.dropOff)})`,
      run: who({ node: node.id, dropOff: true }, `Who stopped at ${node.label}`),
    });
  const way = wayTo(r, node).map((n) => n.label);
  if (way.filter(isConcrete).length >= 2)
    out.push({ label: 'Make a funnel of the way here', run: () => openFunnel(way) });
  return out;
}

export function pathsView(r: PathsResult, o: PathsViewOptions): HTMLElement {
  if (!r.total)
    return empty(
      'No paths in this range. Widen the dates, start elsewhere, or include events.',
      undefined,
      {
        icon: 'paths',
      },
    );
  const body =
    o.display === 'top'
      ? topPathsTable(r, o.noun, openFunnel)
      : sankey(r, {
          noun: o.noun,
          actions: (node) => {
            dashboardUsage.detail('step');
            return nodeActions(r, node, o);
          },
          onLink: (l) => {
            dashboardUsage.detail('transition');
            showActors(
              'paths',
              o.shared,
              { node: l.source, target: l.target },
              `Who went ${l.source.replace(/^\d+:/, '')} → ${l.target.replace(/^\d+:/, '')}`,
            );
          },
        });
  return h('div', { class: 'paths-view' }, body);
}

/** Under a funnel: open paths around one of its steps. */
export function funnelPathsMenu(steps: number, shared: Spec): HTMLElement {
  const funnel = {
    ...shared,
    kind: undefined,
    project: undefined,
    from: undefined,
    to: undefined,
    viz: undefined,
  };
  const open = (step: number, mode: string) =>
    go('insights/new/paths', {
      spec: JSON.stringify({ funnel: { spec: funnel, step, mode }, steps: 5 }),
    });
  const chip = (label: string, step: number, mode: string) =>
    h('button', { type: 'button', class: 'chip', onclick: () => open(step, mode) }, label);
  return h(
    'div',
    { class: 'row people-row' },
    h('span', { class: 'muted small' }, 'Paths:'),
    Array.from({ length: steps }, (_, i) => [
      chip(`after ${i + 1}`, i + 1, 'after'),
      i > 0 ? chip(`drop-offs before ${i + 1}`, i + 1, 'dropoff') : null,
    ]),
  );
}
