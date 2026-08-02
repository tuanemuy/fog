import {
  ApplicationError,
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";

/**
 * Translation table for failures raised *inside* a Durable Object by
 * `SqlStorage`. This is one of the two translation points in the DO stack;
 * the other is `platform/stubErrors.ts`, which handles failures raised by the
 * stub call itself on the caller's side.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function translateSqliteError(error: unknown): never {
  // Errors we raised ourselves (OCC conflicts, integrity assertions) pass
  // straight through — re-translating them would collapse distinctions the
  // caller is meant to see.
  if (error instanceof ApplicationError) {
    throw error;
  }

  const message = messageOf(error);

  if (message.includes("SQLITE_FULL")) {
    throw new SystemError(
      SystemErrorCode.StorageCapacityExceeded,
      "Durable Object storage is full",
      error,
    );
  }

  if (
    message.includes("SQLITE_CONSTRAINT_UNIQUE") ||
    message.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    throw new ConflictError(
      "UNIQUE_VIOLATION",
      "Unique constraint violated",
      error,
    );
  }

  if (message.includes("SQLITE_CONSTRAINT_FOREIGNKEY")) {
    throw new ConflictError(
      "FOREIGN_KEY_VIOLATION",
      "Foreign key constraint violated",
      error,
    );
  }

  if (message.includes("SQLITE_CONSTRAINT")) {
    throw new ConflictError(
      "CONSTRAINT_VIOLATION",
      "Constraint violated",
      error,
    );
  }

  throw new SystemError(
    SystemErrorCode.DatabaseError,
    "Durable Object storage query failed",
    error,
  );
}
