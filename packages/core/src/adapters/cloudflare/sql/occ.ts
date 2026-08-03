import { ConflictError } from "@repo/core/application/errors";
import { all, type Sql } from "./exec";

/**
 * Optimistic concurrency control for the DO stack: a conditional `UPDATE`
 * guarded on `version` whose matched-row count is read back from `RETURNING 1`.
 *
 * Zero matched rows is a caller-visible signal, not a retry candidate — there
 * is deliberately no application-level OCC retry decorator anywhere in the
 * codebase. The conflict travels out to the transport boundary unswallowed.
 *
 * **"The row is gone" and "the version has moved on" are deliberately the same
 * answer here**, and they are not distinguished by a second read. Both mean the
 * caller's `Versioned<T>` no longer describes storage, both are resolved the
 * same way (re-read and retry from the top), and separating them would cost an
 * extra statement to publish a distinction with no caller. What the design
 * forbids is *misattribution* — reading some other statement's matched-row
 * count as this one's — which the per-statement `RETURNING 1` is what rules
 * out. `userData/__tests__/occ.integration.test.ts` pins both halves.
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
