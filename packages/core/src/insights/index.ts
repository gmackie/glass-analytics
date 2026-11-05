/**
 * The insight registry.
 *
 * Each entry pairs a zod schema with a runner. The Worker exposes every entry as
 * `POST /api/query` (with `"kind"`), the MCP server exposes each one as a
 * `query_<kind>` tool, and the CLI as `dataflare query <kind>`. Adding an insight
 * type is therefore: write a runner, add it here. See docs/extending.md.
 */

import type { z } from 'zod/v4';
import { runFunnel } from './funnel.ts';
import { runJourneys } from './journeys.ts';
import { runRetention } from './retention.ts';
import { funnelSpec, journeysSpec, retentionSpec, trendsSpec, webSpec } from './schemas.ts';
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
  journeys: define({
    description:
      'Bounded forward/backward session paths with branching, repeats and observation limits. Counts sessions, not causal effects.',
    schema: journeysSpec,
    run: runJourneys,
  }),
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
      'Conversion through ordered steps within a time window, with drop-off per step and optional breakdown. Use for signup or checkout flows.',
    schema: funnelSpec,
    run: runFunnel,
  }),
  retention: define({
    description:
      'Cohort retention: of people who first did an event in each day/week/month, how many came back to do another event in later periods.',
    schema: retentionSpec,
    run: runRetention,
  }),
} as const;

export type InsightKind = keyof typeof INSIGHTS;

export function isInsightKind(kind: string): kind is InsightKind {
  return Object.hasOwn(INSIGHTS, kind);
}

export * from './experiment.ts';
export * from './funnel.ts';
export * from './journeys.ts';
export * from './retention.ts';
export * from './schemas.ts';
export * from './trends.ts';
export * from './types.ts';
export * from './web.ts';
