/**
 * The insight registry.
 *
 * Each entry pairs a zod schema with a runner. The Worker exposes every entry as
 * `POST /api/query` (with `"kind"`), the MCP server exposes each one as a
 * `query_<kind>` tool, and the CLI as `dataflare query <kind>`. Adding an insight
 * type is therefore: write a runner, add it here. See docs/extending.md.
 */

import type { z } from 'zod/v4';
import { runFunnelCorrelation } from './correlation.ts';
import { runFunnel } from './funnel.ts';
import { runPaths } from './paths.ts';
import { runRetention } from './retention.ts';
import { runRevenue } from './revenue.ts';
import {
  funnelCorrelationSpec,
  funnelSpec,
  pathsSpec,
  retentionSpec,
  revenueSpec,
  trendsSpec,
  webSpec,
} from './schemas.ts';
import { runTrends } from './trends.ts';
import type { QueryContext, ResultBase } from './types.ts';
import { runWeb } from './web.ts';

export interface InsightDefinition<
  S extends z.ZodType = z.ZodType,
  R extends ResultBase = ResultBase,
> {
  /** One sentence shown to agents and in the API index. */
  description: string;
  schema: S;
  run(spec: z.infer<S>, ctx: QueryContext): Promise<R>;
}

function define<S extends z.ZodType, R extends ResultBase>(
  def: InsightDefinition<S, R>,
): InsightDefinition<S, R> {
  return def;
}

export const INSIGHTS = {
  web: define({
    description:
      'Web analytics overview for a period: visitors, pageviews, sessions, bounce rate, session length, top pages, referrers, UTMs, countries, devices, errors and web vitals.',
    schema: webSpec,
    run: runWeb,
  }),
  trends: define({
    description:
      'Count or aggregate events over time, optionally broken down by a property. Use for "how many X per day", "unique users who did X", "revenue by week".',
    schema: trendsSpec,
    run: runTrends,
  }),
  funnel: define({
    description:
      'Conversion through steps within a time window: ordered, strict or unordered, with exclusions and optional steps, drop-off and median time per step, breakdowns (first/last touch, a step, all steps), time-to-convert distribution or conversion over time (viz). Use for signup or checkout flows.',
    schema: funnelSpec,
    run: runFunnel,
  }),
  funnel_correlation: define({
    description:
      'What goes with converting through a funnel and with dropping off: other events done during the attempt, or values of properties (e.g. person.plan, browser), ranked by odds ratio with significance. Use after query_funnel to explain a drop-off.',
    schema: funnelCorrelationSpec,
    run: runFunnelCorrelation,
  }),
  retention: define({
    description:
      'Cohort retention: of people who first did an event in each day/week/month, how many came back to do another event in later periods.',
    schema: retentionSpec,
    run: runRetention,
  }),
  paths: define({
    description:
      'User paths: the most common sequences of pages and events, as steps and the links between them, with drop-offs and the top whole paths. Start or end at a page or event (globs like "/blog/*"), follow up to 10 steps, collapse repeats, exclude or group steps, clean paths, or look around a funnel step (after, before, between, drop-off).',
    schema: pathsSpec,
    run: runPaths,
  }),
  revenue: define({
    description:
      'Revenue and recurring revenue per period: gross, refunds, net, paying customers, ARPU, MRR/ARR and its movements (new, expansion, contraction, churned, reactivated), churn and LTV, by product or first-touch channel, and the top customers or accounts. Reads revenue events and Stripe.',
    schema: revenueSpec,
    run: runRevenue,
  }),
} as const;

export type InsightKind = keyof typeof INSIGHTS;

export function isInsightKind(kind: string): kind is InsightKind {
  return Object.hasOwn(INSIGHTS, kind);
}

export * from './correlation.ts';
export * from './experiment.ts';
export * from './funnel.ts';
export * from './paths.ts';
export * from './retention.ts';
export * from './revenue.ts';
export * from './schemas.ts';
export * from './trends.ts';
export * from './types.ts';
export * from './web.ts';
