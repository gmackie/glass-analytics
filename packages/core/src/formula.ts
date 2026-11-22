/**
 * Formulas over series: `B / A * 100`, `(A - B) / A`, `max(A, B)`, `round(B / A, 2)`.
 *
 * Letters name series in order (A is the first). The grammar is arithmetic: numbers,
 * letters, + - * / (also × ÷), unary minus, parentheses, and four functions: abs, min, max
 * and round. It is parsed once into a tree and evaluated per bucket, never with `eval`, so a
 * formula from an agent or a URL can't run code. Division by zero gives 0, as in PostHog.
 *
 * `lexFormula` and `checkFormula` never throw: an editor uses them on every keystroke to
 * colour the text, underline the exact mistake and suggest what can come next.
 */

export type FormulaFunction = 'abs' | 'min' | 'max' | 'round';

export type FormulaNode =
  | { type: 'num'; value: number }
  | { type: 'var'; index: number; name: string }
  | { type: 'neg'; arg: FormulaNode }
  | { type: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { type: 'call'; fn: FormulaFunction; args: FormulaNode[] };

export class FormulaError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** The functions a formula can call, with how many values each takes. */
export const FORMULA_FUNCTIONS: Record<
  FormulaFunction,
  { min: number; max: number; signature: string; description: string }
> = {
  abs: { min: 1, max: 1, signature: 'abs(x)', description: 'x without its sign' },
  min: { min: 2, max: 2, signature: 'min(a, b)', description: 'The smaller of a and b' },
  max: { min: 2, max: 2, signature: 'max(a, b)', description: 'The larger of a and b' },
  round: {
    min: 1,
    max: 2,
    signature: 'round(x, digits)',
    description: 'x rounded to a whole number, or to `digits` decimal places',
  },
};

export const MAX_FORMULA_LENGTH = 500;

// ── Lexing ──────────────────────────────────────────────────────────────────

export type FormulaTokenKind = 'num' | 'var' | 'fn' | 'op' | 'paren' | 'comma' | 'space' | 'bad';

export interface FormulaToken {
  kind: FormulaTokenKind;
  start: number;
  end: number;
  /** The token as written. Operators are normalised: × is *, ÷ is /. */
  text: string;
  /** Why a `bad` token is bad. */
  error?: string;
}

const OPERATORS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '×': '*',
  '÷': '/',
};

function readWhile(input: string, start: number, re: RegExp): number {
  let end = start;
  while (end < input.length && re.test(input[end]!)) end++;
  return end;
}

function readNumber(input: string, start: number): FormulaToken {
  const end = readWhile(input, start, /[0-9.]/);
  const text = input.slice(start, end);
  if (Number.isFinite(Number(text))) return { kind: 'num', start, end, text };
  return { kind: 'bad', start, end, text, error: `"${text}" isn't a number` };
}

function readName(input: string, start: number): FormulaToken {
  const end = readWhile(input, start, /[A-Za-z0-9_]/);
  const text = input.slice(start, end);
  if (text.length === 1 && /[A-Za-z]/.test(text))
    return { kind: 'var', start, end, text: text.toUpperCase() };
  if (Object.hasOwn(FORMULA_FUNCTIONS, text.toLowerCase()))
    return { kind: 'fn', start, end, text: text.toLowerCase() };
  return {
    kind: 'bad',
    start,
    end,
    text,
    error: `Unknown name "${text}": series are single letters A, B, C…, and the functions are abs, min, max and round`,
  };
}

function readToken(input: string, i: number): FormulaToken {
  const c = input[i]!;
  if (c === ' ' || c === '\t')
    return { kind: 'space', start: i, end: readWhile(input, i, /[ \t]/), text: ' ' };
  if (/[0-9.]/.test(c)) return readNumber(input, i);
  if (/[A-Za-z]/.test(c)) return readName(input, i);
  if (OPERATORS[c]) return { kind: 'op', start: i, end: i + 1, text: OPERATORS[c]! };
  if (c === '(' || c === ')') return { kind: 'paren', start: i, end: i + 1, text: c };
  if (c === ',') return { kind: 'comma', start: i, end: i + 1, text: c };
  return { kind: 'bad', start: i, end: i + 1, text: c, error: `"${c}" can't be used in a formula` };
}

/** Tokens covering the whole input, with their positions. Never throws. */
export function lexFormula(input: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < input.length) {
    const t = readToken(input, i);
    tokens.push(t);
    i = t.end;
  }
  return tokens;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** What could come next where a formula stopped making sense. */
export type FormulaExpectation = 'value' | 'operator' | 'close' | 'comma';

