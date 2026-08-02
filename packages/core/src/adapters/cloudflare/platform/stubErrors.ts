import { SystemError, SystemErrorCode } from "@repo/core/application/errors";

/**
 * Translation for failures raised by the *stub call itself* — the Durable
 * Object was unreachable, was evicted mid-call, or refused the request. These
 * never enter the value envelope (the DO never ran), so the calling adapter
 * has to fold them into the same `SerializedError` shape separately.
 *
 * Nothing here maps to `ConflictError`: a 409 tells the client "your request
 * conflicted with another one, resubmit with fresh state", which is a lie when
 * the DO simply could not be reached.
 */

function isOverloaded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "overloaded" in error &&
    (error as { overloaded: unknown }).overloaded === true
  );
}

export function translateStubError(error: unknown): never {
  if (isOverloaded(error)) {
    throw new SystemError(
      SystemErrorCode.ServiceOverloaded,
      "Durable Object is overloaded",
      error,
    );
  }

  throw new SystemError(
    SystemErrorCode.DatabaseError,
    "Durable Object call failed",
    error,
  );
}
