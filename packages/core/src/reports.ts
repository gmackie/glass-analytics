/**
 * Report tiles: what a scheduled report says about each analysis — a headline value, the
 * change from the period before, a note — and a small chart snapshot from which the PNG is
 * drawn later. Snapshots hold numbers and labels only (no people), so the public image link
 * shows nothing more than the chart.
 */

import type { FunnelResult } from './insights/funnel.ts';
import type { PathsResult } from './insights/paths.ts';
import type { RetentionResult } from './insights/retention.ts';
import type { TrendsResult, TrendsSeries } from './insights/trends.ts';
import { funnelPng, retentionPng, timeChartPng } from './raster/charts.ts';

export type ChartSnapshot =
  | {
      type: 'time';
      labels: string[];
      series: { label: string; values: number[] }[];
      chart: 'line' | 'area' | 'bar';
      percent?: boolean;
    }
  | { type: 'funnel'; steps: { label: string; count: number }[] }
  | { type: 'retention'; average: number[]; period: string };

export interface ReportTile {
  title: string;
  value?: string;
  delta?: string;
  note?: string;
  chart: ChartSnapshot | null;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

/** "18 Nov", or "09:00" for hours. */
export function bucketLabel(ms: number, interval: string): string {
  const d = new Date(ms);
  if (interval === 'hour' || interval === 'minute') return d.toISOString().slice(11, 16);
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return interval === 'month' ? `${month} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${month}`;
}

/** "▲ 8% vs the period before", "▼ 3%", or nothing when there's no base. */
export function deltaText(now: number, before: number | undefined): string | undefined {
  if (before === undefined || before === 0) return undefined;
  const change = (now - before) / Math.abs(before);
  if (Math.abs(change) < 0.005) return 'No change vs the period before';
  return `${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change * 100))}% vs the period before`;
}

const isPercent = (s: TrendsSeries) => s.format === 'percent';

function trendsTile(title: string, r: TrendsResult, display?: string): ReportTile {
  const lines = [...r.series, ...(r.formulas ?? [])].slice(0, 6);
  const first = lines[0];
  if (!first) return { title, note: 'No data in this period.', chart: null };
  const before = r.compare?.series.find(
    (s) => s.seriesIndex === first.seriesIndex && s.breakdown === first.breakdown,
  );
  const percent = lines.every(isPercent);
  return {
    title,
    value: percent ? pct(first.values.at(-1) ?? 0) : fmt(first.total),
    delta: percent ? undefined : deltaText(first.total, before?.total),
    note:
      lines.length > 1
        ? `${first.breakdown ?? first.label} and ${lines.length - 1} more`
        : undefined,
    chart: {
      type: 'time',
      labels: r.buckets.map((b) => bucketLabel(b, r.interval)),
      series: lines.map((s) => ({ label: s.breakdown ?? s.label, values: s.values })),
      chart: display === 'bar' ? 'bar' : display === 'area' ? 'area' : 'line',
      ...(percent ? { percent: true } : {}),
    },
  };
}

function funnelTile(title: string, r: FunnelResult): ReportTile {
  const first = r.steps[0];
  const last = r.steps.at(-1);
  if (!first?.count || !last)
    return { title, note: 'No one started the funnel in this period.', chart: null };
  return {
    title,
    value: pct(last.count / first.count),
    note: `${fmt(last.count)} of ${fmt(first.count)} reached ${last.label}`,
    chart: { type: 'funnel', steps: r.steps.map((s) => ({ label: s.label, count: s.count })) },
  };
}

function retentionTile(title: string, r: RetentionResult): ReportTile {
  const back = r.average[1];
  return {
    title,
    value: back === undefined ? undefined : pct(back, 0),
    note: back === undefined ? 'Not enough periods yet.' : `came back after 1 ${r.period}`,
    chart:
      r.average.length > 1 ? { type: 'retention', average: r.average, period: r.period } : null,
  };
}

function pathsTile(title: string, r: PathsResult): ReportTile {
  const top = r.topPaths.find((p) => p.items.length > 1) ?? r.topPaths[0];
  return {
    title,
    value: `${fmt(r.total)} paths`,
    note: top ? `Most common: ${top.items.join(' → ')} (${fmt(top.count)})` : undefined,
    chart: null,
  };
}

/** The report's view of one analysis result. */
export function reportTile(
  title: string,
  kind: string,
  result: unknown,
  display?: string,
): ReportTile {
  switch (kind) {
    case 'trends':
      return trendsTile(title, result as TrendsResult, display);
    case 'funnel':
      return funnelTile(title, result as FunnelResult);
    case 'retention':
      return retentionTile(title, result as RetentionResult);
    case 'paths':
      return pathsTile(title, result as PathsResult);
    default:
      return { title, note: `${kind} isn't in reports yet.`, chart: null };
  }
}

/** The PNG of a snapshot. */
export function snapshotPng(c: ChartSnapshot): Promise<Uint8Array> {
  if (c.type === 'funnel') return funnelPng({ steps: c.steps });
  if (c.type === 'retention') return retentionPng(c.average, c.period);
  return timeChartPng({ labels: c.labels, series: c.series, type: c.chart, percent: c.percent });
}