export interface FormulaProblem {
  message: string;
  /** Character offsets of the text to underline (equal at the end of the input). */
  at: number;
  end: number;
  expected: FormulaExpectation[];
}

export type FormulaCheck =
  | { ok: true; node: FormulaNode; refs: number[] }
  | ({ ok: false } & FormulaProblem);

class FormulaSyntaxError extends Error {
  readonly problem: FormulaProblem;
  constructor(problem: FormulaProblem) {
    super(problem.message);
    this.problem = problem;
  }
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** "A (Pageview) and B (Signed up)", or "A–C" when only the count is known. */
function describeSeries(series: number | readonly string[]): string {
  if (typeof series === 'number') return series > 1 ? `A–${letter(series - 1)}` : 'A';
  const named = series.map((label, i) => `${letter(i)} (${label})`);
  return named.length > 1
    ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
    : (named[0] ?? 'none');
}

function unknownSeries(name: string, series: number | readonly string[]): string {
  const n = typeof series === 'number' ? series : series.length;
  if (n === 0) return `${name} isn't a series: add a series first`;
  if (typeof series === 'number')
    return `Formula uses ${name}, but there ${n === 1 ? 'is 1 series' : `are ${n} series`} (${describeSeries(series)}).`;
  return `${name} isn't a series: you have ${describeSeries(series)}`;
}

class Parser {
  private pos = 0;
  private readonly tokens: FormulaToken[];
  private readonly input: string;
  private readonly series: number | readonly string[];
  private readonly count: number;
  readonly refs = new Set<number>();

  constructor(input: string, series: number | readonly string[]) {
    this.input = input;
    this.series = series;
    this.count = typeof series === 'number' ? series : series.length;
    this.tokens = lexFormula(input).filter((t) => t.kind !== 'space');
  }

  private peek(): FormulaToken | undefined {
    return this.tokens[this.pos];
  }

  private fail(message: string, expected: FormulaExpectation[], t = this.peek()): never {
    if (t?.kind === 'bad')
      throw new FormulaSyntaxError({ message: t.error!, at: t.start, end: t.end, expected });
    const at = t?.start ?? this.input.length;
    throw new FormulaSyntaxError({ message, at, end: t?.end ?? at, expected });
  }

  formula(): FormulaNode {
    if (!this.tokens.length) this.fail('Empty: write a formula such as B / A', ['value']);
    const node = this.sum();
    const extra = this.peek();
    if (extra) {
      const hint = extra.text === ')' ? 'a ")" with no "(" before it' : `"${extra.text}"`;
      this.fail(`Unexpected ${hint} after a complete formula: join them with + - * or /`, [
        'operator',
      ]);
    }
    return node;
  }

  private sum(): FormulaNode {
    let node = this.product();
    for (
      let t = this.peek();
      t?.kind === 'op' && (t.text === '+' || t.text === '-');
      t = this.peek()
    ) {
      this.pos++;
      node = { type: 'bin', op: t.text, left: node, right: this.product() };
    }
    return node;
  }

