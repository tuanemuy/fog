import {
  callDurableObject,
  directoryStub,
} from "@repo/core/adapters/cloudflare/doStubs";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import type { ServerEnv } from "@repo/core/application/di/serverCloudflare";

const DIRECTORY_LOCATOR = /^dir:g(\d+):b(\d+)$/;

/**
 * `GET /__diagnostics/schema-version?locator=dir:g1:b0` — the one route that
 * makes a real cross-Worker round trip, so a `script_name` mismatch (which
 * fails silently everywhere else) shows here. Bucket locators only: a user
 * locator would answer "does this account hold data". Exists only where
 * `DIAGNOSTICS_ENABLED` is declared, i.e. the local config.
 */
export async function handleDiagnostics(
  request: Request,
  env: ServerEnv,
): Promise<Response> {
  if (env.DIAGNOSTICS_ENABLED !== "true") {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  if (url.pathname !== "/__diagnostics/schema-version") {
    return new Response("Not found", { status: 404 });
  }
  const match = DIRECTORY_LOCATOR.exec(url.searchParams.get("locator") ?? "");
  if (!match) {
    return Response.json(
      { error: "locator must be of the form dir:g<generation>:b<index>" },
      { status: 400 },
    );
  }
  const stub = directoryStub(env.IDENTITY_DIRECTORY, {
    generation: Number(match[1]),
    bucketIndex: Number(match[2]),
  }) as unknown as IdentityDirectoryDurableObject;
  const result = await callDurableObject(() => stub.readSchemaVersion());
  return Response.json(result);
}
