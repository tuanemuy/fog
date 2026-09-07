import { isCodedError } from "@repo/core/lib/error";

/**
 * Describes one of the two tables the Alarm multiplexes so the runner
 * logic can be shared between them.
 *
 * `spec/database/index.md` states that the conventions the two tables
 * hold in common — the Alarm schedule, backoff, leasing and pruning — are
 * implemented once for both, and that **two** conventions are separated,
 * which is the whole of the divergence:
 *
 *  1. **Identity and convergence.** `jobs` converges on `operation_key`
 *     and carries three convergence rules; `outbox_events` is one event,
 *     one row, immutable, and converges never. That difference lives in
 *     `stores/jobWriter.ts`, not here.
 *  2. **Which columns go `NULL` at termination.** `jobs` nulls all three
 *     of `lease_until` / `owner_token` / `next_run_at`;
 *     `outbox_events` nulls only two and **keeps `owner_token`**, because
 *     the send-materials call guard compares against it after the row has
 *     terminated. Dropping it would make that guard fail for every
 *     `published` row and take the whole normal delivery path with it.
 *     That difference is {@link RowTableDescriptor.clearsOwnerTokenOnTerminal}.
 *
 * The status vocabularies differ in spelling only (`published` means
 * "handed to the Queue", not "processed"), and no difference in pruning
 * follows from it: both tables prune the normally-completed side and keep
 * the abnormal one forever.
 *
 * Table names, column names **and the leased status literal** are
 * interpolated into SQL. They come from this closed descriptor and never
 * from input, which is what keeps that safe. **What carries that safety is
 * the literal unions below, not a runtime check** — there is none, and
 * none is wanted: widening any of those three to `string` would let a
 * value that never passed through this file reach a statement, so such a
 * change breaks the reason interpolation is allowed at the same moment it
 * is made. `completedStatus` and `failedStatus` are passed as bind
 * parameters everywhere they are used, so they carry none of that.
 */
export type RowTableDescriptor = Readonly<{
  table: "jobs" | "outbox_events";
  keyColumn: "operation_key" | "id";
  leasedStatus: "running" | "publishing";
  completedStatus: "done" | "published";
  failedStatus: "poison" | "quarantined";
  clearsOwnerTokenOnTerminal: boolean;
}>;

export const JOBS_TABLE: RowTableDescriptor = {
  table: "jobs",
  keyColumn: "operation_key",
  leasedStatus: "running",
  completedStatus: "done",
  failedStatus: "poison",
  clearsOwnerTokenOnTerminal: true,
};

export const OUTBOX_TABLE: RowTableDescriptor = {
  table: "outbox_events",
  keyColumn: "id",
  leasedStatus: "publishing",
  completedStatus: "published",
  failedStatus: "quarantined",
  clearsOwnerTokenOnTerminal: false,
};

export type ClaimedRow<TRow> = Readonly<{ row: TRow; ownerToken: string }>;

const FAILURE_LABEL_MAX_LENGTH = 120;

/**
 * The one shape a thrown value takes when it reaches `terminal_reason` or
 * a runner's log.
 *
 * Both destinations are named by the hygiene rule in
 * `spec/async/index.md` — neither PII nor a reusable secret goes into a
 * log or a `terminalReason` — and a `poison` / `quarantined` row is
 * retained until an operator acts, so whatever lands there lands there for
 * good. An error's `message` is written by whoever threw it: a mail
 * provider's SDK routinely puts the rejected request in it, which is the
 * recipient and the raw token. It is therefore never taken.
 *
 * What is taken is code-owned: a `CodedError`'s `code`, otherwise the
 * error's constructor name, otherwise `fallback`. The length cap holds the
 * rule even if a `code` is ever built from something wider than the closed
 * vocabularies of today.
 */
export function failureLabel(error: unknown, fallback: string): string {
  const label = isCodedError(error)
    ? error.code
    : error instanceof Error
      ? error.name
      : null;
  const chosen = label === null || label.length === 0 ? fallback : label;
  return chosen.slice(0, FAILURE_LABEL_MAX_LENGTH);
}

/**
 * Mints one claim token: 128 bits from a CSPRNG, hex-encoded.
 *
 * For `outbox_events` this value is a **per-claim, per-row capability**,
 * not merely an execution-owner identifier: whoever holds
 * `(event.id, owner_token)` can make the send-materials RPC answer
 * `send`. Sharing one value across the rows of a single wake-up would let
 * a token recovered from one DLQ message unlock the other rows of that
 * batch, since `event.id` travels through the Queue and the DLQ as well.
 * Derivation from time, a counter or the DO's identity is likewise
 * excluded — a derivable value can be guessed through the guard.
 */
export function newOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ClaimOptions = Readonly<{
  now: number;
  limit: number;
  leaseMs: number;
}>;

