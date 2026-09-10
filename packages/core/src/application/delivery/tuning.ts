import { SystemError, SystemErrorCode } from "../errors";

/**
 * Every operational value the delivery machinery reads, in one place.
 *
 * **The values are settled, but not all by the same kind of reason.**
 * Four kinds recur, and they are neither exhaustive nor disjoint: a
 * platform ceiling this module records (the bind-parameter budget behind
 * `jobsMaxRowsPerChunk`, which is SQLite's own, and the three queue
 * ceilings, which are read off the local broker and unverified against
 * the production Queue); participation in a
 * constraint {@link createDeliveryTuning} enforces
 * (`queueMaxRetryPeriodMs`, `dlqRetentionMs`, `resetTokenTtlMs`,
 * `publishedRetentionMs` — a check bounds those four, it does not choose
 * them, and today's declarations clear their bounds with room to spare);
 * a copy of a real queue-consumer setting (the paragraph below); and, for
 * tiers 1 and 2 of the three-tier job bound, one past measurement — the
 * 3.4 ms per 1,000 rows recorded on #37, costed against the row count a
 * wake-up may touch, with the arithmetic in `docs/runtime_cloudflare.md`.
 * **A value matching none of them is a judgement about the shape the
 * machinery has to have, not a derivation**, and what each such value was
 * chosen for is in chapter 12 of that runbook, row by row.
 *
 * **What has not happened is a spike on a real workload**, and it cannot:
 * no `jobs.kind` handler is registered yet, so there is nothing whose
 * per-wake-up cost could be timed. `spec/database/index.md` makes that
 * the trigger — the spike runs once the first handler lands, and tiers 1
 * and 2 are the values to revisit then (tier 3 is the bind ceiling and
 * moves only with SQLite).
 *
 * **What the count limits do not bound.** The claim `SELECT` scans the
 * runnable set and sorts the part of it that is due; neither is bounded
 * by `jobsMaxJobsPerPass` or `relayMaxRowsPerPass`, which cap only how
 * many rows are taken from the result. A DO with a large backlog pays
 * that on every wake-up, and re-arming the Alarm as index seeks does not
 * change it. The rationale for accepting the sort (it is what stops rows
 * left behind by a DO reset from starving) is in
 * `spec/database/index.md`, and the operational consequence is recorded
 * in `docs/runtime_cloudflare.md`.
 *
 * **Where a declared value meets the real setting.** `eventsMaxRetries`,
 * `eventsMaxBatchTimeoutMs` and `dlqMaxRetries` also appear in the request
 * Worker's wrangler config — the first two as the events consumer's
 * `max_retries` / `max_batch_timeout`, the third as the **DLQ consumer's
 * own `max_retries`**, a separate consumer block. The agreement between
 * the declarations and the config is held by
 * `apps/web/app/worker/cloudflare/__tests__/wranglerConfig.test.ts`,
 * which compares the four declarations against every request-Worker
 * config in the repository — the local `wrangler.toml` and both deploy
 * templates. `eventsRetryDelayMs` is the counterpart of that consumer's
 * `retry_delay`, which the config leaves unset today; the declared `0` is
 * the value the derivation below assumes for it, and the same test reads
 * the absent key as `0`, so a config that starts setting `retry_delay`
 * turns the suite red until this one moves with it. `dlqRetentionMs` corresponds to the Queue's
 * `message_retention_period`, which is **not** a wrangler config key at
 * all — it is a Queue-resource setting reachable only through `wrangler
 * queues create/update --message-retention-period-secs`
 * (`@pulumi/cloudflare`'s `QueueArgs` takes `accountId` / `name` and
 * nothing else), so that one is an out-of-band operational step — it is
 * carried in the deploy templates' headers and in
 * `docs/runtime_cloudflare.md`, and nothing here can observe whether it
 * was run.
 *
 * **`queueMaxRetryPeriodMs` has no config key of its own.** No wrangler
 * or Queue-resource setting states how long the platform keeps retrying a
 * message; the period is a consequence of the consumer settings above. It
 * is therefore bounded from below by
 * {@link createDeliveryTuning}'s third check rather than mirrored, and
 * the declared value is not a guarantee of what the platform will
 * actually take. The declared 300,000 ms stands against a floor of
 * 90,000 ms (`3 * (0 + 30,000)`) — a number computed from the three
 * declarations above rather than one of its own, which
 * `__tests__/tuning.test.ts` recomputes and pins so that moving any of
 * them cannot leave it behind — and the slack is margin for a scheduler
 * this module cannot see rather than a measurement of one.
 *
 * **Queue value ranges are real** — checked against the `cli.js` of the
 * wrangler `apps/web` resolves and its scripts launch, 4.114.0. The tree
 * carries a second, older copy under `@cloudflare/vitest-pool-workers`,
 * so the version to reproduce this against is the one
 * `pnpm --filter @repo/web exec wrangler --version` prints, not whatever
 * the store happens to hold: `message_retention_period` accepts
 * 60–1,209,600 seconds and
 * `delivery_delay` accepts 0–86,400 seconds. Both constraints below are
 * jointly satisfiable inside those ranges as long as the reset-token TTL
 * is not on the order of minutes.
 */
