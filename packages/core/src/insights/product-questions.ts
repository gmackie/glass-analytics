import type { Dialect } from '../sql/dialect.ts';
import { num } from '../sql/source.ts';
import { DAY_MS, iso, type TimeRange } from '../time.ts';
import { runFunnel } from './funnel.ts';
import type { FunnelSpec } from './schemas.ts';
import type { QueryContext } from './types.ts';

type FieldType = 'string' | 'boolean';
interface QuestionInput {
  event: string;
  fields: Record<string, FieldType>;
  /** The generic funnel groups by property text, so mixed types would merge distinct values. */
  consistentTypes?: boolean;
}

interface Measurement {
  answer: Record<string, unknown>;
  summary: string;
  sql: string[];
  drilldown: { route: string; params: Record<string, unknown> };
}

interface ProductQuestion {
  project: string;
  key: string;
  revision: number;
  title: string;
  unit: string;
  method: string;
  limitation: string;
  source: string;
  inputs: QuestionInput[];
  followUpMs?: number;
  run: (range: TimeRange, ctx: QueryContext) => Promise<Measurement>;
}

const agentEvent = 'agent_operation_completed';
const onboarding = 'onboarding_completed';
const habit = 'habit_completed';

export const productQuestions: readonly ProductQuestion[] = [
  {
    project: 'levelforge',
    key: 'review-intake',
    revision: 1,
    title: 'How many distinct Studio tasks did agents submit for producer review?',
    unit: 'Studio task identified by project_id and task_id',
    method:
      'Count a successful taskBoard.advance with action submit and resulting status review. Count each Studio project and task pair once within the period. Report matching events with missing identifiers separately.',
    limitation:
      'Producer decisions and review age require LevelForge’s durable task revision history. Observe measures submitted tasks.',
    source:
      'https://git.forgegraf.com/gmackie/levelforge/src/commit/5a3576b853b5c32af43fb27ea1a39e7b5c48cc83/apps/nextjs/.glass/client/README.md#L55',
    inputs: [
      {
        event: agentEvent,
        fields: {
          operation: 'string',
          action: 'string',
          status: 'string',
          project_id: 'string',
          task_id: 'string',
        },
      },
    ],
    run: reviewIntake,
  },
  {
    project: 'habitplay',
    key: 'guest-habit-follow-up',
    revision: 1,
    title: 'Did guests log another completed habit within 24 hours of finishing onboarding?',
    unit: 'Tracked guest identity with a full 24-hour follow-up',
    method:
      'Enter at guest onboarding completion and allow 24 hours before the observation cutoff. Count a later done habit on a known surface outside onboarding. Break down the result by first_task_done at entry. Report counts with the eligible denominator.',
    limitation:
      'HabitPlay emits the starter habit before it records onboarding completion. A missing later event leaves activity outside the observed surfaces unknown.',
    source:
      'https://git.forgegraf.com/gmackie/habitplay/src/branch/main/apps/expo/app/%28onboarding%29/first-task.tsx#L30',
    inputs: [
      {
        event: onboarding,
        consistentTypes: true,
        fields: { path: 'string', first_task_done: 'boolean' },
      },
      { event: habit, consistentTypes: true, fields: { status: 'string', surface: 'string' } },
    ],
    followUpMs: DAY_MS,
    run: habitFollowUp,
  },
];

export function questionDefinition({ run: _run, ...definition }: ProductQuestion) {
  return definition;
}

export function questionSkill(question: ProductQuestion): string {
  const { project, key, title, unit, method, limitation, revision } = question;
  const example = JSON.stringify({ project, key, from: '-30d', to: 'now' });
  const sources = question.inputs
    .map(
      ({ event, fields }) =>
        `- \`${event}\` with ${Object.entries(fields)
          .map(([name, type]) => `\`${name}\` (${type})`)
          .join(', ')}`,
    )
    .join('\n');
  return `---
name: ${project}-${key}
description: ${JSON.stringify(title)}
metadata:
  revision: "${revision}"
---

# ${title}

Use Observe’s read-only \`run_product_question\` tool. For the last 30 days, pass \`${example}\`. Use the requested time bounds for other periods. The start is inclusive and the observation cutoff is exclusive.

Counting unit: ${unit}. ${method}

## Required signals

${sources}

If the answer is unavailable, report the missing evidence returned by the tool. For a measured result, include the observation cutoff and the dashboard link. ${limitation} [App event contract](${question.source})
`;
}

/** Count typed inputs within the same project and observation period as the measurement.
 * No individual property values leave the event store. */
