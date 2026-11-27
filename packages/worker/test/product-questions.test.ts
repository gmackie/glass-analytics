import assert from 'node:assert/strict';
import { it } from 'node:test';
import { READ, testApp, wire } from './harness.ts';

it('discovers, generates and runs bounded product questions through the read API and MCP', async () => {
  const app = testApp();
  for (const id of ['levelforge', 'habitplay', 'quiet'])
    await app.json('POST', '/api/projects', { body: { id } });
  const from = Date.now() - 300_000;
  const to = from + 200_000;
  const range = `from=${from}&to=${to}`;
  const root = '/api/product-questions';
  const key = 'review-intake';
  const params = { project: 'levelforge', key, from, to };
  const path = (op: string) => `${root}/${key}${op}?project=levelforge&${range}`;
  const mcp = async (name: string, args: object) => {
    const rpc = await app.json<{
      result: { structuredContent: Record<string, unknown>; isError?: boolean };
    }>('POST', '/mcp', {
      key: READ,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    assert.ok(!rpc.result.isError, JSON.stringify(rpc.result));
    return rpc.result.structuredContent;
  };
  const fleet = await app.json<{ projects: string[]; questions: { key: string }[] }>(
    'GET',
    `${root}?${range}`,
    { key: READ },
  );
  assert.deepEqual(fleet.projects.sort(), ['habitplay', 'levelforge', 'quiet']);
  assert.equal(fleet.questions.length, 2);
  const quiet = await mcp('list_product_questions', { project: 'quiet', from, to });
  assert.deepEqual(quiet.questions, []);
  assert.match(String(quiet.summary), /instrumentation_coverage/);
  const missing = await mcp('get_product_question', params);
  assert.equal(missing.skill, null);
  const gap = await app.json('GET', path('/run'), { key: READ });
  assert.equal(gap.answer, null);
  assert.match(String(gap.summary), /agent_operation_completed/);
  assert.equal(
    (
      await app.call('GET', path('').replace('project=levelforge', 'project=habitplay'), {
        key: READ,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.call('GET', path('').replace('project=levelforge', 'project=unregistered'), {
        key: READ,
      })
    ).status,
    404,
  );
  assert.equal(
    (await app.call('GET', root + '?project=quiet&from=2099-01-01&to=2099-01-02', { key: READ }))
      .status,
    400,
  );
  assert.equal((await app.call('GET', path(''), { key: null })).status, 401);
  const signal = {
    project_id: 'studio',
    operation: 'taskBoard.advance',
    action: 'submit',
    status: 'review',
  };
  const send = async (task_id: unknown, when = from + 1000, extra = {}) =>
    app.json('POST', '/api/import', {
      body: {
        project: 'levelforge',
        events: [
          wire('agent_operation_completed', { ts: when, props: { ...signal, task_id, ...extra } }),
        ],
      },
    });
  await send(123);
  assert.match(
    JSON.stringify((await mcp('get_product_question', params)).evidence),
    /task_id \(string\)/,
  );
  await send('task-A');
  const first = await mcp('get_product_question', params);
  assert.match(String(first.skill), /^---\nname: levelforge-review-intake/);
  assert.match(String(first.skill), /run_product_question/);
  await send('task-A', from + 2000, { note: 'private-free-text' });
  await send('outside', to);
  const second = await app.json('GET', path(''), { key: READ });
  assert.equal(first.skill, second.skill);
  assert.doesNotMatch(JSON.stringify(second), /private-free-text|task-A/);
  const result = await mcp('run_product_question', params);
  assert.deepEqual(result, await app.json('GET', path('/run'), { key: READ }));
  assert.deepEqual(result.answer, {
    distinctTasks: 1,
    studioProjects: 1,
    submissionEvents: 3,
    unkeyedEvents: 1,
  });
  assert.match(String(result.dashboard), /#\/sql\?project=levelforge/);
});
