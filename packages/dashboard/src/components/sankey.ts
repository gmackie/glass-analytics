/**
 * The paths chart: a column per step, a bar per page or event, and bands between them as wide
 * as the people who went that way. Hovering a step traces everything that leads to it and
 * away from it; drop-offs are a faded stub to its right. Clicking a step opens its menu.
 * Narrow screens (under 460px) get the same data as a list per step.
 */

import type { PathLink, PathNode, PathsResult } from '@dataflare/core/insights/paths';
import { type Child, h, mount, s } from '../dom.ts';
import { count, duration, percent } from '../format.ts';
import { SERIES } from './charts.ts';
import { icon } from './icons.ts';
import { popover } from './menu.ts';

export interface PathAction {
  label: string;
  run: () => void;
}

export interface SankeyOptions {
  /** What was counted: [one, many]. */
  noun: [string, string];
  /** The menu for a step. */
  actions: (node: PathNode) => PathAction[];
  onStepOpen?: () => void;
  /** Clicking a band: the people who went that way. */
  onLink?: (link: PathLink) => void;
}

/** "1 person", "3 people". */
const counted = (n: number, [one, many]: [string, string]) => `${count(n)} ${n === 1 ? one : many}`;

const NODE_W = 10;
const GAP = 10;
const PAD = { top: 8, bottom: 8, left: 4, right: 130 };
const NARROW = 460;

interface Box {
  node: PathNode;
  x: number;
  y: number;
  h: number;
  /** Where the next outgoing and incoming bands attach. */
  outY: number;
  inY: number;
}

interface Layout {
  W: number;
  H: number;
  scale: number;
  boxes: Map<string, Box>;
  colX: (column: number) => number;
}

function columnsOf(nodes: PathNode[]): Map<number, PathNode[]> {
  const out = new Map<number, PathNode[]>();
  for (const n of nodes) out.set(n.column, [...(out.get(n.column) ?? []), n]);
  return out;
}

/** People per pixel: the busiest column fills the height, less its gaps. */
function scaleFor(columns: Map<number, PathNode[]>, inner: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const list of columns.values()) {
    const total = list.reduce((sum, n) => sum + n.count, 0);
    if (total) best = Math.min(best, (inner - GAP * (list.length - 1)) / total);
  }
  return Number.isFinite(best) ? best : 1;
}

function layout(r: PathsResult, W: number): Layout {
  const columns = columnsOf(r.nodes);
  const tallest = Math.max(1, ...[...columns.values()].map((l) => l.length));
  const H = Math.max(240, Math.min(560, tallest * 46));
  const inner = H - PAD.top - PAD.bottom;
  const scale = scaleFor(columns, inner);
  const span = Math.max(1, r.steps - 1);
  const colX = (c: number) => PAD.left + ((c - 1) / span) * (W - PAD.left - PAD.right - NODE_W);
  const boxes = new Map<string, Box>();
  for (const [column, list] of columns) {
    let y = PAD.top;
    for (const node of list) {
      const height = Math.max(2, node.count * scale);
      boxes.set(node.id, { node, x: colX(column), y, h: height, outY: y, inY: y });
      y += height + GAP;
    }
  }
  return { W, H, scale, boxes, colX };
}

/** Neighbours in either direction, for tracing a step's whole flow. */
function reach(links: PathLink[], from: string, forward: boolean): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    for (const l of links) {
      const [a, b] = forward ? [l.source, l.target] : [l.target, l.source];
      if (a === at && !seen.has(b)) {
        seen.add(b);
        queue.push(b);
      }
    }
  }
  return seen;
}

const colorOf = (node: PathNode) =>
  node.other ? 'var(--muted)' : SERIES[(node.column - 1) % SERIES.length]!;

function band(l: PathLink, L: Layout): SVGElement | null {
  const a = L.boxes.get(l.source);
  const b = L.boxes.get(l.target);
  if (!a || !b) return null;
  const width = Math.max(1, l.count * L.scale);
  const y0 = a.outY + width / 2;
  const y1 = b.inY + width / 2;
  a.outY += width;
  b.inY += width;
  const x0 = a.x + NODE_W;
  const x1 = b.x;
  const mid = (x0 + x1) / 2;
  return s('path', {
    d: `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1}`,
    'stroke-width': width,
    stroke: colorOf(a.node),
    class: 'sankey-link',
    'data-source': l.source,
    'data-target': l.target,
  });
}

function dropStub(box: Box, L: Layout): SVGElement | null {
  if (!box.node.dropOff) return null;
  const height = Math.max(1, box.node.dropOff * L.scale);
  return s('rect', {
    x: box.x + NODE_W,
    y: box.outY,
    width: 18,
    height,
    class: 'sankey-drop',
    'data-node': box.node.id,
  });
}

