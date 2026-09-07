import type { EventDraft, EventId } from "@repo/core/domain/common/event";

/**
 * `enqueueEvent` — the single write path into `outbox_events`.
 *
 * The row is inserted in the same `transactionSync` as the business write
 * that produced it, which is the only way the two can be made atomic:
 * there is no dedicated Outbox DO because only the emitting DO's own
 * tables can commit together with the update that caused the event.
 *
 * **One event, one row, immutable — never converging.** Unlike
 * `jobs.operation_key`, an event id is not an identity that
 * re-submissions collapse onto: folding two occurrences into one row
 * would lose one delivery.
 *
 * Nine columns are written explicitly and four stay `NULL`
 * (`lease_until` / `owner_token` / `terminal_reason` / `completed_at`),
 * which is the 9 + 4 = 13 breakdown of the table. **`next_run_at` is set
 * to now rather than left `NULL`**: the Alarm's re-arm reads `min()`,
 * which skips NULLs, and the claim predicate is `next_run_at <= now`, so
 * a NULL row would be invisible to both while still counting as runnable
 * — the DO would keep waking and never move the row.
 *
 * Each draft is written in its own statement. Batching would have to stay
 * inside the 100 bind-parameter ceiling (nine bound columns means twelve
 * drafts already exceed it), and one statement per draft removes the
 * ceiling from the picture entirely.
 */
export function writeEnqueuedEvents(
  sql: SqlStorage,
  drafts: readonly EventDraft[],
  mintEventId: () => EventId,
  now: number,
): void {
  for (const draft of drafts) {
    sql.exec(
      `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
      mintEventId(),
      draft.type,
      JSON.stringify(draft.payload),
      draft.aggregateId,
      draft.occurredAt.getTime(),
      now,
      now,
    );
  }
}
