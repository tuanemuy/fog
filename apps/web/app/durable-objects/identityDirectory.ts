import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectState as CoreDurableObjectState,
  SqlStorage,
} from "@cloudflare/workers-types";
import * as facade from "@repo/core/adapters/cloudflare/identityDirectory/facade";
import {
  type AlarmCache,
  createAlarmCache,
  rearmBeforeWork,
  rearmFailClosed,
  settleAlarm,
} from "@repo/core/adapters/cloudflare/jobs/alarm";
import { IDENTITY_DIRECTORY_JOB_HANDLERS } from "@repo/core/adapters/cloudflare/jobs/registry";
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
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "@repo/core/adapters/cloudflare/schema/identityDirectory";
import {
  createIdentityDirectoryContainer,
  type IdentityDirectoryContainer,
  type StateEnv,
} from "@repo/core/application/di/stateCloudflare";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";

/**
 * One instance per credential bucket (`dir:g{generation}:b{index}`). Holds the
 * credential → `userId` mappings, reset tokens and the bucket's own jobs.
 *
 * The bucket name is derived from an HMAC by the *request* Worker; neither the
 * raw email nor the SSO subject nor the routing secret ever reaches this class
 * (ADR-016).
 */
export class IdentityDirectoryDurableObject extends DurableObject<StateEnv> {
  /** See `UserDataDurableObject.alarmCache` — same ownership rule. */
  protected readonly alarmCache: AlarmCache = createAlarmCache();

  protected readonly container: IdentityDirectoryContainer;

  constructor(ctx: DurableObjectState, env: StateEnv) {
    super(ctx, env);
    this.container = createIdentityDirectoryContainer(this.state, env);
  }

  lookupCredential(
    args: facade.LookupCredentialArgs,
  ): Promise<RpcEnvelope<facade.LookupCredentialResult>> {
    return this.entry(() =>
      facade.lookupCredential(this.container, args, this.now()),
    );
  }

  reportLoginResult(
    kind: CredentialMappingKind,
    hmac: string,
    ok_: boolean,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.reportLoginResult(this.container, kind, hmac, ok_);
      return null;
    });
  }

  reserveCredential(
    args: facade.ReserveCredentialFacadeArgs,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.reserveCredential(this.container, args, this.now());
      return null;
    });
  }

  activateReservation(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    userId: string,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.activateReservation(
        this.container,
        kind,
        hmac,
        operationId,
        userId,
      );
      return null;
    });
  }

  cancelReservation(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    callerToken: string,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.cancelReservation(
        this.container,
        kind,
        hmac,
        operationId,
        callerToken,
      );
      return null;
    });
  }

  checkPreviousGeneration(
    kind: CredentialMappingKind,
    hmac: string,
  ): Promise<RpcEnvelope<boolean>> {
    return this.entry(() =>
      facade.checkPreviousGeneration(this.container, kind, hmac),
    );
  }

  requestPasswordReset(
    kind: CredentialMappingKind,
    hmac: string,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.requestPasswordReset(this.container, kind, hmac, this.now());
      return null;
    });
  }

  /**
   * Operator diagnostic. Like `readSchemaVersion`, one of exactly two entry
   * points outside the migration gate: gate, fail-closed and alarm re-arming
   * are all skipped.
   *
   * Never logs the ids it returns.
   */
  listBucketUserIds(
    cursor: string | null,
    limit: number,
  ): RpcEnvelope<readonly string[]> {
    try {
      const bounded = Math.max(1, Math.min(limit, 1000));
      const sql = this.sql();
      const rows =
        cursor === null
          ? sql
              .exec<{ user_id: string }>(
                "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL ORDER BY user_id LIMIT ?",
                bounded,
              )
              .toArray()
          : sql
              .exec<{ user_id: string }>(
                "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?",
                cursor,
                bounded,
              )
              .toArray();
      return ok(rows.map((row) => row.user_id));
    } catch (error) {
      return err(error);
    }
  }

  readSchemaVersion(): RpcEnvelope<number> {
    try {
      return ok(readSchemaVersion(this.sql()));
    } catch (error) {
      return err(error);
    }
  }

  /** Same four-step order and the same two catches as the User Data class. */
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
        mailSender: this.container.mailSender,
        appUrl: this.container.appUrl,
      },
      IDENTITY_DIRECTORY_JOB_HANDLERS,
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
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
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

  protected selfLocator(): string {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== "") {
      return name;
    }
    return readSelfLocator(this.sql()) ?? "";
  }
}