export type DeliveryTuning = Readonly<{
  /** Rows the relay pass may claim in one wake-up. */
  relayMaxRowsPerPass: number;
  relayLeaseMs: number;
  relayBackoffBaseMs: number;
  relayBackoffMaxDelayMs: number;
  /** Publish attempts past which the row becomes `quarantined`. */
  relayMaxAttempts: number;

  /**
   * Tier 1 of the three-tier bound on how much one wake-up touches:
   * jobs claimed per pass. Held independently of the relay's limit so a
   * backlog in one pass cannot starve the other.
   */
  jobsMaxJobsPerPass: number;
  /**
   * Tier 2: chunk iterations one job may run. Reaching it returns the
   * row to `pending` and releases `lease_until` / `owner_token` in the
   * same transaction that commits the progress — this threshold *is*
   * what makes that rule implementable.
   */
  jobsMaxChunkIterations: number;
  /**
   * Tier 3: rows one chunk may touch.
   *
   * **The value is the bind-parameter ceiling, so a statement that spends
   * more than one bind per row divides it.** 100 is SQLite's limit on
   * binds per statement, and it is a per-statement budget rather than a
   * row count: a chunk whose statement writes two columns per row fits
   * 50 rows, not 100. Sub-queries carrying their own `LIMIT` spend no
   * binds per row and are unaffected.
   */
  jobsMaxRowsPerChunk: number;
  jobsLeaseMs: number;
  jobsBackoffBaseMs: number;
  jobsBackoffMaxDelayMs: number;
  jobsMaxAttempts: number;

  /**
   * Fixed interval a fail-closed DO re-arms its Alarm with. **No backoff
   * is applied to it** (`spec/database/index.md`, "fail-closed"): the
   * cause is deployment state, not data, and the DO must keep checking at
   * a steady rate until the code catches up.
   */
  failClosedRearmIntervalMs: number;

  /** Retention of normally-terminated rows; the abnormal ones are kept forever. */
  publishedRetentionMs: number;
  doneRetentionMs: number;
  /**
   * Rows one prune sweep may delete — a judgement about how much a single
   * transaction may remove at once. **Unlike `jobsMaxRowsPerChunk` above,
   * no bind ceiling reaches this value**: the sweep is one `DELETE … WHERE
   * key IN (SELECT … LIMIT ?)`, which spends three binds whatever the row
   * count.
   */
  pruneMaxRowsPerPass: number;

  /** Declared counterparts of the request Worker's queue-consumer config. */
  eventsMaxRetries: number;
  dlqMaxRetries: number;
  /**
   * Declared counterparts of the events consumer's `max_batch_timeout` and
   * `retry_delay` — the two settings that, together with
   * `eventsMaxRetries`, put a floor under `queueMaxRetryPeriodMs`.
   */
  eventsMaxBatchTimeoutMs: number;
  eventsRetryDelayMs: number;
  /**
   * Declared counterpart of the Queue resource's `message_retention_period`.
   *
   * **The out-of-band step that sets it is mandatory, not an adjustment:
   * on the platform default both constraints in
   * {@link createDeliveryTuning} are broken at once.** The `queues create`
   * / `queues update` of the wrangler `apps/web` launches (4.114.0, as
   * above) omit `settings.message_retention_period`
   * from the request body when `--message-retention-period-secs` is absent
   * (`cli.js`), so a queue nobody configured keeps Cloudflare's documented
   * default of 4 days — 345,600,000 ms, at which
   * `queueMaxRetryPeriodMs + dlqRetentionMs` exceeds `resetTokenTtlMs` and
   * `publishedRetentionMs` alike.
   *
   * The staging and production deploy templates carry that step in their
   * headers, and
   * `apps/web/app/worker/cloudflare/__tests__/wranglerConfig.test.ts` pins
   * the seconds those headers pass to this declaration, so moving one
   * without the other turns the suite red. What is pinned is the
   * instruction, not the queue: whether anyone ran it, and what the Queue
   * resource ended up set to, is observable nowhere in this repository, so
   * the checks in {@link createDeliveryTuning} still hold over the declared
   * values only.
   *
   * **Limit: what this bounds is undelivered backlog, not how long a
   * message sits in the DLQ.** `message_retention_period` caps how long
   * the queue keeps a message no consumer has taken. A consumer *is*
   * bound to the DLQ, and `handleDlqBatch` acks every message it is
   * handed, so dwell time is set by how fast batches form and is
   * unrelated to this number. Both constraints below still read it as
   * the worst-case age of a message on its way to the handler, which is
   * what they need; nothing here buys an operator time to act on a
   * message.
   */
  dlqRetentionMs: number;
  /**
   * How long the platform may keep retrying one message before it reaches
   * the DLQ. Derived from the three settings above at construction time,
   * where it is checked to cover them.
   */
  queueMaxRetryPeriodMs: number;
  resetTokenTtlMs: number;

  /**
   * Queue ceilings read off miniflare's queues broker constants
   * (`MAX_MESSAGE_BATCH_COUNT` / `MAX_MESSAGE_BATCH_SIZE` /
   * `MAX_MESSAGE_SIZE_BYTES`). **Limit: unverified against the production
   * Queue** — nothing in this repository observes what the platform
   * enforces, so all three stand on the local broker only. Only the
   * per-message one can bite today because the relay publishes row by
   * row, but all three are carried so that a future move to `sendBatch`
   * cannot overlook a ceiling.
   */
  queueMaxBatchCount: number;
  queueMaxBatchBytes: number;
  queueMaxMessageBytes: number;

  /**
   * Page size of `list-quarantined-events`, and of the `poison` listing
   * that mirrors it.
   *
   * The continuation is a keyset cursor on `(completed_at, id)`, not an
   * offset: a mass quarantine is the case this page size exists for, and
   * rows leaving the set between pages would make an offset skip the
   * rows that shifted down.
   */
  listQuarantinedEventsLimit: number;
  /** Page size of `list-poisoned-jobs`; the same discipline as the quarantine listing. */
  listPoisonedJobsLimit: number;

  /**
   * How long a deletion saga waits before re-issuing a round of
   * `deleteMapping` that was a no-op over two generations, and only then
   * confirms (`spec/rotation/index.md`, 削除の no-op 確定). The spec's
   * constraint is "longer than the upper bound on a cross-DO RPC's
   * lifetime", so that an import overtaken by the no-op has landed by the
   * time of the second round. **Limit: that bound is not documented as a
   * platform figure anywhere this repository can cite**, so the value is
   * a judgement — comfortably above the 30 s a Worker invocation is
   * allowed and above the DO lease used here — and not a derivation; the
   * exit the spec provides for that case (bounded re-issues under the
   * saga's own backoff) is not taken.
   */
  deleteNoopReissueDelayMs: number;
}>;

