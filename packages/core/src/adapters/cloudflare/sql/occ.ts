import { ConflictError } from "@repo/core/application/errors";
import { all, type Sql } from "./exec";

/**
 * Optimistic concurrency control for the DO stack: a conditional `UPDATE`
 * guarded on `version` whose matched-row count is read back from `RETURNING 1`.
 *
 * Zero matched rows is a caller-visible signal, not a retry candidate — there
 * is deliberately no application-level OCC retry decorator anywhere in the
 * codebase. The conflict travels out to the transport boundary unswallowed.
 */
export function conditionalUpdate(
  sql: Sql,
  query: string,
  bindings: readonly unknown[],
  subject: string,
): void {
  const rows = all(sql, query, ...bindings);
  if (rows.length === 0) {
    // `subject` names the aggregate, never a value from it: this message
    // reaches the transport boundary and logs.
    throw new ConflictError(
      "OPTIMISTIC_LOCK_FAILURE",
      `Optimistic lock failure while saving ${subject}`,
    );
  }
}
