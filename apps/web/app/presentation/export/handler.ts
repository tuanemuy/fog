import { createZipArchiveWriter } from "@repo/core/adapters/fflate/zipArchiveWriter";
import type { RequestContainer } from "@repo/core/application/di/types";
import { exportAllData } from "@repo/core/application/export/exportAllData";
import { clientErrorStatus, toClientErrorBody } from "../errorBody";
import { readSessionUserId } from "../requestSession";

export type ExportHandlerDeps = Readonly<{
  container: RequestContainer;
  appUrl: string;
}>;

export const EXPORT_PATH = "/export";
const MAX_TIMEZONE_LENGTH = 64;
const NO_STORE = { "cache-control": "no-store" };

export function isExportRoute(pathname: string): boolean {
  return pathname === EXPORT_PATH;
}

function errorResponse(error: unknown): Response {
  return Response.json(
    { error: toClientErrorBody(error) },
    { status: clientErrorStatus(error), headers: NO_STORE },
  );
}

function refused(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { kind: "validation", code, message } },
    { status, headers: NO_STORE },
  );
}

/**
 * Whether a cookie-authenticated POST came from this app's own pages: an
 * `Origin` must be ours, and without one the fetch metadata must not say
 * another site sent it. A non-browser client sends neither.
 */
function isSameOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(appUrl).origin;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/**
 * `POST /export` (S-ST-02): the session's own data as a zip, rendered and
 * encoded here on the request Worker after the user's object read it in
 * one transaction. A bare handler rather than a server function because
 * the answer is a binary download with its `Content-Disposition`, not
 * JSON. Nothing on this path writes.
 */
export async function handleExport(
  request: Request,
  deps: ExportHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  if (!isSameOrigin(request, deps.appUrl)) {
    return new Response("Forbidden", { status: 403 });
  }
  const userId = await readSessionUserId(request, deps.container);
  if (userId === null) {
    return refused("UNAUTHENTICATED", "Sign in to export your data", 401);
  }
  let timezone: FormDataEntryValue | null;
  try {
    timezone = (await request.formData()).get("timezone");
  } catch {
    return refused("INVALID_INPUT", "The body must be form data", 400);
  }
  if (typeof timezone !== "string" || timezone.length > MAX_TIMEZONE_LENGTH) {
    return refused("INVALID_INPUT", "timezone is required", 400);
  }
  try {
    const output = await exportAllData(
      { container: deps.container, input: { userId, timezone } },
      createZipArchiveWriter(),
    );
    return new Response(output.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": output.contentType,
        "content-disposition": `attachment; filename="${output.filename}"`,
        "content-length": String(output.data.byteLength),
        "x-content-type-options": "nosniff",
        ...NO_STORE,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
