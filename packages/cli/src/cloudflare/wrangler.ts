/**
 * Running Wrangler, Cloudflare's CLI.
 *
 * Dataflare provisions and deploys through Wrangler rather than raw API calls:
 * Wrangler handles uploads, D1 migrations, secrets and Pipelines, and stays
 * current as Cloudflare's APIs change. The `Wrangler` interface keeps the rest
 * of the CLI testable with a fake runner.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Wrangler {
  run(args: string[], options?: { input?: string }): Promise<RunResult>;
}

export class WranglerError extends Error {
  readonly result: RunResult;
  readonly args: string[];
  constructor(args: string[], result: RunResult) {
    // The reason is in stderr; stdout (bindings, upload sizes) is long and would push it out of view.
    const tail = (text: string, n: number) => text.trim().split('\n').slice(-n).join('\n');
    const output = result.stderr.trim() ? tail(result.stderr, 15) : tail(result.stdout, 12);
    super(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${output}`);
    this.args = args;
    this.result = result;
  }

  get output(): string {
    return `${this.result.stdout}\n${this.result.stderr}`;
  }
}

/** The installed wrangler's entry point, or undefined when it isn't installed. */
export function localWrangler(): string | undefined {
  try {
    // wrangler's package.json "exports" doesn't expose bin/wrangler.js, so
    // resolving that path always throws. package.json itself is resolvable.
    const require = createRequire(import.meta.url);
    const bin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

function wranglerCommand(): { cmd: string; prefix: string[] } {
  const bin = localWrangler();
  if (bin) return { cmd: process.execPath, prefix: [bin] };
  return {
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefix: ['--yes', 'wrangler@4'],
  };
}

/** Wrangler authenticated with an API token, running non-interactively. */
export function createWrangler(auth: { token: string; accountId: string }, cwd: string): Wrangler {
  const { cmd, prefix } = wranglerCommand();
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd, [...prefix, ...args], {
          cwd,
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: auth.token,
            CLOUDFLARE_ACCOUNT_ID: auth.accountId,
            CI: '1',
            WRANGLER_SEND_METRICS: 'false',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        if (options.input !== undefined) child.stdin.write(options.input);
        child.stdin.end();
      });
    },
  };
}

/** Run and throw on failure. */
export async function must(
  wrangler: Wrangler,
  args: string[],
  options?: { input?: string },
): Promise<string> {
  const result = await wrangler.run(args, options);
  if (result.code !== 0) throw new WranglerError(args, result);
  return result.stdout;
}

/** Parse the first JSON array or object in Wrangler output (it sometimes prints banners first). */
export function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`Expected JSON from wrangler, got: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start)) as T;
}
