import { getContainer } from "@repo/core/application/di/containerStore";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  AppServerError,
  extractSerializedError,
  httpStatusFor,
  redactForClient,
  type SerializedError,
  UNVERIFIED_SERIALIZED_ERROR,
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
    // Only `isNotFound` rides the invariant `extractSerializedError`'s JSDoc
    // states — a thrown value's shape never derives from external input: it is
    // `obj?.isNotFound === true`, so breaking that invariant lets a decoded
    // payload skip classification entirely, not just the remnant stage.
    // `isRedirect` is `obj instanceof Response && !!obj.options`, which no
    // plain object can satisfy.
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
 * It classifies the failure the same way the middleware does — including a
 * failure that already crossed a serialization boundary, whose `kind` is read
 * back from its surviving payload — so redaction and the `system` / `unknown`
 * logging branch see the kind the usecase earned.
 *
 * What it cannot do is put that classification back on the wire. The HTTP
 * status is already committed, and the RSC boundary does not run
 * `appServerErrorAdapter`, so unless the `serialized` payload survives that
 * boundary the client reads the failure as `kind: "unknown"` — both failing
 * towards less information.
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
//
// Classifying here is what put `extractSerializedError`'s structural stage on
// the server side, so this function is the reason its invariant — a thrown
// value's shape never derives from external input — has to hold. Read the
// JSDoc there before routing a new kind of value into this catch.
async function toClientError(error: unknown): Promise<AppServerError> {
  // Not `isAppServerError` + `serializeError`: the brand does not survive a
  // serialization boundary, so an error that already crossed one would lose its
  // `kind` here and a 409 / 422 would leave as a 500.
  //
  // Last-resort backstop for the boundary catch: `serializeError` fails closed
  // on its own, but `extractSerializedError`'s remnant stage still throws when
  // the caught value's own getters throw (its JSDoc names this limit). A
  // secondary throw from here would leave the middleware's `catch` and skip
  // status, redaction and logging, so it lands on the pre-redacted unknown
  // instead — the logger still gets the original value as `cause`.
  let rawSerialized: SerializedError;
  try {
    rawSerialized = extractSerializedError(error);
  } catch {
    rawSerialized = UNVERIFIED_SERIALIZED_ERROR;
  }

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
