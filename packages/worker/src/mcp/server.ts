/**
 * A Model Context Protocol server over Streamable HTTP, stateless.
 *
 * Each POST to `/mcp` carries one JSON-RPC message and gets a JSON response;
 * no sessions or server-sent events are needed because every Dataflare tool is a
 * single request/response. Clients that can only speak stdio use the CLI
 * bridge, `dataflare mcp`, which forwards to this endpoint.
 *
 * Spec: https://modelcontextprotocol.io/specification
 */

import { GLASS_VERSION, upgradeMessage } from '@dataflare/core/version';
import { z } from 'zod/v4';
import type { Scope } from '../auth.ts';
import { describeIssues, HttpError, isValidationError, json } from '../http.ts';
import type { GlassService } from '../service.ts';
import { TOOLS, TOOLS_BY_NAME } from './tools.ts';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_TEXT = 100_000;

export const INSTRUCTIONS = `Dataflare is the analytics for this product: web analytics, product analytics, session replay, feature flags and A/B tests, stored in the user's own Cloudflare account.
- Start with "overview" for a period, then "list_events" for exact event names before querying.
- Properties: built-in columns (path, browser, country, utm_source…), event properties ("plan" or "props.plan"), person properties ("person.plan").
- Times: ISO dates or relative offsets like "-30d"; ranges end at "now" by default.
- To debug a user problem: query_funnel or query_trends with a breakdown → list_replays (with_errors) → summarise_replay.
- To add tracking: "instrument" returns the exact code. Name events object_action in snake_case past tense.
- Every result includes the SQL that ran and a dashboard link; quote them when reporting back.
- If overview or /health reports upgradeAvailable, tell the user to run \`npx dataflare-cli@latest upgrade\` — do not try to upgrade yourself.`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});
const rpcResult = (id: JsonRpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });

let schemaCache:
  | {
      name: string;
      title: string;
      description: string;
      inputSchema: unknown;
      annotations: object;
    }[]
  | null = null;

function toolList() {
  schemaCache ??= TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', ...schema },
      annotations: { title: t.title, readOnlyHint: t.scope === 'read', openWorldHint: false },
    };
  });
  return schemaCache;
}

async function callTool(
  service: GlassService,
  scope: Scope,
  params: Record<string, unknown> | undefined,
) {
  const name = String(params?.name ?? '');
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  if (tool.scope === 'admin' && scope !== 'admin') {
    return {
      content: [
        {
          type: 'text',
          text: `"${name}" changes data and needs the admin key; this connection uses the read-only key.`,
        },
      ],
      isError: true,
    };
  }
  try {
    if (service.actor) {
      const args = params?.arguments;
      const sqlText = (args as { query?: unknown } | undefined)?.query;
      service.setActor({
        ...service.actor,
        operation: `tool:${name}`,
        detail: typeof sqlText === 'string' ? sqlText : JSON.stringify(args ?? {}),
      });
    }
    const result = await tool.run(service, params?.arguments ?? {});
    let text = JSON.stringify(result, null, 2);
    if (text.length > MAX_TEXT)
      text = `${text.slice(0, MAX_TEXT)}\n… (truncated; narrow the query or lower limits)`;
    return {
      content: [{ type: 'text', text }],
      ...(result && typeof result === 'object' && !Array.isArray(result)
        ? { structuredContent: result }
        : {}),
    };
  } catch (err) {
    // Tool errors go back to the model as readable text so it can correct itself.
    const message =
      err instanceof HttpError
        ? `${err.message}${err.hint ? ` Hint: ${err.hint}` : ''}`
        : isValidationError(err)
          ? `Invalid arguments — ${describeIssues(err)}`
          : err instanceof Error
            ? err.message
            : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function handleMessage(msg: JsonRpcRequest, service: GlassService, scope: Scope) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(msg?.id, -32600, 'Invalid JSON-RPC request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      const health = await service.health();
      const instructions =
        health.upgradeAvailable && health.latest
          ? `${INSTRUCTIONS}\n- UPGRADE NEEDED: ${upgradeMessage(health.version, health.latest)}`
          : INSTRUCTIONS;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'glass', title: 'Dataflare Analytics', version: GLASS_VERSION },
        instructions,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: toolList() });
    case 'tools/call':
      return rpcResult(msg.id, await callTool(service, scope, msg.params));
    case 'resources/list':
      return rpcResult(msg.id, { resources: [] });
    case 'prompts/list':
      return rpcResult(msg.id, { prompts: [] });
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(
  request: Request,
  service: GlassService,
  scope: Scope,
): Promise<Response> {
  if (request.method === 'GET') {
    // No server-initiated stream: every tool is request/response.
    return new Response(
      'This MCP server does not offer an SSE stream. POST JSON-RPC messages instead.',
      { status: 405, headers: { Allow: 'POST' } },
    );
  }
  if (request.method === 'DELETE')
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = [];
  for (const m of messages) {
    const r = await handleMessage(m, service, scope);
    if (r) responses.push(r);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}
