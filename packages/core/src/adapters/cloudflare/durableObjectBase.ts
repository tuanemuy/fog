import { DurableObject } from "cloudflare:workers";
import {
  createDeliveryTuning,
  DELIVERY_TUNING_DEFAULTS,
  type DeliveryTuning,
} from "@repo/core/application/delivery/tuning";
import type {
  DeliveryBacklog,
  ListPoisonedJobsResult,
  ListQuarantinedEventsResult,
  PoisonedJobCursor,
  QuarantinedEventCursor,
  QuarantinedEventSummary,
  RpcEnvelope,
  SerializedRpcError,
} from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { UnitOfWorkProvider } from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import { isCodedError } from "@repo/core/lib/error";
import { rearm } from "./alarmSchedule";
import {
  type JobHandlerRegistry,
  NO_TERMINAL_STAGE,
  runJobsPass,
  runPrunePass,
  type TerminalStageSelector,
} from "./jobRunner";
import {
  applyInitialSchema,
  isInitialized,
  readSchemaVersion,
  readSelfLocator,
  runMigrationGate,
} from "./migrationGate";
import { runRelayPass } from "./outboxRelay";
import type { OutboxQueueMessage } from "./queueMessage";
import { failureLabel, newOwnerToken, updateMatchedRow } from "./rowRunner";
import type { MigrationPlan } from "./schema/plan";

const WAKE_UP_FAILED = "Wake-up step failed";
const DO_ENTRY_FAILED = "Durable Object entry failed";

/**
 * Bindings the state Worker gives its Durable Object classes.
 *
 * The Queue producer is here rather than on the request Worker because
 * the relay runs inside `alarm()`. The provider-idempotency derivation
 * key is a state-Worker secret and is one of the keys that never leaves
 * the DO; the mail provider's own secret belongs to the request Worker,
 * where the consumer lives.
 */
export type StateWorkerEnv = Readonly<{
  EVENTS_QUEUE: Queue<OutboxQueueMessage>;
  PROVIDER_IDEMPOTENCY_KEY?: string;
  IDENTITY_MAIL_ENCRYPTION_KEY?: string;
  /** The two-generation form of the encryption keyring (JSON); wins over the single key when set. */
  IDENTITY_MAIL_ENCRYPTION_KEYRING?: string;
  /** The key commitment (JSON) the buckets verify injected mapping keys against; unset while single-generation. */
  DIRECTORY_KEY_COMMITMENT?: string;
  /** The reset-token derivation key; state Worker only (`spec/async/index.md` 衛生規則). */
  IDENTITY_RESET_TOKEN_KEY?: string;
  /**
   * The state Worker's own namespaces, for the saga jobs that call the other
   * class from inside `alarm()`. Untyped here because the classes extend this
   * module; the job handlers cast the stub they address.
   */
  USER_DATA?: DurableObjectNamespace;
  IDENTITY_DIRECTORY?: DurableObjectNamespace;
}>;

export type DurableObjectRuntimeConfig = Readonly<{
  plan: MigrationPlan;
  allowInitialize: boolean;
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
  tuningOverrides?: Partial<DeliveryTuning>;
  /** The export snapshot's byte cap; `EXPORT_MAX_SOURCE_BYTES` when unset. */
  exportMaxSourceBytes?: number;
  jobRegistry?: JobHandlerRegistry;
  terminalStage?: TerminalStageSelector;
}>;

/**
 * Shared behaviour of both Durable Object classes: the value envelope at
 * the RPC boundary, the schema gate, the Alarm's fixed order, and the one
 * place a re-arm is issued after a unit of work.
 *
 * **The constructor holds values and makes no judgements.** Neither the
 * missing-name check nor building the tuning happens here: throwing from
 * a constructor fails the Durable Object's startup itself, so the failure
 * surfaces as a platform error rather than through the value envelope,
 * and both the test expectations and the explanation of the rule would
 * fork at that point. Both checks run at the head of each RPC entry and
 * at the head of `alarm()` instead.
 */
export abstract class AsyncWorkDurableObject<
  TCtx,
