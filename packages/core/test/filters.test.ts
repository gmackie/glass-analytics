import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Filter, matchFilter, parseProperty } from '../src/filters.ts';
import { basin, sqlite } from '../src/sql/dialect.ts';
import { filtersSql } from '../src/sql/filters.ts';
import { assertReadOnlySql, UnsafeSqlError } from '../src/sql/guard.ts';
import { createDb, insert } from './helpers.ts';

function idsMatching(filters: Filter[]): string[] {
  const db = createDb();
  insert(db, [
    {
      id: 'a',
      browser: 'Chrome',
      props: { plan: 'pro', seats: 5, beta: true, tags: { team: 'core' } },
      person_props: { tier: 'gold' },
    },
    { id: 'b', browser: 'Firefox', props: { plan: 'free', seats: 1, beta: false } },
    { id: 'c', browser: 'Safari', props: {} },
    { id: 'd', browser: 'Chrome', props: { plan: "o'brien" } },
  ]);
  const rows = db
    .prepare(`SELECT id FROM events WHERE ${filtersSql(filters, sqlite)} ORDER BY id`)
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

describe('property references', () => {
  it('distinguishes columns, event props and person props', () => {
    assert.deepEqual(parseProperty('browser'), { kind: 'column', column: 'browser' });
    assert.deepEqual(parseProperty('plan'), { kind: 'event', path: ['plan'] });
    assert.deepEqual(parseProperty('props.tags.team'), { kind: 'event', path: ['tags', 'team'] });
    assert.deepEqual(parseProperty('person.tier'), { kind: 'person', path: ['tier'] });
  });
});

describe('filters compiled to SQL (executed on SQLite)', () => {
  it('compares columns and event properties', () => {
    assert.deepEqual(idsMatching([{ property: 'browser', value: 'Chrome' }]), ['a', 'd']);
    assert.deepEqual(idsMatching([{ property: 'plan', value: 'pro' }]), ['a']);
    assert.deepEqual(idsMatching([{ property: 'props.tags.team', value: 'core' }]), ['a']);
  });

  it('treats neq and not_contains as including missing values', () => {
    assert.deepEqual(idsMatching([{ property: 'plan', op: 'neq', value: 'pro' }]), ['b', 'c', 'd']);
    assert.deepEqual(idsMatching([{ property: 'plan', op: 'not_contains', value: 'PR' }]), [
      'b',
      'c',
      'd',
    ]);
  });

  it('handles numbers, booleans, lists and presence', () => {
    assert.deepEqual(idsMatching([{ property: 'seats', op: 'gt', value: 2 }]), ['a']);
    assert.deepEqual(idsMatching([{ property: 'seats', value: 1 }]), ['b']);
    assert.deepEqual(idsMatching([{ property: 'beta', value: true }]), ['a']);
    assert.deepEqual(idsMatching([{ property: 'beta', value: false }]), ['b']);
    assert.deepEqual(idsMatching([{ property: 'plan', op: 'in', value: ['pro', 'free'] }]), [
      'a',
      'b',
    ]);
    assert.deepEqual(idsMatching([{ property: 'plan', op: 'is_set' }]), ['a', 'b', 'd']);
    assert.deepEqual(idsMatching([{ property: 'plan', op: 'is_not_set' }]), ['c']);
    assert.deepEqual(idsMatching([{ property: 'person.tier', value: 'gold' }]), ['a']);
  });

  it('escapes values instead of letting them change the query', () => {
    assert.deepEqual(idsMatching([{ property: 'plan', value: "o'brien" }]), ['d']);
    assert.deepEqual(idsMatching([{ property: 'plan', value: "x' OR '1'='1" }]), []);
  });

  it('rejects property keys that could break out of a JSON path', () => {
    assert.throws(
      () => filtersSql([{ property: 'pl"an', value: 'x' }], sqlite),
      /Invalid property key/,
    );
    assert.throws(
      () => filtersSql([{ property: "plan')--", value: 'x' }], basin()),
      /Invalid property key/,
    );
  });

  it('uses Basin JSON functions in the lake dialect', () => {
    const sql = filtersSql(
      [
        { property: 'plan', value: 'pro' },
        { property: 'person.seats', op: 'gte', value: 3 },
      ],
      basin('glass'),
    );
    assert.match(sql, /json_as_text\(props, 'plan'\) = 'pro'/);
    assert.match(sql, /json_get_float\(person_props, 'seats'\) >= 3/);
    assert.doesNotMatch(sql, /json_extract/);
  });
});

describe('filters evaluated in JavaScript (flag targeting)', () => {
  const ctx = { distinct_id: 'x', country: 'GB', person: { plan: 'pro', seats: 4 } };
  it('matches the SQL semantics', () => {
    assert.equal(matchFilter({ property: 'country', value: 'GB' }, ctx), true);
    assert.equal(matchFilter({ property: 'person.plan', value: 'pro' }, ctx), true);
    assert.equal(matchFilter({ property: 'person.seats', op: 'gte', value: 4 }, ctx), true);
    assert.equal(matchFilter({ property: 'person.plan', op: 'neq', value: 'free' }, ctx), true);
    assert.equal(matchFilter({ property: 'person.missing', op: 'is_not_set' }, ctx), true);
    assert.equal(matchFilter({ property: 'country', op: 'in', value: ['US', 'CA'] }, ctx), false);
  });
});

describe('read-only SQL guard', () => {
  it('allows SELECT and WITH queries, including replace()', () => {
    assert.equal(assertReadOnlySql('SELECT 1;'), 'SELECT 1');
    assert.ok(
      assertReadOnlySql(
        "WITH x AS (SELECT replace(path, '/', '') AS p FROM events) SELECT * FROM x",
      ),
    );
    assert.ok(assertReadOnlySql("SELECT 'delete from events' AS harmless"));
    assert.ok(assertReadOnlySql("SELECT '-- not a comment; nor this /*' AS s FROM events"));
    assert.ok(assertReadOnlySql('SELECT /* note */ count(*) FROM events -- trailing'));
    assert.ok(assertReadOnlySql("SELECT 'it''s' AS s"));
    assert.ok(assertReadOnlySql("SELECT [it's] FROM events WHERE a$b = 1"));
    assert.ok(assertReadOnlySql('SELECT props::varchar AS p FROM events'));
    assert.ok(assertReadOnlySql("SELECT * FROM events WHERE props @> '{}'"));
  });

  it('rejects statements hidden by mixing comments and literals', () => {
    for (const sql of [
      "select '/*'; delete from flags; select '*/'",
      "select '/*') q; delete from flags; select * from (select '*/'",
      "select '--'\n; delete from flags",
      "select 'unterminated",
      // SQLite reads [x'] as one identifier, so the quote must not open a string.
      "select 1 as [']) x; delete from flags; select * from (select 1 as [']",
      // A Tcl-style parameter name swallows everything up to `)`, quotes included.
      "select $a(')+1 x) y;delete/**/from/**/flags;select * from (select $b(') z",
      "select @a(')+1 x) y;delete/**/from/**/flags;select * from (select :b(') z",
      'select 1 as [unterminated',
    ]) {
      assert.throws(() => assertReadOnlySql(sql), UnsafeSqlError, sql);
    }
  });

  it('rejects writes, including writes hidden behind WITH', () => {
    for (const sql of [
      'DELETE FROM events',
      'WITH x AS (SELECT 1) DELETE FROM events',
      'SELECT 1; DROP TABLE events',
      'PRAGMA table_info(events)',
      'INSERT INTO flags VALUES (1)',
      'REPLACE INTO flags VALUES (1)',
    ]) {
      assert.throws(() => assertReadOnlySql(sql), UnsafeSqlError, sql);
    }
  });
});
