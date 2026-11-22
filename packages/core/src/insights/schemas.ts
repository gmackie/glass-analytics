/**
 * Query specs.
 *
 * These zod schemas are the single source of truth for every query shape. The
 * same definitions validate HTTP API input, generate the JSON Schemas served at
 * `/api/schema`, and become the input schemas of the MCP tools — so the
 * `.describe()` text here is what coding agents read. Keep it precise.
 */

import { z } from 'zod/v4';
import { FILTER_OPS } from '../filters.ts';

const time = z
  .union([z.string(), z.number()])
  .describe(
    'ISO date ("2026-10-01"), epoch ms, "now", "today", "yesterday", or a relative offset like "-30d", "-12h", "-3mo".',
  );

export const filterSchema = z
  .object({
    property: z
      .string()
      .describe(
        'Property to test. Built-in columns: path, url, host, referrer_host, utm_source, utm_medium, utm_campaign, country, region, city, device, browser, os, event, session_id, user_id. Anything else is an event property ("plan" or "props.plan"); prefix with "person." for person properties ("person.plan"). Use "cohort" with a saved cohort key as the value (ops eq/in or neq/not_in) to keep only people in (or not in) that cohort; list keys with list_cohorts. Prefix with "session." to keep whole visits: "session.utm_source" = "google" keeps every event of sessions that landed from Google, so their later pages and conversions count.',
      ),
    op: z.enum(FILTER_OPS).optional().describe('Comparison operator. Defaults to "eq".'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional()
      .describe('Value to compare with. Lists for "in"/"not_in". Omit for "is_set"/"is_not_set".'),
  })
  .describe('A condition on an event, column or person property.');

const common = {
  project: z
    .string()
    .optional()
    .describe('Project id. Defaults to the only project, or "default".'),
  from: time.optional().describe('Start of the range (inclusive). Defaults to "-30d".'),
  to: time.optional().describe('End of the range (exclusive). Defaults to "now".'),
  filters: z.array(filterSchema).optional().describe('Conditions every event must match.'),
  utcOffsetMinutes: z
    .number()
    .int()
    .min(-840)
    .max(840)
    .optional()
    .describe(
      'Shift day/week/month boundaries by a fixed offset from UTC, e.g. 60 for UTC+1. Prefer timezone, which follows daylight saving.',
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA time zone for day/week/month boundaries, e.g. "Europe/London" (follows daylight saving). Defaults to the project time zone, else UTC.',
    ),
  filterTestAccounts: z
    .boolean()
    .optional()
    .describe(
      "Leave out internal and test traffic, using the project's internalFilters setting (see get_settings).",
    ),
};

const stepSchema = z.object({
  event: z.string().describe('Event name, e.g. "$pageview" or "signup_completed".'),
  filters: z.array(filterSchema).optional().describe('Extra conditions for this step only.'),
  label: z.string().optional().describe('Display name for this step.'),
});

/** Every way a trends series can aggregate its events. */
export const TRENDS_MATHS = [
  'total',
  'dau',
  'unique_persons',
  'unique_sessions',
  'unique_groups',
  'wau',
  'mau',
  'first_time',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p75',
  'p90',
  'p95',
  'p99',
  'revenue',
  'avg_count_per_actor',
  'min_count_per_actor',
  'max_count_per_actor',
  'median_count_per_actor',
  'p75_count_per_actor',
  'p90_count_per_actor',
  'p95_count_per_actor',
  'p99_count_per_actor',
] as const;

export type TrendsMath = (typeof TRENDS_MATHS)[number];

const aggregateBy = z
  .string()
  .optional()
  .describe(
    'What unique counts and per-actor maths count: "person" (default), "session", or a group type such as "company" (from glass.group("company", id)).',
  );

const breakdownSpec = z
  .union([z.string(), z.array(z.string()).min(1).max(4)])
  .optional()
  .describe(
    'Split by one or more properties, e.g. "browser", "person.plan", "group.company.plan" or ["browser","utm_source"] (joined with " · "). "cohort" splits by the saved cohorts in breakdownCohorts.',
  );

const breakdownExtras = {
  breakdownLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Top N breakdown values to keep. Default 10.'),
  breakdownCohorts: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('With breakdown "cohort": the saved cohort keys to compare (list_cohorts).'),
  breakdownBins: z
    .number()
    .int()
    .min(2)
    .max(50)
    .optional()
    .describe(
      'For a numeric breakdown property: group its values into this many equal-width ranges instead of one line per value.',
    ),
};

export const trendsSpec = z
  .object({
    ...common,
    series: z
      .array(
        z.object({
          event: z
            .union([z.string(), z.array(z.string()).min(1).max(20)])
            .describe('Event name, a list of names (any of them), or "*" for all events.'),
          math: z
            .enum(TRENDS_MATHS)
            .optional()
            .describe(
              'How to aggregate. total: events (default). dau/unique_persons: unique actors per interval. wau/mau: unique actors in the 7/30 days up to each point. unique_sessions. unique_groups: distinct groups of groupType. first_time: actors doing it for the first time ever. sum/avg/min/max/median/p75/p90/p95/p99 of a numeric "property". revenue: sum of revenue in the base currency. avg|min|max|median|p75|p90|p95|p99_count_per_actor: how many times each actor did it.',
            ),
          property: z
            .string()
            .optional()
            .describe(
              'Numeric property for sum, avg, min, max and the percentiles, e.g. "amount".',
            ),
          groupType: z
            .string()
            .optional()
            .describe('For unique_groups: the group type to count, e.g. "company".'),
          filters: z.array(filterSchema).optional(),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(20)
      .describe('One line per series; formulas refer to them as A, B, C… in order.'),
    interval: z
      .enum(['minute', 'hour', 'day', 'week', 'month'])
      .optional()
      .describe('Bucket size. Defaults to "day". "minute" works for ranges up to two days.'),
    aggregateBy,
    breakdown: breakdownSpec,
    ...breakdownExtras,
    formulas: z
      .array(
        z.object({
          expr: z
            .string()
            .min(1)
            .describe(
              'Arithmetic over series letters, e.g. "B / A" (A is the first series), with abs(x), min(a, b), max(a, b) and round(x, digits).',
            ),
          label: z.string().optional(),
          format: z
            .enum(['number', 'percent'])
            .optional()
            .describe('How to show the values: "percent" shows 0.25 as 25%. Default "number".'),
        }),
      )
      .max(5)
      .optional()
      .describe('Lines computed from the series, per interval and breakdown value.'),
    formulaOnly: z
      .boolean()
      .optional()
      .describe('Show only the formula lines (the series still run, as inputs).'),
    compare: z
      .boolean()
      .optional()
      .describe('Also return the previous period of the same length, aligned bucket by bucket.'),
    cumulative: z.boolean().optional().describe('Running totals instead of per-interval values.'),
    smoothing: z
      .number()
      .int()
      .min(2)
      .max(90)
      .optional()
      .describe('Moving average over this many intervals, e.g. 7 on a daily chart.'),
    trendLine: z.boolean().optional().describe('Add a least-squares trend line to each series.'),
    display: z
      .enum(['line', 'area', 'bar', 'bar_value', 'table', 'pie', 'number', 'world_map'])
      .optional()
      .describe('How the dashboard draws it. world_map expects breakdown "country".'),
    logScale: z.boolean().optional().describe('Dashboard: logarithmic y axis.'),
    percentStack: z.boolean().optional().describe('Dashboard: stack breakdowns as shares of 100%.'),
    showValues: z.boolean().optional().describe('Dashboard: label points with their values.'),
  })
  .describe('Event counts or aggregates over time.');

const funnelStepSchema = stepSchema.extend({
  optional: z
    .boolean()
    .optional()
    .describe('People may skip this step and still reach the next ones (not for the first step).'),
});

export const funnelSpec = z
  .object({
    ...common,
    steps: z
      .array(funnelStepSchema)
      .min(2)
      .max(20)
      .describe('Ordered steps. A person converts by doing each step after the previous one.'),
    window: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Maximum time from the first step to the last, e.g. "1h", "7d", "2w". Seconds if a number. Default "7d".',
      ),
    order: z
      .enum(['ordered', 'strict', 'unordered'])
      .optional()
      .describe(
        '"ordered" (default): each step after the previous one, other events in between allowed. "strict": each step must be the very next event. "unordered": steps in any order within the window.',
      ),
    exclusions: z
      .array(
        z.object({
          event: z.string(),
          filters: z.array(filterSchema).optional(),
          fromStep: z
            .number()
            .int()
            .min(1)
            .describe('Step after which the event excludes (1 = first).'),
          toStep: z.number().int().min(2).describe('Step before which it excludes.'),
        }),
      )
      .max(5)
      .optional()
      .describe(
        'Drop attempts where this event happened between two steps, e.g. a "coupon_applied" between checkout and purchase.',
      ),
    aggregateBy,
    breakdown: z
      .union([z.string(), z.array(z.string()).min(1).max(4)])
      .optional()
      .describe(
        'Split by one or more properties, e.g. "utm_source" or ["utm_source","device"]. "cohort" splits by breakdownCohorts.',
      ),
    breakdownAttribution: z
      .union([z.enum(['first_touch', 'last_touch', 'all_steps']), z.number().int().min(1)])
      .optional()
      .describe(
        'Which event the breakdown value comes from: the first step (default), the last step reached, a step number, or "all_steps" (the value must be the same on every step).',
      ),
    ...breakdownExtras,
    viz: z
      .enum(['steps', 'time_to_convert', 'trends'])
      .optional()
      .describe(
        '"steps" (default): counts and conversion per step. "time_to_convert": the distribution of time between fromStep and toStep. "trends": conversion rate over time, by when people entered.',
      ),
    fromStep: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('time_to_convert / trends: from this step (default 1).'),
    toStep: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe('time_to_convert / trends: to this step (default the last).'),
    interval: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('trends view: bucket size. Default picks from the range length.'),
  })
  .describe('Conversion through an ordered sequence of events.');

export const funnelCorrelationSpec = funnelSpec
  .extend({
    correlation: z
      .enum(['events', 'properties'])
      .optional()
      .describe(
        '"events" (default): which other events people did before converting or dropping off. "properties": which values of `properties` go with converting.',
      ),
    properties: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        'For correlation "properties": person or first-step properties, e.g. ["person.plan","browser"].',
      ),
    exclude: z.array(z.string()).optional().describe('Events to leave out of the correlation.'),
    limit: z.number().int().min(1).max(50).optional().describe('Top N each way. Default 10.'),
  })
  .describe('What goes with converting through a funnel, and with dropping off.');

const pathPoint = z
  .object({
    type: z
      .enum(['page', 'event'])
      .optional()
      .describe('"page" (default): a page path. "event": an event name (or itemProperty value).'),
    value: z
      .string()
      .min(1)
      .max(500)
      .describe('The path or event name. "*" matches any characters, e.g. "/blog/*".'),
  })
  .describe('A point on a path: a page or an event.');

export const pathCleaningRule = z
  .object({
    match: z
      .string()
      .min(1)
      .max(500)
      .describe('A page path pattern; "*" matches any characters, e.g. "/users/*/settings".'),
    alias: z
      .string()
      .min(1)
      .max(500)
      .describe('What matching paths are shown as, e.g. "/users/:id/settings".'),
  })
  .describe('Show every page path matching a pattern as one step.');

export const PATH_MODES = ['after', 'before', 'between', 'dropoff'] as const;

export const pathsSpec = z
  .object({
    ...common,
    aggregateBy: z
      .enum(['person', 'session'])
      .optional()
      .describe(
        '"person" (default): each person\'s first path in the range. "session": every session\'s path.',
      ),
    include: z
      .object({
        pages: z.boolean().optional().describe('Page views, by path. Default true.'),
        events: z
          .union([z.boolean(), z.array(z.string()).min(1).max(50)])
          .optional()
          .describe(
            "Custom events: true for all (not Dataflare's own bookkeeping), or a list of names. Default false.",
          ),
      })
      .optional()
      .describe('What counts as a step.'),
    itemProperty: z
      .string()
      .optional()
      .describe(
        'Name each step by this event property when it is set (e.g. "screen" or "title"), instead of the path or event name.',
      ),
    start: pathPoint.optional().describe('Paths start at the first time each person does this.'),
    end: pathPoint
      .optional()
      .describe(
        'Paths end at the first time each person does this. With start too: only paths from start to end.',
      ),
    steps: z
      .number()
      .int()
      .min(2)
      .max(10)
      .optional()
      .describe('How many steps to follow. Default 5.'),
    collapseRepeats: z
      .boolean()
      .optional()
      .describe('Count a page or event done several times in a row once. Default true.'),
    exclude: z
      .array(z.string().min(1).max(500))
      .max(20)
      .optional()
      .describe('Pages or events to leave out of every path ("*" wildcards allowed).'),
    cleaning: z
      .array(pathCleaningRule)
      .max(50)
      .optional()
      .describe("Rules for this query, applied before the project's pathCleaning rules."),
    projectCleaning: z
      .boolean()
      .optional()
      .describe("Apply the project's pathCleaning rules (see get_settings). Default true."),
    groups: z
      .array(z.string().min(1).max(500))
      .max(20)
      .optional()
      .describe('Wildcard groups: steps matching a pattern like "/blog/*" show as that pattern.'),
    boundary: z
      .union([z.literal('session'), z.object({ minutes: z.number().int().min(1).max(43_200) })])
      .optional()
      .describe(
        '"session" (default): a path stays in one session. { minutes }: it may span sessions for that long after it starts.',
      ),
    perStep: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Show the top N steps at each position; the rest are "Other". Default 8.'),
    minPeople: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Hide links followed by fewer than this many.'),
    maxPeople: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Hide links followed by more than this many.'),
    funnel: z
      .object({
        spec: funnelSpec.describe('The funnel (ordered or strict); its range is the paths range.'),
        step: z.number().int().min(1).describe('The funnel step (1 is the first).'),
        mode: z
          .enum(PATH_MODES)
          .describe(
            '"after": what people did after reaching the step. "before": what led up to it. "between": what they did between this step and the next. "dropoff": what people who reached the step before it did instead.',
          ),
      })
      .optional()
      .describe('Paths around a funnel step, instead of start or end.'),
  })
  .describe('The journeys people take: the most common sequences of pages and events.');

export const revenueSpec = z
  .object({
    ...common,
    interval: z
      .enum(['day', 'week', 'month'])
      .optional()
      .describe('Period length. Default "month".'),
    breakdown: z
      .string()
      .optional()
      .describe(
        'Split revenue by "product", a first-touch source ("channel", "referrer", "utm_source", "utm_medium", "utm_campaign", "entry_page"), "country", or any property such as "person.plan" or "group.company.industry".',
      ),
    aggregateBy,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Top customers to list. Default 10.'),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("The currency amounts are in (the project's base currency). Set by the server."),
  })
  .describe(
    'Revenue: gross, refunds, net, orders, paying customers, ARPU; MRR/ARR with new, expansion, contraction, churned and reactivated MRR; revenue and customer churn; LTV; a breakdown and top customers (or accounts).',
  );

export const retentionSpec = z
  .object({
    ...common,
    cohortEvent: stepSchema.describe(
      'The event that puts a person in a cohort ("*" for any event). With retentionType "first_time", their first one in the range.',
    ),
    returnEvent: stepSchema.describe('The event that counts as coming back ("*" for any event).'),
    period: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('Cohort and return period. Default "week".'),
    periods: z
      .number()
      .int()
      .min(1)
      .max(52)
      .optional()
      .describe('How many periods after the cohort to measure. Default 8.'),
    retentionType: z
      .enum(['first_time', 'recurring'])
      .optional()
      .describe(
        '"first_time" (default): a person joins the cohort of their first cohortEvent in the range. "recurring": they join every period in which they did it, so returning users count again.',
      ),
    cumulative: z
      .boolean()
      .optional()
      .describe(
        'Count a person in period k if they came back in period k or any later one ("on or after"), instead of exactly in period k.',
      ),
    meanMethod: z
      .enum(['weighted', 'simple'])
      .optional()
      .describe(
        'The average row: "weighted" (default) by cohort size, or "simple", the plain mean of each cohort’s rate.',
      ),
    aggregateBy,
    breakdown: z
      .union([z.string(), z.array(z.string()).min(1).max(4)])
      .optional()
      .describe(
        'One retention table per value of a property of the cohort event, e.g. "utm_source", "person.plan", or "cohort" with breakdownCohorts.',
      ),
    breakdownLimit: breakdownExtras.breakdownLimit,
    breakdownCohorts: breakdownExtras.breakdownCohorts,
  })
  .describe('How many people come back after their first event.');

export const webSpec = z
  .object({
    ...common,
    interval: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('Time series bucket. Default picks from the range length.'),
    compare: z
      .boolean()
      .optional()
      .describe('Include totals for the previous period of the same length. Default true.'),
  })
  .describe(
    'Web analytics overview: visitors, pageviews, sessions, bounce rate and top breakdowns.',
  );

const metricEvent = {
  event: z.string().describe('Event name ("*" for any).'),
  filters: z.array(filterSchema).optional(),
};
const metricCommon = {
  name: z.string().optional().describe('Label, e.g. "Checkout conversion".'),
  goal: z
    .enum(['increase', 'decrease'])
    .optional()
    .describe('Which way is better. Default "increase" (use "decrease" for e.g. errors or churn).'),
};

/** How an experiment measures success. Each is computed per exposed person (or group). */
export const metricSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conversion'),
    ...metricEvent,
    ...metricCommon,
    within: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only count it within this long of exposure, e.g. "7d". Default: any time after.'),
  }),
  z.object({
    kind: z.literal('mean'),
    ...metricEvent,
    ...metricCommon,
    math: z
      .enum(['count', 'sum'])
      .optional()
      .describe(
        'Per person: how many times they did it ("count", default) or the sum of `property`.',
      ),
    property: z
      .string()
      .optional()
      .describe('For math "sum": the numeric property, e.g. "revenue".'),
    winsorize: z
      .object({
        lower: z.number().min(0).max(50).optional().describe('Clamp values below this percentile.'),
        upper: z
          .number()
          .min(50)
          .max(100)
          .optional()
          .describe('Clamp values above this percentile, e.g. 99.'),
      })
      .optional()
      .describe('Limit outliers: one huge spender can swing a mean.'),
  }),
  z.object({
    kind: z.literal('ratio'),
    ...metricCommon,
    numerator: z.object({
      ...metricEvent,
      math: z.enum(['count', 'sum']).optional(),
      property: z.string().optional(),
    }),
    denominator: z.object({
      ...metricEvent,
      math: z.enum(['count', 'sum']).optional(),
      property: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal('funnel'),
    ...metricCommon,
    steps: z.array(z.object(metricEvent)).min(1).max(10).describe('Ordered steps after exposure.'),
    window: z
      .union([z.string(), z.number()])
      .optional()
      .describe('From the first step to the last. Default "7d".'),
  }),
  z.object({
    kind: z.literal('retention'),
    ...metricEvent,
    ...metricCommon,
    from: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Return window start after exposure. Default "1d".'),
    to: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Return window end after exposure. Default "8d". People exposed less long ago are left out.',
      ),
  }),
]);

