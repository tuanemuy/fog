import {
  CodedError,
  type FieldErrors,
  hasSerializedKind,
  isCodedError,
  type SerializedErrorBase,
} from "@repo/core/lib/error";

export type { FieldErrors } from "@repo/core/lib/error";

export type SerializedNotFoundError = SerializedErrorBase & {
  kind: "notFound";
};

export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  fieldErrors?: FieldErrors;
};

export type SerializedConflictError = SerializedErrorBase & {
  kind: "conflict";
};

export type SerializedUnauthorizedError = SerializedErrorBase & {
  kind: "unauthorized";
};

export type SerializedForbiddenError = SerializedErrorBase & {
  kind: "forbidden";
};

export type SerializedSystemError = SerializedErrorBase & {
  kind: "system";
};

/**
 * Brand of its own rather than a `serializedKind` match: `ApplicationError` is
 * an abstract layer boundary, not one serialized kind, and its subclasses each
 * report a different `serializedKind`.
 */
const APPLICATION_ERROR_BRAND: unique symbol = Symbol.for(
  "@repo/core/ApplicationError",
);

export abstract class ApplicationError<
  TCode extends string = string,
> extends CodedError<TCode> {
  override readonly name: string = "ApplicationError";
  readonly [APPLICATION_ERROR_BRAND] = true as const;
}

/**
 * Narrows to the application layer's own errors only. `BusinessRuleError` is a
 * `CodedError` but not an `ApplicationError`, so it answers `false` here; use
 * `isCodedError` when the question is "already translated into the shared error
 * contract" regardless of layer.
 *
 * `isCodedError` plus the layer brand, not the brand alone: the brand answers
 * only which layer minted the value, while the narrowed type promises the whole
 * `CodedError` contract, and the contract check is what keeps a bare
 * `{ [brand]: true }` object from passing. Same limit as every registry brand —
 * a forgery satisfying both is indistinguishable from the real thing.
 */
export function isApplicationError(error: unknown): error is ApplicationError {
  return isCodedError(error) && APPLICATION_ERROR_BRAND in error;
}

/**
 * What a per-kind guard narrows to: the shared error contract plus the one
 * `serializedKind` that was matched. Deliberately not a concrete class —
 * `serializedKind` is many-to-one (`ValidationError` and the presentation
 * layer's `InputValidationError` both report `"validation"`), so class identity
 * cannot be derived from it for any kind. Today only `validation` has two
 * classes, but nothing in the type system, the linter or the tests keeps the
 * others at one, and the failure mode of that changing is a silent unsound
 * narrowing.
 *
 * `toSerialized` is removed from `CodedError` rather than intersected over it:
 * an intersection keeps both method signatures and overload resolution picks
 * the base one, so `toSerialized()` would still return the wide
 * `SerializedErrorBase & { kind: string }` and this half of the narrowing would
 * be inert. Everything else `CodedError` carries — including its symbol-keyed
 * brand, which is what stops an outside object literal from claiming this type
 * — survives the `Omit`.
 *
 * The runtime behind this type checks `serializedKind === kind` and nothing
 * more; that `toSerialized()` really returns `TSerialized` is unverified. It
 * holds today only because every `Serialized*Error` adds nothing but optional
 * properties to `SerializedErrorBase & { kind }`. Give any variant a required
 * field and this type starts lying with no compile error to show for it.
 */
type NarrowedByKind<
  TSerialized extends SerializedErrorBase & { kind: string },
> = Omit<CodedError, "toSerialized"> & {
  readonly serializedKind: TSerialized["kind"];
  toSerialized(): TSerialized;
};

/**
 * Builds a per-kind guard so every one of them is generated from the same
 * shape rather than hand-written.
 *
 * Taking the kind as `TSerialized["kind"]` is also what enforces
 * `hasSerializedKind`'s calling convention: its own `TKind extends string`
 * accepts any string, so a typo would compile into a guard that is always
 * `false`. Here it is a compile error.
 */
function kindGuard<TSerialized extends SerializedErrorBase & { kind: string }>(
  kind: TSerialized["kind"],
): (error: unknown) => error is NarrowedByKind<TSerialized> {
  return (error): error is NarrowedByKind<TSerialized> =>
    hasSerializedKind(error, kind);
}

export class NotFoundError extends ApplicationError {
  override readonly name = "NotFoundError";
  readonly serializedKind: SerializedNotFoundError["kind"] = "notFound";

