import { ConflictError } from "@repo/core/application/errors";

/** The one translation of a zero-row OCC update (`spec/database/index.md`). */
export function occConflict(): ConflictError {
  return new ConflictError(
    "OPTIMISTIC_LOCK_FAILURE",
    "The row was modified by another operation",
  );
}
