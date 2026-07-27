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
  CredentialDirectoryPort,
  CredentialKind,
  CredentialLocator,
  CredentialRef,
  CurrentAccount,
  DirectoryCredential,
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
} from "@repo/core/application/identity/contracts";
import { operationId } from "@repo/core/application/identity/contracts";
import { IdentityCoordinator } from "@repo/core/application/identity/coordinator";
import { rpcMutation, rpcQuery } from "@repo/core/application/identity/rpc";
import type { Email, UserId } from "@repo/core/domain/identity/valueObject";
import {
  Email as EmailValue,
  UserId as UserIdValue,
} from "@repo/core/domain/identity/valueObject";
import {
  canonicalPasswordCredential,
  credentialLocators,
  type DirectoryKeyring,
  validateDirectoryKeyring,
} from "./identityRouting";

type RotationRow = Readonly<{
  locator: CredentialLocator;
  credential: CredentialRef;
  userId: UserId;
  operationId: OperationId;
  accountEpoch: number;
}>;

type DirectoryStub = {
  reserve(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      credential: CredentialRef;
      userId: string;
      accountEpoch: number;
      now: number;
      reservationExpiresAt: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>>;
  markInitialized(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  activate(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>>;
  lookupPassword(
    input: IdentityRpcQuery<{ locator: CredentialLocator }>,
  ): Promise<RpcResult<PasswordCredential | null>>;
  lookup(
    input: IdentityRpcQuery<{ locator: CredentialLocator }>,
  ): Promise<RpcResult<DirectoryCredential | null>>;
  replacePassword(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      passwordHash: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  tombstone(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>>;
  purge(
    input: IdentityRpcMutation<{
      locator: CredentialLocator;
      accountEpoch: number;
    }>,
  ): Promise<RpcResult<null>>;
  storePasswordReset(
    input: IdentityRpcMutation<{
      userId: string;
      tokenHash: string;
      expiresAt: number;
    }>,
  ): Promise<RpcResult<null>>;
  consumePasswordReset(
    input: IdentityRpcMutation<{ tokenHash: string; now: number }>,
  ): Promise<RpcResult<{ userId: UserId } | null>>;
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
      locator?: CredentialLocator;
      credentialKind?: CredentialKind;
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
  ): Promise<RpcResult<AccountAuthSummary | null>>;
  addCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      locator: CredentialLocator;
      kind: CredentialKind;
      primaryEmail?: string;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<AccountAuthSummary>>;
  removeCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      locator: CredentialLocator;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<AccountAuthSummary>>;
  replaceCredentialLocator(
    input: IdentityRpcMutation<{
      userId: string;
      previous: CredentialLocator;
      active: CredentialLocator;
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
      locators: readonly CredentialLocator[];
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
  initialize(input: {
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string; trashRetentionDays: number }>>;
  getProfile(): Promise<
    RpcResult<{
      userId: string;
      trashRetentionDays: number;
      displayName?: string | null;
    }>
  >;
  deleteAll(input: {
    expectedUserId: string;
  }): Promise<RpcResult<{ deleted: true }>>;
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
      if (
        !(error instanceof RemoteIdentityError) ||
        error.overloaded ||
        !error.retryable ||
        attempt >= 2
      ) {
        throw translate(error);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function translate(error: unknown): Error {
  if (!(error instanceof RemoteIdentityError)) {
    return error instanceof Error
      ? error
      : new SystemError(SystemErrorCode.NetworkError, "Identity RPC failed");
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

  locators(canonicalCredential: string): Promise<readonly CredentialLocator[]> {
    return credentialLocators(canonicalCredential, this.keyring);
  }

  async lookupPassword(
    email: Email,
  ): Promise<readonly (PasswordCredential | null)[]> {
    const locators = await this.locators(canonicalPasswordCredential(email));
    return Promise.all(
      locators.map((locator) =>
        retryRpc(() =>
          this.forLocator(locator).lookupPassword(rpcQuery({ locator })),
        ),
      ),
    );
  }

  async lookupCredential(
    canonicalCredential: string,
  ): Promise<readonly (DirectoryCredential | null)[]> {
    const locators = await this.locators(canonicalCredential);
    return Promise.all(
      locators.map((locator) =>
        retryRpc(() => this.forLocator(locator).lookup(rpcQuery({ locator }))),
      ),
    );
  }

  async reserve(
    input: Parameters<CredentialDirectoryPort["reserve"]>[0],
  ): Promise<void> {
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

  async markInitialized(
    input: Parameters<CredentialDirectoryPort["markInitialized"]>[0],
  ): Promise<void> {
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

  async activate(
    input: Parameters<CredentialDirectoryPort["activate"]>[0],
  ): Promise<void> {
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

  async replacePassword(
    input: Parameters<CredentialDirectoryPort["replacePassword"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).replacePassword(
        rpcMutation(input.operationId, {
          locator: input.locator,
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
    await retryRpc(() =>
      this.forLocator(input.locator).tombstone(
        rpcMutation(input.operationId, {
          locator: input.locator,
          accountEpoch: input.accountEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async purge(
    input: Parameters<CredentialDirectoryPort["purge"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).purge(
        rpcMutation(input.operationId, {
          locator: input.locator,
          accountEpoch: input.accountEpoch,
        }),
      ),
    );
  }

  async storePasswordReset(
    input: Parameters<CredentialDirectoryPort["storePasswordReset"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forLocator(input.locator).storePasswordReset(
        rpcMutation(input.operationId, {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        }),
      ),
    );
  }

  consumePasswordReset(
    input: Parameters<CredentialDirectoryPort["consumePasswordReset"]>[0],
  ): Promise<{ userId: UserId } | null> {
    return retryRpc(() =>
      this.forLocator(input.locator).consumePasswordReset(
        rpcMutation(input.operationId, {
          tokenHash: input.tokenHash,
          now: input.now,
        }),
      ),
    );
  }

  scanForRotation(
    input: Parameters<CredentialDirectoryPort["scanForRotation"]>[0],
  ): Promise<{
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

  async saveRotationCheckpoint(
    input: Parameters<CredentialDirectoryPort["saveRotationCheckpoint"]>[0],
  ): Promise<void> {
    const checkpointId = operationId(
      `rotation-checkpoint:${input.generation}:${input.bucket}:${input.cursor ?? "done"}`,
    );
    await retryRpc(() =>
      this.forBucket(input.generation, input.bucket).saveRotationCheckpoint(
        rpcMutation(checkpointId, input),
      ),
    );
  }

  expiredReservations(
    input: Parameters<CredentialDirectoryPort["expiredReservations"]>[0],
  ): Promise<readonly RotationRow[]> {
    return retryRpc(() =>
      this.forBucket(input.generation, input.bucket).expiredReservations(
        rpcQuery({ now: input.now, limit: input.limit }),
      ),
    );
  }

  private forLocator(locator: CredentialLocator): DirectoryStub {
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
          ...(input.locator ? { locator: input.locator } : {}),
          ...(input.credentialKind
            ? { credentialKind: input.credentialKind }
            : {}),
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

  getAuthSummary(userId: UserId): Promise<AccountAuthSummary | null> {
    return retryRpc(() => this.forUser(userId).getAuthSummary(rpcQuery({})));
  }

  addCredentialLocator(
    input: Parameters<AccountHomePort["addCredentialLocator"]>[0],
  ): Promise<AccountAuthSummary> {
    return retryRpc(() =>
      this.forUser(input.userId).addCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          locator: input.locator,
          kind: input.kind,
          ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
          bumpSessionEpoch: input.bumpSessionEpoch,
          now: input.now,
        }),
      ),
    );
  }

  removeCredentialLocator(
    input: Parameters<AccountHomePort["removeCredentialLocator"]>[0],
  ): Promise<AccountAuthSummary> {
    return retryRpc(() =>
      this.forUser(input.userId).removeCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          locator: input.locator,
          bumpSessionEpoch: input.bumpSessionEpoch,
          now: input.now,
        }),
      ),
    );
  }

  async replaceCredentialLocator(
    input: Parameters<AccountHomePort["replaceCredentialLocator"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forUser(input.userId).replaceCredentialLocator(
        rpcMutation(input.operationId, {
          userId: input.userId,
          previous: input.previous,
          active: input.active,
          kind: input.kind,
          now: input.now,
        }),
      ),
    );
  }

  beginDeletion(
    input: Parameters<AccountHomePort["beginDeletion"]>[0],
  ): ReturnType<AccountHomePort["beginDeletion"]> {
    return retryRpc(() =>
      this.forUser(input.userId).beginDeletionV1(
        rpcMutation(input.operationId, {
          userId: input.userId,
          now: input.now,
        }),
      ),
    );
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
}

class CloudflareUserDataIdentityAdapter implements UserDataIdentityPort {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async initialize(
    input: Parameters<UserDataIdentityPort["initialize"]>[0],
  ): Promise<void> {
    await retryRpc(() =>
      this.forUser(input.userId).initialize({
        operationId: input.operationId,
        userId: input.userId,
        now: input.now,
      }),
    );
  }

  async getProfile(userId: UserId): Promise<UserDataIdentityProfile | null> {
    try {
      const profile = await retryRpc(() => this.forUser(userId).getProfile());
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

  async deleteAll(
    input: Parameters<UserDataIdentityPort["deleteAll"]>[0],
  ): Promise<void> {
    try {
      await retryRpc(() =>
        this.forUser(input.userId).deleteAll({ expectedUserId: input.userId }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("no such table: profile")
      ) {
        return;
      }
      throw error;
    }
  }

  private forUser(userId: UserId): UserDataStub {
    return stub<UserDataStub>(this.namespace, userId);
  }
}

export class CloudflareIdentityGateway
  implements IdentityApplicationPort, IdentityPrimitivePort
{
  private readonly directoryPort: CloudflareCredentialDirectoryAdapter;
  private readonly accountHomePort: CloudflareAccountHomeAdapter;
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
    this.coordinator = new IdentityCoordinator({
      directory: this.directoryPort,
      accountHome: this.accountHomePort,
      userData: new CloudflareUserDataIdentityAdapter(userData),
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
            const active = (
              await this.directoryPort.locators(row.credential.canonicalValue)
            ).find(
              (candidate) =>
                candidate.generation === this.keyring.active.generation,
            );
            if (!active) throw new Error("ACTIVE_LOCATOR_MISSING");
            const rotationOperation = operationId(
              `rotate:${active.generation}:${row.locator.opaqueKey}`,
            );
            await this.directoryPort.reserve({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              credential: row.credential,
              accountEpoch: row.accountEpoch,
              now: input.now,
            });
            await this.directoryPort.markInitialized({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              now: input.now,
            });
            await this.directoryPort.activate({
              operationId: rotationOperation,
              userId: row.userId,
              locator: active,
              accountEpoch: row.accountEpoch,
              now: input.now,
            });
            await this.accountHomePort.replaceCredentialLocator({
              operationId: rotationOperation,
              userId: row.userId,
              previous: row.locator,
              active,
              kind: row.credential.kind,
              now: input.now,
            });
            await this.directoryPort.tombstone({
              operationId: rotationOperation,
              locator: row.locator,
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
        await this.directoryPort.saveRotationCheckpoint({
          generation: previous.generation,
          bucket,
          cursor: page.nextCursor,
          scanned: page.rows.length,
          moved,
          conflicts,
          completedAt: page.nextCursor === null ? input.now : null,
        });
        cursor = page.nextCursor ?? undefined;
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
          const [authority, operation] = await Promise.all([
            this.accountHomePort.getAuthSummary(row.userId),
            this.accountHomePort.getOperation(row.userId, row.operationId),
          ]);
          if (
            authority?.status === "active" &&
            operation &&
            ["user-data-initialized", "directory-active", "completed"].includes(
              operation.state,
            )
          ) {
            await this.directoryPort.activate({
              operationId: row.operationId,
              userId: row.userId,
              locator: row.locator,
              accountEpoch: authority.operationEpoch,
              now: input.now,
            });
            activated += 1;
          } else if (
            authority?.status === "deleting" ||
            authority?.status === "deleted"
          ) {
            await this.directoryPort.tombstone({
              operationId: row.operationId,
              locator: row.locator,
              accountEpoch: authority.operationEpoch,
              now: input.now,
            });
            tombstoned += 1;
          }
        }
      }
    }
    return { activated, tombstoned };
  }
}