/**
 * The declared values. Module scope holds the declaration only —
 * validation lives in {@link createDeliveryTuning}, which must be called
 * from a DI factory, a queue handler, or a Durable Object's RPC entry /
 * `alarm()` prologue. Calling it at module scope would make a throw a
 * top-level side effect of the built Worker and break boot.
 */
export const DELIVERY_TUNING_DEFAULTS: DeliveryTuning = {
  relayMaxRowsPerPass: 25,
  relayLeaseMs: 60_000,
  relayBackoffBaseMs: 1_000,
  relayBackoffMaxDelayMs: 300_000,
  relayMaxAttempts: 5,

  jobsMaxJobsPerPass: 10,
  jobsMaxChunkIterations: 20,
  jobsMaxRowsPerChunk: 100,
  jobsLeaseMs: 60_000,
  jobsBackoffBaseMs: 1_000,
  jobsBackoffMaxDelayMs: 300_000,
  jobsMaxAttempts: 5,

  failClosedRearmIntervalMs: 300_000,

  publishedRetentionMs: 86_400_000,
  doneRetentionMs: 86_400_000,
  pruneMaxRowsPerPass: 50,

  eventsMaxRetries: 3,
  dlqMaxRetries: 1,
  eventsMaxBatchTimeoutMs: 30_000,
  eventsRetryDelayMs: 0,
  dlqRetentionMs: 600_000,
  queueMaxRetryPeriodMs: 300_000,
  resetTokenTtlMs: 3_600_000,

  queueMaxBatchCount: 100,
  queueMaxBatchBytes: 288_000,
  queueMaxMessageBytes: 128_000,

  listQuarantinedEventsLimit: 50,
  listPoisonedJobsLimit: 50,

  deleteNoopReissueDelayMs: 60_000,
};

