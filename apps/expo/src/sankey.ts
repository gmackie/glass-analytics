import type { PathLink, PathNode } from '@dataflare/core/insights/paths';
import type { Paths } from './data.ts';

export const railWidth = 9;
export const touchHeight = 44;
const minColumnWidth = 132;
const headingHeight = 28;

export type NodeBox = { node: PathNode; x: number; y: number; height: number; labelY: number };
type Band = { link: PathLink; path: string; width: number; source: PathNode };
type Slot = NodeBox & { outgoing: number; incoming: number };

/** One scale across all columns. Small steps keep a full touch target around their actual flow. */
export function sankeyLayout(paths: Paths, viewport: number) {
  const columns = new Map<number, PathNode[]>();
  for (const node of paths.nodes) {
    const column = columns.get(node.column) ?? [];
    column.push(node);
    columns.set(node.column, column);
  }
  const last = Math.max(1, ...columns.keys());
  const width = Math.max(viewport, last * minColumnWidth);
  const pitch = width / last;
  const totals = Array.from(columns.values(), (list) => list.reduce((sum, n) => sum + n.count, 0));
  const scale = 148 / Math.max(1, ...totals);
  const boxes = new Map<string, Slot>();
  let height = headingHeight;
  for (const [column, nodes] of columns) {
    let top = headingHeight;
    for (const node of nodes) {
      const barHeight = Math.max(2, node.count * scale);
      const slot = Math.max(touchHeight, barHeight);
      const y = top + (slot - barHeight) / 2;
      boxes.set(node.id, {
        node,
        x: (column - 1) * pitch,
        y,
        height: barHeight,
        labelY: top + (slot - touchHeight) / 2,
        incoming: y,
        outgoing: y,
      });
      top += slot + 8;
    }
    height = Math.max(height, top);
  }
  const bands: Band[] = [];
  for (const link of paths.links) {
    const source = boxes.get(link.source);
    const target = boxes.get(link.target);
    if (!source || !target || !link.count) continue;
    const thickness = link.count * scale;
    const y1 = source.outgoing + thickness / 2;
    const y2 = target.incoming + thickness / 2;
    const x1 = source.x + railWidth;
    const x2 = target.x;
    const middle = (x1 + x2) / 2;
    source.outgoing += thickness;
    target.incoming += thickness;
    bands.push({
      link,
      source: source.node,
      width: thickness,
      path: `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`,
    });
  }
  return {
    width,
    height,
    pitch,
    scale,
    columns: [...columns.keys()],
    nodes: [...boxes.values()],
    bands,
  };
}
