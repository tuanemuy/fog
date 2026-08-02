import {
  CodedError,
  type FieldErrors,
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

export abstract class ApplicationError<
  TCode extends string = string,
> extends CodedError<TCode> {
  override readonly name: string = "ApplicationError";
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

export class NotFoundError extends ApplicationError {
  override readonly name = "NotFoundError";

  override toSerialized(): SerializedNotFoundError {
    return {
      kind: "notFound",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

export class ConflictError extends ApplicationError {
  override readonly name = "ConflictError";

  override toSerialized(): SerializedConflictError {
    return {
      kind: "conflict",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isConflictError(error: unknown): error is ConflictError {
  return error instanceof ConflictError;
}

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

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

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

  override toSerialized(): SerializedUnauthorizedError {
    return {
      kind: "unauthorized",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isUnauthorizedError(
  error: unknown,
): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}

export class ForbiddenError extends ApplicationError {
  override readonly name = "ForbiddenError";

  override toSerialized(): SerializedForbiddenError {
    return {
      kind: "forbidden",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

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
  // The Durable Object refused the call because it is over capacity
  // (`.overloaded`). Not retryable at this layer: the caller-visible answer is
  // "try later", and an automatic retry here would add load to the thing that
  // is already saturated.
  ServiceOverloaded: "SERVICE_OVERLOADED",
  // The DO's SQLite store hit its size cap (`SQLITE_FULL`). Reads and DELETEs
  // still work, which is what keeps the recovery paths usable — so this is a
  // caller-visible signal, never a retry candidate.
  StorageCapacityExceeded: "STORAGE_CAPACITY_EXCEEDED",
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

export function isSystemError(error: unknown): error is SystemError {
  return error instanceof SystemError;
}
