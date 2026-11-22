/**
 * Error tracking: turning `$exception` events into issues.
 *
 * Each exception gets a fingerprint from its type, its message with the variable
 * parts taken out (numbers, ids, URLs, emails, quoted values) and its top three
 * in-app frames, so the same bug groups together however often it happens and
 * whatever data it happened on. Frames are keyed on file and function rather than
 * line and column, and content hashes are dropped from bundle names, so a rebuild
 * doesn't split an issue. A `$fingerprint` property overrides all of this.
 */

import { sha256Hex } from './hash.ts';
import { markInApp, parseStack, type StackFrame } from './stack.ts';

export type IssueStatus = 'active' | 'resolved' | 'suppressed' | 'merged';
export const ISSUE_STATUSES = ['active', 'resolved', 'suppressed'] as const;

export interface ExceptionInfo {
  type: string;
  message: string;
  stack: string;
  frames: StackFrame[];
  handled: boolean;
  level: string;
  release: string | null;
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/**
 * Read an `$exception` event's properties: the SDKs' `type`/`message`/`stack` (and PostHog-style
 * `$exception_type`/`$exception_message`), plus the `source`/`line`/`column` window.onerror gives
 * when there's no stack.
 */
export function exceptionInfo(
  props: Record<string, unknown>,
  pageHost: string,
  inAppIncludes?: readonly string[],
): ExceptionInfo {
  const type = text(props.type ?? props.$exception_type) || 'Error';
  const message = text(props.message ?? props.$exception_message);
  const stack = text(props.stack ?? props.$exception_stack);
  let frames = parseStack(stack);
  if (frames.length === 0 && props.source) {
    frames = [
      {
        function: '',
        file: text(props.source),
        line: props.line === undefined ? null : Number(props.line),
        column: props.column === undefined ? null : Number(props.column),
        inApp: false,
      },
    ];
  }
  frames = markInApp(frames, pageHost, inAppIncludes);
  return {
    type: type.slice(0, 200),
    message: message.slice(0, 2000),
    stack,
    frames,
    handled: props.handled === true || props.$exception_handled === true,
    level: text(props.level ?? props.$exception_level) || 'error',
    release: text(props.$release ?? props.release) || null,
  };
}

/** The message with its variable parts replaced, so "id 123 not found" and "id 456 not found" match. */
export function normaliseMessage(message: string): string {
  return message
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:0x)?[0-9a-f]*\d[0-9a-f]*\b/gi, (m) =>
      m.length >= 8 || /^0x/i.test(m) ? '<hex>' : m,
    )
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/(["'`])(?:(?!\1).){1,200}\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** A bundle's file without its content hash: "/assets/index-BxT8QXh2.js" → "/assets/index.js". */
export function stableFile(file: string): string {
  let path = file.split(/[?#]/)[0]!;
  try {
    path = new URL(path).pathname;
  } catch {
    // a path already
  }
  return path
    .replace(/[-.~][A-Za-z0-9_]{8,}(?=\.(?:m?js|cjs|jsx|ts|tsx)$)/, '')
    .replace(/[-.][0-9a-f]{6,}(?=\.)/g, '');
}

/** Minified function names ("a", "Xe") change with every build, so they're left out. */
const minified = (fn: string) => fn.length <= 2 || /^[a-zA-Z_$][\w$]?$/.test(fn);

function frameKey(f: StackFrame): string {
  const fn = f.function.replace(/^(async |new )/, '').replace(/^Object\./, '');
  return `${stableFile(f.file)}|${minified(fn) ? '' : fn}`;
}

/** Fingerprint an exception (hex SHA-256). `override` is the event's `$fingerprint`, if any. */
export async function fingerprint(info: ExceptionInfo, override?: unknown): Promise<string> {
  if (override !== undefined && override !== null && override !== '') {
    const parts = Array.isArray(override) ? override.map(String) : [String(override)];
    return sha256Hex(`custom\n${parts.join('\n')}`);
  }
  const inApp = info.frames.filter((f) => f.inApp);
  const top = (inApp.length ? inApp : info.frames).slice(0, 3).map(frameKey);
  return sha256Hex([info.type, normaliseMessage(info.message), ...top].join('\n'));
}

/** Issue ids are the fingerprint's first 16 hex characters, so concurrent requests agree on them. */
export const issueIdFor = (fp: string) => fp.slice(0, 16);
