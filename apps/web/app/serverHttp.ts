import type { FogServices } from "@repo/core/application/fog/types";
import type { Logger } from "@repo/core/application/ports/logger";
import { handleFogAiHttp, isFogAiHttp } from "@/presentation/fogAiHttp";
import { handleFogGoogleCallback } from "@/presentation/fogGoogleHttp";

export function createFogHttpHandler({
  appUrl,
  services,
  logger,
  healthCheck,
  healthDetails,
  render,
}: {
  appUrl: string;
  services: FogServices;
  logger: Logger;
  healthCheck: () => Promise<void>;
  healthDetails?: Readonly<{
    deploymentSha: string;
    deploymentEnv: "staging" | "production";
    databaseIdentity: string;
  }>;
  render: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/auth/google/callback")
      return handleFogGoogleCallback(request, { services, appUrl });
    if (path === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      try {
        await healthCheck();
        return new Response(
          request.method === "HEAD"
            ? null
            : healthDetails
              ? JSON.stringify({ status: "ok", ...healthDetails })
              : "ok",
          {
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": healthDetails
                ? "application/json; charset=utf-8"
                : "text/plain",
            },
          },
        );
      } catch {
        return new Response("unavailable", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    if (isFogAiHttp(path))
      return handleFogAiHttp(request, { services, appUrl, logger });
    if (/^\/todo(?:\/|$)/.test(path))
      return new Response("Not found", { status: 404 });
    return render(request);
  };
}
