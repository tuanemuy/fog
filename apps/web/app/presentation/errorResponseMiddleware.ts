import { getContainer } from "@repo/core/application/di/containerStore";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  AppServerError,
  httpStatusFor,
  isAppServerError,
  redactForClient,
  redactsMessage,
  type SerializedError,
  serializeError,
} from "./errorResponse";

// Wraps the entire server-function pipeline so throws from `inputValidator`
// and the handler land in the same catch — setting the status inside the
// handler alone would miss validator throws. The `.server(...)` body is
// stripped from client bundles by the compiler, so the top-level import of
// `@tanstack/react-start/server` is safe.
//
// This module owns the redaction boundary for outbound errors: this
// middleware for awaited server functions, `guardStreamedRender` for RSC
// leaves that render after the handler returned.
export const errorResponseMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    const appError = await toClientError(error);
    setResponseStatus(httpStatusFor(appError.serialized));
    throw appError;
  }
});

/**
 * The same boundary, for renders that stream past the middleware.
 *
 * A streaming route forwards `renderServerComponent(...)` without awaiting
 * it, so the RSC leaf renders after the handler returned and its throws
 * never reach the middleware's `catch`. Leaves that read protected data
 * wrap their loading in this so redaction and logging still happen.
 *
 * It cannot restore the HTTP status (the response is already committed) or
 * the serialized `kind` (the RSC boundary does not run
 * `appServerErrorAdapter`), so every streamed failure reaches the client as
 * `kind: "unknown"` — both failing towards less information.
 */
export async function guardStreamedRender<T>(
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    throw await toClientError(error);
  }
}

// The single redaction point: the raw serialized form goes to the injected
// `Logger` for ops triage, the client only ever sees `redactForClient(...)`.
async function toClientError(error: unknown): Promise<AppServerError> {
  const rawSerialized = isAppServerError(error)
    ? error.serialized
    : serializeError(error);

  // Log whatever redaction is about to blank, not just the operational
  // kinds: a `conflict` / `notFound` / `unauthorized` / `forbidden` message
  // is server prose that leaves no other trace once the wire copy is gone.
  if (redactsMessage(rawSerialized.kind)) {
    await logServerError(error, rawSerialized);
  }

  return new AppServerError(redactForClient(rawSerialized));
}

// `containerStore` is client-graph safe (no node-only imports), so
// statically importing `getContainer` here doesn't pull `node:async_hooks`
// into client chunks. The fallback `console.error` only fires if
// container resolution or logger dispatch itself throws.
async function logServerError(
  error: unknown,
  serialized: SerializedError,
): Promise<void> {
  try {
    const { logger } = await getContainer();
    logger.error("Server function failed", {
      kind: serialized.kind,
      code: serialized.code,
      message: serialized.message,
      cause: error,
    });
  } catch (logError) {
    console.error("Server function failed (logger unavailable)", {
      original: error,
      logError,
    });
  }
}
