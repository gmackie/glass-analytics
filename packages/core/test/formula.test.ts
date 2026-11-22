import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkFormula,
  evaluateFormula,
  FormulaError,
  formulaContext,
  lexFormula,
  parseFormula,
} from '../src/formula.ts';

const run = (f: string, values: number[]) =>
  evaluateFormula(parseFormula(f, values.length), values);

const problem = (f: string, series: number | string[] = 3) => {
  const r = checkFormula(f, series);
  assert.equal(r.ok, false, `expected "${f}" to be rejected`);
  return r as Extract<typeof r, { ok: false }>;
};

describe('formulas', () => {
  it('evaluates arithmetic with precedence and parentheses', () => {
    assert.equal(run('B / A * 100', [200, 50]), 25);
    assert.equal(run('(A - B) / A', [10, 4]), 0.6);
    assert.equal(run('A + B * C', [1, 2, 3]), 7);
    assert.equal(run('-A + 2', [5]), -3);
    assert.equal(run('a × b ÷ 2', [3, 4]), 6);
    assert.equal(run('--A', [5]), 5);
  });

  it('gives 0 when dividing by zero', () => {
    assert.equal(run('A / B', [5, 0]), 0);
  });

  it('calls abs, min, max and round', () => {
    assert.equal(run('abs(A - B)', [3, 10]), 7);
    assert.equal(run('min(A, B) + max(A, B)', [3, 10]), 13);
    assert.equal(run('round(B / A, 2)', [3, 1]), 0.33);
    assert.equal(run('ROUND(A / 4)', [10]), 3);
    assert.equal(run('round(A, 99)', [1.5]), 1.5);
  });

  it('rejects unknown series, names and code', () => {
    assert.throws(() => parseFormula('A + D', 3), /uses D, but there are 3 series \(A–C\)/);
    assert.throws(() => parseFormula('Math.max(A)', 1), FormulaError);
    assert.throws(() => parseFormula('A; process.exit()', 1), FormulaError);
    assert.throws(() => parseFormula('(A + B', 2), /Expected "\)"/);
    assert.throws(() => parseFormula('A B', 2), /after a complete formula/);
    assert.throws(() => parseFormula('constructor', 1), /Unknown name "constructor"/);
    assert.throws(() => parseFormula('x'.repeat(501), 1), /too long/);
  });

  it('points at the mistake, in words that name the series', () => {
    const d = problem('B / D', ['Pageview', 'Signed up']);
    assert.equal(d.message, "D isn't a series: you have A (Pageview) and B (Signed up)");
    assert.deepEqual([d.at, d.end], [4, 5]);

    const open = problem('(A + B');
    assert.match(open.message, /close the "\(" at column 1/);
    assert.deepEqual([open.at, open.end], [6, 6]);
    assert.deepEqual(open.expected, ['operator', 'close']);

    const dangling = problem('A /');
    assert.match(dangling.message, /ends too soon/);
    assert.deepEqual(dangling.expected, ['value']);

    assert.match(problem('min(A)').message, /min takes 2 values: min\(a, b\)/);
    assert.match(problem('round(A, 1, 2)').message, /round takes 1 or 2 values/);
    assert.match(problem('abs A').message, /Write abs\(x\)/);
    assert.match(problem('A $ B').message, /"\$" can't be used/);
    assert.match(problem('1.2.3').message, /"1.2.3" isn't a number/);
    assert.match(problem('').message, /Empty/);
    assert.match(problem('A)').message, /a "\)" with no "\(" before it/);
    assert.match(problem('A', 0).message, /add a series first/);
  });

  it('lists the series a formula uses', () => {
    const r = checkFormula('C / (A + C)', 3);
    assert.ok(r.ok);
    assert.deepEqual(r.refs, [0, 2]);
  });
});

describe('formula editing help', () => {
  it('lexes everything, even mistakes, with positions', () => {
    const text = 'round(B ÷ A, 2) $';
    const tokens = lexFormula(text);
    assert.equal(tokens.map((t) => text.slice(t.start, t.end)).join(''), text);
    assert.deepEqual(
      tokens.filter((t) => t.kind !== 'space').map((t) => [t.kind, t.text]),
      [
        ['fn', 'round'],
        ['paren', '('],
        ['var', 'B'],
        ['op', '/'],
        ['var', 'A'],
        ['comma', ','],
        ['num', '2'],
        ['paren', ')'],
        ['bad', '$'],
      ],
    );
  });

  it('knows whether a value or an operator comes next, and the word being typed', () => {
    assert.deepEqual(formulaContext('', 0), { expect: 'value', word: null, depth: 0 });
    assert.equal(formulaContext('B /', 3).expect, 'value');
    assert.equal(formulaContext('B / A', 5).expect, 'value'); // still typing "A"
    assert.equal(formulaContext('B / A ', 6).expect, 'operator');
    assert.equal(formulaContext('(A + B)', 7).expect, 'operator');
    const typing = formulaContext('B / ro', 6);
    assert.deepEqual(typing.word, { start: 4, end: 6, text: 'ro' });
    assert.equal(typing.expect, 'value');
    assert.equal(formulaContext('max(A, (B', 9).depth, 2);
  });
});
