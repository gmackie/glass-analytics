/**
 * Interactive prompts that fail fast (with the flag to use instead) when stdin
 * is not a terminal — agents run `dataflare init` non-interactively.
 */

import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { UsageError } from './config.ts';

export const interactive = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

/** Where a prompt reads and writes; the terminal unless a test supplies its own. */
export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isInteractive: () => boolean;
}

const terminal: PromptIO = {
  input: process.stdin,
  output: process.stdout,
  isInteractive: interactive,
};

/**
 * The output readline writes to: everything goes through until `muted` is set,
 * after which nothing does, so a secret's keystrokes are not echoed. This
 * replaces patching readline's private `_writeToOutput`, which Node 24 turned
 * into a symbol (`rl._writeToOutput` is undefined there, and `.bind` threw).
 */
class MutableOutput extends Writable {
  muted = false;
  readonly target: NodeJS.WritableStream;
  constructor(target: NodeJS.WritableStream) {
    super();
    this.target = target;
  }
  override _write(chunk: Buffer | string, encoding: BufferEncoding, done: () => void) {
    if (!this.muted)
      this.target.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
    done();
  }
}

export async function ask(
  question: string,
  options: { flag: string; secret?: boolean; default?: string },
  io: PromptIO = terminal,
): Promise<string> {
  if (!io.isInteractive()) {
    if (options.default !== undefined) return options.default;
    throw new UsageError(
      `Missing ${options.flag}.`,
      `Pass ${options.flag} (this terminal is not interactive).`,
    );
  }
  const output = new MutableOutput(io.output);
  const rl = createInterface({ input: io.input, output, terminal: true });
  const suffix = options.default ? ` (${options.default})` : '';
  const pending = rl.question(`${question}${suffix}: `);
  // The prompt has been written; hide what is typed after it.
  if (options.secret) output.muted = true;
  const answer = (await pending).trim();
  rl.close();
  if (options.secret) io.output.write('\n');
  return answer || options.default || '';
}

export async function choose<T>(
  question: string,
  items: T[],
  label: (item: T) => string,
  flag: string,
): Promise<T> {
  if (items.length === 1) return items[0]!;
  if (!interactive())
    throw new UsageError(
      `Several options for ${flag}: ${items.map(label).join(', ')}.`,
      `Pass ${flag}.`,
    );
  items.forEach((item, i) => {
    process.stdout.write(`  ${i + 1}. ${label(item)}\n`);
  });
  const answer = Number(await ask(question, { flag, default: '1' }));
  const item = items[answer - 1];
  if (!item) throw new UsageError(`Pick a number from 1 to ${items.length}.`);
  return item;
}