/**
 * Issues one conditional `UPDATE` and answers whether it matched a row.
 *
 * This is the form `spec/database/index.md` names for reading a
 * conditional update's outcome: the returned rows are what says whether
 * anything matched, because the semantics then close inside the statement
 * itself. `changes()` is the second choice and the billing counter
 * `rowsWritten` — which counts index writes as well — is excluded
 * outright.
 *
 * The statement is appended to, so callers pass one without a `RETURNING`
 * clause of their own.
 */
export function updateMatchedRow(
  sql: SqlStorage,
  statement: string,
  ...bindings: SqlStorageValue[]
): boolean {
  return (
    sql
      .exec<{ matched: number }>(
        `${statement} RETURNING 1 AS matched`,
        ...bindings,
      )
      .toArray().length > 0
  );
}

/**
 * The candidate `SELECT` {@link claimRows} issues, as text.
 *
 * **Exported so the plan assertion measures the statement this module
 * actually issues.** A copy in the test would go on being measured after
 * the body moved on, reporting the plan of a statement nobody runs — which
 * is the failure the assertion exists to rule out. That there is a single
 * call site is not a reason to make it internal.
 */
export function claimCandidatesQuery(descriptor: RowTableDescriptor): string {
  return `SELECT * FROM ${descriptor.table}
         WHERE status IN ('pending', '${descriptor.leasedStatus}') AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`;
}

/**
 * Claims up to `limit` runnable rows inside one `transactionSync`.
 *
 * The selection is the **runnable set** (`status` alone) intersected with
 * `next_run_at <= now`, ordered by `next_run_at` ascending. The time
 * predicate belongs to the selection and not to the set definition:
 * leaving it out silently disables backoff, because the CAS below looks
 * only at `status` and `lease_until`.
 *
 * The order is a real sort, not index order. `*_runnable_idx` is
 * `(status, next_run_at)`, so index order puts every `pending` row ahead
 * of every lease-expired leased row; while `pending` rows keep arriving,
 * the rows left behind by a DO reset would starve at the back forever.
 * The cost of that sort is accepted because the ordering is what prevents
 * the starvation — the opposite trade-off from the Alarm re-arm, which was
 * decomposed to keep each statement inside a single `status` group.
 *
 * `UPDATE ... LIMIT` is not used: it needs a SQLite build compiled with
 * `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which the DO's SQLite does not
 * promise. Rows are claimed one CAS statement at a time instead, and a
 * statement that matches zero rows means somebody else holds it.
 *
 * **The second disjunct must name the leased status.** Without it, a
 * `done` / `poison` row still carrying a past `lease_until` would come
 * back into scope for claiming.
 *
 * **The leased status is spelled as a literal, not bound.** SQLite decides
 * a partial index is usable by matching the statement's terms against the
 * index predicate syntactically; a bind parameter proves nothing about the
 * value it will hold, so `status IN ('pending', ?)` cannot satisfy
 * `*_runnable_idx`'s `status IN ('pending','<leasedStatus>')` and the
 * planner falls back to `*_completed_idx` — a seek to a status group, with
 * `next_run_at` demoted from an index constraint to a residual filter.
 * Nothing throws when that happens and the same rows come back in the same
 * order, so **the only thing that notices is the `EXPLAIN QUERY PLAN`
 * assertion in `__tests__/rowRunner.integration.test.ts`.** The CAS below
 * keeps its `status = ?` bind: it seeks by primary key, so no index choice
 * turns on it.
 */
export function claimRows<TRow extends Record<string, SqlStorageValue>>(
  storage: DurableObjectStorage,
  descriptor: RowTableDescriptor,
  options: ClaimOptions,
): ClaimedRow<TRow>[] {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const candidates = sql
      .exec<TRow>(claimCandidatesQuery(descriptor), options.now, options.limit)
      .toArray();

    const claimed: ClaimedRow<TRow>[] = [];
    for (const row of candidates) {
      const key = row[descriptor.keyColumn];
      const ownerToken = newOwnerToken();
      const matched = updateMatchedRow(
        sql,
        `UPDATE ${descriptor.table} SET status = ?, lease_until = ?, owner_token = ?
         WHERE ${descriptor.keyColumn} = ?
           AND (status = 'pending' OR (status = ? AND lease_until < ?))`,
        descriptor.leasedStatus,
        options.now + options.leaseMs,
        ownerToken,
        key,
        descriptor.leasedStatus,
        options.now,
      );
      if (!matched) continue;
      claimed.push({ row, ownerToken });
    }
    return claimed;
  });
}

/**
 * Failure below the attempt ceiling: back to `pending` in one statement,
 * advancing `attempt` and pushing `next_run_at` out by backoff while
 * releasing `lease_until` and `owner_token`.
 *
 * **The row does not stay leased with only `next_run_at` moved.** The
 * Alarm's invariant on leased rows is `next_run_at <= lease_until`;
 * breaking it makes the four-way minimum count the row by `lease_until`
 * and wake for nothing, over and over.
 *
 * For `outbox_events` the release of `owner_token` also closes a window:
 * whatever message that attempt may have put on the Queue loses its
 * bearer token immediately, so a consumer holding the old pair falls
 * through to `nothing-to-send`. The row itself is re-claimed and
 * re-published, so no delivery is lost.
 *
 * **Returns whether the CAS matched.** Zero rows means somebody else
 * holds the row now, so nothing was written; the caller reports it rather
 * than reading the write as done.
 */
