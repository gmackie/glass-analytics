/**
 * A JSON checker for editors: the same answer as `JSON.parse`, but with plain-English errors
 * and an exact position in every browser (Safari's `JSON.parse` errors give none), plus the
 * tokens an editor needs to colour the text, valid or not.
 *
 * Duplicate keys are reported too: `JSON.parse` keeps the last one silently, which in a flag
 * payload is almost always a mistake.
 */

export type JsonTokenKind = 'key' | 'str' | 'num' | 'lit' | 'punct' | 'space' | 'bad';

export interface JsonToken {
  kind: JsonTokenKind;
  start: number;
  end: number;
  /** Why a `bad` token is bad. */
  error?: string;
}

export interface JsonProblem {
  message: string;
  /** Character offsets of the text to underline. */
  at: number;
  end: number;
  /** 1-based line and column of `at`. */
  line: number;
  col: number;
}

export type JsonCheck =
  | { ok: true; value: unknown; tokens: JsonToken[] }
  | ({ ok: false; tokens: JsonToken[] } & JsonProblem);

const MAX_DEPTH = 64;
const WORDS = new Set(['true', 'false', 'null']);
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ESCAPE = /^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;

// ── Lexing ──────────────────────────────────────────────────────────────────

function readString(text: string, start: number): JsonToken {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === quote) {
      const end = i + 1;
      if (quote === "'")
        return {
          kind: 'bad',
          start,
          end,
          error: 'JSON strings use double quotes, not single quotes',
        };
      return { kind: 'str', start, end };
    }
    if (c === '\n')
      return {
        kind: 'bad',
        start,
        end: i,
        error: 'This string has no closing quote (use \\n for a line break)',
      };
    if (c < ' ')
      return {
        kind: 'bad',
        start: i,
        end: i + 1,
        error: 'Tabs and control characters in a string must be escaped, e.g. \\t',
      };
    if (c === '\\') {
      const escaped = ESCAPE.exec(text.slice(i, i + 6));
      if (!escaped)
        return {
          kind: 'bad',
          start: i,
          end: i + 2,
          error: `"${text.slice(i, i + 2)}" isn't a JSON escape`,
        };
      i += escaped[0].length;
      continue;
    }
    i++;
  }
  return { kind: 'bad', start, end: i, error: 'This string has no closing quote' };
}

function readNumber(text: string, start: number): JsonToken {
  let end = start;
  while (end < text.length && /[-+0-9.eE]/.test(text[end]!)) end++;
  const raw = text.slice(start, end);
  if (NUMBER.test(raw)) return { kind: 'num', start, end };
  return { kind: 'bad', start, end, error: `"${raw}" isn't a JSON number` };
}

function readWord(text: string, start: number): JsonToken {
  let end = start;
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end++;
  const word = text.slice(start, end);
  if (WORDS.has(word)) return { kind: 'lit', start, end };
  const lower = word.toLowerCase();
  const hint = WORDS.has(lower) ? ` (JSON writes it ${lower})` : ' (put text in double quotes)';
  return { kind: 'bad', start, end, error: `"${word}" isn't JSON${hint}` };
}

/** JSON allows only these four as whitespace. */
const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

function readSpace(text: string, start: number): JsonToken {
  let end = start;
  while (end < text.length && isSpace(text[end])) end++;
  return { kind: 'space', start, end };
}

function readToken(text: string, i: number): JsonToken {
  const c = text[i]!;
  if (isSpace(c)) return readSpace(text, i);
  if (/\s/.test(c))
    return {
      kind: 'bad',
      start: i,
      end: i + 1,
      error: 'An unusual space character: use a normal space',
    };
  if (c === '"' || c === "'") return readString(text, i);
  if (c === '-' || (c >= '0' && c <= '9')) return readNumber(text, i);
  if ('{}[]:,'.includes(c)) return { kind: 'punct', start: i, end: i + 1 };
  if (/[A-Za-z_$]/.test(c)) return readWord(text, i);
  return { kind: 'bad', start: i, end: i + 1, error: `"${c}" can't appear here` };
}

/** Tokens covering the whole text, keys told apart from other strings. Never throws. */
export function lexJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  while (i < text.length) {
    const token = readToken(text, i);
    tokens.push(token);
    i = token.end;
  }
  markKeys(text, tokens);
  return tokens;
}

