import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { IdentityDirectoryUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import type {
  AttemptOutcomeDto,
  CredentialCoordinateDto,
  LoginCredentialDto,
  ReserveCredentialDto,
} from "@repo/core/application/identity/gateway";
import { toCredentialCoordinate } from "@repo/core/application/identity/rebuild";
import { reserveSignupCredentialProcedure } from "@repo/core/application/identity/reserveSignupCredential";
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
  requireEmailEncryptionKeyring,
} from "./crypto/keyring";
import { encodeMapping } from "./crypto/locatorDerivation";
import {
  AsyncWorkDurableObject,
  type StateWorkerEnv,
} from "./durableObjectBase";
import { createResumeSignupHandler } from "./jobs/resumeSignup";
import { createSweepReservationsHandler } from "./jobs/sweepReservations";
import { IDENTITY_DIRECTORY_PLAN } from "./schema/identityDirectoryPlan";
import { listMappedUserIds } from "./stores/credentialMappingStore";
import { createIdentityDirectoryUnitOfWorkProvider } from "./unitOfWork";

export type ReserveCredentialRpcInput = Readonly<{
  locator: MappingLocator;
  dto: ReserveCredentialDto;
  resumeAt: Date;
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
    super(ctx, env, {
      plan: IDENTITY_DIRECTORY_PLAN,
      allowInitialize: true,
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      jobRegistry: {
        "resume-signup": createResumeSignupHandler({
          env,
          activate: (input) => this.activateLocally(input),
        }),
        "sweep-reservations": createSweepReservationsHandler(),
      },
    });
  }

  protected createUnitOfWorkProvider() {
    return createIdentityDirectoryUnitOfWorkProvider({
      storage: this.ctx.storage,
      clock: this.config.clock,
      idGenerator: this.config.idGenerator,
      selfLocator: this.requireSelfLocator(),
    });
  }

  private encryptionKeyring(): EncryptionKeyring {
    this.keyring ??= requireEmailEncryptionKeyring(
      this.env.IDENTITY_MAIL_ENCRYPTION_KEY,
    );
    return this.keyring;
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
        reserveSignupCredentialProcedure(ctx, {
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
