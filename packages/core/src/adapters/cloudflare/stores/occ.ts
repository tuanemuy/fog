import { ConflictError } from "@repo/core/application/errors";

/** The one translation of a zero-row OCC update (`spec/database/index.md`). */
export function occConflict(): ConflictError {
  return new ConflictError(
    "OPTIMISTIC_LOCK_FAILURE",
    "The row was modified by another operation",
  );
}

/**
 * A `UNIQUE` / primary-key violation raised by the SQLite driver. The
 * revision tables' `(memo_id | document_id, revision_number)` uniqueness is
 * the last line of the history's linearity, and a hit on it is the same
 * signal as a zero-row OCC update: somebody else wrote first.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/.test(
    error.message,
  );
}
