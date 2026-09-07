import { AppServerError } from "./errorResponse";

/**
 * A structural check on what a server function **resolved to**.
 *
 * `errorResponseMiddleware` turns every failure it sees into a rejection,
 * but a response that never reached it — a Worker that died before the
 * handler ran, a platform 500 rendered as JSON, a proxy answering in the
 * server function's place — resolves on the client with whatever body the
 * transport parsed, and the caller would go on to `router.invalidate()`,
 * clear the form or navigate as if the write had happened. So every
 * caller reads the resolved value through this check and treats a shape
 * it does not recognise as a system error: the draft stays, the message
 * shows, the user retries.
 */
export type ServerFnResultGuard<T> = (value: unknown) => value is T;

export function readServerFnResult<T>(
  value: unknown,
  isExpected: ServerFnResultGuard<T>,
  name: string,
): T {
  if (isExpected(value)) return value;
  throw new AppServerError({
    kind: "system",
    code: "UNEXPECTED_SERVER_FN_RESULT",
    message: `${name} resolved to a value of an unexpected shape`,
    retryable: true,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
