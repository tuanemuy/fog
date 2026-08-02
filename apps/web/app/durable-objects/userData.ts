import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectState as CoreDurableObjectState,
  SqlStorage,
} from "@cloudflare/workers-types";
import {
  type AlarmCache,
  createAlarmCache,
  rearmBeforeWork,
  rearmFailClosed,
  settleAlarm,
} from "@repo/core/adapters/cloudflare/jobs/alarm";
import { USER_DATA_JOB_HANDLERS } from "@repo/core/adapters/cloudflare/jobs/registry";
import { runDueJobs } from "@repo/core/adapters/cloudflare/jobs/runner";
import { err, ok } from "@repo/core/adapters/cloudflare/platform/envelope";
import {
  type RpcEntryDeps,
  runRpcEntry,
} from "@repo/core/adapters/cloudflare/platform/rpcEntry";
import {
  readSchemaVersion,
  readSelfLocator,
  runMigrationGate,
} from "@repo/core/adapters/cloudflare/schema/gate";
import {
  USER_DATA_CODE_VERSION,
  USER_DATA_STEPS,
} from "@repo/core/adapters/cloudflare/schema/userData";
import * as facade from "@repo/core/adapters/cloudflare/userData/facade";
import {
  createUserDataContainer,
  type StateEnv,
  type UserDataContainer,
} from "@repo/core/application/di/stateCloudflare";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";

/**
 * One instance per user. Holds that user's entire domain dataset, including
 * the FTS5 search index, and owns the single Alarm that drives its jobs.
 *
 * Tenant isolation here is structural, not columnar: no table carries a
 * `user_id` predicate that could be forgotten, because no code path can obtain
 * another user's stub.
 *
 * The constructor only retains `ctx` / `env` and assembles its container — no
 * I/O, no randomness, no timers. Everything else happens inside an entry point.
 */
export class UserDataDurableObject extends DurableObject<StateEnv> {
  /**
   * The alarm time currently persisted, cached on the instance so that no
   * entry point has to call `getAlarm()` (whose return value the platform docs
   * describe inconsistently).
   *
   * Owned here and passed *into* the alarm helpers by argument, which is why
   * this class needs no test-only public method to reset it — tests reset it
   * by evicting the instance (`evictAllDurableObjects()`).
   */
  protected readonly alarmCache: AlarmCache = createAlarmCache();

  protected readonly container: UserDataContainer;

  constructor(ctx: DurableObjectState, env: StateEnv) {
    super(ctx, env);
    this.container = createUserDataContainer(this.state, env);
  }

  getCurrentUser(
    userId: string,
    epoch: number,
  ): Promise<RpcEnvelope<facade.CurrentUserPayload>> {
    return this.entry(() =>
      facade.getCurrentUser(this.container, userId, epoch),
    );
  }

  changeTrashRetentionDays(
    userId: string,
    epoch: number,
    days: number,
  ): Promise<RpcEnvelope<facade.CurrentUserPayload>> {
    return this.entry(() =>
      facade.changeTrashRetentionDays(
        this.container,
        userId,
        epoch,
        days,
        this.now(),
      ),
    );
  }

  initializeAccount(
    args: facade.InitializeAccountArgs,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.initializeAccount(this.container, args, this.now());
      return null;
    });
  }

  verifyLogin(
    args: facade.VerifyLoginArgs,
  ): Promise<RpcEnvelope<{ sessionEpoch: number }>> {
    return this.entry(() => facade.verifyLogin(this.container, args));
  }

  recordCredentialLocator(
    args: facade.RecordCredentialLocatorArgs,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.recordCredentialLocator(this.container, args);
      return null;
    });
  }

  /**
   * Operator diagnostic. One of exactly two entry points that do **not** run
   * the migration gate, and therefore neither fail closed nor re-arm the
   * alarm: it writes nothing and reads nothing whose shape depends on the
   * schema version, so it cannot damage an un-migrated DO — and it has to keep
   * working precisely when the DO is fail-closed.
   */
  readSchemaVersion(): RpcEnvelope<number> {
    try {
      return ok(readSchemaVersion(this.sql()));
    } catch (error) {
      return err(error);
    }
  }

  /**
   * Order is fixed: re-arm, gate, run, settle.
   *
   * The re-arm comes **before any work** because exceeding the CPU budget is an
   * eviction rather than an exception — the isolate dies and no `finally` runs
   * — so the next wake-up has to be persisted already.
   *
   * The gate is wrapped because it throws when the DO is fail-closed, and
   * nothing may ever escape `alarm()`. Catching it skips the run and the settle
   * and returns **without deleting the alarm**, which is what makes a
   * fail-closed DO keep retrying at a fixed interval instead of going dormant.
   * This is a different catch from the runner's per-job one: that catch keeps a
   * single bad job from stopping the queue, this one keeps a bad *schema* from
   * stopping the DO forever.
   */
  override async alarm(): Promise<void> {
    const now = this.now();
    await rearmBeforeWork(this.state, this.alarmCache, now);
    await this.state.storage.sync();

    try {
      this.gate();
    } catch (error) {
      this.container.logger.error("migration gate is fail-closed", {
        cause: error,
      });
      await rearmFailClosed(this.state, this.alarmCache, now);
      return;
    }

    await runDueJobs(
      {
        ctx: this.state,
        sql: this.sql(),
        now,
        ownerToken: this.container.idGenerator.next(),
        logger: this.container.logger,
        idGenerator: this.container.idGenerator,
      },
      USER_DATA_JOB_HANDLERS,
      now,
    );
    await settleAlarm(this.state, this.sql(), now, this.alarmCache);
  }

  private entry<T>(body: () => T): Promise<RpcEnvelope<T>> {
    const deps: RpcEntryDeps = {
      ctx: this.state,
      sql: this.sql(),
      cache: this.alarmCache,
      gate: () => this.gate(),
    };
    return runRpcEntry(deps, this.now(), body);
  }

  private gate(): void {
    runMigrationGate(
      this.state,
      USER_DATA_STEPS,
      USER_DATA_CODE_VERSION,
      this.selfLocator(),
    );
  }

  /**
   * The same object as `this.ctx`, retyped.
   *
   * `apps/web` sees Durable Object types twice — once from `cloudflare:workers`
   * via the generated `worker-configuration.d.ts`, once from
   * `@cloudflare/workers-types`, which is what `@repo/core` must import because
   * that package's `types` is `["node"]` and it has no ambient Workers globals.
   * The two declare `Request` slightly differently, so the state object is not
   * assignable between them even though it is one value at runtime. One cast,
   * in one place, rather than at every call site.
   */
  private get state(): CoreDurableObjectState {
    return this.ctx as unknown as CoreDurableObjectState;
  }

  private now(): number {
    return this.container.clock.now().getTime();
  }

  private sql(): SqlStorage {
    return this.state.storage.sql;
  }

  /**
   * `ctx.id.name` is populated for stubs obtained through `idFromName`, which
   * is how the request Worker always reaches this class; a stub revived from a
   * raw id has no name, so `_meta.self_locator` is the fallback.
   */
  protected selfLocator(): string {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== "") {
      return name;
    }
    return readSelfLocator(this.sql()) ?? "";
  }
}
