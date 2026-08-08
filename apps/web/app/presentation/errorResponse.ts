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
  type FieldErrors,
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

const SERIALIZED_ERROR_KINDS = {
  business: true,
  notFound: true,
  conflict: true,
  unauthorized: true,
  forbidden: true,
  validation: true,
  system: true,
  unknown: true,
} as const satisfies Record<SerializedErrorKind, true>;

function isSerializedErrorKind(kind: string): kind is SerializedErrorKind {
  return Object.hasOwn(SERIALIZED_ERROR_KINDS, kind);
}

function isSerializedError(
  value: SerializedErrorBase & { kind: string },
): value is SerializedError {
  return isSerializedErrorKind(value.kind);
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
  // Receiver for a `kind` outside the union. It cannot be closed by a type:
  // this union is where each layer's variants are aggregated, so `lib/` — which
  // every layer depends on — cannot name it back without inverting the
  // dependency direction, and `CodedError.toSerialized()` is therefore typed
  // only as `{ kind: string }`. `code` / `message` are carried over so a
  // layerless error still reaches the logger with its own detail.
  return {
    kind: "unknown",
    code: serialized.code,
    message: serialized.message,
  };
}

// Strips server-internal detail before a `SerializedError` crosses the
// transport boundary. `system` and `unknown` can carry messages / codes that
// hint at internal layering (driver names, table names, network targets);
// exposing them to clients adds reconnaissance value with no UX upside.
// Apply at the response boundary only — server-side logs must use the raw
// form so operators retain the original code / message for triage.
export function redactForClient(serialized: SerializedError): SerializedError {
  if (serialized.kind === "system" || serialized.kind === "unknown") {
    return { ...serialized, code: null, message: SYSTEM_ERROR_PUBLIC_MESSAGE };
  }
  return serialized;
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

const APP_SERVER_ERROR_BRAND: unique symbol = Symbol.for(
  "@repo/web/AppServerError",
);

const APP_SERVER_ERROR_NAME = "AppServerError";

export class AppServerError extends Error {
  override readonly name = APP_SERVER_ERROR_NAME;
  readonly [APP_SERVER_ERROR_BRAND] = true as const;

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

function isFieldErrors(value: unknown): value is FieldErrors {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (messages) =>
      Array.isArray(messages) &&
      messages.every((message) => typeof message === "string"),
  );
}

// `isFieldErrors` only inspects string-keyed enumerable values and array
// elements, so a symbol-keyed property or an extra own property grafted onto a
// messages array would survive validation by reference. `Object.entries` drops
// the symbol keys and the array spread copies index elements only, which is
// what extends `asSerializedError`'s rebuild guarantee below the top level.
function rebuildFieldErrors(fieldErrors: FieldErrors): FieldErrors {
  return Object.fromEntries(
    Object.entries(fieldErrors).map(([field, messages]) => [
      field,
      [...messages],
    ]),
  );
}

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

// The ledger of keys `asSerializedError` rebuilds from, pinned to the union:
// adding a field to any `SerializedError` variant — even an optional one,
// which the return type alone would let the rebuild silently strip — fails to
// compile here until the function learns to carry it over.
const REBUILT_KEYS = {
  kind: true,
  code: true,
  message: true,
  retryable: true,
  fieldErrors: true,
} as const satisfies Record<KeysOfUnion<SerializedError>, true>;

/**
 * Validates an unverified payload against the `SerializedError` contract and
 * **rebuilds it from the known keys only**, or answers `null`.
 *
 * Every field the union declares is checked, not just the discriminant: a
 * payload that satisfies `kind` alone would otherwise be cast into a type it
 * does not honour and reach `errorDisplay` / `errorField`, which branch on
 * `code` and iterate `fieldErrors`. Rebuilding rather than returning the input
 * closes the second half: `redactForClient` spreads the payload, so an unknown
 * property riding along would survive redaction and cross to the client. The
 * rebuild reaches inside `fieldErrors` too — see `rebuildFieldErrors` — so the
 * known-keys claim holds below the top level, not just on it, and the ledger of
 * keys it rebuilds from is pinned to the union by `REBUILT_KEYS`.
 *
 * Answering `null` is the fail-closed direction — callers land on
 * {@link UNVERIFIED_SERIALIZED_ERROR} or on `serializeError`, both `unknown`.
 *
 * Exported because the serialization adapter needs it on the **inbound** leg:
 * see `appServerErrorAdapter`. Under CLAUDE.md's "validate at exactly two
 * points" this is the transport boundary, not a third point — it is the same
 * shape check `serverAction`'s `inputValidator` performs, run one step earlier
 * because Seroval reconstructs typed nodes before the validator sees them.
 */
export function asSerializedError(value: unknown): SerializedError | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<Record<keyof typeof REBUILT_KEYS, unknown>>;

  const { kind, code, message, retryable } = v;
  if (typeof kind !== "string" || !isSerializedErrorKind(kind)) return null;
  if (code !== null && typeof code !== "string") return null;
  if (typeof message !== "string") return null;
  if (retryable !== undefined && typeof retryable !== "boolean") return null;

  const base = {
    code,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };

  // `fieldErrors` exists on the `validation` variant only, so on every other
  // kind it is an unknown key and is dropped with the rest.
  if (kind === "validation") {
    const { fieldErrors } = v;
    if (fieldErrors === undefined) return { kind, ...base };
    if (!isFieldErrors(fieldErrors)) return null;
    return { kind, ...base, fieldErrors: rebuildFieldErrors(fieldErrors) };
  }

  return { kind, ...base };
}

