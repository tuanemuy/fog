import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { migrateIdentityDirectory } from "@repo/core/adapters/cloudflare/identity-directory/schema";
import { IdentityDirectoryStore } from "@repo/core/adapters/cloudflare/identity-directory/store";
import type {
  CredentialLocator,
  CredentialRef,
  DirectoryCredential,
  IdentityRpcMutation,
  IdentityRpcQuery,
  PasswordCredential,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import {
  opaqueCredentialKey,
  operationId,
} from "@repo/core/application/identity/contracts";
import {
  rpcFailure,
  rpcOk,
  validateRpcMutation,
  validateRpcQuery,
} from "@repo/core/application/identity/rpc";
import {
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type { AccountHomeDurableObject } from "./AccountHomeDurableObject";

type StateEnv = {
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
};

const conflictCodes = new Set([
  "CREDENTIAL_ALREADY_REGISTERED",
  "RESERVATION_LOST",
  "ACCOUNT_EPOCH_MISMATCH",
  "ACCOUNT_AUTHORITY_MISMATCH",
  "IDENTITY_OPERATION_PAYLOAD_CONFLICT",
]);

function execute<T>(operation: () => T): RpcResult<T> {
  try {
    return rpcOk(operation());
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "IDENTITY_STORAGE_ERROR";
    const conflict = conflictCodes.has(code);
    return rpcFailure(
      conflict ? "conflict" : "infrastructure",
      conflict ? code : "IDENTITY_STORAGE_ERROR",
      conflict
        ? "Identity operation conflicted with current state"
        : "Identity storage operation failed",
      !conflict,
    );
  }
}

function parseLocator(input: CredentialLocator): CredentialLocator {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.generation !== "string" ||
    !Number.isInteger(input.bucket) ||
    input.bucket < 0 ||
    input.bucket > 1023 ||
    typeof input.opaqueKey !== "string" ||
    input.generation.length > 64 ||
    input.opaqueKey.length > 256
  ) {
    throw new Error("IDENTITY_RPC_LOCATOR_INVALID");
  }
  return {
    generation: input.generation,
    bucket: input.bucket,
    opaqueKey: opaqueCredentialKey(input.opaqueKey),
  };
}

function parseCredential(input: CredentialRef): CredentialRef {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.canonicalValue !== "string" ||
    new TextEncoder().encode(input.canonicalValue).byteLength > 1024
  ) {
    throw new Error("IDENTITY_RPC_CREDENTIAL_INVALID");
  }
  if (input.kind === "password") {
    return {
      kind: "password",
      canonicalValue: input.canonicalValue,
      passwordHash: PasswordHash.create(input.passwordHash),
    };
  }
  if (input.kind === "sso") {
    return {
      kind: "sso",
      canonicalValue: input.canonicalValue,
      provider: SsoProvider.create(input.provider),
      verifiedEmail: Email.create(input.verifiedEmail),
    };
  }
  throw new Error("IDENTITY_RPC_CREDENTIAL_INVALID");
}

export class IdentityDirectoryDurableObject extends DurableObject<StateEnv> {
  constructor(
    ctx: DurableObjectState,
    private readonly stateEnv: StateEnv,
  ) {
    super(ctx, stateEnv);
    ctx.blockConcurrencyWhile(async () => {
      migrateIdentityDirectory(ctx.storage, Date.now());
    });
  }

