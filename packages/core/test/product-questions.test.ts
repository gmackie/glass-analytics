import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compileFunnel } from '../src/insights/funnel.ts';
import { productQuestions, questionEvidence } from '../src/insights/product-questions.ts';
import type { FunnelSpec } from '../src/insights/schemas.ts';
import { context, createDb, DAY, insert, link, NOW } from './helpers.ts';

const range = { from: NOW - 4 * DAY, to: NOW };
const review = productQuestions.find((q) => q.project === 'levelforge')!;
const followUp = productQuestions.find((q) => q.project === 'habitplay')!;

it('counts distinct Studio tasks per project and reports unkeyed submissions', async () => {
  const db = createDb();
  const ctx = context(db, review.project);
  const submit = (studio: unknown, task: unknown, ts = range.from, project = ctx.project) => ({
    project,
    event: 'agent_operation_completed',
    ts_ms: ts,
    props: {
      project_id: studio,
      task_id: task,
      action: 'submit',
      status: 'review',
      operation: 'taskBoard.advance',
    },
  });
  insert(db, [
    submit('p', 'a'),
    submit('p', 'a', range.from + 1),
    submit('q', 'a', range.to - 1),
    submit('p', null),
    submit('', 'b'),
    submit('p', 17),
    submit('p', 'other', range.from, 'elsewhere'),
    submit('p', 'late', range.to),
    {
      ...submit('p', 'listed'),
      props: {
        operation: 'taskBoard.list',
        action: 'submit',
        status: 'review',
        project_id: 'p',
        task_id: 'listed',
      },
    },
  ]);
  assert.equal((await questionEvidence(review, range, ctx)).ready, true);
  const result = await review.run(range, ctx);
  assert.deepEqual(result.answer, {
    distinctTasks: 2,
    studioProjects: 2,
    submissionEvents: 6,
    unkeyedEvents: 3,
  });
  assert.deepEqual(
    (await ctx.execute(String(result.drilldown.params.query))).map((row) => ({ ...row })),
    [
      {
        tasks: 2,
        studios: 2,
        submissions: 6,
        unkeyed: 3,
      },
    ],
  );
  const empty = await review.run({ from: 0, to: 1 }, ctx);
  assert.deepEqual(empty.answer, {
    distinctTasks: 0,
    studioProjects: 0,
    submissionEvents: 0,
    unkeyedEvents: 0,
  });
  db.close();
});

it('observes a complete guest cohort, resolves identity and separates onboarding from subsequent habits', async () => {
  const db = createDb();
  const ctx = context(db, followUp.project);
  const entry = (id: string, ts: number, first: boolean, path = 'guest') => ({
    project: ctx.project,
    event: 'onboarding_completed',
    distinct_id: id,
    ts_ms: ts,
    props: { path, first_task_done: first },
  });
  const done = (id: string, ts: number, surface?: string, status = 'done') => ({
    project: ctx.project,
    event: 'habit_completed',
    distinct_id: id,
    ts_ms: ts,
    props: { surface, status },
  });
  const t = range.from + 1000;
  link(db, 'guest-phone', 'same', ctx.project);
  link(db, 'guest-tablet', 'same', ctx.project);
  insert(db, [
    done('guest-phone', t - 1, 'onboarding'),
    entry('guest-phone', t, true),
    done('guest-tablet', t + DAY, 'today'),
    entry('skipped', t + 1, false),
    done('skipped', t + 2, 'onboarding'),
    done('skipped', t + 3, undefined),
    done('skipped', t + 4, ''),
    done('skipped', t + 5, 'tasks', 'skipped'),
    done('skipped', t + DAY + 2, 'today'),
    entry('still-observing', NOW - DAY, true),
    done('still-observing', NOW - DAY + 100, 'today'),
    entry('signed-in', t, false, 'authenticated'),
    done('signed-in', t + 1, 'today'),
    { ...done('skipped', t + 10, 'today'), project: 'elsewhere' },
  ]);
  const r = await followUp.run(range, ctx);
  assert.equal(r.answer.eligibleGuests, 2);
  assert.equal(r.answer.followedUp, 1);
  assert.equal(r.answer.followUpShare, 0.5);
  // A dashboard drill-down must replay the same cohort, including its complete follow-up day.
  const editorSpec = r.drilldown.params.spec as FunnelSpec;
  const [editorSql] = compileFunnel(
    editorSpec,
    ctx,
    {
      from: Number(editorSpec.from),
      to: Number(editorSpec.to),
    },
    DAY,
  );
  const editorRows = await ctx.execute(editorSql!);
  assert.deepEqual(editorRows.map((row) => [row.bd, row.n1, row.n2]).sort(), [
    ['false', 1, 0],
    ['true', 1, 1],
  ]);

  assert.deepEqual(
    (r.answer.byStarterTask as { firstTaskDone: string }[]).sort((a, b) =>
      a.firstTaskDone.localeCompare(b.firstTaskDone),
    ),
    [
      { firstTaskDone: 'false', eligibleGuests: 1, followedUp: 0 },
      { firstTaskDone: 'true', eligibleGuests: 1, followedUp: 1 },
    ],
  );
  assert.equal((await questionEvidence(followUp, range, ctx)).ready, true);
  const short = await questionEvidence(followUp, { from: NOW - DAY, to: NOW }, ctx);
  assert.match(short.missing.join(' '), /longer than 24 hours/);
  assert.equal(
    (await followUp.run({ from: NOW - 10 * DAY, to: NOW - 8 * DAY }, ctx)).answer.followUpShare,
    null,
  );
  insert(db, [{ ...done('skipped', t + 6), props: { surface: 17, status: 'done' } }]);
  assert.ok(
    (await questionEvidence(followUp, range, ctx)).missing.includes(
      'habit_completed.surface (string)',
    ),
  );
  db.close();
});