function nodeLabel(box: Box): SVGElement {
  const text = box.node.label.length > 26 ? `${box.node.label.slice(0, 25)}…` : box.node.label;
  return s(
    'text',
    { x: box.x + NODE_W + 6, y: box.y + Math.min(box.h / 2, 12) + 4, class: 'sankey-label' },
    text,
    s('tspan', { class: 'sankey-count' }, ` ${count(box.node.count)}`),
  );
}

function nodeRect(box: Box): SVGElement {
  return s('rect', {
    x: box.x,
    y: box.y,
    width: NODE_W,
    height: box.h,
    rx: 2,
    fill: colorOf(box.node),
    class: `sankey-node ${box.node.other ? 'other' : ''}`,
    'data-node': box.node.id,
    tabindex: box.node.other ? -1 : 0,
    role: 'button',
    'aria-label': `${box.node.label}: ${box.node.count}`,
  });
}

function nodeReadout(n: PathNode, r: PathsResult, noun: [string, string]): Child[] {
  const share = r.total ? n.count / r.total : 0;
  return [
    h('strong', {}, n.label),
    h('span', {}, `${counted(n.count, noun)} · ${percent(share, 1)} of all paths`),
    n.dropOff
      ? h(
          'span',
          { class: 'muted' },
          `${count(n.dropOff)} stopped here (${percent(n.dropOff / n.count, 0)})`,
        )
      : null,
    n.other ? h('span', { class: 'muted' }, 'Several rarer steps, grouped') : null,
  ];
}

function linkReadout(l: PathLink, L: Layout, noun: [string, string]): Child[] {
  const from = L.boxes.get(l.source)?.node;
  const to = L.boxes.get(l.target)?.node;
  return [
    h('strong', {}, `${from?.label ?? ''} → ${to?.label ?? ''}`),
    h(
      'span',
      {},
      `${counted(l.count, noun)}${from?.count ? ` · ${percent(l.count / from.count, 0)} of ${from.label}` : ''}`,
    ),
    l.avgSeconds !== null
      ? h('span', { class: 'muted' }, `${duration(l.avgSeconds)} on average`)
      : null,
  ];
}

/** Dim everything but what flows into and out of a step (or one band). */
function highlight(svg: SVGElement, ids: Set<string> | null): void {
  svg.classList.toggle('tracing', ids !== null);
  for (const el of svg.querySelectorAll<SVGElement>('[data-node]'))
    el.classList.toggle('lit', ids?.has(el.dataset.node!) ?? false);
  for (const el of svg.querySelectorAll<SVGElement>('.sankey-link'))
    el.classList.toggle(
      'lit',
      Boolean(ids?.has(el.dataset.source!) && ids.has(el.dataset.target!)),
    );
}

function nodeMenu(trigger: SVGElement, node: PathNode, o: SankeyOptions): void {
  const actions = o.actions(node);
  if (!actions.length) return;
  popover(
    trigger as unknown as HTMLElement,
    (close) =>
      h(
        'div',
        { class: 'menu', role: 'menu' },
        h('div', { class: 'menu-title' }, node.label),
        actions.map((a) =>
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item',
              role: 'menuitem',
              onclick: () => {
                close();
                a.run();
              },
            },
            a.label,
          ),
        ),
      ),
    { onOpen: o.onStepOpen },
  );
}

interface Hover {
  svg: SVGElement;
  readout: HTMLElement;
  r: PathsResult;
  L: Layout;
  o: SankeyOptions;
}

function showReadout(hv: Hover, e: MouseEvent, content: Child[]): void {
  const rect = hv.svg.getBoundingClientRect();
  hv.readout.hidden = false;
  mount(hv.readout, ...content);
  hv.readout.style.left = `${Math.min(e.clientX - rect.left + 12, rect.width - 220)}px`;
  hv.readout.style.top = `${e.clientY - rect.top + 12}px`;
}

function onHover(hv: Hover, e: Event): void {
  const t = e.target as SVGElement;
  if (t.dataset.node) {
    const node = hv.L.boxes.get(t.dataset.node)?.node;
    if (!node) return;
    const ids = new Set([
      ...reach(hv.r.links, node.id, true),
      ...reach(hv.r.links, node.id, false),
    ]);
    highlight(hv.svg, ids);
    showReadout(hv, e as MouseEvent, nodeReadout(node, hv.r, hv.o.noun));
  } else if (t.classList.contains('sankey-link')) {
    const link = hv.r.links.find(
      (l) => l.source === t.dataset.source && l.target === t.dataset.target,
    );
    if (!link) return;
    highlight(hv.svg, new Set([link.source, link.target]));
    showReadout(hv, e as MouseEvent, linkReadout(link, hv.L, hv.o.noun));
  }
}