export type ExperimentMetric = z.infer<typeof metricSchema>;

export const experimentOptions = {
  engine: z
    .enum(['bayesian', 'frequentist'])
    .optional()
    .describe(
      '"bayesian" (default): probability each variant is best, credible intervals. "frequentist": p-values and confidence intervals.',
    ),
  confidence: z
    .union([z.literal(0.9), z.literal(0.95), z.literal(0.99)])
    .optional()
    .describe('Required probability (Bayesian) or 1 - alpha (frequentist). Default 0.95.'),
  exposure: z
    .object({
      event: z
        .string()
        .optional()
        .describe(
          'Count exposure on this event instead of $exposure (its flags column holds the variant).',
        ),
      filters: z.array(filterSchema).optional(),
      multipleVariants: z
        .enum(['exclude', 'first_seen'])
        .optional()
        .describe(
          'People who saw more than one variant: leave them out (default), or keep their first.',
        ),
    })
    .optional(),
  minimumDays: z
    .number()
    .min(0)
    .max(90)
    .optional()
    .describe('Declare no winner before this many days. Default 7.'),
  minimumExposures: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Declare no winner before every variant has this many exposures. Default 100.'),
  mde: z
    .number()
    .min(0.001)
    .max(10)
    .optional()
    .describe(
      'Minimum detectable effect (relative) for running-time estimates. Default 0.1 (10%).',
    ),
  aggregateBy: z
    .string()
    .optional()
    .describe(
      'Randomise by a group type (e.g. "company") instead of people; use a flag bucketed by that group.',
    ),
};

