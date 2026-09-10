import type {
  RpcEnvelope,
  SendMailMaterials,
} from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  IdentityDirectoryUnitOfWorkContext,
  RotationCheckpoint,
  RotationKind,
} from "@repo/core/application/execution/unitOfWork";
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
import { ROTATE_ENCRYPTION_OPERATION_KEY } from "@repo/core/application/identity/jobKeys";
import { toCredentialCoordinate } from "@repo/core/application/identity/rebuild";
import {
  type ResetRequestProcedureInput,
  requestPasswordResetProcedure,
} from "@repo/core/application/identity/requestPasswordReset";
import { reserveCredentialProcedure } from "@repo/core/application/identity/reserveSignupCredential";
import type {
  ImportOutcome,
  RemapChunkResult,
} from "@repo/core/application/identity/rotation/transfer";
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
  activeKey,
  type EncryptionKeyring,
  encryptionKeyringFromEnv,
  type KeyCommitment,
  keyCommitmentFromEnv,
  MIN_KEYRING_SECRET_LENGTH,
  previousKey,
} from "./crypto/keyring";
import { encodeMapping } from "./crypto/locatorDerivation";
import { callDurableObject, directoryStub, userDataStub } from "./doStubs";
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
import { createRotateEncryptionHandler } from "./jobs/rotateEncryption";
import { createSweepReservationsHandler } from "./jobs/sweepReservations";
import { createSweepResetTokensHandler } from "./jobs/sweepResetTokens";
import { isInitialized } from "./migrationGate";
import {
  type ImportRemappedMappingsInput,
  importRemappedMappings,
} from "./rotation/importRemappedMappings";
import { type RemapChunkInput, runRemapChunk } from "./rotation/remapChunk";
import { IDENTITY_DIRECTORY_PLAN } from "./schema/identityDirectoryPlan";
import {
  listMappedUserIds,
  readMappingCoordinate,
} from "./stores/credentialMappingStore";
import { readRotationCheckpoint } from "./stores/rotationCheckpointStore";
import { readResetMailMaterials } from "./stores/sendMailMaterials";
import { createIdentityDirectoryUnitOfWorkProvider } from "./unitOfWork";
import type { UserDataDurableObject } from "./userDataDurableObject";

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
        "rotate-encryption": createRotateEncryptionHandler({
          encryptionKeyring: () => this.encryptionKeyring(),
          bucket: () => this.bucket(),
          runUnitOfWork: (fn) => this.runUnitOfWork(fn),
        }),
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

  /**
   * Read from the environment on every use rather than cached: the two
   * variables change with a deploy, and the integration suites swap them
   * on a live instance to drive a rotation in both directions.
   */
  private encryptionKeyring(): EncryptionKeyring {
    return encryptionKeyringFromEnv(
      this.env.IDENTITY_MAIL_ENCRYPTION_KEYRING,
      this.env.IDENTITY_MAIL_ENCRYPTION_KEY,
    );
  }

  /** The key commitment, or `null` while the deployment is single-generation. */
  private keyCommitment(): KeyCommitment | null {
    return keyCommitmentFromEnv(this.env.DIRECTORY_KEY_COMMITMENT);
  }

  /** The commitment's `active` mapping generation; `null` degrades the generation guard to the identity. */
  private activeMappingGeneration(): number | null {
    const commitment = this.keyCommitment();
    return commitment === null ? null : activeKey(commitment).generation;
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
      const activeGeneration = this.activeMappingGeneration();
      await this.runUnitOfWork((ctx) => {
        reserveCredentialProcedure(ctx, {
          locator: input.locator,
          mapping: encodeMapping(input.locator),
          sealedCanonical,
          dto: input.dto,
          resumeAt: input.resumeAt,
          activeGeneration,
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

  /**
   * Unlink / withdrawal: the row and its tokens go, only for the owner
   * presenting the caller token. Absent is success, and the answer says
   * which of the two it was — `deleted: false` is the no-op the deletion
   * sagas must re-issue once when the coordinates span two generations
   * (`spec/rotation/index.md`, 削除の no-op 確定). The domain port keeps
   * its `void`; the distinction is read here, around it, from the row's
   * presence before and after.
   */
  async deleteMapping(input: {
    coordinate: CredentialCoordinateDto;
    dto: DeleteMappingDto;
  }): Promise<RpcEnvelope<{ deleted: boolean }>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => {
        const coordinate = toCredentialCoordinate(input.coordinate);
        const before = ctx.credentialMappingReader.findByLocator(
          coordinate.kind,
          coordinate.mapping,
        );
        ctx.credentialMappingWriter.deleteMapping({
          coordinate,
          userId: UserId.create(input.dto.userId),
          callerToken: input.dto.callerToken,
        });
        const after = ctx.credentialMappingReader.findByLocator(
          coordinate.kind,
          coordinate.mapping,
        );
        return { deleted: before !== null && after === null };
      }),
    );
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

  /**
   * `remap-chunk` (`spec/rotation/index.md`): one chunk of the transfer
   * out of this bucket. The keys arrive as arguments and are kept
   * nowhere; the guards and the per-row order are `runRemapChunk`'s.
   * Adds no runnable row, so the Alarm is not re-armed.
   */
  async remapChunk(
    input: RemapChunkInput,
  ): Promise<RpcEnvelope<RemapChunkResult>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const userData = this.env.USER_DATA;
      const directory = this.env.IDENTITY_DIRECTORY;
      if (userData === undefined || directory === undefined) {
        throw new SystemError(
          SystemErrorCode.ConfigurationError,
          "remap-chunk: the Durable Object bindings are not configured",
        );
      }
      return runRemapChunk(
        {
          storage: this.ctx.storage,
          bucket: this.bucket(),
          encryptionKeyring: this.encryptionKeyring(),
          commitment: this.keyCommitment(),
          runUnitOfWork: (fn) => this.runUnitOfWork(fn),
          recordRemappedLocator: (userId, dto) =>
            callDurableObject(() =>
              (
                userDataStub(
                  userData,
                  userId,
                ) as unknown as UserDataDurableObject
              ).recordRemappedLocator(dto),
            ),
          importRow: async (destination, active, row) => {
            const outcomes = await callDurableObject(() =>
              (
                directoryStub(
                  directory,
                  destination,
                ) as unknown as IdentityDirectoryDurableObject
              ).importRemappedMappings({ active, rows: [row] }),
            );
            return outcomes[0] ?? "rejected";
          },
          now: () => this.config.clock.now().getTime(),
          logger: this.config.logger,
        },
        input,
      );
    });
  }

  /** `import-remapped-mappings`: the destination side of the transfer. No runnable row is added; no re-arm. */
  async importRemappedMappings(
    input: ImportRemappedMappingsInput,
  ): Promise<RpcEnvelope<ImportOutcome[]>> {
    return this.envelope(async () => {
      await this.enterRpc();
      return importRemappedMappings(
        {
          sql: this.ctx.storage.sql,
          bucket: this.bucket(),
          encryptionKeyring: this.encryptionKeyring(),
          commitment: this.keyCommitment(),
          runUnitOfWork: (fn) => this.runUnitOfWork(fn),
          logger: this.config.logger,
        },
        input,
      );
    });
  }

  /** `read-rotation-checkpoint`: this bucket's row for the kind and generation, or `null` for "not yet scanned". Read-only. */
  async readRotationCheckpoint(input: {
    rotationKind: RotationKind;
    generation: number;
  }): Promise<RpcEnvelope<RotationCheckpoint | null>> {
    return this.envelope(async () => {
      await this.enterRpc();
      return readRotationCheckpoint(
        this.ctx.storage.sql,
        input.rotationKind,
        this.bucket().bucketIndex,
        input.generation,
      );
    });
  }

  /**
   * `start-rotate-encryption` (`spec/rotation/index.md`, 直列化): the one
   * entry point of the `rotate-encryption` job. Refused while the key
   * commitment carries a `previous` mapping generation — the two
   * rotations never run at once — and while the encryption keyring
   * carries no `previous` to retire. The unit of work's enqueue re-arms
   * the Alarm.
   */
  async startRotateEncryption(): Promise<
    RpcEnvelope<{ retiringGeneration: number }>
  > {
    return this.envelope(async () => {
      const commitment = this.keyCommitment();
      if (commitment !== null && previousKey(commitment) !== null) {
        throw new SystemError(
          SystemErrorCode.ConfigurationError,
          "A mapping-key rotation is open: the commitment carries a previous generation",
        );
      }
      const previous = previousKey(this.encryptionKeyring());
      if (previous === null) {
        throw new SystemError(
          SystemErrorCode.ConfigurationError,
          "The encryption keyring carries no previous generation to retire",
        );
      }
      const now = this.config.clock.now();
      await this.runUnitOfWork((ctx) => {
        ctx.enqueueJob({
          operationKey: ROTATE_ENCRYPTION_OPERATION_KEY,
          kind: "rotate-encryption",
          payload: { retiringGeneration: previous.generation },
          nextRunAt: now,
        });
        return undefined;
      });
      return { retiringGeneration: previous.generation };
    });
  }

  /**
   * Diagnostics: the `userId`s that hold a mapping in this bucket.
   *
   * The second of the two entries outside the gate's scope
   * (`spec/database/index.md`, fail-closed; `spec/recovery/index.md`,
   * exception group (a)): it neither initialises an object nor refuses a
   * bucket whose `schema_version` is ahead of this build, because it is
   * how an operator maps the blast radius of a fail-closed deploy — the
   * PITR procedure walks every bucket through it. A bucket that was never
   * initialised answers `[]` and stays at zero bytes; the read depends on
   * two columns that exist in every version of the table.
   */
  async listBucketUserIds(): Promise<RpcEnvelope<readonly string[]>> {
    return this.envelope(async () => {
      const sql = this.ctx.storage.sql;
      if (!isInitialized(sql)) return [];
      return listMappedUserIds(sql);
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
