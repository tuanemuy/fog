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
// `isSerializableError` only proves `toSerialized` is callable, so the call,
// the shape of its answer and every property read off that answer are all
// unverified: a third-party error can carry a throwing `toSerialized`, answer
// a non-object, or answer an object whose getters throw. This function runs
// inside the boundary catch (`toClientError`), where a secondary throw would
// skip status, redaction and logging — so each of those shapes fails closed
// onto the `errorMessage(error)` fallback instead of escaping.
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
    // the object `toSerialized` answered. Routing this path through
    // `asSerializedError` makes "every `SerializedError` handed out was
    // rebuilt from known keys" hold on both siblings, not just on
    // `extractSerializedError`'s remnant stage.
    const rebuilt = asSerializedError(serialized);
    if (rebuilt !== null) {
      return rebuilt;
    }
    // Receiver for a `kind` outside the union (and for a union `kind` whose
    // payload fails the rebuild). It cannot be closed by a type: this union is
    // where each layer's variants are aggregated, so `lib/` — which every layer
    // depends on — cannot name it back without inverting the dependency
    // direction, and `CodedError.toSerialized()` is therefore typed only as
    // `{ kind: string }`. `code` / `message` / `retryable` are carried over so a
    // layerless error still reaches the logger with its own detail — but each
    // one only after the same `typeof` checks `asSerializedError` runs: the
    // second trigger means this branch fires precisely when the payload already
    // failed those checks, so an ill-typed value falls back (`code` to null,
    // `message` to `errorMessage`, `retryable` to absent) instead of riding a
    // type it does not honour into `AppServerError.serialized`.
    const source = serialized as Partial<
      Record<"code" | "message" | "retryable", unknown>
    >;
    return {
      kind: "unknown",
      code: typeof source.code === "string" ? source.code : null,
      message:
        typeof source.message === "string"
          ? source.message
          : errorMessage(error),
      ...(typeof source.retryable === "boolean"
        ? { retryable: source.retryable }
        : {}),
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
// once. The ordering is load-bearing twice over: a sparse messages array
// passes an in-place `every` (holes are skipped) but the spread materialises
// each hole as an `undefined` element, so validating the copy rejects it; and
// a getter / Proxy that answers differently per read never gets a second read,
// so the value validated is the value returned. `Object.entries` also drops
// symbol-keyed properties and the spread copies index elements only, which is
// what extends `asSerializedError`'s rebuild guarantee below the top level —
// an extra own property grafted onto a messages array does not survive.
// An own `"__proto__"` key (which `JSON.parse` materialises) is rejected
// outright: `rebuilt[field] = copy` would hit the `Object.prototype.__proto__`
// setter and swap the accumulator's prototype for the attacker-supplied array
// instead of adding a property, and rejecting leaves no ambiguous half-result
// the way a silently-dropped key would.
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

// The ledger of keys `asSerializedError` rebuilds from, pinned to the union:
// adding a field to any `SerializedError` variant — even an optional one,
// which the return type alone would let the rebuild silently strip — fails to
// compile here until this ledger names it. That is as far as the type's force
// reaches: naming a key does not make the function carry it, so the carry-over
// itself is pinned by the rebuild roundtrip cases in
// `__tests__/errorResponse.test.ts`, not by this `satisfies`.
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
 *
 * Because that class is an `Error` subclass, the guard also checks the minimal
 * `Error` shape — `message` is a string — for the same reason
 * `isRehydrationError` does: a bare branded object must not be narrowed into a
 * type that promises `message: string`. `name` and `stack` stay unchecked;
 * that residue rides on the brand.
 *
 * Limit: the payload is validated but **not rebuilt**, so the `serialized` the
 * narrowed type exposes is valid-but-not-minimal — undeclared keys may still
 * ride on it. Never read `.serialized` off a narrowed value directly (handing
 * it to `redactForClient` would reopen the unknown-key path its spread
 * closes); read it through {@link extractSerializedError} or
 * {@link asSerializedError}, which rebuild from known keys.
 */
export function isAppServerError(value: unknown): value is AppServerError {
  if (typeof value !== "object" || value === null) return false;
  if (!(APP_SERVER_ERROR_BRAND in value)) return false;
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
 *
 * Limit: `serializeError` fails closed on its own, but the remnant stage does
 * not — a caught value whose `serialized` accessor throws, or whose payload
 * carries a throwing getter, still throws out of here. The last-resort catch
 * for that exists only on the server-side classification path: `toClientError`
 * catches and lands on {@link UNVERIFIED_SERIALIZED_ERROR}. The client-side
 * callers (`errorDisplay`, the form-action catches) have no such backstop —
 * they rest on the values they catch being transport-decoded plain data,
 * which cannot carry a hostile accessor.
 */
export function extractSerializedError(error: unknown): SerializedError {
  if (hasSerializedRemnant(error)) {
    const structural = asSerializedError(error.serialized);
    if (structural !== null) return structural;
  }
  return serializeError(error);
}