function wire(hv: Hover): void {
  hv.svg.addEventListener('mousemove', (e) => onHover(hv, e));
  hv.svg.addEventListener('mouseleave', () => {
    highlight(hv.svg, null);
    hv.readout.hidden = true;
  });
  for (const el of hv.svg.querySelectorAll<SVGElement>('.sankey-node:not(.other)')) {
    const node = hv.L.boxes.get(el.dataset.node!)?.node;
    if (node) nodeMenu(el, node, hv.o);
  }
  hv.svg.addEventListener('click', (e) => {
    const t = e.target as SVGElement;
    if (!t.classList.contains('sankey-link') || !hv.o.onLink) return;
    const link = hv.r.links.find(
      (l) => l.source === t.dataset.source && l.target === t.dataset.target,
    );
    if (link) hv.o.onLink(link);
  });
}

function sankeySvg(r: PathsResult, W: number, readout: HTMLElement, o: SankeyOptions): SVGElement {
  const L = layout(r, W);
  const links = r.links.map((l) => band(l, L)).filter((x) => x !== null);
  const boxes = [...L.boxes.values()];
  const drops = boxes.map((b) => dropStub(b, L)).filter((x) => x !== null);
  const svg = s(
    'svg',
    {
      viewBox: `0 0 ${W} ${L.H}`,
      width: W,
      height: L.H,
      class: 'sankey',
      role: 'img',
      'aria-label': 'Paths',
    },
    ...links,
    ...drops,
    ...boxes.map(nodeRect),
    ...boxes.map(nodeLabel),
  );
  wire({ svg, readout, r, L, o });
  return svg;
}

function listRow(n: PathNode, max: number, o: SankeyOptions): HTMLElement {
  const row = h(
    'button',
    { type: 'button', class: 'sankey-list-row', disabled: n.other },
    h('span', { class: 'sankey-list-bar', style: `width:${(n.count / max) * 100}%` }),
    h('span', { class: 'sankey-list-label' }, n.label),
    h('span', { class: 'sankey-list-count' }, count(n.count)),
  );
  if (!n.other) nodeMenu(row as unknown as SVGElement, n, o);
  return row;
}

/** Under 460px: each step as a list of bars. */
function sankeyList(r: PathsResult, o: SankeyOptions): HTMLElement {
  const columns = columnsOf(r.nodes);
  const max = Math.max(1, ...r.nodes.map((n) => n.count));
  return h(
    'ol',
    { class: 'sankey-list' },
    [...columns.entries()].map(([column, list]) =>
      h(
        'li',
        {},
        h('div', { class: 'sankey-list-step' }, `Step ${column}`),
        list.map((n) => listRow(n, max, o)),
      ),
    ),
  );
}

export function sankey(r: PathsResult, o: SankeyOptions): HTMLElement {
  const holder = h('div', { class: 'sankey-canvas' });
  const readout = h('div', { class: 'readout sankey-readout', hidden: true });
  const wrap = h('div', { class: 'sankey-wrap' }, holder, readout);
  let last = 0;
  const draw = (width: number) => {
    const w = Math.round(width);
    if (w < 40 || w === last) return;
    last = w;
    mount(holder, w < NARROW ? sankeyList(r, o) : sankeySvg(r, w, readout, o));
  };
  draw(900);
  if (typeof ResizeObserver !== 'undefined')
    new ResizeObserver((entries) => draw(entries[0]?.contentRect.width ?? 0)).observe(wrap);
  return wrap;
}

/** The most common whole paths, as a table with a bar for each. */
export function topPathsTable(
  r: PathsResult,
  noun: [string, string],
  onPick: (items: string[]) => void,
): HTMLElement {
  const max = Math.max(1, ...r.topPaths.map((p) => p.count));
  return h(
    'ol',
    { class: 'top-paths' },
    r.topPaths.map((p) =>
      h(
        'li',
        {},
        h('span', { class: 'top-path-bar', style: `width:${(p.count / max) * 100}%` }),
        h(
          'span',
          { class: 'top-path-steps' },
          p.items.map((item, i) => [
            i ? icon('chevronRight', 12) : null,
            h('span', { class: 'top-path-step' }, item),
          ]),
        ),
        h(
          'span',
          { class: 'top-path-count' },
          `${counted(p.count, noun)} · ${percent(r.total ? p.count / r.total : 0, 1)}`,
        ),
        h(
          'button',
          { type: 'button', class: 'link-button small', onclick: () => onPick(p.items) },
          'Funnel',
        ),
      ),
    ),
  );
}
