/**
 * Breakdown helpers shared by trends and funnels: saved-cohort breakdowns and
 * numeric ranges.
 */

import type { Filter } from '../filters.ts';
import { propertyNumber } from '../sql/filters.ts';
import { type Aggregation, eventsCte, num } from '../sql/source.ts';
import type { TimeRange } from '../time.ts';
import type { QueryContext } from './types.ts';

/** A cohort to break down by, attached by the service (label and resolved membership filter). */
export interface CohortBreakdown {
  key: string;
  label: string;
  filter: Filter;
}

/** Whether a breakdown is "by saved cohort". */
export function isCohortBreakdown(properties: readonly string[]): boolean {
  return properties.length === 1 && properties[0] === 'cohort';
}

export interface NumericBin {
  label: string;
  from: number;
  to: number;
}

/**
 * Numeric breakdown ranges: `bins` equal-width ranges between the property's min and max over
 * the events read, as a CASE expression with labels like "10 – 20" (missing values: "(none)").
 */
export async function numericBins(
  ctx: QueryContext,
  range: TimeRange,
  o: {
    events: string[] | undefined;
    filters?: Filter[];
    aggregation: Aggregation;
    property: string;
    bins: number;
    alias?: string;
  },
): Promise<{ expr: string; bins: NumericBin[]; sql: string }> {
  const d = ctx.dialect;
  const v = propertyNumber(o.property, d);
  const sql = `WITH ${eventsCte(d, { project: ctx.project, ...range, events: o.events, filters: o.filters, aggregation: o.aggregation })}
SELECT MIN(${v}) AS lo, MAX(${v}) AS hi FROM ev`;
  const [row] = await ctx.execute(sql);
  const lo = row?.lo == null ? 0 : num(row.lo);
  const hi = row?.hi == null ? lo : num(row.hi);
  const n = o.bins;
  const width = hi > lo ? (hi - lo) / n : 1;
  const round = (x: number) => Number(x.toPrecision(4));
  const bins = Array.from({ length: n }, (_, i) => {
    const from = lo + i * width;
    const to = i === n - 1 ? hi : lo + (i + 1) * width;
    return { label: `${round(from)} – ${round(to)}`, from, to };
  }).filter((_, i) => hi > lo || i === 0);
  const value = o.alias ? propertyNumber(o.property, d, o.alias) : v;
  const cases = bins
    .slice(0, -1)
    .map((b) => `WHEN ${value} < ${d.num(b.to)} THEN ${d.str(b.label)}`)
    .join(' ');
  const expr = `(CASE WHEN ${value} IS NULL THEN '(none)' ${cases} ELSE ${d.str(bins.at(-1)!.label)} END)`;
  return { expr, bins, sql };
}