  private product(): FormulaNode {
    let node = this.unary();
    for (
      let t = this.peek();
      t?.kind === 'op' && (t.text === '*' || t.text === '/');
      t = this.peek()
    ) {
      this.pos++;
      node = { type: 'bin', op: t.text, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): FormulaNode {
    const t = this.peek();
    if (t?.kind === 'op' && t.text === '-') {
      this.pos++;
      return { type: 'neg', arg: this.unary() };
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const t = this.peek();
    if (!t) this.fail('The formula ends too soon: add a series, a number or "("', ['value']);
    if (t.kind === 'num') {
      this.pos++;
      return { type: 'num', value: Number(t.text) };
    }
    if (t.kind === 'var') return this.variable(t);
    if (t.kind === 'fn') return this.call(t);
    if (t.kind === 'paren' && t.text === '(') return this.group(t);
    this.fail(`Expected a series, a number or "(" where "${t.text}" is`, ['value']);
  }

  private variable(t: FormulaToken): FormulaNode {
    const index = t.text.charCodeAt(0) - 65;
    if (index >= this.count) this.fail(unknownSeries(t.text, this.series), ['value'], t);
    this.pos++;
    this.refs.add(index);
    return { type: 'var', index, name: t.text };
  }

  private group(open: FormulaToken): FormulaNode {
    this.pos++;
    const node = this.sum();
    this.close(`Expected ")" to close the "(" at column ${open.start + 1}`);
    return node;
  }

  private close(message: string): void {
    const t = this.peek();
    if (t?.kind === 'paren' && t.text === ')') {
      this.pos++;
      return;
    }
    this.fail(message, ['operator', 'close'], t);
  }

  private call(t: FormulaToken): FormulaNode {
    const fn = t.text as FormulaFunction;
    const spec = FORMULA_FUNCTIONS[fn];
    this.pos++;
    const open = this.peek();
    if (open?.kind !== 'paren' || open.text !== '(')
      this.fail(`Write ${spec.signature}`, ['value'], open);
    this.pos++;
    const args: FormulaNode[] = [this.sum()];
    while (this.peek()?.kind === 'comma') {
      this.pos++;
      args.push(this.sum());
    }
    this.close(`Expected ")" to close ${fn}(`);
    if (args.length < spec.min || args.length > spec.max)
      this.fail(
        `${fn} takes ${spec.min === spec.max ? spec.min : `${spec.min} or ${spec.max}`} values: ${spec.signature}`,
        ['value'],
        t,
      );
    return { type: 'call', fn, args };
  }
}

/**
 * Check a formula without throwing. `series` is how many series there are, or their labels,
 * which make messages such as "D isn't a series: you have A (Pageview) and B (Signed up)".
 */
export function checkFormula(input: string, series: number | readonly string[]): FormulaCheck {
  if (input.length > MAX_FORMULA_LENGTH)
    return {
      ok: false,
      message: `Formula too long (${MAX_FORMULA_LENGTH} characters at most).`,
      at: MAX_FORMULA_LENGTH,
      end: input.length,
      expected: [],
    };
  const parser = new Parser(input, series);
  try {
    const node = parser.formula();
    return { ok: true, node, refs: [...parser.refs].sort((a, b) => a - b) };
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return { ok: false, ...err.problem };
    throw err;
  }
}

/** Parse a formula. `series` is how many series exist, so `D` with three series is an error. */
export function parseFormula(input: string, series: number | readonly string[]): FormulaNode {
  const r = checkFormula(input, series);
  if (!r.ok) throw new FormulaError(r.message);
  return r.node;
}

// ── Evaluating ──────────────────────────────────────────────────────────────

function binary(op: '+' | '-' | '*' | '/', a: number, b: number): number {
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  return b === 0 ? 0 : a / b;
}

function callFunction(fn: FormulaFunction, args: number[]): number {
  const [a = 0, b = 0] = args;
  if (fn === 'abs') return Math.abs(a);
  if (fn === 'min') return Math.min(a, b);
  if (fn === 'max') return Math.max(a, b);
  const digits = Math.max(0, Math.min(10, Math.round(args.length > 1 ? b : 0)));
  const scale = 10 ** digits;
  return Math.round(a * scale) / scale;
}

/** Evaluate a parsed formula for one bucket: `values[i]` is series i's value. */
export function evaluateFormula(node: FormulaNode, values: readonly number[]): number {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var':
      return values[node.index] ?? 0;
    case 'neg':
      return -evaluateFormula(node.arg, values);
    case 'bin':
      return binary(
        node.op,
        evaluateFormula(node.left, values),
        evaluateFormula(node.right, values),
      );
    case 'call':
      return callFunction(
        node.fn,
        node.args.map((a) => evaluateFormula(a, values)),
      );
  }
}

// ── Editing help ────────────────────────────────────────────────────────────

/** What fits at the caret, for an editor's suggestions, and the partial word being typed. */
export interface FormulaContext {
  /** A value (series, number, function, "(") or something to follow one (operator, ")", ","). */
  expect: 'value' | 'operator';
  /** The letters just before the caret, which a suggestion would replace. */
  word: { start: number; end: number; text: string } | null;
  /** Unclosed "(" before the caret. */
  depth: number;
}

export function formulaContext(input: string, caret: number): FormulaContext {
  const before = lexFormula(input.slice(0, caret)).filter((t) => t.kind !== 'space');
  const last = before.at(-1);
  const typing = last && last.end === caret && /^[A-Za-z]/.test(last.text) ? last : undefined;
  const previous = typing ? before.at(-2) : last;
  const valueEnded =
    previous &&
    (previous.kind === 'num' ||
      previous.kind === 'var' ||
      (previous.kind === 'paren' && previous.text === ')'));
  let depth = 0;
  for (const t of before) if (t.kind === 'paren') depth += t.text === '(' ? 1 : -1;
  return {
    expect: valueEnded ? 'operator' : 'value',
    word: typing
      ? { start: typing.start, end: typing.end, text: input.slice(typing.start, typing.end) }
      : null,
    depth: Math.max(0, depth),
  };
}
