import {
  backoffDelayMs,
  type DeliveryTuning,
} from "@repo/core/application/delivery/tuning";
import type { Logger } from "@repo/core/application/ports/logger";
import type { OutboxQueueMessage } from "./queueMessage";
import {
  claimRows,
  failureLabel,
  finalizeRow,
  OUTBOX_TABLE,
  releaseWithBackoff,
} from "./rowRunner";

const PUBLISH_FAILED = "Publish failed";

export type OutboxRow = Readonly<{
  id: string;
  type: string;
  payload: string;
  aggregate_id: string;
  occurred_at: number;
  created_at: number;
  attempt: number;
  next_run_at: number | null;
  status: string;
  lease_until: number | null;
  owner_token: string | null;
  terminal_reason: string | null;
  completed_at: number | null;
}>;

/** The one Queue capability the relay needs. */
export type EventsQueue = Readonly<{
  send(message: OutboxQueueMessage): Promise<unknown>;
}>;

export type RelayPassOptions = Readonly<{
  storage: DurableObjectStorage;
  queue: EventsQueue;
  /** `_meta.self_locator` — the emitting DO's own locator. */
  routingKey: string;
  tuning: DeliveryTuning;
  now: number;
  logger: Logger;
}>;

/**
 * One relay pass: claim, publish, finalize — three phases, with **only**
 * the publish outside a transaction.
 *
 * The Alarm is the relay's trigger, not a substitute for the Outbox: no
 * external I/O may happen inside a transaction, and `transactionSync`
 * cannot call `fetch` at all, so claiming in one transaction, publishing
 * outside it and finalizing in a second is the only available shape. The
 * gap between phases 2 and 3 is exactly where at-least-once comes from —
 * a DO reset there leaves the row to be re-claimed once its lease expires
 * and published again.
 *
 * **Phases 2 and 3 therefore fail differently and are caught separately.**
 * `quarantined` is defined for a row the relay could not publish; once
 * `send()` has returned, the message is on the Queue and the row is no
 * longer a publish failure. Treating a failed phase 3 as one would advance
 * `attempt` and, at the ceiling, quarantine a row whose message is already
 * in flight — and the send-materials call guard would then answer
 * `nothing-to-send`, so that event's mail would never arrive. A phase 3
 * that throws writes nothing at all: the row stays `publishing` and its
 * lease expiry re-claims it, which is the same recovery a DO reset in that
 * gap takes. The re-publish is inside at-least-once and every consumer is
 * idempotent on `event.id`.
 *
 * **Phase 2 publishes row by row with `send()`; `sendBatch` is not used.**
 * `sendBatch` is all-or-nothing, so one message that trips a limit would
 * advance `attempt` on every row claimed in that wake-up, and the per-row
 * failure isolation the spec requires becomes unreachable. The relay's
 * count limit already bounds the pass, so N round trips are accepted.
 * There is likewise no terminal branch for the per-message size limit: no
 * row the normal write path produces can assemble a message that reaches
 * it, and per-row backoff into `quarantined` absorbs one that did.
 *
 * Per row, failures are caught: one row that cannot be published must not
 * stop the other deliveries and must not escape `alarm()`.
 */
export async function runRelayPass(options: RelayPassOptions): Promise<void> {
  const { storage, queue, tuning, now, logger } = options;

  const claimed = claimRows<OutboxRow>(storage, OUTBOX_TABLE, {
    now,
    limit: tuning.relayMaxRowsPerPass,
    leaseMs: tuning.relayLeaseMs,
  });

  for (const { row, ownerToken } of claimed) {
    try {
      await queue.send({
        eventId: row.id,
        type: row.type,
        payload: JSON.parse(row.payload) as unknown,
        routingKey: options.routingKey,
        ownerToken,
      });
    } catch (error) {
      // The allow-list for logs is `event.id` and `type`. The message as
      // a whole never goes to a log, and `owner_token` never does; the
      // failure itself goes through `failureLabel`.
      logger.error("Outbox publish failed", {
        eventId: row.id,
        type: row.type,
        cause: failureLabel(error, PUBLISH_FAILED),
      });
      try {
        const matched = storage.transactionSync(() =>
          applyPublishFailure(storage, row, ownerToken, error, now, tuning),
        );
        if (!matched) warnLostLease(logger, row);
      } catch (bookkeepingError) {
        logger.error("Failed to record outbox publish failure", {
          eventId: row.id,
          type: row.type,
          cause: failureLabel(bookkeepingError, "Bookkeeping failed"),
        });
      }
      continue;
    }

    try {
      const matched = storage.transactionSync(() =>
        finalizeRow(
          storage.sql,
          OUTBOX_TABLE,
          row.id,
          ownerToken,
          "completed",
          now,
          null,
        ),
      );
      if (!matched) warnLostLease(logger, row);
    } catch (error) {
      logger.error("Failed to record outbox publish", {
        eventId: row.id,
        type: row.type,
        cause: failureLabel(error, "Bookkeeping failed"),
      });
    }
  }
}

/**
 * The claim token has been taken over by a later claim, so the CAS wrote
 * nothing.
 */
function warnLostLease(logger: Logger, row: OutboxRow): void {
  logger.warn("Outbox bookkeeping matched no row", {
    eventId: row.id,
    type: row.type,
  });
}

function applyPublishFailure(
  storage: DurableObjectStorage,
  row: OutboxRow,
  ownerToken: string,
  error: unknown,
  now: number,
  tuning: DeliveryTuning,
): boolean {
  const nextAttempt = row.attempt + 1;
  if (nextAttempt < tuning.relayMaxAttempts) {
    return releaseWithBackoff(
      storage.sql,
      OUTBOX_TABLE,
      row.id,
      ownerToken,
      nextAttempt,
      now +
        backoffDelayMs(
          nextAttempt,
          tuning.relayBackoffBaseMs,
          tuning.relayBackoffMaxDelayMs,
        ),
    );
  }
  return finalizeRow(
    storage.sql,
    OUTBOX_TABLE,
    row.id,
    ownerToken,
    "failed",
    now,
    failureLabel(error, PUBLISH_FAILED),
  );
}
