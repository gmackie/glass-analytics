export type Region = { x: number; y: number; width: number; height: number };
export type PaneLayout = { axis: 'row' | 'column'; first: number; gap: number };

/** All coordinates are relative to the safe-area content view used by both panes. */
export function paneLayout(
  width: number,
  height: number,
  division: Region | null,
): PaneLayout | null {
  if (division && width > 0 && height > 0) {
    const vertical = division.height > division.width;
    const first = vertical ? division.x : division.y;
    const gap = vertical ? division.width : division.height;
    const available = vertical ? width : height;
    if (first > 0 && first + gap < available)
      return { axis: vertical ? 'row' : 'column', first, gap };
  }
  // Two readable columns need room for a site picker and a 360-point report.
  if (width < 640) return null;
  return { axis: 'row', first: Math.min(310, Math.round(width * 0.35)), gap: 1 };
}

export type CompactPage = 'auto' | 'sites' | 'report';

export function visiblePanes(expanded: boolean, count: number, page: CompactPage) {
  if (!count) return 'sites';
  if (expanded) return 'both';
  if (page === 'auto') return count === 1 ? 'report' : 'sites';
  return page;
}
