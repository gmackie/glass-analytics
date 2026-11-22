/**
 * Alerts on saved insights: does the latest value cross a line? Trends alert on one series
 * (every breakdown value is checked, and any can fire); funnels on a step's conversion. A
 * value check compares with a threshold; an increase or decrease check compares with the
 * bucket before, in absolute numbers or percent. By default the last complete bucket is
 * checked; `ongoing` checks the one still filling up.
 */

import { z } from 'zod/v4';
import type { FunnelResult } from './insights/funnel.ts';
import type { TrendsResult } from './insights/trends.ts';

export const alertConditionSchema = z
  .object({
    type: z
      .enum(['value', 'increase', 'decrease'])
      .describe(
        '"value": compare the value itself. "increase" / "decrease": compare the change from the bucket before.',
      ),
    above: z.number().optional().describe('Value checks: fire when the value is above this.'),
    below: z.number().optional().describe('Value checks: fire when the value is below this.'),
    by: z
      .number()
      .min(0)
      .optional()
      .describe('Increase/decrease checks: fire when the change is at least this.'),
    unit: z
      .enum(['absolute', 'percent'])
      .optional()
      .describe('Increase/decrease: "by" is a count (default) or a percent of the bucket before.'),
  })
  .refine(
    (c) =>
      c.type === 'value' ? c.above !== undefined || c.below !== undefined : c.by !== undefined,
    {
      message: 'A value check needs above or below; an increase or decrease check needs by.',
    },
  )
  .describe('When the alert fires.');

export const alertTargetSchema = z
  .object({
    series: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Trends: the series index (0 is A). Default 0.'),
    step: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe('Funnels: alert on conversion from the first step to this one. Default the last.'),
  })
  .describe('What the alert watches.');

export type AlertCondition = z.infer<typeof alertConditionSchema>;
export type AlertTarget = z.infer<typeof alertTargetSchema>;

export interface AlertReading {
  /** Breakdown value, or null. */
  breakdown: string | null;
  value: number;
  /** The bucket before, for increase/decrease checks. */
  previous: number | null;
  breached: boolean;
}

export interface AlertEvaluation {
  /** The bucket checked (epoch ms), or null for funnels (the whole range). */
  at: number | null;
  /** The headline value: the reading without a breakdown, or the largest. */
  value: number | null;
  readings: AlertReading[];
  breaches: AlertReading[];
  /** Why there is nothing to check (no data yet, an empty series). */
  note?: string;
}

function breached(c: AlertCondition, value: number, previous: number | null): boolean {
  if (c.type === 'value')
    return (c.above !== undefined && value > c.above) || (c.below !== undefined && value < c.below);
  if (previous === null) return false;
  const change = c.type === 'increase' ? value - previous : previous - value;
  if (c.unit === 'percent')
    return previous !== 0 && (change / Math.abs(previous)) * 100 >= (c.by ?? 0);
  return change >= (c.by ?? 0);
}

function summarise(readings: AlertReading[], at: number | null, note?: string): AlertEvaluation {
  const plain = readings.find((r) => r.breakdown === null);
  const value =
    plain?.value ?? (readings.length ? Math.max(...readings.map((r) => r.value)) : null);
  return {
    at,
    value,
    readings,
    breaches: readings.filter((r) => r.breached),
    ...(note ? { note } : {}),
  };
}

/** Trends: the chosen series' latest (complete, unless ongoing) bucket, per breakdown value. */
export function evaluateTrendsAlert(
  r: TrendsResult,
  target: AlertTarget,
  condition: AlertCondition,
  ongoing = false,
): AlertEvaluation {
  const index = ongoing ? r.buckets.length - 1 : r.buckets.length - 2;
  if (index < 0 || (condition.type !== 'value' && index < 1))
    return summarise([], null, 'Not enough buckets yet: widen the range.');
  const lines = r.series.filter((s) => s.seriesIndex === (target.series ?? 0));
  const readings = lines.map((s) => {
    const value = s.values[index] ?? 0;
    const previous = index > 0 ? (s.values[index - 1] ?? 0) : null;
    return {
      breakdown: s.breakdown,
      value,
      previous,
      breached: breached(condition, value, previous),
    };
  });
  return summarise(
    readings,
    r.buckets[index] ?? null,
    lines.length ? undefined : 'That series has no data.',
  );
}

/** Funnels: conversion (0–1) from the first step to `step`, overall or per breakdown value. */
export function evaluateFunnelAlert(
  r: FunnelResult,
  target: AlertTarget,
  condition: AlertCondition,
): AlertEvaluation {
  if (condition.type !== 'value')
    return summarise([], null, 'Funnel alerts compare conversion with a value.');
  const k = Math.min(target.step ?? r.steps.length, r.steps.length) - 1;
  const groups = r.breakdowns?.length ? r.breakdowns : [{ value: null, steps: r.steps }];
  const readings = groups.map((g) => {
    const value = g.steps[k]?.conversionFromStart ?? 0;
    return {
      breakdown: g.value,
      value,
      previous: null,
      breached: breached(condition, value, null),
    };
  });
  return summarise(readings, null);
}

/** Either kind, by the result's kind. */
export function evaluateAlert(
  result: TrendsResult | FunnelResult,
  target: AlertTarget,
  condition: AlertCondition,
  ongoing = false,
): AlertEvaluation {
  return result.kind === 'funnel'
    ? evaluateFunnelAlert(result, target, condition)
    : evaluateTrendsAlert(result, target, condition, ongoing);
}

/** "above 1,000", "down by 20% or more". */
export function describeCondition(c: AlertCondition, percentValues = false): string {
  const n = (v: number) =>
    percentValues ? `${Math.round(v * 1000) / 10}%` : v.toLocaleString('en-US');
  if (c.type === 'value') {
    const parts = [
      c.above !== undefined ? `above ${n(c.above)}` : '',
      c.below !== undefined ? `below ${n(c.below)}` : '',
    ];
    return parts.filter(Boolean).join(' or ');
  }
  const amount = c.unit === 'percent' ? `${c.by}%` : (c.by ?? 0).toLocaleString('en-US');
  return `${c.type === 'increase' ? 'up' : 'down'} by ${amount} or more`;
}
