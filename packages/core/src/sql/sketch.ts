/**
 * Percentile sketches: medians and p75/p90/p95/p99 without window functions.
 *
 * SQL groups values into logarithmic buckets (each 2% wider than the last) and
 * counts them; JavaScript walks the counts to the requested rank. A bucket's
 * representative value is within 1% of every value in it, so a quantile is
 * accurate to 1% relative error however many values there are, and the SQL
 * returns at most a few hundred rows per group. Zero and negative values have
 * their own buckets. This is the idea behind DDSketch, which ClickHouse-backed
 * tools use for the same numbers.
 */

import type { Dialect } from './dialect.ts';

/** Bucket growth factor: 2% wider per bucket, so representatives are within 1%. */
export const SKETCH_GAMMA = 1.02;
const LN_GAMMA = Math.log(SKETCH_GAMMA);

/**
 * The sketch columns for a numeric expression: `sign` (-1, 0 or 1) and `k`, the
 * log bucket of its absolute value (0 for zero). `abs(x) + (x = 0)` keeps ln away
 * from zero without relying on CASE short-circuiting, which engines don't promise.
 */
export function sketchColumns(d: Dialect, value: string): { sign: string; key: string } {
  return {
    sign: `(CASE WHEN ${value} > 0 THEN 1 WHEN ${value} < 0 THEN -1 ELSE 0 END)`,
    key: d.logBucket(`(abs(${value}) + (CASE WHEN ${value} = 0 THEN 1 ELSE 0 END))`, LN_GAMMA),
  };
}

export interface SketchCell {
  sign: number;
  key: number;
  n: number;
}

/** The value a bucket stands for: the midpoint that keeps relative error under (γ-1)/(γ+1). */
function representative(cell: SketchCell): number {
  if (cell.sign === 0) return 0;
  const v = (2 * SKETCH_GAMMA ** (cell.key + 1)) / (SKETCH_GAMMA + 1);
  return cell.sign * v;
}

/** Order cells by the values they stand for: most negative first. */
function ordered(cells: readonly SketchCell[]): SketchCell[] {
  return [...cells].sort((a, b) => {
    if (a.sign !== b.sign) return a.sign - b.sign;
    return a.sign >= 0 ? a.key - b.key : b.key - a.key;
  });
}

/**
 * The q-quantile (0–1) of the sketched values, nearest-rank like `percentile()` in
 * insights/web.ts. Returns null when there are no values.
 */
export function sketchQuantile(cells: readonly SketchCell[], q: number): number | null {
  const total = cells.reduce((a, c) => a + c.n, 0);
  if (total === 0) return null;
  const rank = Math.min(total, Math.max(1, Math.ceil(q * total)));
  let seen = 0;
  for (const cell of ordered(cells)) {
    seen += cell.n;
    if (seen >= rank) return representative(cell);
  }
  return representative(ordered(cells).at(-1)!);
}

/** Exact quantile from a distribution of exact values (value → count), nearest-rank. */
export function exactQuantile(
  counts: readonly { value: number; n: number }[],
  q: number,
): number | null {
  const total = counts.reduce((a, c) => a + c.n, 0);
  if (total === 0) return null;
  const rank = Math.min(total, Math.max(1, Math.ceil(q * total)));
  let seen = 0;
  for (const c of [...counts].sort((a, b) => a.value - b.value)) {
    seen += c.n;
    if (seen >= rank) return c.value;
  }
  return null;
}

/** A histogram over sketch cells, merged into at most `bins` ranges, for charts. */
export function sketchHistogram(
  cells: readonly SketchCell[],
  bins = 20,
): { from: number; to: number; count: number }[] {
  const sorted = ordered(cells).filter((c) => c.n > 0);
  if (sorted.length === 0) return [];
  const lo = (c: SketchCell) =>
    c.sign === 0 ? 0 : c.sign > 0 ? SKETCH_GAMMA ** c.key : -(SKETCH_GAMMA ** (c.key + 1));
  const hi = (c: SketchCell) =>
    c.sign === 0 ? 0 : c.sign > 0 ? SKETCH_GAMMA ** (c.key + 1) : -(SKETCH_GAMMA ** c.key);
  const per = Math.max(1, Math.ceil(sorted.length / bins));
  const out: { from: number; to: number; count: number }[] = [];
  for (let i = 0; i < sorted.length; i += per) {
    const group = sorted.slice(i, i + per);
    out.push({
      from: lo(group[0]!),
      to: hi(group.at(-1)!),
      count: group.reduce((a, c) => a + c.n, 0),
    });
  }
  return out;
}