/** A string followed by ":" is a key. */
function markKeys(text: string, tokens: JsonToken[]): void {
  let lastString: JsonToken | null = null;
  for (const t of tokens) {
    if (t.kind === 'space') continue;
    if (t.kind === 'punct' && text[t.start] === ':' && lastString) lastString.kind = 'key';
    lastString = t.kind === 'str' ? t : null;
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────────

class JsonSyntaxError extends Error {
  readonly at: number;
  readonly end: number;
  constructor(message: string, at: number, end: number) {
    super(message);
    this.at = at;
    this.end = end;
  }
}

/** Walks the tokens (spaces skipped) and checks the grammar; values come from JSON.parse after. */
class Parser {
  private pos = 0;
  private readonly text: string;
  private readonly tokens: JsonToken[];
  constructor(text: string, tokens: JsonToken[]) {
    this.text = text;
    this.tokens = tokens;
  }

  private peek(): JsonToken | undefined {
    return this.tokens[this.pos];
  }

  private char(t: JsonToken | undefined): string {
    return t && t.kind === 'punct' ? this.text[t.start]! : '';
  }

  private fail(message: string, t = this.peek()): never {
    if (t?.kind === 'bad') throw new JsonSyntaxError(t.error!, t.start, t.end);
    const at = t?.start ?? this.text.length;
    throw new JsonSyntaxError(message, at, t?.end ?? at);
  }

  private take(expected: string, message: string): void {
    if (this.char(this.peek()) !== expected) this.fail(message);
    this.pos++;
  }

  document(): void {
    if (!this.peek()) this.fail('Empty: write a JSON value, e.g. {} or "text"');
    this.value(0);
    if (this.peek()) this.fail('Unexpected text after the end of the JSON');
  }

  private value(depth: number): void {
    if (depth > MAX_DEPTH) this.fail(`Nested more than ${MAX_DEPTH} levels deep`);
    const t = this.peek();
    const c = this.char(t);
    if (c === '{') this.object(depth);
    else if (c === '[') this.array(depth);
    else if (t && (t.kind === 'str' || t.kind === 'num' || t.kind === 'lit' || t.kind === 'key'))
      this.pos++;
    else
      this.fail(
        t
          ? 'Expected a value: a string, number, object, array, true, false or null'
          : 'The JSON ends too soon',
      );
  }

  private object(depth: number): void {
    this.pos++; // {
    if (this.char(this.peek()) === '}') {
      this.pos++;
      return;
    }
    const seen = new Set<string>();
    for (;;) {
      this.member(depth, seen);
      const next = this.char(this.peek());
      if (next === '}') {
        this.pos++;
        return;
      }
      this.take(',', 'Expected a comma or a closing }');
      if (this.char(this.peek()) === '}') this.fail("JSON doesn't allow a comma before }");
    }
  }

  private member(depth: number, seen: Set<string>): void {
    const key = this.peek();
    if (!key || (key.kind !== 'key' && key.kind !== 'str'))
      this.fail('Expected a property name in double quotes');
    const name = JSON.parse(this.text.slice(key.start, key.end)) as string;
    if (seen.has(name)) this.fail(`"${name}" is already set in this object`, key);
    seen.add(name);
    this.pos++;
    this.take(':', `Expected a colon after "${name}"`);
    this.value(depth + 1);
  }

  private array(depth: number): void {
    this.pos++; // [
    if (this.char(this.peek()) === ']') {
      this.pos++;
      return;
    }
    for (;;) {
      this.value(depth + 1);
      if (this.char(this.peek()) === ']') {
        this.pos++;
        return;
      }
      this.take(',', 'Expected a comma or a closing ]');
      if (this.char(this.peek()) === ']') this.fail("JSON doesn't allow a comma before ]");
    }
  }
}

/** 1-based line and column of a character offset. */
export function lineCol(text: string, at: number): { line: number; col: number } {
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return { line, col: at - before.lastIndexOf('\n') };
}

export function checkJson(text: string): JsonCheck {
  const tokens = lexJson(text);
  const significant = tokens.filter((t) => t.kind !== 'space');
  try {
    new Parser(text, significant).document();
  } catch (err) {
    if (!(err instanceof JsonSyntaxError)) throw err;
    const { line, col } = lineCol(text, err.at);
    return { ok: false, tokens, message: err.message, at: err.at, end: err.end, line, col };
  }
  try {
    return { ok: true, value: JSON.parse(text), tokens };
  } catch (err) {
    // Not expected (the grammar above is JSON's), but never let an editor throw.
    return { ok: false, tokens, message: (err as Error).message, at: 0, end: 0, line: 1, col: 1 };
  }
}
