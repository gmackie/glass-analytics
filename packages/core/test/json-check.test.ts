import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkJson, lexJson, lineCol } from '../src/json-check.ts';

const problem = (text: string) => {
  const r = checkJson(text);
  assert.equal(r.ok, false, `expected ${JSON.stringify(text)} to be invalid`);
  return r as Extract<typeof r, { ok: false }>;
};

describe('checkJson', () => {
  it('accepts what JSON.parse accepts and returns the same value', () => {
    for (const text of [
      '{}',
      '[]',
      '"text"',
      '0',
      '-12.5e3',
      'true',
      'null',
      '{"a": [1, 2, {"b": null}], "c": "\\u00e9\\n"}',
      '  \n\t{ "headline" : "Write faster" , "discount": 20 }\r\n',
    ]) {
      const r = checkJson(text);
      assert.ok(r.ok, text);
      assert.deepEqual(r.value, JSON.parse(text));
    }
  });

  it('says what is wrong and where, in plain words', () => {
    const missingComma = problem('{\n  "a": 1\n  "b": 2\n}');
    assert.match(missingComma.message, /Expected a comma or a closing \}/);
    assert.deepEqual([missingComma.line, missingComma.col], [3, 3]);

    assert.match(problem('{"a": 1,}').message, /doesn't allow a comma before \}/);
    assert.match(problem('[1, 2,]').message, /doesn't allow a comma before \]/);
    assert.match(problem("{'a': 1}").message, /double quotes/);
    assert.match(problem('{"a": True}').message, /JSON writes it true/);
    assert.match(problem('{"a": undefined}').message, /isn't JSON/);
    assert.match(problem('{"a" 1}').message, /Expected a colon after "a"/);
    assert.match(problem('{"a": 01}').message, /isn't a JSON number/);
    assert.match(problem('{"a": "x\\q"}').message, /isn't a JSON escape/);
    assert.match(problem('{"a": "open').message, /no closing quote/);
    assert.match(problem('{"a": "tab\there"}').message, /must be escaped/);
    assert.match(problem('{"a": 1} {"b": 2}').message, /after the end/);
    assert.match(problem('').message, /Empty/);
    assert.match(problem('{"a": ').message, /ends too soon/);
    assert.match(problem('{"a": 1, "a": 2}').message, /"a" is already set/);
    assert.match(problem('{"a": 1}').message, /unusual space/);
  });

  it('underlines the exact text at fault', () => {
    const r = problem('{"plan": "pro", "seats": ten}');
    assert.equal(r.message.startsWith('"ten"'), true);
    assert.equal('{"plan": "pro", "seats": ten}'.slice(r.at, r.end), 'ten');
  });

  it('never throws, and agrees with JSON.parse on random edits', () => {
    const base = '{"type": "web", "transforms": [{"selector": "h1", "text": "Hi"}], "n": -1.5e2}';
    const chars = ['{', '}', '[', ']', ',', ':', '"', ' ', '1', 'a', '\\', '\n', '.'];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      let text = base;
      for (let k = 0; k < 1 + rand(3); k++) {
        const at = rand(text.length + 1);
        text = rand(2)
          ? text.slice(0, at) + chars[rand(chars.length)] + text.slice(at)
          : text.slice(0, at) + text.slice(at + 1);
      }
      let parsed: unknown;
      let valid = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        valid = false;
      }
      const r = checkJson(text);
      // Duplicate keys are the one deliberate difference.
      if (!r.ok && /already set/.test(r.message)) continue;
      assert.equal(r.ok, valid, text);
      if (r.ok) assert.deepEqual(r.value, parsed);
    }
  });
});

describe('lexJson', () => {
  it('covers the text exactly and tells keys from values', () => {
    const text = '{"a": "b", "n": [1, true]}';
    const tokens = lexJson(text);
    assert.equal(tokens.map((t) => text.slice(t.start, t.end)).join(''), text);
    const kinds = tokens.filter((t) => t.kind !== 'space' && t.kind !== 'punct').map((t) => t.kind);
    assert.deepEqual(kinds, ['key', 'str', 'key', 'num', 'lit']);
  });

  it('finds lines and columns', () => {
    assert.deepEqual(lineCol('ab\ncd', 4), { line: 2, col: 2 });
    assert.deepEqual(lineCol('ab', 0), { line: 1, col: 1 });
  });
});
