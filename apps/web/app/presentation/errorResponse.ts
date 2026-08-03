import type {
  SerializedConflictError,
  SerializedForbiddenError,
  SerializedNotFoundError,
  SerializedSystemError,
  SerializedUnauthorizedError,
  SerializedValidationError,
} from "@repo/core/application/errors";
import type { SerializedBusinessError } from "@repo/core/domain/error";
import {
  isSerializableError,
  type SerializedErrorBase,
} from "@repo/core/lib/error";

// Re-exported so `validator.ts` (and other presentation modules) keep a
// single import site for the serialized-error contract even though the
// validation variant is owned by the application layer.
export type { SerializedValidationError } from "@repo/core/application/errors";
export type {
  FieldErrors,
  SerializableError,
  SerializedErrorBase,
} from "@repo/core/lib/error";

export type SerializedUnknownError = SerializedErrorBase & {
  kind: "unknown";
};

export type SerializedError =
  | SerializedBusinessError
  | SerializedNotFoundError
  | SerializedConflictError
  | SerializedUnauthorizedError
  | SerializedForbiddenError
  | SerializedValidationError
  | SerializedSystemError
  | SerializedUnknownError;

export type SerializedErrorKind = SerializedError["kind"];

// Exported so the RPC restoration table in `application/rpc/restoreError.ts`
// can be pinned against the union from this side — the union's authority is
// here, so the check belongs here too.
export const SERIALIZED_ERROR_KINDS = {
  business: true,
  notFound: true,
  conflict: true,
  unauthorized: true,
  forbidden: true,
  validation: true,
  system: true,
  unknown: true,
} as const satisfies Record<SerializedErrorKind, true>;

function isSerializedError(
  value: SerializedErrorBase & { kind: string },
): value is SerializedError {
  return Object.hasOwn(SERIALIZED_ERROR_KINDS, value.kind);
}

const SYSTEM_ERROR_PUBLIC_MESSAGE = "System error";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

// Raw structural projection. Kept un-redacted so server-side observers
// (logger, tracing) can see the original `code` / `message`. The transport
// boundary (`errorResponseMiddleware`) is responsible for running
// `redactForClient` exactly once before the value crosses to the client.
export function serializeError(error: unknown): SerializedError {
  if (!isSerializableError(error)) {
    return { kind: "unknown", code: null, message: errorMessage(error) };
  }
  const serialized = error.toSerialized();
  if (isSerializedError(serialized)) {
    return serialized;
  }
  return {
    kind: "unknown",
    code: serialized.code,
    message: serialized.message,
  };
}

const REDACTED_MESSAGE = "Request failed";

/**
 * Strips server-internal detail before a `SerializedError` crosses the
 * transport boundary.
 *
 * Three treatments, and the `switch` is exhaustive so a new `kind` cannot be
 * added without choosing one:
 *
 * - `system` / `unknown` lose both `code` and `message`. They carry driver
 *   names, table names and network targets — reconnaissance value with no UX
 *   upside.
 * - `notFound` / `conflict` / `unauthorized` / `forbidden` keep `code` and
 *   lose `message`. `code` is their whole contract (`errorDisplay` renders
 *   these four from it and never reads their message), while the message is
 *   free-form server prose that can embed server-minted keys —
 *   `JOB_PAYLOAD_MISMATCH` interpolates a job's
 *   `operationKey`, which for `send-mail` is derived from an HMAC.
 * - `business` / `validation` pass through. Their message is written for the
 *   end user and `errorDisplay` falls back to it whenever no code-specific
 *   wording exists, so redacting it would blank the auth forms.
 *
 * Apply at the response boundary only — server-side logs must use the raw
 * form so operators retain the original code / message for triage. Which
 * kinds *need* that log is {@link redactsMessage}.
 */