  override toSerialized(): SerializedNotFoundError {
    return {
      kind: "notFound",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isNotFoundError = kindGuard<SerializedNotFoundError>("notFound");

export class ConflictError extends ApplicationError {
  override readonly name = "ConflictError";
  readonly serializedKind: SerializedConflictError["kind"] = "conflict";

  override toSerialized(): SerializedConflictError {
    return {
      kind: "conflict",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isConflictError = kindGuard<SerializedConflictError>("conflict");

/**
 * Input / credential verification failure raised by a usecase.
 *
 * Distinct from `BusinessRuleError` (a domain invariant was violated) and
 * from the presentation layer's `InputValidationError` (the transport
 * payload did not match its shape schema). Use this when a usecase
 * deliberately collapses several verification outcomes into one
 * indistinguishable answer — `loginWithPassword` reporting
 * `INVALID_CREDENTIALS` whether the email was malformed, the account is
 * absent, or the password did not match.
 *
 * Shares `kind: "validation"` (and therefore HTTP 422) with
 * `InputValidationError`; `fieldErrors` is optional so usecase-level
 * failures that name no field use the same serialized shape.
 */
export class ValidationError extends ApplicationError {
  override readonly name = "ValidationError";
  readonly serializedKind: SerializedValidationError["kind"] = "validation";

  constructor(
    code: string,
    message: string,
    private readonly fieldErrors?: FieldErrors,
    cause?: unknown,
  ) {
    super(code, message, cause);
  }

  override toSerialized(): SerializedValidationError {
    return {
      kind: "validation",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.fieldErrors !== undefined
        ? { fieldErrors: this.fieldErrors }
        : {}),
    };
  }
}

/**
 * The kind with two producers today: the presentation layer's
 * `InputValidationError` reports the same `serializedKind` and is not a
 * `ValidationError`, so a match here says "a validation failure crossed the
 * contract", never which class raised it.
 */
export const isValidationError =
  kindGuard<SerializedValidationError>("validation");

/**
 * Authorization failures raised by usecases. Distinguished into two kinds:
 * - `UnauthorizedError` — the actor is not authenticated (no / invalid
 *   credentials). Maps to HTTP 401 at the transport boundary.
 * - `ForbiddenError` — the actor is authenticated but lacks permission for
 *   the requested resource / operation. Maps to HTTP 403.
 *
 * These live in the application layer (not presentation) because the
 * decision is a business-rule judgment ("this actor cannot touch this
 * aggregate") that usecases need to throw directly. The HTTP status mapping
 * is a pure transport concern owned by the presentation layer.
 */
export class UnauthorizedError extends ApplicationError {
  override readonly name = "UnauthorizedError";
  readonly serializedKind: SerializedUnauthorizedError["kind"] = "unauthorized";

  override toSerialized(): SerializedUnauthorizedError {
    return {
      kind: "unauthorized",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isUnauthorizedError =
  kindGuard<SerializedUnauthorizedError>("unauthorized");

export class ForbiddenError extends ApplicationError {
  override readonly name = "ForbiddenError";
  readonly serializedKind: SerializedForbiddenError["kind"] = "forbidden";

  override toSerialized(): SerializedForbiddenError {
    return {
      kind: "forbidden",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isForbiddenError =
  kindGuard<SerializedForbiddenError>("forbidden");

/**
 * Codes for unrecoverable system faults surfaced by adapters.
 * Add a new entry per external resource you integrate; include it in
 * `RETRYABLE_SYSTEM_CODES` below if the failure is transient.
 *
 * Distinguish driver failures (`DatabaseError`) from data-integrity failures
 * (`DataIntegrityError`): the former is "the storage layer threw" (connection
 * dropped, lock timeout exhausted), the latter is "stored data violates the
 * shape we expect" (corrupt row, schema-skewed payload, malformed id). They
 * share `kind: "system"` for transport but separate codes so logs / alerts
 * can route them differently — a flood of `DataIntegrityError` means a
 * migration is broken, not the DB itself.
 *
 * `NetworkError` / `ExternalApiError` are template-only placeholders showing
 * the extension shape — no code throws them today. Delete them when you add
 * your first external adapter, or keep as reference.
 */
export const SystemErrorCode = {
  DatabaseError: "DATABASE_ERROR",
  DataIntegrityError: "DATA_INTEGRITY_ERROR",
  // The crypto subsystem (WebCrypto) refused to compute — key import or
  // derivation threw. Kept apart from `DataIntegrityError`, which is what
  // a *stored* hash in an unreadable encoding raises.
  CryptoError: "CRYPTO_ERROR",
  // Writing or clearing the session cookie failed. Deliberately not
  // `DatabaseError`: routing "the storage layer threw" and "the response
  // header could not be written" to the same alert makes the former
  // unreadable. Not retryable — a second attempt writes the same header
  // into the same broken response.
  SessionError: "SESSION_ERROR",
  NetworkError: "NETWORK_ERROR",
  ExternalApiError: "EXTERNAL_API_ERROR",
} as const;
export type SystemErrorCode =
  (typeof SystemErrorCode)[keyof typeof SystemErrorCode];

const RETRYABLE_SYSTEM_CODES: ReadonlySet<SystemErrorCode> =
  new Set<SystemErrorCode>([
    SystemErrorCode.NetworkError,
    SystemErrorCode.ExternalApiError,
  ]);

export class SystemError extends ApplicationError<SystemErrorCode> {
  override readonly name = "SystemError";
  readonly serializedKind: SerializedSystemError["kind"] = "system";

  override get retryable(): boolean {
    return RETRYABLE_SYSTEM_CODES.has(this.code);
  }

  override toSerialized(): SerializedSystemError {
    return {
      kind: "system",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isSystemError = kindGuard<SerializedSystemError>("system");