/**
 * Where a payload that fails {@link asSerializedError} lands when the caller
 * has to produce a `SerializedError` rather than answer `null`.
 *
 * Already carries the redacted `system` / `unknown` message, so it is safe on
 * either side of the boundary: the value is identical whether or not
 * `redactForClient` runs over it.
 */
export const UNVERIFIED_SERIALIZED_ERROR: SerializedError = Object.freeze({
  kind: "unknown",
  code: null,
  message: SYSTEM_ERROR_PUBLIC_MESSAGE,
});

/**
 * Structural identity test for {@link AppServerError}.
 *
 * `instanceof` is unusable here: server functions compile into their own
 * module graph while the serialization adapter loads from the SSR graph, so
 * one process holds two distinct class objects built from this same file —
 * a thrown error fails `instanceof` and silently falls back to Seroval's
 * default `Error` handling, dropping `serialized`. Matching the
 * `Symbol.for()` brand property plus a well-formed `kind`-tagged payload is
 * graph-independent.
 *
 * The brand crosses module graphs but **not** a serialization boundary: it is
 * a symbol-keyed own property, so `structuredClone` / JSON / the Worker ↔
 * Durable Object RPC hop all drop it and this guard then answers `false`. The
 * receiver for those values is {@link extractSerializedError}, which matches
 * the surviving `serialized` remnant structurally and never looks at the brand
 * at all — never widen this guard with a `name` comparison.
 *
 * This is the one guard that still claims a concrete class rather than the
 * contract the per-kind guards narrow to: `createSerializationAdapter` types
 * its `test` as `(value: unknown) => value is TInput`, and this adapter binds
 * `TInput` to `AppServerError`. See `.adr/016`.
 */
export function isAppServerError(value: unknown): value is AppServerError {
  if (typeof value !== "object" || value === null) return false;
  if (!(APP_SERVER_ERROR_BRAND in value)) return false;
  return (
    hasSerializedRemnant(value) && asSerializedError(value.serialized) !== null
  );
}

/**
 * Reads the `kind`-tagged payload out of a caught value: from a `serialized`
 * remnant rebuilt through {@link asSerializedError}, and from `serializeError`
 * for anything else.
 *
 * **The brand is deliberately not consulted here.** Matching it is
 * {@link isAppServerError}'s job — it is what the serialization adapter binds
 * its `test` to — and it is neither necessary nor sufficient for this
 * function: it does not survive the serialization boundary whose far side this
 * receives values from, and it is forgeable by anyone who can call
 * `Symbol.for`, so a genuinely branded instance is still no evidence that its
 * payload is ours (Seroval reconstructs one from any request body tagged
 * `$TSR/t/AppServerError` — see `appServerErrorAdapter`). Branded or not, the
 * payload therefore goes through the same structural rebuild, which is also
 * what stops an unknown property riding along and surviving
 * `redactForClient`'s spread all the way to the client.
 *
 * **Invariant this rests on: the shape of a thrown value never derives from
 * external input.** The remnant stage matches structurally — any object with a
 * `serialized` own property qualifies — and it no longer runs on the client
 * only: `toClientError` classifies with it, so the `kind` it reads decides the
 * HTTP status, and decides whether `redactForClient` and the `system` /
 * `unknown` logging branch run at all. A payload that reached here from a
 * request body could therefore choose its own status and suppress both
 * redaction and the log. Nothing in this repository throws request-derived
 * data — usecases and adapters throw `CodedError` subclasses, and
 * `validateInput` builds its own {@link AppServerError} — which is what makes
 * the stage safe. Re-throwing a value that came off the wire breaks it
 * silently; translate such a value into an error class instead.
 *
 * The same invariant carries `errorResponseMiddleware`'s `isNotFound`
 * pass-through, which is `obj?.isNotFound === true` and so rides on the shape of
 * the thrown value just as this stage does. Its `isRedirect` neighbour does not:
 * that one is `obj instanceof Response && !!obj.options`, which no decoded
 * payload can satisfy.
 */
export function extractSerializedError(error: unknown): SerializedError {
  if (hasSerializedRemnant(error)) {
    const structural = asSerializedError(error.serialized);
    if (structural !== null) return structural;
  }
  return serializeError(error);
}