export function redactForClient(serialized: SerializedError): SerializedError {
  switch (serialized.kind) {
    case "system":
    case "unknown":
      return {
        ...serialized,
        code: null,
        message: SYSTEM_ERROR_PUBLIC_MESSAGE,
      };
    case "notFound":
    case "conflict":
    case "unauthorized":
    case "forbidden":
      return { ...serialized, message: REDACTED_MESSAGE };
    case "business":
    case "validation":
      return serialized;
  }
}

/**
 * Whether {@link redactForClient} drops this kind's `message`.
 *
 * The transport boundary logs exactly these kinds, because for them the
 * server log is the *only* remaining copy of the original prose: `business`
 * and `validation` keep their message on the wire, everything else loses it.
 * Deriving the log condition from redaction rather than listing kinds again
 * is what keeps the pair from drifting — a `conflict` whose message never
 * reached a client and never reached a log would be untriageable.
 */
export function redactsMessage(kind: SerializedErrorKind): boolean {
  switch (kind) {
    case "business":
    case "validation":
      return false;
    case "system":
    case "unknown":
    case "notFound":
    case "conflict":
    case "unauthorized":
    case "forbidden":
      return true;
  }
}

// `system` / `unknown` are mapped to an explicit 500 rather than relying on
// the framework default. This keeps the response status independent of
// runtime-specific defaults and makes the contract auditable in one place.
const HTTP_STATUS_BY_KIND: Record<SerializedErrorKind, number> = {
  business: 422,
  notFound: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  validation: 422,
  system: 500,
  unknown: 500,
};

export function httpStatusFor(serialized: SerializedError): number {
  return HTTP_STATUS_BY_KIND[serialized.kind];
}

const APP_SERVER_ERROR_NAME = "AppServerError";

export class AppServerError extends Error {
  override readonly name = APP_SERVER_ERROR_NAME;

  constructor(public readonly serialized: SerializedError) {
    super(serialized.message);
    // Adapter-bypassed transports fall back to seroval's default Error
    // serialization, leaking `.stack` to clients. `delete` (not `= undefined`)
    // because `exactOptionalPropertyTypes` rejects explicit undefined on
    // `Error.stack?: string`.
    delete this.stack;
  }
}

// Structural detection for the "adapter bypassed" path: when the Seroval
// serialization adapter isn't on the boundary the client receives a plain
// object (or plain Error) whose `serialized` own property survived the
// roundtrip, but `instanceof AppServerError` is false. UI consumers must go
// through `extractSerializedError` so this path stays transparent to them.
function hasSerializedRemnant(
  value: unknown,
): value is { serialized: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "serialized" in value &&
    typeof (value as { serialized: unknown }).serialized === "object" &&
    (value as { serialized: unknown }).serialized !== null
  );
}

function asSerializedError(value: unknown): SerializedError | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { kind?: unknown; message?: unknown };
  if (typeof v.kind !== "string" || typeof v.message !== "string") return null;
  return isSerializedError(v as SerializedErrorBase & { kind: string })
    ? (v as SerializedError)
    : null;
}

/**
 * Structural identity test for {@link AppServerError}.
 *
 * `instanceof` is unusable here: server functions compile into their own
 * module graph while the serialization adapter loads from the SSR graph, so
 * one process holds two distinct class objects built from this same file —
 * a thrown error fails `instanceof` and silently falls back to Seroval's
 * default `Error` handling, dropping `serialized`. Matching the `name` tag
 * plus a well-formed `kind`-tagged payload is graph-independent.
 */
export function isAppServerError(value: unknown): value is AppServerError {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { name?: unknown }).name !== APP_SERVER_ERROR_NAME)
    return false;
  return (
    hasSerializedRemnant(value) && asSerializedError(value.serialized) !== null
  );
}

export function extractSerializedError(error: unknown): SerializedError {
  if (isAppServerError(error)) {
    return error.serialized;
  }
  if (hasSerializedRemnant(error)) {
    const structural = asSerializedError(error.serialized);
    if (structural !== null) return structural;
  }
  return serializeError(error);
}
