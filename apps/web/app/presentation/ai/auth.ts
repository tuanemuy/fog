import { toAiToolContainer } from "@repo/core/application/di/aiToolContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { authorizeAiClient } from "@repo/core/application/identity/authorizeAiClient";
import type { AiTokenCodec } from "@repo/core/application/ports/aiTokenCodec";
import type { AiToolContext } from "./tools";

export type AiAuthDeps = Readonly<{
  container: RequestContainer;
  tokenCodec: AiTokenCodec;
  appUrl: string;
}>;

export type AiAuthResult =
  | Readonly<{ ok: true; ctx: AiToolContext }>
  | Readonly<{ ok: false; response: Response }>;

/** RFC 9728 §5.1: the challenge names where the resource's metadata lives. */
export function unauthorized(appUrl: string, error?: string): Response {
  const parts = [
    `resource_metadata="${new URL("/.well-known/oauth-protected-resource", appUrl).toString()}"`,
  ];
  if (error !== undefined) parts.unshift(`error="${error}"`);
  return Response.json(
    { error: error ?? "unauthorized" },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer ${parts.join(", ")}`,
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * The AI API's guard (PH-07 §1.4): a Bearer access token, then the
 * connection read on every call — revoked or unknown is 401, whatever the
 * token says — and the actor the revisions will name. Every refusal is
 * the same 401; nothing about which check failed reaches the client.
 */
export async function authorizeAiRequest(
  request: Request,
  deps: AiAuthDeps,
): Promise<AiAuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match === null) {
    return { ok: false, response: unauthorized(deps.appUrl) };
  }
  const access = await deps.tokenCodec.verifyAccess(
    match[1] ?? "",
    deps.container.clock.now(),
  );
  if (access === null) {
    return { ok: false, response: unauthorized(deps.appUrl, "invalid_token") };
  }
  let client: { clientName: string } | null;
  try {
    client = await authorizeAiClient({
      container: deps.container,
      input: { userId: access.uid, connectionId: access.cid },
    });
  } catch (error) {
    // An object that was never initialised is a token for no account.
    if (isSystemError(error) && error.code === SystemErrorCode.NotInitialized) {
      client = null;
    } else {
      throw error;
    }
  }
  if (client === null) {
    return { ok: false, response: unauthorized(deps.appUrl, "invalid_token") };
  }
  return {
    ok: true,
    ctx: {
      container: toAiToolContainer(deps.container),
      userId: access.uid,
      actor: {
        kind: "aiClient",
        userId: access.uid,
        connectionId: access.cid,
        clientName: client.clientName,
      },
    },
  };
}
