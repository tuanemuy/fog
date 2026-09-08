import { type AiAuthDeps, authorizeAiRequest } from "./auth";
import { AI_GUIDANCE } from "./guidance";
import { describeTools } from "./mcp";
import { aiErrorStatus, toAiErrorBody } from "./toolErrors";
import { AI_TOOLS, isAiToolName } from "./tools";

const NO_STORE = { "cache-control": "no-store" };

/**
 * `POST /api/ai/<tool>` — the same eleven tools over plain JSON, the same
 * guard, the same registry (PH-07 §2.4). `GET /api/ai` publishes the tool
 * descriptions and the guidance for a client that speaks no MCP.
 */
export async function handleAiRest(
  request: Request,
  pathname: string,
  deps: AiAuthDeps,
): Promise<Response> {
  if (pathname === "/api/ai" || pathname === "/api/ai/") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    return Response.json(
      {
        instructions: AI_GUIDANCE,
        tools: describeTools().map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          endpoint: `/api/ai/${name}`,
        })),
      },
      { headers: NO_STORE },
    );
  }
  const name = pathname.slice("/api/ai/".length);
  if (!isAiToolName(name)) {
    return Response.json(
      {
        error: {
          kind: "notFound",
          code: "UNKNOWN_TOOL",
          message: "Unknown tool",
        },
      },
      {
        status: 404,
        headers: NO_STORE,
      },
    );
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const auth = await authorizeAiRequest(request, deps);
  if (!auth.ok) return auth.response;

  let body: unknown = {};
  const raw = await request.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json(
        {
          error: {
            kind: "validation",
            code: "INVALID_JSON",
            message: "The body is not JSON",
          },
        },
        { status: 400, headers: NO_STORE },
      );
    }
  }
  const tool = AI_TOOLS[name];
  const parsed = tool.inputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          kind: "validation",
          code: "INVALID_INPUT",
          message: "Invalid input",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const result = await tool.run(auth.ctx, parsed.data);
    return Response.json({ result }, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      { error: toAiErrorBody(error) },
      { status: aiErrorStatus(error), headers: NO_STORE },
    );
  }
}
