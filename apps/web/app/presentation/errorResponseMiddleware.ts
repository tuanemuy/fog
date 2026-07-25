import { getContainer } from "@repo/core/application/di/containerStore";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  AppServerError,
  httpStatusFor,
  isAppServerError,
  redactForClient,
  type SerializedError,
  serializeError,
} from "./errorResponse";

// Wraps the entire server-function pipeline so throws from `inputValidator`
// and the handler land in the same catch. Setting the response status from
// inside the handler alone would miss validator throws (they fire before
// `.handler` runs), and the constructor of `AppServerError` can't touch the
// server-only status setter directly. The `.server(...)` body is stripped
// from client bundles by the TanStack Start compiler, so importing
// `@tanstack/react-start/server` at module top-level is safe.
//
// This module owns the redaction boundary for outbound errors — as this
// middleware for awaited server functions, and as `guardStreamedRender` for
// RSC leaves that render after the handler returned. Logger output policy
// (console, structured JSON, sink, …) is owned by the implementation that
// the container injects — this module just forwards the raw payload.
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
 * A per-fragment streaming route forwards `renderServerComponent(...)`
 * without awaiting it, so the RSC leaf renders after the handler returned:
 * a throw inside it never reaches the middleware's `catch`. Leaves that read
 * protected data wrap their loading in this so redaction and logging still
 * happen at one place.
 *
 * Two things it cannot restore, both failing towards less information on the
 * client: the HTTP status (the response is already committed by the time the
 * leaf renders) and the serialized `kind`. The RSC boundary does not run
 * `appServerErrorAdapter`, so the client receives a plain `Error` with no
 * `serialized` payload and `extractSerializedError` falls back to
 * `kind: "unknown"` — every streamed failure reads as the generic wording
 * regardless of what was thrown.
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

  if (rawSerialized.kind === "system" || rawSerialized.kind === "unknown") {
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
