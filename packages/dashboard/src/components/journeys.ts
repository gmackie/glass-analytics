import type { JourneyNode, JourneysResult } from '@dataflare/core/insights/journeys';
import { h, s } from '../dom.ts';
import { count } from '../format.ts';
import { SERIES } from './charts.ts';
import { empty, table } from './ui.ts';

/** Layered Sankey: equal-width units throughout; table is the accessible equivalent. */
export function journeyChart(result: JourneysResult): HTMLElement {
  if (!result.sessions) return empty('No matching session journeys in this interval.');
  const layers = new Map<number, JourneyNode[]>();
  for (const node of result.nodes) {
    const layer = layers.get(node.step) ?? [];
    layer.push(node);
    layers.set(node.step, layer);
  }
  for (const layer of layers.values())
    layer.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const maxNodes = Math.max(...[...layers.values()].map((l) => l.length));
  const height = Math.max(320, maxNodes * 40 + 180);
  const scale = (height - maxNodes * 25 - 70) / result.sessions;
  const width = Math.max(720, layers.size * 205);
  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': `${count(result.sessions)} session journeys; link width counts sessions. See transition table for values.`,
  });
  const positions = new Map<
    string,
    { x: number; y: number; h: number; incoming: number; outgoing: number }
  >();
  for (const [step, layer] of layers) {
    let y = 40;
    svg.append(
      s(
        'text',
        { x: 15 + step * 205, y: 18, fill: 'var(--muted)' },
        `${result.direction === 'backward' ? 'Reverse step' : 'Step'} ${step + 1}`,
      ),
    );
    for (const node of layer) {
      const nodeHeight = node.count * scale;
      positions.set(node.id, { x: 15 + step * 205, y, h: nodeHeight, incoming: 0, outgoing: 0 });
      y += nodeHeight + 25;
    }
  }
  const names = new Map(result.nodes.map((n) => [n.id, `${n.step + 1}: ${n.label}`]));
  for (const edge of result.edges) {
    const from = positions.get(edge.source)!;
    const to = positions.get(edge.target)!;
    const thickness = edge.count * scale;
    const y1 = from.y + from.outgoing + thickness / 2;
    const y2 = to.y + to.incoming + thickness / 2;
    from.outgoing += thickness;
    to.incoming += thickness;
    const path = s(
      'path',
      {
        d: `M${from.x + 12},${y1} C${from.x + 110},${y1} ${to.x - 90},${y2} ${to.x},${y2}`,
        fill: 'none',
        stroke: SERIES[0]!,
        'stroke-opacity': 0.3,
        'stroke-width': thickness,
        tabindex: '0',
        role: 'img',
        'aria-label': `${names.get(edge.source)} to ${names.get(edge.target)}: ${count(edge.count)} sessions`,
      },
      s(
        'title',
        {},
        `${names.get(edge.source)} → ${names.get(edge.target)}: ${count(edge.count)} sessions`,
      ),
    );
    svg.append(path);
  }
  for (const node of result.nodes) {
    const p = positions.get(node.id)!;
    const group = s(
      'g',
      {
        tabindex: '0',
        role: 'img',
        'aria-label': `${names.get(node.id)}: ${count(node.count)} sessions`,
      },
      s('title', {}, `${node.label}: ${count(node.count)} sessions`),
      s('rect', {
        x: p.x,
        y: p.y,
        width: 12,
        height: p.h,
        rx: 2,
        fill: SERIES[node.kind === 'termination' ? 2 : node.step % SERIES.length]!,
      }),
      s(
        'text',
        { x: p.x + 17, y: p.y + Math.min(p.h / 2 + 4, 14), fill: 'var(--ink)', 'font-size': 11 },
        `${node.label.length > 22 ? node.label.slice(0, 21) + '…' : node.label} · ${count(node.count)}`,
      ),
    );
    svg.append(group);
  }
  const exportButton = h(
    'button',
    {
      type: 'button',
      class: 'ghost small',
      onclick: () => {
        const copy = svg.cloneNode(true) as SVGElement;
        // Resolve theme colours so the exported image remains legible outside the app.
        const originals = [svg, ...svg.querySelectorAll('*')];
        const copies = [copy, ...copy.querySelectorAll('*')];
        originals.forEach((el, i) => {
          const style = getComputedStyle(el);
          copies[i]!.setAttribute(
            'style',
            `fill:${style.fill};stroke:${style.stroke};font-family:system-ui,sans-serif`,
          );
        });
        copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        const url = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }),
        );
        const link = h('a', { href: url, download: 'dataflare-journeys.svg' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    },
    'Export SVG',
  );
  return h(
    'div',
    { class: 'journey-view' },
    h(
      'p',
      { class: 'muted small' },
      `Unit: sessions. Observation cutoff: ${result.observation.asOf}. Context is bounded; observed ends do not establish abandonment. ${result.limits.pruned ? 'Low-volume labels are combined as Other.' : ''}`,
    ),
    exportButton,
    h('div', { class: 'journey-sankey', style: 'overflow-x:auto;max-width:100%' }, svg),
    h(
      'details',
      {},
      h('summary', {}, 'Transition table'),
      table(
        ['From', 'To', 'Sessions'],
        result.edges.map((e) => [
          names.get(e.source) ?? '',
          names.get(e.target) ?? '',
          count(e.count),
        ]),
      ),
    ),
  );
}
