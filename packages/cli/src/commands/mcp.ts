/**
 * `dataflare mcp` — an MCP server over stdio that forwards to the deployed
 * Worker's `/mcp` endpoint, adding the API key from `.glass/credentials.json`.
 *
 * This is what `.mcp.json` runs, so the key never has to be written into
 * agent config files.
 */

import { createInterface } from 'node:readline';
import { connection } from '../config.ts';

export async function mcpBridge(
  options: {
    readOnly?: boolean;
    fetcher?: typeof fetch;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const conn = connection(options.readOnly ? 'read' : 'api');
  const fetcher = options.fetcher ?? fetch;
  const output = options.output ?? process.stdout;
  const rl = createInterface({
    input: options.input ?? process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const pending: Promise<void>[] = [];

  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);

  const forward = async (lineText: string) => {
    let message: { id?: string | number | null };
    try {
      message = JSON.parse(lineText) as { id?: string | number | null };
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const res = await fetcher(`${conn.host}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: lineText,
      });
      if (res.status === 202 || message.id === undefined) return; // notification
      const text = await res.text();
      if (!res.ok && !text.startsWith('{')) {
        send({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: {
            code: -32603,
            message: `Dataflare returned HTTP ${res.status}: ${text.slice(0, 200)}`,
          },
        });
        return;
      }
      output.write(`${text.replace(/\n/g, '')}\n`);
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: {
          code: -32603,
          message: `Could not reach ${conn.host}: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  };

  for await (const lineText of rl) {
    if (lineText.trim()) pending.push(forward(lineText));
  }
  await Promise.all(pending);
}