  reserve(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      credential: CredentialRef;
      userId: string;
      accountEpoch: number;
      now: number;
      reservationExpiresAt: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => ({
        userId: new IdentityDirectoryStore(this.ctx.storage).reserve({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          locator: parseLocator(request.payload.locator),
          credential: parseCredential(request.payload.credential),
          accountEpoch: request.payload.accountEpoch,
          now: request.payload.now,
          reservationExpiresAt: request.payload.reservationExpiresAt,
        }),
      })),
    );
  }

  lookupPasswordSignup(
    request: IdentityRpcQuery<{ opaqueOperationKey: string }>,
  ): Promise<
    RpcResult<{
      userId: string;
      email: string;
      passwordHash: string;
    } | null>
  > {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    if (typeof request.payload.opaqueOperationKey !== "string") {
      return Promise.resolve(
        rpcFailure(
          "validation",
          "IDENTITY_RPC_PAYLOAD_INVALID",
          "Invalid identity payload",
        ),
      );
    }
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).lookupPasswordSignup(
          request.payload.opaqueOperationKey,
        ),
      ),
    );
  }

  preparePasswordSignup(
    request: IdentityRpcMutation<{
      opaqueOperationKey: string;
      proposedUserId: string;
      email: string;
      passwordHash: string;
      now: number;
    }>,
  ): Promise<
    RpcResult<{
      userId: string;
      passwordHash: string;
      replayed: boolean;
    }>
  > {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).preparePasswordSignup({
          opaqueOperationKey: request.payload.opaqueOperationKey,
          proposedUserId: UserId.create(request.payload.proposedUserId),
          email: Email.create(request.payload.email),
          passwordHash: PasswordHash.create(request.payload.passwordHash),
          now: request.payload.now,
        }),
      ),
    );
  }

  markInitialized(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).markInitialized({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          locator: parseLocator(request.payload.locator),
          now: request.payload.now,
        });
        return null;
      }),
    );
  }

  activate(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => ({
        userId: new IdentityDirectoryStore(this.ctx.storage).activate({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          locator: parseLocator(request.payload.locator),
          accountEpoch: request.payload.accountEpoch,
          now: request.payload.now,
        }),
      })),
    );
  }

  lookupPassword(
    request: IdentityRpcQuery<{ locator: CredentialLocator }>,
  ): Promise<RpcResult<PasswordCredential | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).lookupPassword(
          parseLocator(request.payload.locator),
        ),
      ),
    );
  }

  lookup(
    request: IdentityRpcQuery<{ locator: CredentialLocator }>,
  ): Promise<RpcResult<DirectoryCredential | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).lookup(
          parseLocator(request.payload.locator),
        ),
      ),
    );
  }

  replacePassword(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      passwordHash: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).replacePassword({
          operationId: operationId(request.operationId),
          locator: parseLocator(request.payload.locator),
          userId: UserId.create(request.payload.userId),
          passwordHash: PasswordHash.create(request.payload.passwordHash),
          accountEpoch: request.payload.accountEpoch,
          now: request.payload.now,
        });
        return null;
      }),
    );
  }

  tombstone(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).tombstone({
          locator: parseLocator(request.payload.locator),
          userId: UserId.create(request.payload.userId),
          accountEpoch: request.payload.accountEpoch,
          now: request.payload.now,
        });
        return null;
      }),
    );
  }

  purge(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      accountEpoch: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).purge(
          parseLocator(request.payload.locator),
          UserId.create(request.payload.userId),
          request.payload.accountEpoch,
        );
        return null;
      }),
    );
  }

  storePasswordReset(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      userId: string;
      tokenHash: string;
      expiresAt: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).storePasswordReset({
          operationId: operationId(request.operationId),
          locator: parseLocator(request.payload.locator),
          userId: UserId.create(request.payload.userId),
          tokenHash: request.payload.tokenHash,
          expiresAt: request.payload.expiresAt,
        });
        return null;
      }),
    );
  }

  lookupPasswordReset(
    request: IdentityRpcMutation<{
      locator: CredentialLocator;
      tokenHash: string;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string } | null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).lookupPasswordReset({
          operationId: operationId(request.operationId),
          tokenHash: request.payload.tokenHash,
          now: request.payload.now,
        }),
      ),
    );
  }

  consumePasswordReset(
    request: IdentityRpcMutation<{ tokenHash: string; now: number }>,
  ): Promise<RpcResult<{ userId: string } | null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).consumePasswordReset({
          operationId: operationId(request.operationId),
          tokenHash: request.payload.tokenHash,
          now: request.payload.now,
        }),
      ),
    );
  }

  scanForRotation(
    request: IdentityRpcQuery<{
      generation: string;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<RpcResult<ReturnType<IdentityDirectoryStore["scanForRotation"]>>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).scanForRotation(
          request.payload,
        ),
      ),
    );
  }

  scanForAuthorityReconcile(
    request: IdentityRpcQuery<{
      generation: string;
      bucket: number;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<
    RpcResult<ReturnType<IdentityDirectoryStore["scanForAuthorityReconcile"]>>
  > {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).scanForAuthorityReconcile(
          request.payload,
        ),
      ),
    );
  }

  saveRotationCheckpoint(
    request: IdentityRpcMutation<{
      generation: string;
      bucket: number;
      cursor: string | null;
      scanned: number;
      moved: number;
      conflicts: number;
      completedAt: number | null;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).saveRotationCheckpoint(
          request.payload,
        );
        return null;
      }),
    );
  }

  getRotationCheckpoint(
    request: IdentityRpcQuery<{ generation: string; bucket: number }>,
  ): Promise<
    RpcResult<ReturnType<IdentityDirectoryStore["rotationCheckpoint"]>>
  > {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).rotationCheckpoint(
          request.payload.generation,
          request.payload.bucket,
        ),
      ),
    );
  }

  operatorGetShardAuthorityStatus(
    request: IdentityRpcQuery<Record<string, never>>,
  ): Promise<RpcResult<ReturnType<IdentityDirectoryStore["authorityStatus"]>>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).authorityStatus(),
      ),
    );
  }

  operatorMarkRestoredSession(
    request: IdentityRpcMutation<{ marker: string; now: number }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).markRestoredSession(
          request.payload.marker,
          request.payload.now,
        );
        return null;
      }),
    );
  }

  expiredReservations(
    request: IdentityRpcQuery<{ now: number; limit: number }>,
  ): Promise<
    RpcResult<ReturnType<IdentityDirectoryStore["expiredReservations"]>>
  > {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).expiredReservations(
          request.payload.now,
          request.payload.limit,
        ),
      ),
    );
  }

  operatorGetCurrentBookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  operatorRestoreBookmark(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
  }

  async operatorRestartSession(): Promise<void> {
    this.ctx.abort("PITR_RESTART_REQUESTED");
  }

  async operatorVerifyRestoredSession(bookmark: string): Promise<string> {
    new IdentityDirectoryStore(this.ctx.storage).markRestoredSession(
      bookmark,
      Date.now(),
    );
    return this.ctx.storage.getCurrentBookmark();
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
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
    if (
      input.generation.trim().length === 0 ||
      input.generation.length > 64 ||
      !Number.isInteger(input.bucket) ||
      input.bucket < 0 ||
      input.bucket > 1023 ||
      (input.cursor !== undefined &&
        new TextEncoder().encode(input.cursor).byteLength > 256) ||
      !Number.isFinite(input.now)
    ) {
      throw new TypeError("IDENTITY_RECONCILE_INPUT_INVALID");
    }
    const store = new IdentityDirectoryStore(this.ctx.storage);
    const page = store.scanForAuthorityReconcile({
      generation: input.generation,
      bucket: input.bucket,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
    let tombstoned = 0;
    let conflicts = 0;
    for (const row of page.rows) {
      if (row.state === "tombstoned") continue;
      const authority = await this.stateEnv.ACCOUNT_HOME.getByName(
        row.userId,
      ).getAuthSummary({
        version: 1,
        payload: {},
      });
      if (!authority.ok) {
        conflicts += 1;
        continue;
      }
      const authoritative =
        authority.value?.status === "active" &&
        authority.value.operationEpoch === row.accountEpoch &&
        authority.value.locators.some(
          (candidate) =>
            candidate.generation === row.locator.generation &&
            candidate.bucket === row.locator.bucket &&
            candidate.opaqueKey === row.locator.opaqueKey,
        );
      if (authoritative) continue;
      store.tombstone({
        locator: row.locator,
        userId: row.userId,
        accountEpoch: row.accountEpoch,
        now: input.now,
      });
      tombstoned += 1;
    }
    return {
      scanned: page.rows.length,
      tombstoned,
      conflicts,
      nextCursor: page.nextCursor,
      complete: page.nextCursor === null,
    };
  }
}
