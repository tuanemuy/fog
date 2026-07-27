import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  AccountAuthSummary,
  AccountHomePort,
  AuthenticatedUserDataRouter,
  CredentialDirectoryPort,
  CredentialKind,
  CredentialRef,
  CurrentAccount,
  DirectoryReference,
  DirectoryCredential,
  DirectoryAuthorityRow,
  IdentityApplicationPort,
  IdentityOperation,
  IdentityPrimitivePort,
  IdentityRegistration,
  IdentityRpcMutation,
  IdentityRpcQuery,
  OperationId,
  PasswordCredential,
  RpcError,
  RpcResult,
  UserDataIdentityPort,
  UserDataIdentityProfile,
  UserDataIdentityStatus,
} from "@repo/core/application/identity/contracts";
import { operationId } from "@repo/core/application/identity/contracts";
import { IdentityCoordinator } from "@repo/core/application/identity/coordinator";
import { CanonicalAuthenticatedUserDataRouter } from "@repo/core/application/identity/authenticatedUserDataRouter";
import { rpcMutation, rpcQuery } from "@repo/core/application/identity/rpc";
import type { Email, UserId } from "@repo/core/domain/identity/valueObject";
import {
  Email as EmailValue,
  SsoProvider as SsoProviderValue,
  SsoSubject as SsoSubjectValue,
  UserId as UserIdValue,
} from "@repo/core/domain/identity/valueObject";
import {
  canonicalPasswordCredential,
  credentialLocators,
  decodeDirectoryReference,
  type DirectoryKeyring,
  encodeDirectoryReference,
  validateDirectoryKeyring,
} from "./identityRouting";
import { decryptIdentityValue, encryptIdentityValue } from "./identityEnvelope";
import type {
  PhysicalCredentialLocator,
  StoredCredentialRef,
  StoredDirectoryCredential,
} from "./identityPhysical";
import type { PhysicalDirectoryAuthorityRow } from "./identity-directory/store";
import type { PhysicalAccountAuthSummary } from "./account-home/store";

type RotationRow = Readonly<{
  locator: PhysicalCredentialLocator;
  credential: StoredCredentialRef;
  userId: UserId;
  operationId: OperationId;
  accountEpoch: number;
}>;