async function inputEvidence(input: QuestionInput, range: TimeRange, ctx: QueryContext) {
  const d = ctx.dialect;
  const fields = Object.entries(input.fields);
  const columns = fields.map(([key, type], i) => {
    const value =
      type === 'boolean'
        ? d.jsonBool('props', [key])
        : `NULLIF(${d.jsonString('props', [key])}, '')`;
    const typed = `COUNT(${value}) AS f${i}`;
    if (!input.consistentTypes) return typed;
    return `${typed}, COUNT(NULLIF(${d.jsonText('props', [key])}, '')) AS present${i}`;
  });
  const [row] =
    await ctx.execute(`SELECT COUNT(*) AS n, ${columns.join(', ')} FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND event = ${d.str(input.event)}
  AND ts_ms >= ${d.num(range.from)} AND ts_ms < ${d.num(range.to)}`);
  const count = num(row?.n);
  const missingFields = fields
    .filter((_, i) => {
      const typed = num(row?.[`f${i}`]);
      return !typed || (input.consistentTypes && typed !== num(row?.[`present${i}`]));
    })
    .map(([key, type]) => `${input.event}.${key} (${type})`);
  return { event: input.event, count, missing: count ? missingFields : [input.event] };
}

export async function questionEvidence(
  question: ProductQuestion,
  range: TimeRange,
  ctx: QueryContext,
) {
  const inputs = await Promise.all(
    question.inputs.map((input) => inputEvidence(input, range, ctx)),
  );
  const missing = inputs.flatMap((input) => input.missing);
  if (question.followUpMs && range.to - range.from <= question.followUpMs)
    missing.push('Choose an observation period longer than 24 hours for a complete follow-up.');
  return { ready: missing.length === 0, inputs, missing };
}

function reviewSql(d: Dialect, table: string, project: string, range: TimeRange) {
  const prop = (key: string) => d.jsonString('props', [key]);
  return `SELECT COUNT(CASE WHEN studio IS NOT NULL AND task IS NOT NULL THEN 1 END) AS tasks,
  COUNT(DISTINCT CASE WHEN task IS NOT NULL THEN studio END) AS studios,
  COALESCE(SUM(n), 0) AS submissions,
  COALESCE(SUM(CASE WHEN studio IS NULL OR task IS NULL THEN n ELSE 0 END), 0) AS unkeyed
FROM (
  SELECT NULLIF(${prop('project_id')}, '') AS studio, NULLIF(${prop('task_id')}, '') AS task, COUNT(*) AS n
  FROM ${table}
  WHERE project = ${d.str(project)} AND ts_ms >= ${d.num(range.from)} AND ts_ms < ${d.num(range.to)}
    AND event = ${d.str(agentEvent)} AND ${prop('operation')} = ${d.str('taskBoard.advance')}
    AND ${prop('action')} = ${d.str('submit')} AND ${prop('status')} = ${d.str('review')}
  GROUP BY 1, 2
) submissions`;
}

async function reviewIntake(range: TimeRange, ctx: QueryContext): Promise<Measurement> {
  const d = ctx.dialect;
  const query = (logical = false) => reviewSql(d, d.table('events', logical), ctx.project, range);
  const sql = query();
  const [row] = await ctx.execute(sql);
  const answer = {
    distinctTasks: num(row?.tasks),
    studioProjects: num(row?.studios),
    submissionEvents: num(row?.submissions),
    unkeyedEvents: num(row?.unkeyed),
  };
  return {
    answer,
    sql: [sql],
    drilldown: { route: 'sql', params: { query: query(true) } },
    summary: `Observed ${answer.distinctTasks} distinct tasks submitted for review across ${answer.studioProjects} Studio projects. Matching events missing a task or project ID: ${answer.unkeyedEvents}.`,
  };
}

async function habitFollowUp(range: TimeRange, ctx: QueryContext): Promise<Measurement> {
  // runFunnel extends the entry window by its conversion window when reading later steps.
  const spec: FunnelSpec = {
    from: range.from,
    to: range.to - DAY_MS,
    order: 'ordered',
    window: '24h',
    aggregateBy: 'person',
    steps: [
      { event: onboarding, filters: [{ property: 'props.path', value: 'guest' }] },
      {
        event: habit,
        filters: [
          { property: 'props.status', value: 'done' },
          { property: 'props.surface', op: 'is_set' },
          { property: 'props.surface', op: 'neq', value: '' },
          { property: 'props.surface', op: 'neq', value: 'onboarding' },
        ],
      },
    ],
    breakdown: 'props.first_task_done',
    breakdownAttribution: 'first_touch',
  };
  const funnel = await runFunnel(spec, ctx);
  const eligibleGuests = funnel.steps[0]!.count;
  const followedUp = funnel.steps[1]!.count;
  const byStarterTask = (funnel.breakdowns ?? []).map(({ value, steps }) => ({
    firstTaskDone: value,
    eligibleGuests: steps[0]!.count,
    followedUp: steps[1]!.count,
  }));
  return {
    answer: {
      eligibleGuests,
      followedUp,
      followUpShare: eligibleGuests ? followedUp / eligibleGuests : null,
      entryCutoff: iso(range.to - DAY_MS),
      byStarterTask,
    },
    summary: `Observed an outside-onboarding habit completion within 24 hours for ${followedUp} of ${eligibleGuests} eligible guest identities.`,
    sql: funnel.sql,
    drilldown: { route: 'insights/funnel', params: { spec } },
  };
}