> extends DurableObject<StateWorkerEnv> {
  protected readonly migrationPlan: MigrationPlan;
  protected readonly config: DurableObjectRuntimeConfig;
  /**
   * `ctx.id.name` — the DO's own locator, readable from inside the object
   * (including in the constructor) for any stub obtained through
   * `idFromName`. It is `undefined` for a stub built from `idFromString` /
   * `newUniqueId`, which the stub-selection adapter never builds — and,
   * on the local workerd, for an object the runtime brought back on its
   * own to fire an Alarm after a process restart (PH-06 verification O-2).
   * `requireSelfLocator` falls back to `_meta.self_locator` for that case.
   */
  protected readonly selfLocatorValue: string | undefined;
  private storedSelfLocator: string | null = null;
  private cachedTuning: DeliveryTuning | null = null;

  constructor(
    ctx: DurableObjectState,
    env: StateWorkerEnv,
    config: DurableObjectRuntimeConfig,
  ) {
    super(ctx, env);
    this.config = config;
    this.migrationPlan = config.plan;
    this.selfLocatorValue = ctx.id.name;
  }

  protected abstract createUnitOfWorkProvider(): UnitOfWorkProvider<TCtx>;

  /**
   * Resolves the DO's own locator: `ctx.id.name` when the stub carries
   * it, otherwise `_meta.self_locator`, the copy the schema gate wrote on
   * initialisation for exactly the paths on which the name is unavailable
   * (`spec/database/index.md`). Both the RPC entries and `alarm()` come
   * through here, so an object woken without its name still relays with
   * its routing key and runs its due jobs. When both values exist the gate
   * checks that they agree (`runMigrationGate`); a locator taken from
   * `_meta` is by construction the one the gate wrote.
   *
   * **Limit.** The fallback exists for the local workerd, which restores
   * an object to fire a due Alarm after `wrangler dev` restarts without
   * handing it `id.name`; the production runtime keeps the name on every
   * wake-up. An object with neither a name nor a `_meta` row was never
   * initialised and cannot know which tenant it is: `NotInitialized`, as
   * on any other read of an uninitialised object.
   */
  protected requireSelfLocator(): string {
    if (this.selfLocatorValue !== undefined && this.selfLocatorValue !== "") {
      return this.selfLocatorValue;
    }
    this.storedSelfLocator ??= readSelfLocator(this.ctx.storage.sql);
    if (this.storedSelfLocator !== null && this.storedSelfLocator !== "") {
      return this.storedSelfLocator;
    }
    throw new SystemError(
      SystemErrorCode.NotInitialized,
      "Durable Object was reached through a stub that carries no name, and holds no locator of its own",
    );
  }

  protected tuning(): DeliveryTuning {
    if (this.cachedTuning === null) {
      this.cachedTuning = createDeliveryTuning(this.config.tuningOverrides);
    }
    return this.cachedTuning;
  }

  /**
   * The catch boundary at the RPC entry. Errors cross the request Worker
   * ↔ Durable Object boundary as a value envelope, never as a thrown
   * custom class: RPC does not preserve the structural serialization
   * contract that the guards depend on.
   */
  protected async envelope<T>(fn: () => Promise<T>): Promise<RpcEnvelope<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: serializeRpcError(error) };
    }
  }

  /**
   * Runs at the head of every RPC entry except the two diagnostics, and
   * at the head of {@link runUnitOfWork}:
   * resolve the locator, build the tuning, pass the schema gate, and — if
   * the gate seeded job rows — arm the Alarm for them before the body
   * runs. The gate cannot arm it itself, because it holds its exclusion
   * by never awaiting and `setAlarm()` is asynchronous.
   *
   * Arming before the body rather than after is deliberate: the rows the
   * gate wrote are already committed in the gate's own transaction, so
   * their wake-up must not depend on whether the body succeeds.
   */
  protected async enterRpc(): Promise<void> {
    const selfLocator = this.requireSelfLocator();
    const result = runMigrationGate({
      storage: this.ctx.storage,
      plan: this.migrationPlan,
      selfLocator,
      allowInitialize: this.config.allowInitialize,
      now: this.config.clock.now().getTime(),
    });
    this.tuning();
    if (result.seededJobs) await rearm(this.ctx.storage);
  }

  /**
   * The **only** place a unit of work is run and the Alarm re-armed
   * afterwards. **Later slices route their usecase RPCs through here**
   * instead of calling `provider.run` and writing their own re-arm;
   * otherwise the rule "whoever added a runnable row arms the Alarm"
   * splits per path.
   *
   * **The gate runs here as well as at each RPC entry**, so an entry
   * written as `envelope(() => this.runUnitOfWork(...))` fails closed
   * without doing anything further: this is the only write path into the
   * DO, and a `schema_version` ahead of this build has to stop it. The
   * duplication is cheap and harmless — the gate is idempotent (two
   * reads, and no row at all on a DO that may not initialise) — and the
   * entry-side call stays because the read-only entries need the gate
   * without running a unit of work.
   */
  protected async runUnitOfWork<T>(
    fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T,
  ): Promise<T> {
    await this.enterRpc();
    const provider = this.createUnitOfWorkProvider();
    const result = provider.run(fn);
    if (provider.takeRearmRequest()) await rearm(this.ctx.storage);
    return result;
  }

  /**
   * The one seam that may bring a Durable Object into existence: it
   * applies the initialisation branch **inside the same `transactionSync`
   * as the business write** that justifies the object existing at all.
   *
   * Splitting the two is what this exists to prevent. An object whose
   * schema committed but whose first business write did not is an *empty*
   * Durable Object — every table, no account row — and an empty one cannot
   * be reached from the directory's user listing, so it can be neither
   * found nor reclaimed. Committing them together means a failure leaves
   * the object at zero bytes, which is a state that recovers by being
   * retried.
   *
   * On an object that is already initialised this falls through to the
   * ordinary path, gate included, so a re-sent procedure is migrated and
   * run exactly like any other entry.
   */
  protected async runInitializingUnitOfWork<T>(
    fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T,
  ): Promise<T> {
    if (isInitialized(this.ctx.storage.sql)) return this.runUnitOfWork(fn);

    const selfLocator = this.requireSelfLocator();
    const plan = this.migrationPlan;
    this.tuning();
    const provider = this.createUnitOfWorkProvider();
    const result = provider.run(((ctx: TCtx) => {
      applyInitialSchema(this.ctx.storage.sql, plan, selfLocator);
      return fn(ctx);
    }) as typeof fn);
    if (provider.takeRearmRequest()) await rearm(this.ctx.storage);
    return result;
  }

  /**
   * Diagnostic entry. **Does not pass the gate and writes no row**, which
   * is what lets it report an uninitialised DO as uninitialised instead
   * of creating one. It is one of the two entries outside the gate's
   * scope.
   */
  async readSchemaVersion(): Promise<
    RpcEnvelope<{ schemaVersion: number | null }>
  > {
    return this.envelope(async () => ({
      schemaVersion: readSchemaVersion(this.ctx.storage.sql),
    }));
  }

  /**
   * Operator entry: lists quarantined rows, oldest first.
   *
   * Six columns and no more. `owner_token` is withheld because it is a
   * bearer credential for the send-materials guard, `aggregate_id`
   * because it is the throttle window key and would correlate messages
   * back to one recipient, and `payload` because the column that explains
   * a quarantine is `terminal_reason`, not it.
   *
   * The page is bounded: quarantine is retained indefinitely and happens
   * *en masse* (a Queue producer binding outage quarantines everything at
   * once), so an unbounded listing would be the only path in the system
   * that grows with the row count. The `completed_at` ordering is
   * resolved by `outbox_completed_idx`; what costs a sort is only the
   * `id` tie-break within a group of equal `completed_at`, and that
   * tie-break is what makes the cursor stable.
   *
   * **`completed_at` is read through `?? 0`, both into the cursor and
   * into each row.** A quarantined row always carries one — the argument
   * is in {@link QuarantinedEventCursor}, and it rests on the two
   * statements that write the status column, not on the column type,
   * which is nullable and so leaves a branch this read has to cover.
   * The `?? 0` covers it and nothing more: it is not a recovery, and were
   * the invariant ever broken, a `NULL` in the last row of a page would
   * collapse the cursor to `0` and start the next page from the top of
   * the set.
   *
   * Read-only, so it does not re-arm the Alarm.
   */
  async listQuarantinedEvents(
    cursor?: QuarantinedEventCursor | null,
  ): Promise<RpcEnvelope<ListQuarantinedEventsResult>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const limit = this.tuning().listQuarantinedEventsLimit;
      const sql = this.ctx.storage.sql;
      const rows = cursor
        ? sql
            .exec<QuarantinedRow>(
              `SELECT id, type, attempt, created_at, completed_at, terminal_reason
               FROM outbox_events
               WHERE status = 'quarantined'
                 AND (completed_at > ?1 OR (completed_at = ?1 AND id > ?2))
               ORDER BY completed_at ASC, id ASC LIMIT ?3`,
              cursor.completedAt,
              cursor.eventId,
              limit + 1,
            )
            .toArray()
        : sql
            .exec<QuarantinedRow>(
              `SELECT id, type, attempt, created_at, completed_at, terminal_reason
               FROM outbox_events
               WHERE status = 'quarantined'
               ORDER BY completed_at ASC, id ASC LIMIT ?1`,
              limit + 1,
            )
            .toArray();

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page.map(toQuarantinedSummary),
        nextCursor:
          rows.length > limit && last
            ? { completedAt: last.completed_at ?? 0, eventId: last.id }
            : null,
      } satisfies ListQuarantinedEventsResult;
    });
  }

  /**
   * Operator entry: re-drives one quarantined row.
   *
   * Five columns are written in one statement and that is all of them —
   * the four state columns `status='pending'`, `next_run_at = now`,
   * `attempt = 0`, `completed_at = NULL`, and a re-minted `owner_token`.
   * `terminal_reason` is **kept**: it is the only record of why the row
   * was quarantined. Minting `owner_token` **again** closes the
   * exposure window — any
   * `(event.id, owner_token)` pair that had reached the Queue or the DLQ
   * before the quarantine now fails the guard. The side effect is that
   * re-driving an old DLQ message for that event answers
   * `nothing-to-send`; the row itself is still claimed and published, so
   * no delivery is lost.
   *
   * **Writing `next_run_at` is not optional.** It is nulled at
   * termination, so restoring only `status` leaves a row the re-arm's
   * `min()` skips (SQL `min()` ignores NULL), the claim predicate
   * `next_run_at <= now` misses, and `deleteAlarm()` will not fire for
   * either — a DO that wakes and moves nothing.
   *
   * The Alarm is re-armed afterwards. A DO holding only quarantined rows
   * is by definition disarmed, which is precisely the situation an
   * operator re-drives in.
   */
  async requeueQuarantinedEvent(
    eventId: string,
  ): Promise<RpcEnvelope<{ requeued: boolean }>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const now = this.config.clock.now().getTime();
      const requeued = this.ctx.storage.transactionSync(() =>
        updateMatchedRow(
          this.ctx.storage.sql,
          `UPDATE outbox_events
           SET status = 'pending', next_run_at = ?, attempt = 0, completed_at = NULL, owner_token = ?
           WHERE id = ? AND status = 'quarantined'`,
          now,
          newOwnerToken(),
          eventId,
        ),
      );
      if (requeued) await rearm(this.ctx.storage);
      return { requeued };
    });
  }

  /**
   * Operator entry: deletes one quarantined row for good. The last of the
   * two ways a quarantined row leaves (`spec/database/index.md`); read
   * `terminal_reason` first, since nothing records the row afterwards.
   * Removes nothing runnable, so the Alarm is not re-armed.
   */
  async deleteQuarantinedEvent(
    eventId: string,
  ): Promise<RpcEnvelope<{ deleted: boolean }>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const deleted = this.ctx.storage.transactionSync(() =>
        updateMatchedRow(
          this.ctx.storage.sql,
          "DELETE FROM outbox_events WHERE id = ? AND status = 'quarantined'",
          eventId,
        ),
      );
      return { deleted };
    });
  }

  /**
   * Operator entry: what still waits to be published. `quarantined` rows
   * are not backlog — they are the listing's — so only the two live
   * statuses are counted.
   */
  async readDeliveryBacklog(): Promise<RpcEnvelope<DeliveryBacklog>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const row = this.ctx.storage.sql
        .exec<{ pending: number; publishing: number; oldest: number | null }>(
          `SELECT
             (SELECT count(*) FROM outbox_events WHERE status = 'pending') AS pending,
             (SELECT count(*) FROM outbox_events WHERE status = 'publishing') AS publishing,
             (SELECT min(created_at) FROM outbox_events WHERE status IN ('pending','publishing')) AS oldest`,
        )
        .one();
      return {
        pendingCount: row.pending,
        publishingCount: row.publishing,
        oldestCreatedAt: row.oldest,
      };
    });
  }

  /**
   * Operator entry: lists `poison` job rows, oldest first, by the same
   * discipline as {@link listQuarantinedEvents}: five columns and no
   * `payload` (the column that explains a termination is
   * `terminal_reason`), a bounded page, a keyset cursor on
   * `(completed_at, operation_key)` that `jobs_completed_idx` resolves.
   * Read-only, so it does not re-arm the Alarm.
   */
  async listPoisonedJobs(
    cursor?: PoisonedJobCursor | null,
  ): Promise<RpcEnvelope<ListPoisonedJobsResult>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const limit = this.tuning().listPoisonedJobsLimit;
      const sql = this.ctx.storage.sql;
      const rows = cursor
        ? sql
            .exec<PoisonedRow>(
              `SELECT operation_key, kind, attempt, completed_at, terminal_reason
               FROM jobs
               WHERE status = 'poison'
                 AND (completed_at > ?1 OR (completed_at = ?1 AND operation_key > ?2))
               ORDER BY completed_at ASC, operation_key ASC LIMIT ?3`,
              cursor.completedAt,
              cursor.operationKey,
              limit + 1,
            )
            .toArray()
        : sql
            .exec<PoisonedRow>(
              `SELECT operation_key, kind, attempt, completed_at, terminal_reason
               FROM jobs
               WHERE status = 'poison'
               ORDER BY completed_at ASC, operation_key ASC LIMIT ?1`,
              limit + 1,
            )
            .toArray();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page.map((row) => ({
          operationKey: row.operation_key,
          kind: row.kind,
          attempt: row.attempt,
          completedAt: row.completed_at ?? 0,
          terminalReason: row.terminal_reason,
        })),
        nextCursor:
          rows.length > limit && last
            ? {
                completedAt: last.completed_at ?? 0,
                operationKey: last.operation_key,
              }
            : null,
      } satisfies ListPoisonedJobsResult;
    });
  }

  /**
   * Operator entry: re-drives one `poison` row. Four columns and no more —
   * `status = 'pending'`, `next_run_at = now`, `attempt = 0`,
   * `completed_at = NULL` — which is convergence rule (2) minus the
   * payload it does not replace (`spec/database/index.md`).
   * `terminal_reason` is **kept**: it is the record an operator reads, and
   * it is what makes the next run a cleanup where one exists rather than
   * a forward (`spec/recovery/index.md`). `lease_until` / `owner_token`
   * are already `NULL` on a terminated row. Re-armed afterwards, for the
   * same reason as the quarantine re-drive.
   */
  async requeuePoisonedJob(
    operationKey: string,
  ): Promise<RpcEnvelope<{ requeued: boolean }>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const now = this.config.clock.now().getTime();
      const requeued = this.ctx.storage.transactionSync(() =>
        updateMatchedRow(
          this.ctx.storage.sql,
          `UPDATE jobs SET status = 'pending', next_run_at = ?, attempt = 0, completed_at = NULL
           WHERE operation_key = ? AND status = 'poison'`,
          now,
          operationKey,
        ),
      );
      if (requeued) await rearm(this.ctx.storage);
      return { requeued };
    });
  }

  /** Operator entry: deletes one `poison` row for good. Removes nothing runnable; no re-arm. */
  async deletePoisonedJob(
    operationKey: string,
  ): Promise<RpcEnvelope<{ deleted: boolean }>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const deleted = this.ctx.storage.transactionSync(() =>
        updateMatchedRow(
          this.ctx.storage.sql,
          "DELETE FROM jobs WHERE operation_key = ? AND status = 'poison'",
          operationKey,
        ),
      );
      return { deleted };
    });
  }

  /**
   * The fixed order of a wake-up: (1) re-arm and confirm persistence,
   * (2) the schema gate, (3-a) the relay pass, (3-b) the jobs pass,
   * the prune at the tail, (4) recompute from both tables and re-arm.
   *
   * **This never throws.** Retry belongs to the job runner and to the
   * relay, not to the platform.
   *
   * **`deleteAlarm()` splits by path, and the two cases are written
   * separately on purpose.** On the fail-closed path at (2) the Alarm is
   * *not* deleted: it is re-armed at a fixed interval and the wake-up
   * returns. Deleting it would mean that once correct code came back,
   * nothing would notice until the next input reached the DO — and a DO
   * nobody accesses would stay stopped forever. At (4) the ordinary rule
   * applies and `deleteAlarm()` does fire when both runnable sets are
   * empty.
   *
   * **The fixed interval overwrites what (1) armed**, and no backoff is
   * applied to it. A fail-closed DO characteristically holds `pending`
   * rows whose `next_run_at` is in the past; arming that past time would
   * fire immediately, return at the gate, and arm the same past time
   * again — a spin.
   */
  override async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const now = this.config.clock.now().getTime();

    try {
      await rearm(storage);
    } catch (error) {
      this.config.logger.error("Alarm re-arm failed", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
    }

    let tuning: DeliveryTuning;
    try {
      tuning = this.tuning();
      runMigrationGate({
        storage,
        plan: this.migrationPlan,
        selfLocator: this.requireSelfLocator(),
        allowInitialize: this.config.allowInitialize,
        now,
      });
    } catch (error) {
      this.config.logger.error("Alarm stopped at the schema gate", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
      // The tuning may be exactly what failed to build, so fall back to
      // the declared default for the one value needed to keep checking.
      const interval =
        this.cachedTuning?.failClosedRearmIntervalMs ??
        DELIVERY_TUNING_DEFAULTS.failClosedRearmIntervalMs;
      try {
        await storage.setAlarm(now + interval);
      } catch (rearmError) {
        this.config.logger.error("Fail-closed re-arm failed", {
          cause: failureLabel(rearmError, WAKE_UP_FAILED),
        });
      }
      return;
    }

    try {
      await runRelayPass({
        storage,
        queue: this.env.EVENTS_QUEUE,
        routingKey: this.requireSelfLocator(),
        tuning,
        now,
        logger: this.config.logger,
      });
    } catch (error) {
      this.config.logger.error("Relay pass failed", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
    }

    try {
      await runJobsPass({
        storage,
        tuning,
        now,
        registry: this.config.jobRegistry ?? {},
        logger: this.config.logger,
        terminalStage: this.config.terminalStage ?? NO_TERMINAL_STAGE,
      });
    } catch (error) {
      this.config.logger.error("Jobs pass failed", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
    }

    try {
      runPrunePass(storage, tuning, now);
    } catch (error) {
      this.config.logger.error("Prune pass failed", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
    }

    try {
      await rearm(storage);
    } catch (error) {
      this.config.logger.error("Alarm re-arm failed", {
        cause: failureLabel(error, WAKE_UP_FAILED),
      });
    }
  }
}

type PoisonedRow = Readonly<{
  operation_key: string;
  kind: string;
  attempt: number;
  completed_at: number | null;
  terminal_reason: string | null;
}>;

type QuarantinedRow = Readonly<{
  id: string;
  type: string;
  attempt: number;
  created_at: number;
  completed_at: number | null;
  terminal_reason: string | null;
}>;

function toQuarantinedSummary(row: QuarantinedRow): QuarantinedEventSummary {
  return {
    eventId: row.id,
    type: row.type,
    attempt: row.attempt,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? 0,
    terminalReason: row.terminal_reason,
  };
}

/**
 * Turns anything thrown inside a DO into the serialized contract.
 *
 * A value that is already a `CodedError` serializes itself; anything else
 * is translated into a `SystemError` first. Nothing is ever re-thrown as
 * it stands — the classification on the far side rests on no thrown
 * value's shape deriving from external input.
 *
 * The code for that residue is `UnclassifiedError` and not
 * `DatabaseError`: what lands here is whatever the entry body threw
 * without classifying it, a `TypeError` from assembling a Queue message as
 * readily as a storage fault, and the code an operator triages on should
 * not name the storage layer for either. It is also distinct from the code
 * `callDurableObject` raises when the stub call itself failed, so a log
 * says whether the DO fell over or was never reached.
 *
 * **The residue's `message` is the same code-owned projection the runners
 * write to `terminal_reason`**, taken from {@link failureLabel} rather
 * than reimplemented, so the hygiene rule of `spec/async/index.md` cannot
 * come apart between the two places. The thrown value's own `message` is
 * never taken: it is written by whoever threw it, a mail provider's SDK
 * puts the rejected request — recipient and raw token — in it, and this
 * value reaches the request Worker's logger and tracing un-redacted (the
 * client-facing redaction in `errorResponse.ts` happens later and only for
 * the client). `kind` and `code` survive, which is what the caller
 * discriminates on.
 */
function serializeRpcError(error: unknown): SerializedRpcError {
  if (isCodedError(error)) return error.toSerialized();
  return new SystemError(
    SystemErrorCode.UnclassifiedError,
    failureLabel(error, DO_ENTRY_FAILED),
  ).toSerialized();
}