function errorChainIncludes(error: unknown, fragment: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes(fragment)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

type DirectoryStub = {
  lookupPasswordSignup(
    input: IdentityRpcQuery<{ opaqueOperationKey: string }>,
  ): Promise<
    RpcResult<{
      userId: string;
      emailEncrypted: string;
      passwordHash: string;
      preparedAt: number;
    } | null>
  >;
  preparePasswordSignup(
    input: IdentityRpcMutation<{
      opaqueOperationKey: string;
      proposedUserId: string;
      emailEncrypted: string;
      passwordHash: string;
      now: number;
    }>,
  ): Promise<
    RpcResult<{
      userId: string;
      passwordHash: string;
      preparedAt: number;
      replayed: boolean;
    }>
  >;
  prepareSsoCreate(
    input: IdentityRpcMutation<{
      opaqueOperationKey: string;
      proposedUserId: string;
      provider: string;
      subjectEncrypted: string;
      emailEncrypted: string;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string; replayed: boolean }>>;
  reserve(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      credential: StoredCredentialRef;
      userId: string;
      accountEpoch: number;
      now: number;
      reservationExpiresAt: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>>;
  markInitialized(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  activate(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>>;
  lookupPassword(
    input: IdentityRpcQuery<{ locator: PhysicalCredentialLocator }>,
  ): Promise<RpcResult<StoredDirectoryCredential | null>>;
  lookup(
    input: IdentityRpcQuery<{ locator: PhysicalCredentialLocator }>,
  ): Promise<RpcResult<StoredDirectoryCredential | null>>;
  replacePassword(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      passwordHash: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  tombstone(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  purge(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
    }>,
  ): Promise<RpcResult<null>>;
  storePasswordReset(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      tokenHash: string;
      expiresAt: number;
    }>,
  ): Promise<RpcResult<null>>;
  enqueuePasswordResetMail(
    input: IdentityRpcMutation<{
      userId: string;
      email: string;
      resetSecret: string;
      expiresAt: number;
      providerIdempotencyKey: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  lookupPasswordReset(
    input: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      tokenHash: string;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: UserId } | null>>;
  consumePasswordReset(
    input: IdentityRpcMutation<{ tokenHash: string; now: number }>,
  ): Promise<RpcResult<{ userId: UserId } | null>>;
  scanForAuthorityReconcile(
    input: IdentityRpcQuery<{
      generation: string;
      bucket: number;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<
    RpcResult<{
      rows: readonly PhysicalDirectoryAuthorityRow[];
      nextCursor: string | null;
    }>
  >;
  scanForRotation(
    input: IdentityRpcQuery<{
      generation: string;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<
    RpcResult<{ rows: readonly RotationRow[]; nextCursor: string | null }>
  >;
  saveRotationCheckpoint(
    input: IdentityRpcMutation<{
      generation: string;
      bucket: number;
      cursor: string | null;
      scanned: number;
      moved: number;
      conflicts: number;
      completedAt: number | null;
    }>,
  ): Promise<RpcResult<null>>;
  getRotationCheckpoint(
    input: IdentityRpcQuery<{ generation: string; bucket: number }>,
  ): Promise<
    RpcResult<{
      generation: string;
      bucket: number;
      cursor: string | null;
      scanned: number;
      moved: number;
      conflicts: number;
      completedAt: number | null;
    } | null>
  >;
  operatorGetShardAuthorityStatus(
    input: IdentityRpcQuery<Record<string, never>>,
  ): Promise<
    RpcResult<{
      mappings: number;
      reserved: number;
      initialized: number;
      active: number;
      tombstoned: number;
      minimumAccountEpoch: number | null;
      maximumAccountEpoch: number | null;
      restoredSessionMarker: string | null;
      restoredSessionVerifiedAt: number | null;
    }>
  >;
  operatorMarkRestoredSession(
    input: IdentityRpcMutation<{ marker: string; now: number }>,
  ): Promise<RpcResult<null>>;
  expiredReservations(
    input: IdentityRpcQuery<{ now: number; limit: number }>,
  ): Promise<RpcResult<readonly RotationRow[]>>;
};

type AccountHomeStub = {
  beginOperation(
    input: IdentityRpcMutation<{
      userId: string;
      kind: Parameters<AccountHomePort["beginOperation"]>[0]["kind"];
      payloadDigest: string;
      primaryEmail?: string;
      now: number;
    }>,
  ): Promise<RpcResult<IdentityOperation>>;
  advanceOperation(
    input: IdentityRpcMutation<{
      userId: string;
      expectedState: Parameters<
        AccountHomePort["advanceOperation"]
      >[0]["expectedState"];
      nextState: Parameters<
        AccountHomePort["advanceOperation"]
      >[0]["nextState"];
      locator?: PhysicalCredentialLocator;
      credential?: Parameters<
        AccountHomePort["advanceOperation"]
      >[0]["credential"];
      primaryEmail?: string;
      bumpSessionEpoch?: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<IdentityOperation>>;
  getOperation(
    input: IdentityRpcQuery<{ operationId: string }>,
  ): Promise<RpcResult<IdentityOperation | null>>;
  getAuthSummary(
    input: IdentityRpcQuery<Record<string, never>>,
  ): Promise<RpcResult<PhysicalAccountAuthSummary | null>>;
  compensateCreate(
    input: IdentityRpcMutation<{ userId: string; now: number }>,
  ): Promise<RpcResult<null>>;
  addCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      locator: PhysicalCredentialLocator;
      credential: Parameters<
        AccountHomePort["addCredentialLocator"]
      >[0]["credential"];
      primaryEmail?: string;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<PhysicalAccountAuthSummary>>;
  removeCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      credentialId: string;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<PhysicalAccountAuthSummary>>;
  replaceCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      previous: PhysicalCredentialLocator;
      active: PhysicalCredentialLocator;
      kind: CredentialKind;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  beginDeletionV1(
    input: IdentityRpcMutation<{ userId: string; now: number }>,
  ): Promise<
    RpcResult<{
      epoch: number;
      state: Parameters<AccountHomePort["advanceOperation"]>[0]["nextState"];
      locators: readonly PhysicalCredentialLocator[];
    }>
  >;
  finishDeletionV1(
    input: IdentityRpcMutation<{
      userId: string;
      epoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ completed: boolean }>>;
};

type UserDataStub = {
  identityInitializeV1(
    input: IdentityRpcMutation<{ userId: string; now: number }>,
  ): Promise<RpcResult<{ userId: string; trashRetentionDays: number }>>;
  identityGetProfileV1(input: IdentityRpcQuery<{ userId: string }>): Promise<
    RpcResult<{
      userId: string;
      trashRetentionDays: number;
      displayName?: string | null;
    }>
  >;
  identityGetStatusV1(
    input: IdentityRpcQuery<{ userId: string }>,
  ): Promise<RpcResult<UserDataIdentityStatus>>;
  identityDeleteAllV1(
    input: IdentityRpcMutation<{ userId: string }>,
  ): Promise<RpcResult<{ deleted: true }>>;
};

class RemoteIdentityError extends Error {
  readonly overloaded: boolean;

  constructor(readonly detail: RpcError) {
    super(detail.message);
    this.name = "RemoteIdentityError";
    this.overloaded = detail.code === "OVERLOADED";
  }

  get retryable(): boolean {
    return this.detail.retryable;
  }
}

function stub<T>(namespace: DurableObjectNamespace, name: string): T {
  return namespace.get(namespace.idFromName(name)) as unknown as T;
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw new RemoteIdentityError(result.error);
}

async function retryRpc<T>(operation: () => Promise<RpcResult<T>>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return unwrap(await operation());
    } catch (error) {
      const retryable =
        error instanceof RemoteIdentityError
          ? error.retryable && !error.overloaded
          : error instanceof Error &&
            "retryable" in error &&
            error.retryable === true &&
            !("overloaded" in error && error.overloaded === true);
      if (!retryable || attempt >= 2) {
        throw translate(error);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function translate(error: unknown): Error {
  if (!(error instanceof RemoteIdentityError)) {
    return new SystemError(
      SystemErrorCode.NetworkError,
      "Identity RPC failed",
      error,
    );
  }
  switch (error.detail.kind) {
    case "conflict":
      return new ConflictError(error.detail.code, error.detail.message, error);
    case "not-found":
      return new NotFoundError(error.detail.code, error.detail.message, error);
    case "validation":
      return new ValidationError(
        error.detail.code,
        error.detail.message,
        undefined,
        error,
      );
    case "infrastructure":
      return new SystemError(
        error.detail.code === "SQLITE_FULL"
          ? SystemErrorCode.StorageCapacityExceeded
          : SystemErrorCode.NetworkError,
        error.detail.message,
        error,
      );
  }
}

class CloudflareCredentialDirectoryAdapter implements CredentialDirectoryPort {
  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly keyring: DirectoryKeyring,
  ) {}

  async references(
    canonicalCredential: string,
  ): Promise<readonly DirectoryReference[]> {
    return (await credentialLocators(canonicalCredential, this.keyring)).map(
      encodeDirectoryReference,
    );
  }

  async lookupPassword(
    email: Email,
  ): Promise<readonly (PasswordCredential | null)[]> {
    const references = await this.references(
      canonicalPasswordCredential(email),
    );
    return Promise.all(
      references.map(async (directoryReference) => {
        const locator = decodeDirectoryReference(directoryReference);
        const stored = await retryRpc(() =>
          this.forLocator(locator).lookupPassword(rpcQuery({ locator })),
        );
        if (stored?.credential.kind !== "password") return null;
        return {
          userId: stored.userId,
          credentialId: stored.credential.credentialId,
          email: EmailValue.create(
            await decryptIdentityValue(
              stored.credential.emailEncrypted,
              this.keyring,
              `credential:${stored.credential.credentialId}:email`,
            ),
          ),
          passwordHash: stored.credential.passwordHash,
          directoryReference,
          accountEpoch: stored.accountEpoch,
        };
      }),
    );
  }

  async lookupCredential(
    canonicalCredential: string,
  ): Promise<readonly (DirectoryCredential | null)[]> {
    const references = await this.references(canonicalCredential);
    return Promise.all(
      references.map(async (directoryReference) => {
        const locator = decodeDirectoryReference(directoryReference);
        const stored = await retryRpc(() =>
          this.forLocator(locator).lookup(rpcQuery({ locator })),
        );
        return stored
          ? this.toDirectoryCredential(stored, directoryReference)
          : null;
      }),
    );
  }

  async preparePasswordSignup(
    input: Parameters<CredentialDirectoryPort["preparePasswordSignup"]>[0],
  ): ReturnType<CredentialDirectoryPort["preparePasswordSignup"]> {
    const operationDigest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input.operationId),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const operationRegistry = stub<DirectoryStub>(
      this.namespace,
      `signup-operation:${operationDigest}`,
    );
    const existing = await retryRpc(() =>
      operationRegistry.lookupPasswordSignup(
        rpcQuery({ opaqueOperationKey: operationDigest }),
      ),
    );
    if (existing) {
      try {
        const existingEmail = EmailValue.create(
          await decryptIdentityValue(
            existing.emailEncrypted,
            this.keyring,
            `signup-operation:${operationDigest}:email`,
          ),
        );
        if (existingEmail !== input.email) {
          throw new ConflictError(
            "IDENTITY_OPERATION_PAYLOAD_CONFLICT",
            "Signup operation does not match its original email",
          );
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "IDENTITY_ENVELOPE_KEY_UNAVAILABLE"
        ) {
          throw error;
        }
      }
      return {
        userId: UserIdValue.create(existing.userId),
        passwordHash:
          existing.passwordHash as PasswordCredential["passwordHash"],
        preparedAt: existing.preparedAt,
        replayed: true,
      };
    }
    const emailEncrypted = await encryptIdentityValue(
      input.email,
      this.keyring,
      `signup-operation:${operationDigest}:email`,
    );
    const prepared = await retryRpc(() =>
      operationRegistry.preparePasswordSignup(
        rpcMutation(input.operationId, {
          opaqueOperationKey: operationDigest,
          proposedUserId: input.proposedUserId,
          emailEncrypted,
          passwordHash: input.passwordHash,
          now: input.now,
        }),
      ),
    );
    return {
      userId: UserIdValue.create(prepared.userId),
      passwordHash: prepared.passwordHash as PasswordCredential["passwordHash"],
      preparedAt: prepared.preparedAt,
      replayed: prepared.replayed,
    };
  }

  async prepareSsoCreate(
    input: Parameters<CredentialDirectoryPort["prepareSsoCreate"]>[0],
  ): ReturnType<CredentialDirectoryPort["prepareSsoCreate"]> {
    const operationDigest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input.operationId),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const registry = stub<DirectoryStub>(
      this.namespace,
      `sso-operation:${operationDigest}`,
    );
    const [subjectEncrypted, emailEncrypted] = await Promise.all([
      encryptIdentityValue(
        input.subject,
        this.keyring,
        `sso-operation:${operationDigest}:subject`,
      ),
      encryptIdentityValue(
        input.email,
        this.keyring,
        `sso-operation:${operationDigest}:email`,
      ),
    ]);
    const prepared = await retryRpc(() =>
      registry.prepareSsoCreate(
        rpcMutation(input.operationId, {
          opaqueOperationKey: operationDigest,
          proposedUserId: input.proposedUserId,
          provider: input.provider,
          subjectEncrypted,
          emailEncrypted,
          now: input.now,
        }),
      ),
    );
    return {
      userId: UserIdValue.create(prepared.userId),
      replayed: prepared.replayed,
    };
  }

  async reserve(
    input: Parameters<CredentialDirectoryPort["reserve"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    const credential = await this.toStoredCredential(
      input.credentialId,
      input.credential,
    );
    await retryRpc(() =>
      this.forLocator(locator).reserve(
        rpcMutation(input.operationId, {
          locator,
          credential,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
          reservationExpiresAt: input.now + 15 * 60_000,
        }),
      ),
    );
  }

  async markInitialized(
    input: Parameters<CredentialDirectoryPort["markInitialized"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).markInitialized(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
  }

  async activate(
    input: Parameters<CredentialDirectoryPort["activate"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).activate(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async replacePassword(
    input: Parameters<CredentialDirectoryPort["replacePassword"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).replacePassword(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          passwordHash: input.passwordHash,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async tombstone(
    input: Parameters<CredentialDirectoryPort["tombstone"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).tombstone(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async purge(
    input: Parameters<CredentialDirectoryPort["purge"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).purge(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
        }),
      ),
    );
  }

  async storePasswordReset(
    input: Parameters<CredentialDirectoryPort["storePasswordReset"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).storePasswordReset(
        rpcMutation(input.operationId, {
          locator,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        }),
      ),
    );
  }

  async enqueuePasswordResetMail(
    input: Parameters<CredentialDirectoryPort["enqueuePasswordResetMail"]>[0],
  ): Promise<void> {
    const locator = decodeDirectoryReference(input.directoryReference);
    await retryRpc(() =>
      this.forLocator(locator).enqueuePasswordResetMail(
        rpcMutation(input.operationId, {
          userId: input.userId,
          email: input.email,
          resetSecret: input.resetSecret,
          expiresAt: input.expiresAt,
          providerIdempotencyKey: input.providerIdempotencyKey,
          now: input.now,
        }),
      ),
    );
  }

  lookupPasswordReset(
    input: Parameters<CredentialDirectoryPort["lookupPasswordReset"]>[0],
  ): Promise<{ userId: UserId } | null> {
    const locator = decodeDirectoryReference(input.directoryReference);
    return retryRpc(() =>
      this.forLocator(locator).lookupPasswordReset(
        rpcMutation(input.operationId, {
          locator,
          tokenHash: input.tokenHash,
          now: input.now,
        }),
      ),
    );
  }

  consumePasswordReset(
    input: Parameters<CredentialDirectoryPort["consumePasswordReset"]>[0],
  ): Promise<{ userId: UserId } | null> {
    const locator = decodeDirectoryReference(input.directoryReference);
    return retryRpc(() =>
      this.forLocator(locator).consumePasswordReset(
        rpcMutation(input.operationId, {
          tokenHash: input.tokenHash,
          now: input.now,
        }),
      ),
    );
  }

  async scanForAuthorityReconcile(input: {
    generation: string;
    bucket: number;
    cursor?: string;
    limit: number;
  }): Promise<{
    rows: readonly DirectoryAuthorityRow[];
    nextCursor: string | null;
  }> {
    const page = await retryRpc(() =>
      this.forBucket(input.generation, input.bucket).scanForAuthorityReconcile(
        rpcQuery({
          generation: input.generation,
          bucket: input.bucket,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: input.limit,
        }),
      ),
    );
    return {
      rows: page.rows.map((row) => ({
        directoryReference: encodeDirectoryReference(row.locator),
        userId: row.userId,
        operationId: row.operationId,
        state: row.state,
        accountEpoch: row.accountEpoch,
      })),
      nextCursor: page.nextCursor,
    };
  }

  scanForRotation(input: {
    generation: string;
    bucket: number;
    cursor?: string;
    limit: number;
  }): Promise<{
    rows: readonly RotationRow[];
    nextCursor: string | null;
  }> {
    return retryRpc(() =>
      this.forBucket(input.generation, input.bucket).scanForRotation(
        rpcQuery({
          generation: input.generation,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: input.limit,
        }),
      ),
    );
  }

  async saveRotationCheckpoint(input: {
    generation: string;
    bucket: number;
    cursor: string | null;
    scanned: number;
    moved: number;
    conflicts: number;
    completedAt: number | null;
  }): Promise<void> {
    const checkpointId = operationId(
      [
        "rotation-checkpoint",
        input.generation,
        input.bucket,
        input.cursor ?? "done",
        input.scanned,
        input.moved,
        input.conflicts,
        input.completedAt ?? "pending",
      ].join(":"),
    );
    await retryRpc(() =>
      this.forBucket(input.generation, input.bucket).saveRotationCheckpoint(
        rpcMutation(checkpointId, input),
      ),
    );
  }

  expiredReservations(input: {
    generation: string;
    bucket: number;
    now: number;
    limit: number;
  }): Promise<readonly RotationRow[]> {
    return retryRpc(() =>
      this.forBucket(input.generation, input.bucket).expiredReservations(
        rpcQuery({ now: input.now, limit: input.limit }),
      ),
    );
  }

  rotationCheckpoint(generation: string, bucket: number) {
    return retryRpc(() =>
      this.forBucket(generation, bucket).getRotationCheckpoint(
        rpcQuery({ generation, bucket }),
      ),
    );
  }

  shardAuthorityStatus(generation: string, bucket: number) {
    return retryRpc(() =>
      this.forBucket(generation, bucket).operatorGetShardAuthorityStatus(
        rpcQuery({}),
      ),
    );
  }

  async markRestoredSession(
    generation: string,
    bucket: number,
    marker: string,
    now: number,
  ): Promise<void> {
    await retryRpc(() =>
      this.forBucket(generation, bucket).operatorMarkRestoredSession(
        rpcMutation(operationId(`restore-verify:${generation}:${bucket}`), {
          marker,
          now,
        }),
      ),
    );
  }

  private async toStoredCredential(
    credentialId: string,
    credential: CredentialRef,
  ): Promise<StoredCredentialRef> {
    const canonicalValueEncrypted = await encryptIdentityValue(
      credential.canonicalValue,
      this.keyring,
      `credential:${credentialId}:canonical`,
    );
    if (credential.kind === "password") {
      return {
        credentialId,
        kind: "password",
        canonicalValueEncrypted,
        emailEncrypted: await encryptIdentityValue(
          credential.canonicalValue.replace(/^email:/u, ""),
          this.keyring,
          `credential:${credentialId}:email`,
        ),
        passwordHash: credential.passwordHash,
      };
    }
    const subject = credential.canonicalValue.split("\u0000").at(-1) ?? "";
    return {
      credentialId,
      kind: "sso",
      canonicalValueEncrypted,
      provider: credential.provider,
      subjectEncrypted: await encryptIdentityValue(
        subject,
        this.keyring,
        `credential:${credentialId}:subject`,
      ),
      verifiedEmailEncrypted: await encryptIdentityValue(
        credential.verifiedEmail,
        this.keyring,
        `credential:${credentialId}:verified-email`,
      ),
    };
  }

  physicalLocators(
    canonicalCredential: string,
  ): Promise<readonly PhysicalCredentialLocator[]> {
    return credentialLocators(canonicalCredential, this.keyring);
  }

  decryptCanonicalCredential(credential: StoredCredentialRef): Promise<string> {
    return decryptIdentityValue(
      credential.canonicalValueEncrypted,
      this.keyring,
      `credential:${credential.credentialId}:canonical`,
    );
  }

  async reencryptCredential(
    credential: StoredCredentialRef,
  ): Promise<StoredCredentialRef> {
    const canonicalValueEncrypted = await encryptIdentityValue(
      await this.decryptCanonicalCredential(credential),
      this.keyring,
      `credential:${credential.credentialId}:canonical`,
    );
    if (credential.kind === "password") {
      return {
        ...credential,
        canonicalValueEncrypted,
        emailEncrypted: await encryptIdentityValue(
          await decryptIdentityValue(
            credential.emailEncrypted,
            this.keyring,
            `credential:${credential.credentialId}:email`,
          ),
          this.keyring,
          `credential:${credential.credentialId}:email`,
        ),
      };
    }
    return {
      ...credential,
      canonicalValueEncrypted,
      subjectEncrypted: await encryptIdentityValue(
        await decryptIdentityValue(
          credential.subjectEncrypted,
          this.keyring,
          `credential:${credential.credentialId}:subject`,
        ),
        this.keyring,
        `credential:${credential.credentialId}:subject`,
      ),
      verifiedEmailEncrypted: await encryptIdentityValue(
        await decryptIdentityValue(
          credential.verifiedEmailEncrypted,
          this.keyring,
          `credential:${credential.credentialId}:verified-email`,
        ),
        this.keyring,
        `credential:${credential.credentialId}:verified-email`,
      ),
    };
  }

  logicalDirectoryCredential(
    row: StoredDirectoryCredential,
  ): Promise<DirectoryCredential> {
    return this.toDirectoryCredential(
      row,
      encodeDirectoryReference(row.locator),
    );
  }

  async reservePhysical(input: {
    operationId: OperationId;
    userId: UserId;
    locator: PhysicalCredentialLocator;
    credential: StoredCredentialRef;
    accountEpoch: number;
    now: number;
  }): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).reserve(
        rpcMutation(input.operationId, {
          locator: input.locator,
          credential: input.credential,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
          reservationExpiresAt: input.now + 15 * 60_000,
        }),
      ),
    );
  }

  async markInitializedPhysical(input: {
    operationId: OperationId;
    userId: UserId;
    locator: PhysicalCredentialLocator;
    now: number;
  }): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).markInitialized(
        rpcMutation(input.operationId, {
          locator: input.locator,
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
  }

  async activatePhysical(input: {
    operationId: OperationId;
    userId: UserId;
    locator: PhysicalCredentialLocator;
    accountEpoch: number;
    now: number;
  }): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).activate(
        rpcMutation(input.operationId, {
          locator: input.locator,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async tombstonePhysical(input: {
    operationId: OperationId;
    userId: UserId;
    locator: PhysicalCredentialLocator;
    accountEpoch: number;
    now: number;
  }): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).tombstone(
        rpcMutation(input.operationId, {
          locator: input.locator,
          userId: input.userId,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  private async toDirectoryCredential(
    stored: StoredDirectoryCredential,
    directoryReference: DirectoryReference,
  ): Promise<DirectoryCredential> {
    const credential =
      stored.credential.kind === "password"
        ? {
            credentialId: stored.credential.credentialId,
            kind: "password" as const,
            email: EmailValue.create(
              await decryptIdentityValue(
                stored.credential.emailEncrypted,
                this.keyring,
                `credential:${stored.credential.credentialId}:email`,
              ),
            ),
            passwordHash: stored.credential.passwordHash,
          }
        : {
            credentialId: stored.credential.credentialId,
            kind: "sso" as const,
            provider: SsoProviderValue.create(stored.credential.provider),
            subject: SsoSubjectValue.create(
              await decryptIdentityValue(
                stored.credential.subjectEncrypted,
                this.keyring,
                `credential:${stored.credential.credentialId}:subject`,
              ),
            ),
            verifiedEmail: EmailValue.create(
              await decryptIdentityValue(
                stored.credential.verifiedEmailEncrypted,
                this.keyring,
                `credential:${stored.credential.credentialId}:verified-email`,
              ),
            ),
          };
    return {
      userId: stored.userId,
      operationId: stored.operationId,
      directoryReference,
      state: stored.state,
      accountEpoch: stored.accountEpoch,
      credential,
    };
  }

  private forLocator(locator: PhysicalCredentialLocator): DirectoryStub {
    return this.forBucket(locator.generation, locator.bucket);
  }

  private forBucket(generation: string, bucket: number): DirectoryStub {
    return stub<DirectoryStub>(this.namespace, `${generation}:${bucket}`);
  }
}

class CloudflareAccountHomeAdapter implements AccountHomePort {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  beginOperation(
    input: Parameters<AccountHomePort["beginOperation"]>[0],
  ): Promise<IdentityOperation> {
    return retryRpc(() =>
      this.forUser(input.userId).beginOperation(
        rpcMutation(input.operationId, {
          userId: input.userId,
          kind: input.kind,
          payloadDigest: input.payloadDigest,
          ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
          now: input.now,
        }),
      ),
    );
  }

  advanceOperation(
    input: Parameters<AccountHomePort["advanceOperation"]>[0],
  ): Promise<IdentityOperation> {
    return retryRpc(() =>
      this.forUser(input.userId).advanceOperation(
        rpcMutation(input.operationId, {
          userId: input.userId,
          expectedState: input.expectedState,
          nextState: input.nextState,
          ...(input.directoryReference
            ? {
                locator: decodeDirectoryReference(input.directoryReference),
              }
            : {}),
          ...(input.credential ? { credential: input.credential } : {}),
          ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
          ...(input.bumpSessionEpoch !== undefined
            ? { bumpSessionEpoch: input.bumpSessionEpoch }
            : {}),
          now: input.now,
        }),
      ),
    );
  }

  getOperation(
    userId: UserId,
    id: OperationId,
  ): Promise<IdentityOperation | null> {
    return retryRpc(() =>
      this.forUser(userId).getOperation(rpcQuery({ operationId: id })),
    );
  }

  async getAuthSummary(userId: UserId): Promise<AccountAuthSummary | null> {
    const summary = await retryRpc(() =>
      this.forUser(userId).getAuthSummary(rpcQuery({})),
    );
    return summary ? this.toAccountAuthSummary(summary) : null;
  }

  async compensateCreate(
    input: Parameters<AccountHomePort["compensateCreate"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forUser(input.userId).compensateCreate(
        rpcMutation(input.operationId, {
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
  }

  async addCredentialLocator(
    input: Parameters<AccountHomePort["addCredentialLocator"]>[0],
  ): Promise<AccountAuthSummary> {
    const summary = await retryRpc(() =>
      this.forUser(input.userId).addCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          locator: decodeDirectoryReference(input.directoryReference),
          credential: input.credential,
          ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
          bumpSessionEpoch: input.bumpSessionEpoch,
          now: input.now,
        }),
      ),
    );
    return this.toAccountAuthSummary(summary);
  }

  async removeCredentialLocator(
    input: Parameters<AccountHomePort["removeCredentialLocator"]>[0],
  ): Promise<AccountAuthSummary> {
    const summary = await retryRpc(() =>
      this.forUser(input.userId).removeCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          credentialId: input.credentialId,
          bumpSessionEpoch: input.bumpSessionEpoch,
          now: input.now,
        }),
      ),
    );
    return this.toAccountAuthSummary(summary);
  }

  async replaceCredentialLocator(
    input: Parameters<AccountHomePort["replaceCredentialLocator"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forUser(input.userId).replaceCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          previous: decodeDirectoryReference(input.previous),
          active: decodeDirectoryReference(input.active),
          kind: input.kind,
          now: input.now,
        }),
      ),
    );
  }

  async beginDeletion(
    input: Parameters<AccountHomePort["beginDeletion"]>[0],
  ): ReturnType<AccountHomePort["beginDeletion"]> {
    const deletion = await retryRpc(() =>
      this.forUser(input.userId).beginDeletionV1(
        rpcMutation(input.operationId, {
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
    return {
      epoch: deletion.epoch,
      state: deletion.state,
      directoryReferences: deletion.locators.map(encodeDirectoryReference),
    };
  }

  async finishDeletion(
    input: Parameters<AccountHomePort["finishDeletion"]>[0],
  ): Promise<boolean> {
    return (
      await retryRpc(() =>
        this.forUser(input.userId).finishDeletionV1(
          rpcMutation(input.operationId, {
            userId: input.userId,
            epoch: input.epoch,
            now: input.now,
          }),
        ),
      )
    ).completed;
  }

  private forUser(userId: UserId): AccountHomeStub {
    return stub<AccountHomeStub>(this.namespace, userId);
  }

  private toAccountAuthSummary(
    summary: PhysicalAccountAuthSummary,
  ): AccountAuthSummary {
    return {
      ...summary,
      credentials: summary.credentials.map(({ locators, ...credential }) => ({
        ...credential,
        directoryReferences: locators.map(encodeDirectoryReference),
      })),
    };
  }
}

class CloudflareUserDataIdentityAdapter implements UserDataIdentityPort {
  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly router: AuthenticatedUserDataRouter = CanonicalAuthenticatedUserDataRouter,
  ) {}

  async initialize(
    input: Parameters<UserDataIdentityPort["initialize"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forUser(input.userId).identityInitializeV1(
        rpcMutation(input.operationId, {
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
  }

  async getProfile(userId: UserId): Promise<UserDataIdentityProfile | null> {
    try {
      const profile = await retryRpc(() =>
        this.forUser(userId).identityGetProfileV1(rpcQuery({ userId })),
      );
      return {
        userId: profile.userId as UserId,
        displayName: profile.displayName ?? null,
        trashRetentionDays: profile.trashRetentionDays,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  getStatus(userId: UserId): Promise<UserDataIdentityStatus> {
    return retryRpc(() =>
      this.forUser(userId).identityGetStatusV1(rpcQuery({ userId })),
    );
  }

  async deleteAll(
    input: Parameters<UserDataIdentityPort["deleteAll"]>[0],
  ): Promise<void> {
    try {
      const status = await this.getStatus(input.userId);
      if (status.deleted) return;
      await retryRpc(() =>
        this.forUser(input.userId).identityDeleteAllV1(
          rpcMutation(input.operationId, { userId: input.userId }),
        ),
      );
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        errorChainIncludes(error, "no such table: profile")
      ) {
        return;
      }
      throw error;
    }
  }

  private forUser(userId: UserId): UserDataStub {
    return stub<UserDataStub>(
      this.namespace,
      this.router.forAuthenticatedUser(userId).objectName,
    );
  }
}

export class CloudflareIdentityGateway
  implements IdentityApplicationPort, IdentityPrimitivePort
{
  private readonly directoryPort: CloudflareCredentialDirectoryAdapter;
  private readonly accountHomePort: CloudflareAccountHomeAdapter;
  private readonly userDataPort: CloudflareUserDataIdentityAdapter;
  private readonly coordinator: IdentityCoordinator;
  readonly keyring: DirectoryKeyring;

  constructor(
    directory: DurableObjectNamespace,
    accountHomes: DurableObjectNamespace,
    userData: DurableObjectNamespace,
    keyring: DirectoryKeyring,
  ) {
    this.keyring = validateDirectoryKeyring(keyring);
    this.directoryPort = new CloudflareCredentialDirectoryAdapter(
      directory,
      this.keyring,
    );
    this.accountHomePort = new CloudflareAccountHomeAdapter(accountHomes);
    this.userDataPort = new CloudflareUserDataIdentityAdapter(userData);
    this.coordinator = new IdentityCoordinator({
      directory: this.directoryPort,
      accountHome: this.accountHomePort,
      userData: this.userDataPort,
      newUserId: () => UserIdValue.create(crypto.randomUUID()),
    });
  }

  registerWithPassword(
    input:
      | IdentityRegistration
      | (Omit<IdentityRegistration, "operationId" | "userId" | "email"> & {
          operationId: string;
          userId: string;
          email: string;
        }),
  ): Promise<{ sessionEpoch: number }> {
    return this.coordinator.registerWithPassword({
      ...input,
      operationId: operationId(input.operationId),
      userId: UserIdValue.create(input.userId),
      email: EmailValue.create(input.email),
    });
  }

  preparePasswordSignup(
    input: Parameters<IdentityApplicationPort["preparePasswordSignup"]>[0],
  ): ReturnType<IdentityApplicationPort["preparePasswordSignup"]> {
    return this.directoryPort.preparePasswordSignup(input);
  }

  findPasswordCredential(
    email: Email | string,
  ): Promise<PasswordCredential | null> {
    return this.coordinator.findPasswordCredential(EmailValue.create(email));
  }

  getAccountAuthority(
    userId: UserId | string,
  ): Promise<AccountAuthSummary | null> {
    return this.coordinator.getAccountAuthority(UserIdValue.create(userId));
  }

  getCurrentAccount(userId: UserId | string): Promise<CurrentAccount | null> {
    return this.coordinator.getCurrentAccount(UserIdValue.create(userId));
  }

  lookupOrCreateSso(
    input: Parameters<IdentityPrimitivePort["lookupOrCreateSso"]>[0],
  ): ReturnType<IdentityPrimitivePort["lookupOrCreateSso"]> {
    return this.coordinator.lookupOrCreateSso(input);
  }

  storePasswordReset(
    input: Parameters<IdentityPrimitivePort["storePasswordReset"]>[0],
  ): Promise<void> {
    return this.coordinator.storePasswordReset(input);
  }

  requestPasswordReset(
    input: Parameters<IdentityPrimitivePort["requestPasswordReset"]>[0],
  ): ReturnType<IdentityPrimitivePort["requestPasswordReset"]> {
    return this.coordinator.requestPasswordReset(input);
  }

  changePassword(
    input: Parameters<IdentityPrimitivePort["changePassword"]>[0],
  ): ReturnType<IdentityPrimitivePort["changePassword"]> {
    return this.coordinator.changePassword(input);
  }

  consumePasswordReset(
    input: Parameters<IdentityPrimitivePort["consumePasswordReset"]>[0],
  ): ReturnType<IdentityPrimitivePort["consumePasswordReset"]> {
    return this.coordinator.consumePasswordReset(input);
  }

  linkSso(
    input: Parameters<IdentityPrimitivePort["linkSso"]>[0],
  ): Promise<void> {
    return this.coordinator.linkSso(input);
  }

  unlinkCredential(
    input: Parameters<IdentityPrimitivePort["unlinkCredential"]>[0],
  ): Promise<void> {
    return this.coordinator.unlinkCredential(input);
  }

  deleteAccount(
    input: Parameters<IdentityPrimitivePort["deleteAccount"]>[0],
  ): Promise<void> {
    return this.coordinator.deleteAccount(input);
  }

  async rotatePreviousGeneration(input: {
    now: number;
    limit?: number;
  }): Promise<{ scanned: number; moved: number; conflicts: number }> {
    const previous = this.keyring.previous;
    if (!previous) return { scanned: 0, moved: 0, conflicts: 0 };
    const bucketCount = this.keyring.buckets ?? 64;
    const totals = { scanned: 0, moved: 0, conflicts: 0 };
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      let cursor: string | undefined;
      do {
        const page = await this.directoryPort.scanForRotation({
          generation: previous.generation,
          bucket,
          ...(cursor ? { cursor } : {}),
          limit: input.limit ?? 100,
        });
        let moved = 0;
        let conflicts = 0;
        for (const row of page.rows) {
          try {
            const canonical =
              await this.directoryPort.decryptCanonicalCredential(
                row.credential,
              );
            const active = (
              await this.directoryPort.physicalLocators(canonical)
            ).find(
              (candidate) =>
                candidate.generation === this.keyring.active.generation,
            );
            if (!active) throw new Error("ACTIVE_LOCATOR_MISSING");
            const rotationOperation = operationId(
              `rotate:${active.generation}:${row.locator.opaqueKey}`,
            );
            const rotatedCredential =
              await this.directoryPort.reencryptCredential(row.credential);
            await this.directoryPort.reservePhysical({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              credential: rotatedCredential,
              accountEpoch: row.accountEpoch,
              now: input.now,
            });
            await this.directoryPort.markInitializedPhysical({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              now: input.now,
            });
            await this.directoryPort.activatePhysical({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              accountEpoch: row.accountEpoch,
              now: input.now,
            });
            await this.accountHomePort.replaceCredentialLocator({
              operationId: rotationOperation,
              userId: row.userId,
              previous: encodeDirectoryReference(row.locator),
              active: encodeDirectoryReference(active),
              kind: row.credential.kind,
              now: input.now,
            });
            await this.directoryPort.tombstonePhysical({
              operationId: rotationOperation,
              locator: row.locator,
              userId: row.userId,
              accountEpoch: row.accountEpoch,
              now: input.now,
            });
            moved += 1;
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            conflicts += 1;
          }
        }
        totals.scanned += page.rows.length;
        totals.moved += moved;
        totals.conflicts += conflicts;
        const blocked = conflicts > 0;
        await this.directoryPort.saveRotationCheckpoint({
          generation: previous.generation,
          bucket,
          cursor: blocked ? (cursor ?? null) : page.nextCursor,
          scanned: page.rows.length,
          moved,
          conflicts,
          completedAt: !blocked && page.nextCursor === null ? input.now : null,
        });
        cursor = blocked ? undefined : (page.nextCursor ?? undefined);
      } while (cursor);
    }
    return totals;
  }

  async reconcileExpiredReservations(input: {
    now: number;
    limitPerBucket?: number;
  }): Promise<{ activated: number; tombstoned: number }> {
    const generations = [
      this.keyring.active.generation,
      ...(this.keyring.previous ? [this.keyring.previous.generation] : []),
    ];
    const bucketCount = this.keyring.buckets ?? 64;
    let activated = 0;
    let tombstoned = 0;
    for (const generation of generations) {
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const rows = await this.directoryPort.expiredReservations({
          generation,
          bucket,
          now: input.now,
          limit: input.limitPerBucket ?? 100,
        });
        for (const row of rows) {
          const result = await this.reconcileReservation(row, input.now);
          if (result === "activated") activated += 1;
          if (result === "tombstoned") tombstoned += 1;
        }
      }
    }
    return { activated, tombstoned };
  }

  async operatorRotatePage(input: {
    generation: string;
    bucket: number;
    now: number;
    limit?: number;
  }): Promise<{
    scanned: number;
    moved: number;
    conflicts: number;
    nextCursor: string | null;
    completed: boolean;
  }> {
    const previous = this.keyring.previous;
    if (!previous || input.generation !== previous.generation) {
      throw new ValidationError(
        "IDENTITY_ROTATION_GENERATION_INVALID",
        "Rotation must target the configured previous generation",
      );
    }
    const bucketCount = this.keyring.buckets ?? 64;
    if (
      !Number.isInteger(input.bucket) ||
      input.bucket < 0 ||
      input.bucket >= bucketCount
    ) {
      throw new ValidationError(
        "IDENTITY_ROTATION_BUCKET_INVALID",
        "Rotation bucket is invalid",
      );
    }
    const checkpoint = await this.directoryPort.rotationCheckpoint(
      input.generation,
      input.bucket,
    );
    if (checkpoint?.completedAt !== null && checkpoint !== null) {
      return {
        scanned: 0,
        moved: 0,
        conflicts: 0,
        nextCursor: null,
        completed: true,
      };
    }
    const page = await this.directoryPort.scanForRotation({
      generation: input.generation,
      bucket: input.bucket,
      ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}),
      limit: Math.min(Math.max(input.limit ?? 100, 1), 100),
    });
    let moved = 0;
    let conflicts = 0;
    for (const row of page.rows) {
      try {
        await this.rotateRow(row, input.now);
        moved += 1;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        conflicts += 1;
      }
    }
    const blocked = conflicts > 0;
    const nextCursor = blocked ? (checkpoint?.cursor ?? null) : page.nextCursor;
    await this.directoryPort.saveRotationCheckpoint({
      generation: input.generation,
      bucket: input.bucket,
      cursor: nextCursor,
      scanned: page.rows.length,
      moved,
      conflicts,
      completedAt: !blocked && page.nextCursor === null ? input.now : null,
    });
    return {
      scanned: page.rows.length,
      moved,
      conflicts,
      nextCursor,
      completed: !blocked && page.nextCursor === null,
    };
  }

  async operatorReconcilePage(input: {
    generation: string;
    bucket: number;
    now: number;
    limit?: number;
  }): Promise<{ examined: number; activated: number; tombstoned: number }> {
    const allowedGenerations = new Set([
      this.keyring.active.generation,
      ...(this.keyring.previous ? [this.keyring.previous.generation] : []),
    ]);
    if (!allowedGenerations.has(input.generation)) {
      throw new ValidationError(
        "IDENTITY_RECONCILE_GENERATION_INVALID",
        "Reconcile generation is not configured",
      );
    }
    const rows = await this.directoryPort.expiredReservations({
      generation: input.generation,
      bucket: input.bucket,
      now: input.now,
      limit: Math.min(Math.max(input.limit ?? 100, 1), 100),
    });
    let activated = 0;
    let tombstoned = 0;
    for (const row of rows) {
      const result = await this.reconcileReservation(row, input.now);
      if (result === "activated") activated += 1;
      if (result === "tombstoned") tombstoned += 1;
    }
    return { examined: rows.length, activated, tombstoned };
  }

  private async reconcileReservation(
    row: RotationRow,
    now: number,
  ): Promise<"activated" | "tombstoned" | "unchanged"> {
    const [authority, initialOperation, userData] = await Promise.all([
      this.accountHomePort.getAuthSummary(row.userId),
      this.accountHomePort.getOperation(row.userId, row.operationId),
      this.userDataPort.getStatus(row.userId),
    ]);
    if (
      userData.initialized &&
      !userData.deleted &&
      initialOperation &&
      authority &&
      !["deleting", "deleted"].includes(authority.status)
    ) {
      let operation = initialOperation;
      if (operation.state === "credential-reserved") {
        operation = await this.accountHomePort.advanceOperation({
          operationId: row.operationId,
          userId: row.userId,
          expectedState: "credential-reserved",
          nextState: "user-data-initialized",
          now,
        });
      }
      if (
        ["user-data-initialized", "directory-active", "completed"].includes(
          operation.state,
        )
      ) {
        await this.directoryPort.activatePhysical({
          operationId: row.operationId,
          userId: row.userId,
          locator: row.locator,
          accountEpoch: authority.operationEpoch,
          now,
        });
        if (operation.state === "user-data-initialized") {
          operation = await this.accountHomePort.advanceOperation({
            operationId: row.operationId,
            userId: row.userId,
            expectedState: "user-data-initialized",
            nextState: "directory-active",
            now,
          });
        }
        if (operation.state === "directory-active") {
          const logical = (
            await this.directoryPort.logicalDirectoryCredential({
              ...row,
              state: "initialized",
            })
          ).credential;
          const primaryEmail =
            logical.kind === "sso" ? logical.verifiedEmail : logical.email;
          await this.accountHomePort.advanceOperation({
            operationId: row.operationId,
            userId: row.userId,
            expectedState: "directory-active",
            nextState: "completed",
            credential: logical,
            primaryEmail,
            now,
          });
        }
        return "activated";
      }
    }
    if (
      userData.deleted ||
      !userData.initialized ||
      authority?.status === "deleting" ||
      authority?.status === "deleted"
    ) {
      await this.directoryPort.tombstonePhysical({
        operationId: row.operationId,
        locator: row.locator,
        userId: row.userId,
        accountEpoch: authority?.operationEpoch ?? row.accountEpoch,
        now,
      });
      if (
        initialOperation &&
        ["signup", "sso-create"].includes(initialOperation.kind)
      ) {
        await this.accountHomePort.compensateCreate({
          operationId: row.operationId,
          userId: row.userId,
          now,
        });
      }
      return "tombstoned";
    }
    return "unchanged";
  }

  async operatorReconcileRestoredPage(input: {
    generation: string;
    bucket: number;
    cursor?: string;
    limit?: number;
    now: number;
  }): Promise<{
    scanned: number;
    tombstoned: number;
    conflicts: number;
    nextCursor: string | null;
    complete: boolean;
  }> {
    const allowedGenerations = new Set([
      this.keyring.active.generation,
      ...(this.keyring.previous ? [this.keyring.previous.generation] : []),
    ]);
    const bucketCount = this.keyring.buckets ?? 64;
    if (
      !allowedGenerations.has(input.generation) ||
      !Number.isInteger(input.bucket) ||
      input.bucket < 0 ||
      input.bucket >= bucketCount
    ) {
      throw new ValidationError(
        "IDENTITY_RECONCILE_SHARD_INVALID",
        "Reconcile shard is not configured",
      );
    }
    const page = await this.directoryPort.scanForAuthorityReconcile({
      generation: input.generation,
      bucket: input.bucket,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: Math.min(Math.max(input.limit ?? 100, 1), 100),
    });
    let tombstoned = 0;
    let conflicts = 0;
    for (const row of page.rows) {
      if (row.state === "tombstoned") continue;
      try {
        const authority = await this.accountHomePort.getAuthSummary(row.userId);
        const authoritative =
          authority?.status === "active" &&
          authority.operationEpoch === row.accountEpoch &&
          authority.credentials.some((credential) =>
            credential.directoryReferences.includes(row.directoryReference),
          );
        if (authoritative) continue;
        await this.directoryPort.tombstone({
          operationId: row.operationId,
          directoryReference: row.directoryReference,
          userId: row.userId,
          accountEpoch: row.accountEpoch,
          now: input.now,
        });
        tombstoned += 1;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        conflicts += 1;
      }
    }
    return {
      scanned: page.rows.length,
      tombstoned,
      conflicts,
      nextCursor: page.nextCursor,
      complete: page.nextCursor === null,
    };
  }

  async getDirectoryShardAuthorityStatus(input: {
    generation: string;
    bucket: number;
  }): Promise<
    Awaited<
      ReturnType<DirectoryStub["operatorGetShardAuthorityStatus"]>
    > extends RpcResult<infer T>
      ? T
      : never
  > {
    return this.directoryPort.shardAuthorityStatus(
      input.generation,
      input.bucket,
    );
  }

  async markDirectoryRestoredSession(input: {
    generation: string;
    bucket: number;
    marker: string;
    now: number;
  }): Promise<void> {
    await this.directoryPort.markRestoredSession(
      input.generation,
      input.bucket,
      input.marker,
      input.now,
    );
  }

  private async rotateRow(row: RotationRow, now: number): Promise<void> {
    const canonical = await this.directoryPort.decryptCanonicalCredential(
      row.credential,
    );
    const active = (await this.directoryPort.physicalLocators(canonical)).find(
      (candidate) => candidate.generation === this.keyring.active.generation,
    );
    if (!active) throw new Error("ACTIVE_LOCATOR_MISSING");
    const rotationOperation = operationId(
      `rotate:${active.generation}:${row.locator.opaqueKey}`,
    );
    const rotatedCredential = await this.directoryPort.reencryptCredential(
      row.credential,
    );
    await this.directoryPort.reservePhysical({
      operationId: rotationOperation,
      userId: row.userId,
      locator: active,
      credential: rotatedCredential,
      accountEpoch: row.accountEpoch,
      now,
    });
    await this.directoryPort.markInitializedPhysical({
      operationId: rotationOperation,
      userId: row.userId,
      locator: active,
      now,
    });
    await this.directoryPort.activatePhysical({
      operationId: rotationOperation,
      userId: row.userId,
      locator: active,
      accountEpoch: row.accountEpoch,
      now,
    });
    await this.accountHomePort.replaceCredentialLocator({
      operationId: rotationOperation,
      userId: row.userId,
      previous: encodeDirectoryReference(row.locator),
      active: encodeDirectoryReference(active),
      kind: row.credential.kind,
      now,
    });
    await this.directoryPort.tombstonePhysical({
      operationId: rotationOperation,
      locator: row.locator,
      userId: row.userId,
      accountEpoch: row.accountEpoch,
      now,
    });
  }
}