export const experimentSpec = z
  .object({
    project: common.project,
    flag: z.string().describe('Feature flag key whose variants are compared.'),
    goal: stepSchema
      .extend({
        value: z
          .string()
          .optional()
          .describe(
            'Optional numeric property summed per person (e.g. "revenue") for a mean metric.',
          ),
      })
      .optional()
      .describe(
        'Simple form: a conversion event (and optional value). Same as one conversion metric.',
      ),
    metrics: z
      .array(metricSchema)
      .max(10)
      .optional()
      .describe('Primary metrics. The first decides the winner.'),
    secondary: z
      .array(metricSchema)
      .max(20)
      .optional()
      .describe('Secondary metrics, reported but not deciding.'),
    variants: z
      .array(z.string())
      .min(2)
      .optional()
      .describe(
        'Variant keys, control first. Defaults to the variants seen, with "control" first if present.',
      ),
    from: time.optional(),
    to: time.optional(),
    filters: z
      .array(filterSchema)
      .optional()
      .describe('Only these exposures, e.g. internal traffic left out.'),
    ...experimentOptions,
  })
  .describe('A/B test readout for a flag.');

export const sqlSpec = z
  .object({
    project: common.project,
    query: z
      .string()
      .min(1)
      .describe(
        'One read-only SELECT. Tables: events, identities (D1 mode) or <namespace>.events / <namespace>.identities (lake mode).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Maximum rows returned. Default 1000.'),
  })
  .describe('Raw read-only SQL against the event store.');

export type TrendsSpec = z.infer<typeof trendsSpec>;
export type FunnelSpec = z.infer<typeof funnelSpec>;
export type FunnelCorrelationSpec = z.infer<typeof funnelCorrelationSpec>;
export type RetentionSpec = z.infer<typeof retentionSpec>;
export type PathsSpec = z.infer<typeof pathsSpec>;
export type PathCleaningRule = z.infer<typeof pathCleaningRule>;
export type WebSpec = z.infer<typeof webSpec>;
export type ExperimentSpec = z.infer<typeof experimentSpec>;
export type SqlSpec = z.infer<typeof sqlSpec>;
export type FilterSpec = z.infer<typeof filterSchema>;
