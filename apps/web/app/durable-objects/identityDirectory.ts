import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectState as CoreDurableObjectState,
  SqlStorage,
} from "@cloudflare/workers-types";
import { sealCanonical } from "@repo/core/adapters/cloudflare/identityDirectory/canonicalCipher";
import * as facade from "@repo/core/adapters/cloudflare/identityDirectory/facade";
import * as resetTokenCrypto from "@repo/core/adapters/cloudflare/identityDirectory/resetTokenCrypto";
import {
  type AlarmCache,
  createAlarmCache,
  rearmAfterFailure,
  rearmBeforeWork,
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
import { all } from "@repo/core/adapters/cloudflare/sql/exec";
import type {
  LookupCredentialArgs,
  LookupCredentialResult,
  ReserveCredentialFacadeArgs,
} from "@repo/core/application/di/facades";
import {
  createIdentityDirectoryContainer,
  type IdentityDirectoryContainer,
  readStateSecretsOrNull,
  type StateEnv,
} from "@repo/core/application/di/stateCloudflare";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { SealedCanonical } from "@repo/core/domain/identity/ports/credentialMappingStore";
import type { ResetTokenIssueMaterial } from "@repo/core/domain/identity/ports/passwordResetTokenPort";
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
    args: LookupCredentialArgs,
  ): Promise<RpcEnvelope<LookupCredentialResult>> {
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

  /**
   * The one entry that does work before `entry()`.
   *
   * Sealing the address is WebCrypto and therefore asynchronous, and a unit of
   * work's callback is type-rejected from being asynchronous — so the only
   * moment a bucket can encrypt is here, in the entry point, which is
   * asynchronous by construction. The ciphertext then crosses into the
   * transaction as a plain value (ADR-036).
   *
   * The failure is returned as an envelope like any other: a deployment with no
   * mail-encryption key must fail the signup rather than write a reservation
   * whose address can never be recovered.
   */
  async reserveCredential(
    args: ReserveCredentialFacadeArgs,
  ): Promise<RpcEnvelope<null>> {
    let sealed: SealedCanonical;
    try {
      sealed = await sealCanonical(
        readStateSecretsOrNull(this.env)?.mailEncryptionKeyring ?? null,
        args.canonical,
        { kind: args.kind, credentialId: args.credentialId },
      );
    } catch (error) {
      return err(error);
    }
    return this.entry(() => {
      facade.reserveCredential(this.container, args, sealed, this.now());
      return null;
    });
  }

  activateReservation(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    userId: string,
    callerToken: string,
  ): Promise<RpcEnvelope<null>> {
    return this.entry(() => {
      facade.activateReservation(
        this.container,
        kind,
        hmac,
        operationId,
        userId,
        callerToken,
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

  /**
   * The second entry that does work before `entry()`, for the same reason
   * `reserveCredential` does.
   *
   * The reset token is derived here — HMAC over a fresh `tokenId`, then SHA-256
   * of the result — because WebCrypto is asynchronous and a unit of work's
   * callback is type-rejected from being asynchronous. Only the two derived
   * strings cross into the transaction, and the row keeps the hash, so a
   * database dump yields nothing that can be redeemed (ADR-042).
   *
   * **Minted unconditionally.** Whether the address is registered is decided
   * inside the transaction, and the four cases have to cost the same; deriving
   * only when eligible would make the work itself the oracle the uniform path
   * exists to close.
   */
  async requestPasswordReset(
    kind: CredentialMappingKind,
    hmac: string,
  ): Promise<RpcEnvelope<null>> {
    let material: ResetTokenIssueMaterial;
    try {
      material = await resetTokenCrypto.mintResetTokenMaterial(
        resetTokenCrypto.requireResetTokenKeyring(
          readStateSecretsOrNull(this.env)?.resetTokenKeyring ?? null,
        ),
      );
    } catch (error) {
      // A deployment with no reset-token key can neither derive a link nor
      // store one that could ever be redeemed, so it fails rather than writing
      // a row that records the request as served.
      return err(error);
    }
    return this.entry(() => {
      facade.requestPasswordReset(
        this.container,
        kind,
        hmac,
        this.now(),
        material,
      );
      return null;
    });
  }

  /**
   * Operator diagnostic. Like `readSchemaVersion`, one of exactly two entry
   * points outside the migration gate: gate, fail-closed and alarm re-arming
   * are all skipped.
   *
   * Deliberately **not** on `IdentityDirectoryFacade`: it enumerates every
   * `userId` in a bucket, and a `userId` is a value that lets its holder address
   * the user's Durable Object. Keeping it off the interface the composition root
   * holds means no request-path code can call it even by mistake. Binding it to
   * an operator secret is #38's.
   *
   * Goes through the SQL helpers like every other statement in the two classes,
   * so a driver failure is translated before it reaches the envelope; skipping
   * the *gate* is the exemption, not skipping `sql/exec.ts`.
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
          ? all<{ user_id: string }>(
              sql,
              "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL ORDER BY user_id LIMIT ?",
              bounded,
            )
          : all<{ user_id: string }>(
              sql,
              "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?",
              cursor,
              bounded,
            );
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

  /** Same four-step order and the same single guard as the User Data class. */
  override async alarm(): Promise<void> {
    const now = this.now();
    try {
      await rearmBeforeWork(this.state, this.alarmCache, now);
      await this.state.storage.sync();
      this.gate();
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
          // Read here rather than in the constructor, and leniently: an unset
          // optional binding must not be able to stop `alarm()` from running.
          secrets: readStateSecretsOrNull(this.env),
        },
        IDENTITY_DIRECTORY_JOB_HANDLERS,
        now,
      );
      await settleAlarm(this.state, this.sql(), now, this.alarmCache);
    } catch (error) {
      await rearmAfterFailure(
        this.state,
        this.alarmCache,
        this.container.logger,
        now,
        error,
      );
    }
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
