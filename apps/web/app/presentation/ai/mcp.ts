import { type AiAuthDeps, authorizeAiRequest } from "./auth";
import { AI_GUIDANCE } from "./guidance";
import { isToolLevelFailure, toAiErrorBody } from "./toolErrors";
import {
  AI_TOOL_NAMES,
  AI_TOOLS,
  type AiToolContext,
  isAiToolName,
  toolInputJsonSchema,
} from "./tools";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "fog";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;

type JsonRpcId = string | number | null;

type JsonRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id?: JsonRpcId | undefined;
  method: string;
  params?: unknown;
}>;

export type McpDeps = AiAuthDeps & Readonly<{ serverVersion: string }>;

function ok(id: JsonRpcId, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { "cache-control": "no-store" } },
  );
}

function fail(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function parseRequest(body: unknown): JsonRpcRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const r = body as Record<string, unknown>;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return null;
  const id = r.id;
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id: id as JsonRpcId | undefined,
    method: r.method,
    params: r.params,
  };
}

/** `tools/list`'s entries; also what `GET /api/ai` publishes. */
export function describeTools() {
  return AI_TOOL_NAMES.map((name) => ({
    name,
    description: AI_TOOLS[name].description,
    inputSchema: toolInputJsonSchema(name),
    annotations: AI_TOOLS[name].annotations,
  }));
}

/**
 * MCP Streamable HTTP, stateless, JSON answers only (design D-04, PH-07
 * §2.3): `initialize` / `ping` / `tools/list` / `tools/call`, hand-written
 * JSON-RPC. A tool's business failure is the tool's own result
 * (`isError: true`, the error as JSON text) so the model can act on it; a
 * system failure is a JSON-RPC error. `GET` / `DELETE` are 405 — there is
 * no session and no stream to open.
 */
export async function handleMcp(
  request: Request,
  deps: McpDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  // DNS-rebinding guard of the Streamable HTTP transport: a browser origin
  // other than the app's own is refused; non-browser clients send none.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== deps.appUrl) {
    return new Response("Forbidden", { status: 403 });
  }
  const auth = await authorizeAiRequest(request, deps);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(null, PARSE_ERROR, "Parse error", undefined, 400);
  }
  if (Array.isArray(body)) {
    return fail(
      null,
      INVALID_REQUEST,
      "Batches are not supported",
      undefined,
      400,
    );
  }
  const rpc = parseRequest(body);
  if (rpc === null) {
    return fail(null, INVALID_REQUEST, "Invalid Request", undefined, 400);
  }
  // A notification (no id) gets no body back.
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  return dispatch(rpc.id, rpc.method, rpc.params, auth.ctx, deps);
}

async function dispatch(
  id: JsonRpcId,
  method: string,
  params: unknown,
  ctx: AiToolContext,
  deps: McpDeps,
): Promise<Response> {
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: deps.serverVersion },
        instructions: AI_GUIDANCE,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: describeTools() });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  ctx: AiToolContext,
): Promise<Response> {
  const p =
    typeof params === "object" && params !== null
      ? (params as { name?: unknown; arguments?: unknown })
      : {};
  if (typeof p.name !== "string" || !isAiToolName(p.name)) {
    return fail(id, METHOD_NOT_FOUND, `Unknown tool: ${String(p.name)}`);
  }
  const tool = AI_TOOLS[p.name];
  const parsed = tool.inputSchema.safeParse(p.arguments ?? {});
  if (!parsed.success) {
    return fail(id, INVALID_PARAMS, "Invalid params", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    });
  }
  try {
    const result = await tool.run(ctx, parsed.data);
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const body = toAiErrorBody(error);
    if (isToolLevelFailure(body.kind)) {
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: true,
      });
    }
    return fail(id, SERVER_ERROR, body.message);
  }
}
