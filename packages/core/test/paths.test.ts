/**
 * User paths: forward from a start, backward to an end, between two points, around a funnel
 * step; repeats, exclusions, wildcard groups, cleaning rules, session and window boundaries,
 * "Other", people-per-link limits, and drill-down into nodes, links and drop-offs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePathsActors, type PathsResult, runPaths } from '../src/insights/paths.ts';
import { pathsSpec } from '../src/insights/schemas.ts';
import { globToGlob, globToLike } from '../src/sql/dialect.ts';
import { context, createDb, DAY, insert, NOW, type TestEvent } from './helpers.ts';

const MIN = 60_000;
const BASE = NOW - 2 * DAY;

/** One person's visit: steps a minute apart, in one session. */
function visit(
  person: string,
  steps: string[],
  opts: { session?: string; at?: number } = {},
): TestEvent[] {
  const at = opts.at ?? BASE;
  return steps.map((step, i) => ({
    distinct_id: person,
    session_id: opts.session ?? `${person}-s`,
    ts_ms: at + i * MIN,
    ...(step.startsWith('/') ? { event: '$pageview', path: step } : { event: step }),
  }));
}

function seed(): ReturnType<typeof createDb> {
  const db = createDb();
  insert(db, [
    ...visit('a', ['/', '/pricing', '/signup', 'signup_completed']),
    ...visit('b', ['/', '/pricing', '/pricing', '/docs']),
    ...visit('c', ['/', '/docs', '/pricing', '/signup']),
    ...visit('d', ['/blog/one', '/pricing']),
    ...visit('e', ['/blog/two', '/', '/pricing']),
    ...visit('f', ['/users/42/settings', '/users/7/settings', '/']),
    // Noise Dataflare records about itself never shows up.
    { distinct_id: 'a', session_id: 'a-s', event: '$pageleave', ts_ms: BASE + 30_000 },
  ]);
  return db;
}

const run = (db: ReturnType<typeof createDb>, s: Record<string, unknown>, extra: object = {}) =>
  runPaths(pathsSpec.parse({ from: '-7d', ...s }), { ...context(db), ...extra });

const node = (r: PathsResult, column: number, label: string) =>
  r.nodes.find((n) => n.column === column && n.label === label);
const link = (r: PathsResult, from: string, to: string) =>
  r.links.find((l) => l.source === from && l.target === to);

