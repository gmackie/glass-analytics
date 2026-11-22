/**
 * Stack traces from Chrome/V8 (browsers, Node, Workers, Deno, Bun), Firefox and
 * Safari, parsed into frames. Error tracking fingerprints the top frames of your
 * own code and maps minified frames back to source with uploaded source maps.
 */

export interface StackFrame {
  /** Function name as written in the trace ("" when anonymous). */
  function: string;
  /** URL or path of the file. */
  file: string;
  /** 1-based line and column, as browsers print them. */
  line: number | null;
  column: number | null;
  /** Whether the frame is the site's own code (rather than a vendor script, extension or runtime). */
  inApp: boolean;
}

/** Frames kept per exception. */
export const MAX_FRAMES = 50;

// "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)", "    at new Foo (file:1:2)"
const V8 = /^\s*at\s+(?:(?:async\s+)?(.*?)\s+\()?(.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/;
// "fn@file:1:2", "@file:1:2", "global code@file:1:2", "fn/<@file:1:2"
const GECKO = /^\s*(.*?)@(.*?)(?::(\d+))?(?::(\d+))?\s*$/;
// The file inside an eval frame: "eval at fn (https://a.com/x.js:1:2), <anonymous>:3:4".
const EVAL_ORIGIN = /\((\S+?):(\d+):(\d+)\)/;

function frame(fn: string, file: string, line?: string, column?: string): StackFrame {
  return {
    function: fn.trim(),
    file: file.trim(),
    line: line ? Number(line) : null,
    column: column ? Number(column) : null,
    inApp: false,
  };
}

/** A Chrome/V8 frame: "at fn (file:1:2)", "at file:1:2", eval frames, "at fn (native)". */
function v8Frame(line: string): StackFrame | null {
  const m = V8.exec(line);
  if (!m) return null;
  let [, fn = '', file = '', l, c] = m;
  const origin = file.startsWith('eval at') ? EVAL_ORIGIN.exec(file) : null;
  if (origin) [, file, l, c] = origin as unknown as [string, string, string, string];
  // "at fn (native)" and "at <anonymous>"
  const bare = !l && !fn && !file.includes('/') && !file.includes(':');
  return bare ? frame(file, '', undefined, undefined) : frame(fn, file, l, c);
}

/** A Firefox or Safari frame: "fn@file:1:2", "@file:1:2", "global code@file:1:2". */
function geckoFrame(line: string): StackFrame | null {
  const m = GECKO.exec(line);
  if (!m) return null;
  const [, fn = '', rawFile = '', l, c] = m;
  // Firefox eval frames: "fn@https://a.com/x.js line 2 > eval:1:1" — keep the script that ran eval.
  const evalAt = / line (\d+) > (?:eval|Function)/.exec(rawFile);
  if (evalAt) return frame(fn, rawFile.slice(0, evalAt.index), evalAt[1], undefined);
  return frame(fn, rawFile, l, c);
}

/** Parse one line of a trace, or null for lines that aren't frames (the message, blank lines). */
export function parseFrame(text: string): StackFrame | null {
  const line = text.trimEnd();
  if (!line.trim()) return null;
  if (/^\s*at\s/.test(line)) return v8Frame(line);
  if (line.includes('@')) return geckoFrame(line);
  // Safari: "[native code]" or a bare function name.
  return line.trim() === '[native code]' ? frame('', '[native code]', undefined, undefined) : null;
}

/** Parse a whole trace. */
export function parseStack(stack: string | null | undefined): StackFrame[] {
  if (!stack) return [];
  const out: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const f = parseFrame(line);
    if (f) out.push(f);
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

const VENDOR =
  /\/node_modules\/|\/vendor\/|\/bower_components\/|^(node:|internal\/|native|\[native code\])/;
const NOT_PAGE = /^(chrome|moz|safari(-web)?|webkit-masked-url)-?extension:|^webkit-masked-url:/;

function hostOf(file: string): string | null {
  try {
    return new URL(file).host;
  } catch {
    return null;
  }
}

/**
 * Mark which frames are in-app. With `includes` (the `inAppIncludes` setting), a frame is in-app
 * when its file contains one of them. Otherwise: files on the page's own host, relative paths and
 * server paths, minus node_modules, vendor folders, browser extensions and runtime internals.
 */
export function markInApp(
  frames: StackFrame[],
  pageHost: string,
  includes?: readonly string[],
): StackFrame[] {
  return frames.map((f) => {
    if (!f.file || VENDOR.test(f.file) || NOT_PAGE.test(f.file)) return { ...f, inApp: false };
    if (includes?.length) return { ...f, inApp: includes.some((s) => f.file.includes(s)) };
    const host = hostOf(f.file);
    if (host === null) return { ...f, inApp: !f.file.startsWith('<') };
    if (/^(https?|file):/.test(f.file) === false) return { ...f, inApp: false };
    return { ...f, inApp: f.file.startsWith('file:') || !pageHost || host === pageHost };
  });
}

/** The path a frame's file was served at, e.g. "/assets/index-BxT8.js", for finding its source map. */
export function framePath(file: string): string {
  try {
    const u = new URL(file);
    return u.protocol === 'file:' ? u.pathname : u.pathname;
  } catch {
    return file.split(/[?#]/)[0]!;
  }
}
