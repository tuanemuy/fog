import type { AiRuntime } from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import { handleMcp } from "./mcp";
import {
  handleAuthorizationServerMetadata,
  handleAuthorize,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
} from "./oauth";
import { handleAiRest } from "./rest";

export type AiRouteDeps = Readonly<{
  container: RequestContainer;
  runtime: AiRuntime;
  appUrl: string;
  serverVersion: string;
}>;

/** The paths the request Worker answers before TanStack (design D-04). */
export function isAiRoute(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token" ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/api/ai" ||
    pathname.startsWith("/api/ai/")
  );
}

export function handleAiRoute(
  request: Request,
  pathname: string,
  deps: AiRouteDeps,
): Promise<Response> | Response {
  const shared = {
    container: deps.container,
    tokenCodec: deps.runtime.tokenCodec,
    appUrl: deps.appUrl,
  };
  switch (pathname) {
    case "/mcp":
      return handleMcp(request, {
        ...shared,
        serverVersion: deps.serverVersion,
      });
    case "/oauth/register":
      return handleRegister(request, shared);
    case "/oauth/authorize":
      return handleAuthorize(request, shared);
    case "/oauth/token":
      return handleToken(request, shared);
    case "/.well-known/oauth-authorization-server":
      return handleAuthorizationServerMetadata(deps.appUrl);
    case "/.well-known/oauth-protected-resource":
      return handleProtectedResourceMetadata(deps.appUrl);
    default:
      return handleAiRest(request, pathname, shared);
  }
}