/**
 * Build a validated tuning set.
 *
 * The two constraints on delivery operating values are the whole of them
 * (`spec/async/index.md`): both have the same left-hand side, the Queue's
 * maximum retry period plus the DLQ retention, and differ only in what
 * bounds it.
 *
 *  1. `< resetTokenTtl` — a functional requirement: what has to hold is
 *     that the **last events-queue retry** still finds the token live,
 *     that retry being the last attempt that carries the link at all.
 *     The sum is a conservative stand-in for that window. Its second
 *     term is the worst-case age a message can reach on its way to the
 *     DLQ handler — margin added on top, not time a delivery spends —
 *     and **the DLQ leg carries no delivery**: `handleDlqBatch` logs the
 *     message's identity, acks, and sends nothing.
 *  2. `<= publishedRetention` — the send-materials guard requires the row
 *     to exist, so a delivery arriving after the prune removed it always
 *     misses.
 *
 * Writing only one of them lets the value-setter pick two numbers that
 * cannot both hold, and the resulting permanent miss is close to
 * undetectable in operation.
 *
 * A third check anchors the left-hand side itself. `queueMaxRetryPeriodMs`
 * is not a setting anyone can write down: what the platform is configured
 * to do is `eventsMaxRetries` attempts, each waiting `eventsRetryDelayMs`
 * and then up to `eventsMaxBatchTimeoutMs` for its batch to form. So the
 * declared period must cover
 * `eventsMaxRetries * (eventsRetryDelayMs + eventsMaxBatchTimeoutMs)`.
 * That is a floor, not a model of the platform's scheduler — it says the
 * budget cannot be smaller than the retries already bought, which is what
 * stops the retry count and the period from being raised independently
 * until the two describe different systems.
 */
export function createDeliveryTuning(
  overrides: Partial<DeliveryTuning> = {},
): DeliveryTuning {
  const tuning: DeliveryTuning = { ...DELIVERY_TUNING_DEFAULTS, ...overrides };
  const queueRetryFloorMs =
    tuning.eventsMaxRetries *
    (tuning.eventsRetryDelayMs + tuning.eventsMaxBatchTimeoutMs);
  const deliveryBudget = tuning.queueMaxRetryPeriodMs + tuning.dlqRetentionMs;

  if (tuning.queueMaxRetryPeriodMs < queueRetryFloorMs) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Delivery tuning: queueMaxRetryPeriodMs must cover eventsMaxRetries * (eventsRetryDelayMs + eventsMaxBatchTimeoutMs)",
    );
  }
  if (deliveryBudget >= tuning.resetTokenTtlMs) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Delivery tuning: queueMaxRetryPeriodMs + dlqRetentionMs must be strictly less than resetTokenTtlMs",
    );
  }
  if (deliveryBudget > tuning.publishedRetentionMs) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Delivery tuning: queueMaxRetryPeriodMs + dlqRetentionMs must not exceed publishedRetentionMs",
    );
  }
  return Object.freeze(tuning);
}

/**
 * Exponential backoff for the next attempt, capped. Shared by the job
 * runner and the relay — the backoff rule is one of the conventions the
 * two tables hold in common (`spec/database/index.md`).
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxDelayMs: number,
): number {
  const raw = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(raw, maxDelayMs);
}
