import type {
  RpcEnvelope,
  SendMailMaterials,
} from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { IdentityDirectoryUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import {
  beginCredentialChangeProcedure,
  markCredentialChangeAdvancedProcedure,
  promoteVerifierProcedure,
} from "@repo/core/application/identity/credentialChangeProcedures";
import type {
  AttemptOutcomeDto,
  BeginCredentialChangeDto,
  ConsumedResetTokenDto,
  CredentialCoordinateDto,
  DeleteMappingDto,
  LoginCredentialDto,
  PromoteVerifierDto,
  ReserveCredentialDto,
} from "@repo/core/application/identity/gateway";
import { toCredentialCoordinate } from "@repo/core/application/identity/rebuild";
import {
  type ResetRequestProcedureInput,
  requestPasswordResetProcedure,
} from "@repo/core/application/identity/requestPasswordReset";
import { reserveCredentialProcedure } from "@repo/core/application/identity/reserveSignupCredential";
import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type {
  CredentialMappingRecord,
  MappingLocator,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { CredentialId, UserId } from "@repo/core/domain/identity/valueObject";
import { openCanonical, sealCanonical } from "./crypto/canonicalCipher";
import {
  type EncryptionKeyring,
  MIN_KEYRING_SECRET_LENGTH,
  requireEmailEncryptionKeyring,
} from "./crypto/keyring";
import { encodeMapping } from "./crypto/locatorDerivation";
import {
  AsyncWorkDurableObject,
  type StateWorkerEnv,
} from "./durableObjectBase";
import {
  createCredentialChangeCleanupHandler,
  credentialChangeHasCleanup,
} from "./jobs/cleanup/credentialChangeCleanup";
import { createSignupCleanupHandler } from "./jobs/cleanup/signupCleanup";
import { createResumeCredentialChangeHandler } from "./jobs/resumeCredentialChange";
import { createResumeSignupHandler } from "./jobs/resumeSignup";
import { createSweepReservationsHandler } from "./jobs/sweepReservations";
import { createSweepResetTokensHandler } from "./jobs/sweepResetTokens";
import { IDENTITY_DIRECTORY_PLAN } from "./schema/identityDirectoryPlan";
import {
  listMappedUserIds,
  readMappingCoordinate,
} from "./stores/credentialMappingStore";
import { readResetMailMaterials } from "./stores/sendMailMaterials";
import { createIdentityDirectoryUnitOfWorkProvider } from "./unitOfWork";

export type ReserveCredentialRpcInput = Readonly<{
  locator: MappingLocator;
  dto: ReserveCredentialDto;
  resumeAt: Date;
}>;

export type CommitSagaRpcInput = Readonly<{
  locator: MappingLocator;
  operationId: string;
}>;

export type ActivateReservationRpcInput = Readonly<{
  locator: MappingLocator;
  operationId: string;
  userId: string;
}>;

/**
 * One credential bucket. Buckets initialise themselves on first use — their
 * names are bounded by the keyring — and hold the mapping rows, the reset
 * tokens and the throttle windows for every canonical that hashes into them.
 * The canonical is sealed and opened here and nowhere else: the encryption
 * key never leaves the state Worker.
 */
export class IdentityDirectoryDurableObject extends AsyncWorkDurableObject<IdentityDirectoryUnitOfWorkContext> {
  private keyring: EncryptionKeyring | null = null;

  constructor(ctx: DurableObjectState, env: StateWorkerEnv) {
    const signupCleanup = createSignupCleanupHandler({
      env,
      bucket: () => this.bucket(),
    });
    const credentialChangeCleanup = createCredentialChangeCleanupHandler();
    super(ctx, env, {
      // The cleanup stages of `spec/recovery/index.md`: always for a
      // registration, and for a credential change only while its mapping
      // is still `pending` under this saga.
      terminalStage: (row, sql) => {
        if (row.kind === "resume-signup") return signupCleanup;
        if (
          row.kind === "resume-credential-change" &&
          credentialChangeHasCleanup(row, sql)
        ) {
          return credentialChangeCleanup;
        }
        return null;
      },
      plan: IDENTITY_DIRECTORY_PLAN,
      allowInitialize: true,
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      jobRegistry: {
        "resume-signup": createResumeSignupHandler({
          env,
          commit: (input) => this.commitLocally(input),
          activate: (input) => this.activateLocally(input),
          openCanonical: (row) =>
            openCanonical(
              this.encryptionKeyring(),
              { kind: row.kind, credentialId: row.credentialId },
              {
                ciphertext: row.ciphertext,
                encryptionGeneration: row.encryptionGeneration,
                nonce: row.nonce,
              },
            ),
        }),
        "sweep-reservations": createSweepReservationsHandler(),
        "sweep-reset-tokens": createSweepResetTokensHandler(),
        "resume-credential-change": createResumeCredentialChangeHandler({
          env,
          markAdvanced: (input) =>
            this.runUnitOfWork((ctx) =>
              markCredentialChangeAdvancedProcedure(
                ctx,
                input.coordinate,
                input.operationId,
              ),
            ),
          promote: (input) =>
            this.runUnitOfWork((ctx) =>
              promoteVerifierProcedure(ctx, input.coordinate, input.dto),
            ),
        }),
      },
    });
  }

  protected createUnitOfWorkProvider() {
    return createIdentityDirectoryUnitOfWorkProvider({
      storage: this.ctx.storage,
      clock: this.config.clock,
      idGenerator: this.config.idGenerator,
      selfLocator: this.requireSelfLocator(),
      resetTokenKey: this.resetTokenKey(),
      bucket: this.bucket(),
      identityTuning: createIdentityTuning(undefined, this.tuning()),
      resetTokenTtlMs: this.tuning().resetTokenTtlMs,
    });
  }

  /** `dir:g{generation}:b{index}` — this bucket's own coordinates. */
  private bucket(): { generation: number; bucketIndex: number } {
    const match = /^dir:g(\d+):b(\d+)$/.exec(this.requireSelfLocator());
    if (match === null) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "The directory bucket has no bucket-shaped locator",
      );
    }
    return { generation: Number(match[1]), bucketIndex: Number(match[2]) };
  }

  private resetTokenKey(): string {
    const key = this.env.IDENTITY_RESET_TOKEN_KEY;
    if (key === undefined || key.length < MIN_KEYRING_SECRET_LENGTH) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "IDENTITY_RESET_TOKEN_KEY is not configured",
      );
    }
    return key;
  }

  private encryptionKeyring(): EncryptionKeyring {
    this.keyring ??= requireEmailEncryptionKeyring(
      this.env.IDENTITY_MAIL_ENCRYPTION_KEY,
    );
    return this.keyring;
  }

  private commitLocally(input: CommitSagaRpcInput): Promise<boolean> {
    return this.runUnitOfWork((ctx) =>
      ctx.credentialMappingWriter.commitSaga({
        coordinate: {
          credentialId: CredentialId.create(input.locator.credentialId),
          kind: input.locator.kind,
          mapping: encodeMapping(input.locator),
        },
        operationId: input.operationId,
      }),
    );
  }

  private activateLocally(
    input: ActivateReservationRpcInput,
  ): Promise<boolean> {
    return this.runUnitOfWork((ctx) =>
      ctx.credentialMappingWriter.activateReservation({
        coordinate: {
          credentialId: CredentialId.create(input.locator.credentialId),
          kind: input.locator.kind,
          mapping: encodeMapping(input.locator),
        },
        operationId: input.operationId,
        userId: UserId.create(input.userId),
      }),
    );
  }

  /** Registration saga phase 1: seal outside the transaction, reserve inside it. */
  async reserveCredential(
    input: ReserveCredentialRpcInput,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const sealedCanonical = await sealCanonical(
        this.encryptionKeyring(),
        { kind: input.locator.kind, credentialId: input.locator.credentialId },
        input.dto.canonical,
      );
      await this.runUnitOfWork((ctx) => {
        reserveCredentialProcedure(ctx, {
          locator: input.locator,
          mapping: encodeMapping(input.locator),
          sealedCanonical,
          dto: input.dto,
          resumeAt: input.resumeAt,
        });
        return undefined;
      });
    });
  }

  /** The coordinator's mark between registration phases 2 and 3. */
  async commitSaga(input: CommitSagaRpcInput): Promise<RpcEnvelope<boolean>> {
    return this.envelope(() => this.commitLocally(input));
  }

  /** Registration saga phase 3. */
  async activateReservation(
    input: ActivateReservationRpcInput,
  ): Promise<RpcEnvelope<boolean>> {
    return this.envelope(() => this.activateLocally(input));
  }

  /** Login row resolution — the one read that carries the verifier out. */
  async resolveLoginCredential(
    locator: Omit<MappingLocator, "credentialId">,
  ): Promise<RpcEnvelope<LoginCredentialDto | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => {
        const mapping = encodeMapping(locator);
        const record = ctx.credentialMappingReader.findByLocator(
          locator.kind,
          mapping,
        );
        return record === null ? null : toLoginDto(record, mapping);
      }),
    );
  }

  async recordAttemptOutcome(input: {
    coordinate: CredentialCoordinateDto;
    outcome: AttemptOutcomeDto;
  }): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        ctx.credentialAttemptRecorder.recordAttemptOutcome(
          toCredentialCoordinate(input.coordinate),
          input.outcome,
        );
        return undefined;
      });
    });
  }

  /** One canonical, decrypted for its owner and nobody else. */
  async revealCanonical(input: {
    coordinate: CredentialCoordinateDto;
    userId: string;
  }): Promise<RpcEnvelope<string | null>> {
    return this.envelope(async () => {
      const coordinate = toCredentialCoordinate(input.coordinate);
      const record = await this.runUnitOfWork((ctx) =>
        ctx.credentialMappingReader.findByLocator(
          coordinate.kind,
          coordinate.mapping,
        ),
      );
      if (
        record === null ||
        record.userId !== input.userId ||
        record.credentialId !== coordinate.credentialId
      ) {
        return null;
      }
      const canonical = await openCanonical(
        this.encryptionKeyring(),
        { kind: coordinate.kind, credentialId: coordinate.credentialId },
        record.sealedCanonical,
      );
      if (canonical === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "The stored canonical could not be decrypted",
        );
      }
      return canonical;
    });
  }

  /** S-AC-07 phase 0: the whole request in one transaction (`requestPasswordResetProcedure`). */
  async requestPasswordReset(
    input: ResetRequestProcedureInput,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      const tuning = createIdentityTuning(undefined, this.tuning());
      await this.runUnitOfWork((ctx) => {
        requestPasswordResetProcedure(ctx, input, now, tuning);
        return undefined;
      });
    });
  }

  /** Consumes the token and answers with the coordinate the change saga needs. */
  async consumeResetToken(
    token: string,
  ): Promise<RpcEnvelope<ConsumedResetTokenDto | null>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      const bucket = this.bucket();
      const sql = this.ctx.storage.sql;
      return this.runUnitOfWork((ctx) => {
        const consumed = ctx.resetTokenStore.verifyAndConsume(token, now);
        if (consumed === null) return null;
        const credentialId = CredentialId.create(consumed.credentialId);
        const record =
          ctx.credentialMappingReader.findByCredentialId(credentialId);
        const coordinate = readMappingCoordinate(sql, consumed.credentialId);
        if (record === null || coordinate === null) return null;
        return {
          userId: consumed.userId,
          credentialId: consumed.credentialId,
          coordinate: {
            credentialId: consumed.credentialId,
            kind: coordinate.kind,
            mapping: encodeMapping({
              ...bucket,
              kind: coordinate.kind,
              hmac: coordinate.hmac,
            }),
          },
          hasVerifier: record.passwordVerifier !== null,
          changeAuthToken: consumed.changeAuthToken,
        };
      });
    });
  }

  /** Credential-change saga phase 1. */
  async beginCredentialChange(input: {
    coordinate: CredentialCoordinateDto;
    dto: BeginCredentialChangeDto;
    resumeAt: Date;
  }): Promise<RpcEnvelope<boolean>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        beginCredentialChangeProcedure(
          ctx,
          input.coordinate,
          input.dto,
          input.resumeAt,
        ),
      ),
    );
  }

  /** Credential-change saga phase 3a. */
  async markCredentialChangeAdvanced(input: {
    coordinate: CredentialCoordinateDto;
    operationId: string;
  }): Promise<RpcEnvelope<boolean>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        markCredentialChangeAdvancedProcedure(
          ctx,
          input.coordinate,
          input.operationId,
        ),
      ),
    );
  }

  /** Credential-change saga phase 3b. */
  async promoteVerifier(input: {
    coordinate: CredentialCoordinateDto;
    dto: PromoteVerifierDto;
  }): Promise<RpcEnvelope<boolean>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        promoteVerifierProcedure(ctx, input.coordinate, input.dto),
      ),
    );
  }

  async cancelReservation(input: {
    locator: MappingLocator;
    callerToken: string;
  }): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        ctx.credentialMappingWriter.cancelReservation({
          coordinate: {
            credentialId: CredentialId.create(input.locator.credentialId),
            kind: input.locator.kind,
            mapping: encodeMapping(input.locator),
          },
          callerToken: input.callerToken,
        });
        return undefined;
      });
    });
  }

  /** Unlink: the row and its tokens go, only for the owner presenting the caller token. */
  async deleteMapping(input: {
    coordinate: CredentialCoordinateDto;
    dto: DeleteMappingDto;
  }): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        ctx.credentialMappingWriter.deleteMapping({
          coordinate: toCredentialCoordinate(input.coordinate),
          userId: UserId.create(input.dto.userId),
          callerToken: input.dto.callerToken,
        });
        return undefined;
      });
    });
  }

  /** The send-materials RPC; the guard lives in `readResetMailMaterials`. Passes the gate, writes nothing. */
  async getResetMailMaterials(input: {
    eventId: string;
    ownerToken: string | null | undefined;
  }): Promise<RpcEnvelope<SendMailMaterials>> {
    return this.envelope(async () => {
      await this.enterRpc();
      return readResetMailMaterials(this.ctx.storage.sql, input, {
        resetTokenKey: this.resetTokenKey(),
        providerIdempotencyKey: this.providerIdempotencyKey(),
        bucket: this.bucket(),
        encryptionKeyring: this.encryptionKeyring(),
        nowMs: this.config.clock.now().getTime(),
      });
    });
  }

  private providerIdempotencyKey(): string {
    const key = this.env.PROVIDER_IDEMPOTENCY_KEY;
    if (key === undefined || key.length < MIN_KEYRING_SECRET_LENGTH) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "PROVIDER_IDEMPOTENCY_KEY is not configured",
      );
    }
    return key;
  }

  /**
   * Operator entry, the last resort of a withdrawal
   * (`spec/database/index.md`): every mapping row this bucket holds for
   * the account, whatever its `status`, and the reset tokens of those
   * credentials. The only deletion an operator may issue without a caller
   * token, which is why it is not on the identity gateway.
   */
  async purgeUserMappings(
    userId: string,
  ): Promise<RpcEnvelope<{ deletedMappings: number; deletedTokens: number }>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const sql = this.ctx.storage.sql;
      return this.ctx.storage.transactionSync(() => {
        const ids = sql
          .exec<{ credential_id: string }>(
            "SELECT credential_id FROM credential_mappings WHERE user_id = ?",
            userId,
          )
          .toArray()
          .map((row) => row.credential_id);
        let deletedTokens = 0;
        for (const id of ids) {
          deletedTokens += sql
            .exec<{ credential_id: string }>(
              "DELETE FROM password_reset_tokens WHERE credential_id = ? RETURNING credential_id",
              id,
            )
            .toArray().length;
        }
        const deletedMappings = sql
          .exec<{ credential_id: string }>(
            "DELETE FROM credential_mappings WHERE user_id = ? RETURNING credential_id",
            userId,
          )
          .toArray().length;
        return { deletedMappings, deletedTokens };
      });
    });
  }

  /** Diagnostics: the `userId`s that hold a mapping in this bucket. Passes the gate, writes nothing. */
  async listBucketUserIds(): Promise<RpcEnvelope<readonly string[]>> {
    return this.envelope(async () => {
      await this.enterRpc();
      return listMappedUserIds(this.ctx.storage.sql);
    });
  }
}

function toLoginDto(
  record: CredentialMappingRecord,
  mapping: string,
): LoginCredentialDto {
  return {
    coordinate: {
      credentialId: record.credentialId,
      kind: record.kind,
      mapping,
    },
    userId: record.userId,
    credentialVersion: record.credentialVersion,
    changeState: record.changeState,
    changeOrigin: record.changeOrigin,
    failedAttempts: record.failedAttempts,
    nextAttemptAllowedAt: record.nextAttemptAllowedAt,
    passwordVerifier: record.passwordVerifier,
  };
}