describe('paths', () => {
  it('follows each person forward from their first page, collapsing repeats', async () => {
    const r = await run(seed(), { steps: 4 });
    assert.equal(r.kind, 'paths');
    assert.equal(r.direction, 'forward');
    assert.equal(r.total, 6);
    assert.equal(node(r, 1, '/')?.count, 3);
    // b's two /pricing views are one step: / → /pricing → /docs.
    assert.equal(link(r, '2:/pricing', '3:/docs')?.count, 1);
    assert.equal(link(r, '1:/', '2:/pricing')?.count, 2);
    assert.equal(link(r, '1:/', '2:/pricing')?.avgSeconds, 60);
    // Pages only by default: a's signup_completed isn't a step, so a stops at /signup.
    assert.equal(node(r, 3, '/signup')?.count, 1);
    assert.equal(node(r, 3, '/signup')?.dropOff, 1);
    // Every path is different; ties go in order of their steps.
    assert.deepEqual(r.topPaths[0], { items: ['/', '/docs', '/pricing', '/signup'], count: 1 });
    assert.match(r.summary, /6 people/);
    assert.ok(r.sql.length === 2);
  });

  it('keeps repeats when asked', async () => {
    const r = await run(seed(), { steps: 4, collapseRepeats: false });
    assert.equal(link(r, '2:/pricing', '3:/pricing')?.count, 1);
  });

  it('includes custom events, but never Dataflare bookkeeping', async () => {
    const r = await run(seed(), { steps: 4, include: { pages: true, events: true } });
    assert.equal(link(r, '3:/signup', '4:signup_completed')?.count, 1);
    assert.ok(!r.nodes.some((n) => n.label === '$pageleave'));
  });

  it('starts at a page (globs allowed) and ends at one', async () => {
    const start = await run(seed(), { start: { value: '/pricing' }, steps: 3 });
    assert.equal(start.total, 5);
    assert.equal(node(start, 1, '/pricing')?.count, 5);
    assert.equal(link(start, '1:/pricing', '2:/signup')?.count, 2);

    const blog = await run(seed(), { start: { value: '/blog/*' }, steps: 2 });
    assert.equal(blog.total, 2);

    const end = await run(seed(), { end: { value: '/pricing' }, steps: 3 });
    assert.equal(end.direction, 'backward');
    // The end is the last column; what led there is before it.
    assert.equal(node(end, 3, '/pricing')?.count, 5);
    assert.equal(link(end, '2:/', '3:/pricing')?.count, 3);
    assert.deepEqual(end.topPaths.find((p) => p.items[0] === '/blog/two')?.items, [
      '/blog/two',
      '/',
      '/pricing',
    ]);
  });

  it('between a start and an end keeps only paths that got there, and stops at the end', async () => {
    const r = await run(seed(), { start: { value: '/' }, end: { value: '/signup' }, steps: 5 });
    // a (/ → /pricing → /signup) and c (/ → /docs → /pricing → /signup); b never reaches /signup.
    assert.equal(r.total, 2);
    assert.ok(r.nodes.every((n) => n.column <= 4));
    assert.equal(node(r, 3, '/signup')?.count, 1);
  });

  it('excludes, groups with wildcards and cleans paths', async () => {
    const ex = await run(seed(), { exclude: ['/docs'], steps: 3 });
    assert.ok(!ex.nodes.some((n) => n.label === '/docs'));

    const grouped = await run(seed(), { groups: ['/blog/*'], steps: 2 });
    assert.equal(node(grouped, 1, '/blog/*')?.count, 2);

    const cleaned = await run(seed(), {
      cleaning: [{ match: '/users/*/settings', alias: '/users/:id/settings' }],
      steps: 3,
    });
    // Both settings pages are one step now, so they collapse: /users/:id/settings → /.
    assert.equal(link(cleaned, '1:/users/:id/settings', '2:/')?.count, 1);

    const project = await run(
      seed(),
      { steps: 3 },
      { pathCleaning: [{ match: '/users/*/settings', alias: '/users/:id/settings' }] },
    );
    assert.ok(node(project, 1, '/users/:id/settings'));
    const off = await run(
      seed(),
      { steps: 3, projectCleaning: false },
      { pathCleaning: [{ match: '/users/*/settings', alias: '/users/:id/settings' }] },
    );
    assert.ok(node(off, 1, '/users/42/settings'));
  });

  it('stays in the session, or spans sessions inside a window', async () => {
    const db = createDb();
    insert(db, [
      ...visit('g', ['/', '/pricing'], { session: 'g1' }),
      ...visit('g', ['/signup'], { session: 'g2', at: BASE + 10 * MIN }),
    ]);
    const session = await run(db, { steps: 3 });
    assert.equal(node(session, 2, '/pricing')?.dropOff, 1);
    const window = await run(db, { steps: 3, boundary: { minutes: 60 } });
    assert.equal(link(window, '2:/pricing', '3:/signup')?.count, 1);
    const short = await run(db, { steps: 3, boundary: { minutes: 5 } });
    assert.equal(link(short, '2:/pricing', '3:/signup'), undefined);
  });

  it('counts sessions instead of people', async () => {
    const db = createDb();
    insert(db, [
      ...visit('h', ['/', '/docs'], { session: 'h1' }),
      ...visit('h', ['/', '/pricing'], { session: 'h2', at: BASE + DAY / 2 }),
    ]);
    assert.equal((await run(db, { steps: 2 })).total, 1);
    const sessions = await run(db, { steps: 2, aggregateBy: 'session' });
    assert.equal(sessions.total, 2);
    assert.match(sessions.summary, /2 sessions/);
  });

  it('groups the rare steps of a column into Other, and filters links by people', async () => {
    const r = await run(seed(), { steps: 2, perStep: 1 });
    const other = node(r, 1, 'Other');
    assert.ok(other?.other);
    assert.equal(other?.count, 3);
    const min = await run(seed(), { steps: 2, minPeople: 2 });
    assert.ok(min.links.every((l) => l.count >= 2));
    assert.ok(
      min.nodes.every((n) => min.links.some((l) => l.source === n.id || l.target === n.id)),
    );
  });

  it('looks around a funnel step', async () => {
    const funnel = {
      steps: [
        { event: '$pageview', filters: [{ property: 'path', value: '/' }] },
        { event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] },
      ],
    };
    const after = await run(seed(), { funnel: { spec: funnel, step: 2, mode: 'after' }, steps: 3 });
    // a, b, c, e reached /pricing after /: their paths start there.
    assert.equal(node(after, 1, '/pricing')?.count, 4);
    const dropoff = await run(seed(), {
      funnel: { spec: funnel, step: 2, mode: 'dropoff' },
      steps: 3,
    });
    // No one who visited / failed to reach /pricing except f (/ is f's last page).
    assert.equal(dropoff.total, 1);
    const between = await run(seed(), {
      funnel: { spec: funnel, step: 1, mode: 'between' },
      steps: 4,
    });
    // c went / → /docs → /pricing: /docs sits between.
    assert.equal(link(between, '1:/', '2:/docs')?.count, 1);
    assert.ok(!between.nodes.some((n) => n.label === '/signup'));
    const before = await run(seed(), {
      funnel: { spec: funnel, step: 2, mode: 'before' },
      steps: 3,
    });
    assert.equal(before.direction, 'backward');
    assert.equal(node(before, 3, '/pricing')?.count, 4);
  });

  it('rejects specs that cannot work', async () => {
    const funnel = { steps: [{ event: 'a' }, { event: 'b' }] };
    await assert.rejects(
      run(seed(), { funnel: { spec: funnel, step: 1, mode: 'after' }, start: { value: '/' } }),
      /not both/,
    );
    await assert.rejects(
      run(seed(), { funnel: { spec: { ...funnel, order: 'unordered' }, step: 1, mode: 'after' } }),
      /ordered/,
    );
    await assert.rejects(
      run(seed(), { funnel: { spec: funnel, step: 2, mode: 'between' } }),
      /before the last/,
    );
    await assert.rejects(
      run(seed(), { funnel: { spec: funnel, step: 1, mode: 'dropoff' } }),
      /step 2/,
    );
    await assert.rejects(run(seed(), { include: { pages: false } }), /Include/);
  });

  it('lists the people behind a node, a link and a drop-off', async () => {
    const db = seed();
    const ctx = context(db);
    const spec = pathsSpec.parse({ from: '-7d', steps: 4 });
    const actors = async (sel: Parameters<typeof compilePathsActors>[2]) =>
      (await ctx.execute(compilePathsActors(spec, ctx, sel, { limit: 50, offset: 0 }))).map(
        (r) => r.actor,
      );
    assert.deepEqual(await actors({ node: '1:/' }), ['a', 'b', 'c']);
    assert.deepEqual(await actors({ node: '1:/', target: '2:/pricing' }), ['a', 'b']);
    assert.deepEqual(await actors({ node: '3:/signup', dropOff: true }), ['a']);
    assert.throws(
      () => compilePathsActors(spec, ctx, { node: '1:Other' }, { limit: 1, offset: 0 }),
      /Other/,
    );
    assert.throws(
      () => compilePathsActors(spec, ctx, { node: 'nope' }, { limit: 1, offset: 0 }),
      /node id/,
    );
  });
});

