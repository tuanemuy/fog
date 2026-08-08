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

const SYSTEM_ERROR_PUBLIC_MESSAGE = "System error";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

function unknownFrom(error: unknown): SerializedUnknownError {
  return { kind: "unknown", code: null, message: errorMessage(error) };
}

// Raw structural projection. Kept un-redacted so server-side observers
// (logger, tracing) can see the original `code` / `message`. The transport
// boundary (`errorResponseMiddleware`) is responsible for running
// `redactForClient` exactly once before the value crosses to the client.
//
// `isSerializableError` only proves `toSerialized` is callable, so its call and
// everything read off its answer are unverified. This runs inside the boundary
// catch, where a secondary throw would skip status, redaction and logging, so
// every such shape fails closed onto `unknown`. One residue remains — a
// throwing own `message` getter — recorded in `.adr/016`.
export function serializeError(error: unknown): SerializedError {
  if (!isSerializableError(error)) {
    return unknownFrom(error);
  }
  try {
    const serialized: unknown = error.toSerialized();
    if (typeof serialized !== "object" || serialized === null) {
      return unknownFrom(error);
    }
    // Rebuilt rather than returned by reference: nothing pins the key set of
    // the object `toSerialized` answered, and routing through
    // `asSerializedError` makes "every `SerializedError` handed out was rebuilt
    // from known keys" hold here too, not only in `extractSerializedError`.
    const rebuilt = asSerializedError(serialized);
    if (rebuilt !== null) {
      return rebuilt;
    }
    // Receiver for a `kind` outside the union, or a union `kind` whose payload
    // failed the rebuild. No type can close it: the union is assembled here in
    // presentation, so `CodedError.toSerialized()` can only be typed
    // `{ kind: string }`. Detail is carried over so a layerless error still
    // reaches the logger, each field behind the same `typeof` check the rebuild
    // ran. Destructured once so a two-faced getter cannot answer the check and
    // the result differently.
    const { code, message, retryable } = serialized as Partial<
      Record<"code" | "message" | "retryable", unknown>
    >;
    return {
      kind: "unknown",
      code: typeof code === "string" ? code : null,
      message: typeof message === "string" ? message : errorMessage(error),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
    };
  } catch {
    return unknownFrom(error);
  }
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

// Copy first, then validate the copy — one pass, each property read exactly
// once. The ordering is load-bearing twice: a sparse array passes an in-place
// `every` (holes are skipped) but the spread materialises each hole as
// `undefined`, and a getter that answers differently per read never gets a
// second read. `Object.entries` plus the spread also drop symbol keys and
// grafted own properties, which extends the rebuild guarantee below the top
// level. An own `"__proto__"` key is rejected rather than dropped: assigning it
// would hit the `Object.prototype` setter and swap the accumulator's prototype.
function rebuildFieldErrors(value: unknown): FieldErrors | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rebuilt: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    if (field === "__proto__") return null;
    if (!Array.isArray(messages)) return null;
    const copy: unknown[] = [...messages];
    if (
      !copy.every((message): message is string => typeof message === "string")
    ) {
      return null;
    }
    rebuilt[field] = copy;
  }
  return rebuilt;
}

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

// The ledger of keys `asSerializedError` rebuilds from, pinned to the union so
// that adding a field to any variant — even an optional one the return type
// would let the rebuild silently strip — fails to compile until it is named
// here. Naming a key does not make the function carry it; the roundtrip cases
// in `__tests__/errorResponse.test.ts` pin that half.
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
 * payload satisfying `kind` alone would reach `errorDisplay` / `errorField`,
 * which branch on `code` and iterate `fieldErrors`. Rebuilding rather than
 * returning the input closes the other half — `redactForClient` spreads the
 * payload, so an unknown property riding along would survive redaction and
 * cross to the client. The rebuild reaches inside `fieldErrors` too.
 *
 * Answering `null` is the fail-closed direction — callers land on
 * {@link UNVERIFIED_SERIALIZED_ERROR} or on `serializeError`, both `unknown`.
 *
 * Exported because the serialization adapter needs it on the **inbound** leg;
 * see `appServerErrorAdapter`. Under CLAUDE.md's "validate at exactly two
 * points" this is the transport boundary, not a third point.
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
    const rebuiltFieldErrors = rebuildFieldErrors(fieldErrors);
    if (rebuiltFieldErrors === null) return null;
    return { kind, ...base, fieldErrors: rebuiltFieldErrors };
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
 * `instanceof` is unusable here: server functions compile into their own module
 * graph while the serialization adapter loads from the SSR graph, so a thrown
 * error fails `instanceof` and silently falls back to Seroval's default `Error`
 * handling, dropping `serialized`. Brand plus a well-formed payload is
 * graph-independent. The `message` check is the minimal `Error` shape the
 * narrowed type promises; `name` and `stack` ride on the brand.
 *
 * The brand crosses module graphs but **not** a serialization boundary, so this
 * guard answers `false` for values that already crossed one. Their receiver is
 * {@link extractSerializedError}, which reads the surviving remnant
 * structurally — never widen this guard with a `name` comparison.
 *
 * The one guard still claiming a concrete class rather than a contract, because
 * `createSerializationAdapter` binds its `test` to `TInput`. See `.adr/016`.
 *
 * Limit: the payload is validated but **not rebuilt**, so undeclared keys may
 * still ride on it. Never read `.serialized` off a narrowed value directly —
 * go through {@link extractSerializedError} or {@link asSerializedError}.
 */
export function isAppServerError(value: unknown): value is AppServerError {
  if (typeof value !== "object" || value === null) return false;
  // `Object.hasOwn`, not `in`: the brand is a class field and therefore an own
  // property on every real instance, so `in`'s prototype-chain walk buys
  // nothing except accepting a brand planted on a prototype. This mirrors
  // `isSerializedErrorKind`, whose test pins the same choice.
  if (!Object.hasOwn(value, APP_SERVER_ERROR_BRAND)) return false;
  if (typeof (value as { message?: unknown }).message !== "string") {
    return false;
  }
  return (
    hasSerializedRemnant(value) && asSerializedError(value.serialized) !== null
  );
}

/**
 * Reads the `kind`-tagged payload out of a caught value: from a `serialized`
 * remnant rebuilt through {@link asSerializedError}, and from `serializeError`
 * for anything else.
 *
 * **The brand is deliberately not consulted here.** It does not survive the
 * serialization boundary whose far side this receives values from, and it is
 * forgeable, so it is neither necessary nor sufficient — Seroval reconstructs a
 * branded instance from any request body tagged `$TSR/t/AppServerError`.
 * Branded or not, the payload goes through the same structural rebuild.
 *
 * **Invariant this rests on: the shape of a thrown value never derives from
 * external input.** The remnant stage matches structurally, and `toClientError`
 * classifies with it, so the `kind` it reads decides the HTTP status and whether
 * redaction and the `system` / `unknown` log run at all. A request-derived
 * payload reaching here could choose its own status and suppress both. Nothing
 * in this repository throws request-derived data; re-throwing a value that came
 * off the wire breaks the invariant silently. `errorResponseMiddleware`'s
 * `isNotFound` pass-through rides on it too.
 *
 * Limit: the remnant stage does not fail closed — a caught value whose accessors
 * throw still throws out of here. `toClientError` is the only backstop, so it
 * covers the server path alone; the client-side callers rest on catching
 * transport-decoded plain data.
 */
export function extractSerializedError(error: unknown): SerializedError {
  if (hasSerializedRemnant(error)) {
    const structural = asSerializedError(error.serialized);
    if (structural !== null) return structural;
  }
  return serializeError(error);
}