export function releaseWithBackoff(
  sql: SqlStorage,
  descriptor: RowTableDescriptor,
  key: SqlStorageValue,
  ownerToken: string,
  attempt: number,
  nextRunAt: number,
): boolean {
  return updateMatchedRow(
    sql,
    `UPDATE ${descriptor.table}
     SET status = 'pending', attempt = ?, next_run_at = ?, lease_until = NULL, owner_token = NULL
     WHERE ${descriptor.keyColumn} = ? AND owner_token = ?`,
    attempt,
    nextRunAt,
    key,
    ownerToken,
  );
}

/**
 * Releases a row that hit the chunk-iteration ceiling. `attempt` is
 * untouched because nothing failed. The released row is not re-claimed in
 * the same wake-up — allowing that would make the ceiling meaningless.
 *
 * **The progress made so far has to be written into the transaction this
 * statement runs in**, which is the caller's to arrange: `runJobsPass`
 * does it by running the handler's `commit` closure immediately before
 * this call, inside the same `transactionSync`.
 *
 * Returns whether the CAS matched, on the same terms as
 * {@link releaseWithBackoff}.
 */
export function releaseForNextWakeUp(
  sql: SqlStorage,
  descriptor: RowTableDescriptor,
  key: SqlStorageValue,
  ownerToken: string,
  nextRunAt: number,
): boolean {
  return updateMatchedRow(
    sql,
    `UPDATE ${descriptor.table}
     SET status = 'pending', next_run_at = ?, lease_until = NULL, owner_token = NULL
     WHERE ${descriptor.keyColumn} = ? AND owner_token = ?`,
    nextRunAt,
    key,
    ownerToken,
  );
}

/**
 * Terminates a row, CAS'd on the claim token so a re-claim cannot be
 * clobbered. `completed_at` is written on both terminal statuses —
 * `next_run_at` cannot stand in for it, since backoff pushes that one
 * into the future.
 *
 * Returns whether the CAS matched. A terminal write that matched nothing
 * is the one the guarantee turns on: the row is now leased by a later
 * claim, and reading the write as a completion would report work as
 * finished that no row records.
 */
export function finalizeRow(
  sql: SqlStorage,
  descriptor: RowTableDescriptor,
  key: SqlStorageValue,
  ownerToken: string,
  status: "completed" | "failed",
  now: number,
  terminalReason: string | null,
): boolean {
  const nextStatus =
    status === "completed"
      ? descriptor.completedStatus
      : descriptor.failedStatus;
  const assignments = [
    "status = ?",
    "completed_at = ?",
    "terminal_reason = COALESCE(?, terminal_reason)",
    "lease_until = NULL",
    "next_run_at = NULL",
    ...(descriptor.clearsOwnerTokenOnTerminal ? ["owner_token = NULL"] : []),
  ].join(", ");
  return updateMatchedRow(
    sql,
    `UPDATE ${descriptor.table} SET ${assignments}
     WHERE ${descriptor.keyColumn} = ? AND owner_token = ?`,
    nextStatus,
    now,
    terminalReason,
    key,
    ownerToken,
  );
}

/**
 * Deletes normally-completed rows past their retention, bounded by count.
 *
 * The abnormal side (`poison` / `quarantined`) is never touched: those
 * rows are the only record of what went wrong and are exactly what the
 * operator re-drive entries act on, so a retention window that removed
 * them would leave the residue without the record of it. What bounds
 * their lifetime is an operator's response time, not a setting, which is
 * why it cannot be written as an inequality between retention values.
 *
 * `DELETE ... LIMIT` is avoided for the same build-flag reason as
 * `UPDATE ... LIMIT`; the subquery's `LIMIT` consumes no bind parameter
 * per row, so the 100-parameter ceiling is not in play.
 *
 * **Nothing is returned.** The only count on offer is `rowsWritten`, which
 * bills index writes as well as row deletions, so it is not the number of
 * rows deleted and would be read as one the moment it were returned.
 */
export function pruneCompleted(
  sql: SqlStorage,
  descriptor: RowTableDescriptor,
  completedBefore: number,
  limit: number,
): void {
  sql.exec(
    `DELETE FROM ${descriptor.table}
     WHERE ${descriptor.keyColumn} IN (
       SELECT ${descriptor.keyColumn} FROM ${descriptor.table}
       WHERE status = ? AND completed_at < ?
       ORDER BY completed_at LIMIT ?
     )`,
    descriptor.completedStatus,
    completedBefore,
    limit,
  );
}