describe('glob patterns', () => {
  it('escape each engine’s own wildcards', () => {
    assert.equal(globToLike('/a_b%c\\/*'), '/a\\_b\\%c\\\\/%');
    assert.equal(globToGlob('/a?[b]/*'), '/a[?][[]b]/*');
  });
});

describe('path cleaning suggestions', () => {
  it('proposes a rule per id-shaped pattern that merges several paths', async () => {
    const { suggestPathRules } = await import('../src/insights/paths.ts');
    const rules = suggestPathRules([
      { path: '/users/42/settings', views: 10 },
      { path: '/users/7/settings', views: 5 },
      { path: '/orders/3f2a9c1e-1b2c-4d5e-8f90-123456789abc', views: 4 },
      { path: '/orders/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', views: 2 },
      { path: '/blog/2026-11-19', views: 1 },
      { path: '/pricing', views: 100 },
      { path: '/posts/99', views: 1 },
    ]);
    assert.deepEqual(
      rules.map((r) => [r.match, r.alias, r.paths, r.views]),
      [
        ['/users/*/settings', '/users/:id/settings', 2, 15],
        ['/orders/*', '/orders/:uuid', 2, 6],
      ],
    );
    assert.deepEqual(rules[0]!.examples, ['/users/42/settings', '/users/7/settings']);
  });
});
