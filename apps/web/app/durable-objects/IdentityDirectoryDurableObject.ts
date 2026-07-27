import { DurableObject } from "cloudflare:workers";
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
  rpcQuery,
  validateRpcMutation,
  validateRpcQuery,
} from "@repo/core/application/identity/rpc";
import {
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "@repo/core/domain/identity/valueObject";

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
    typeof input.opaqueKey !== "string"
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

export class IdentityDirectoryDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
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
  ): Promise<RpcResult<{ userId: string }>>;
  reserve(request: {
    opaqueKey: string;
    generation: string;
    canonicalValue: string;
    kind: "password" | "sso";
    provider?: string;
    userId: string;
    operationId: string;
    passwordHash?: string;
    now: number;
    reservationExpiresAt: number;
  }): Promise<RpcResult<{ userId: string }>>;
  reserve(
    request:
      | IdentityRpcMutation<{
          locator: CredentialLocator;
          credential: CredentialRef;
          userId: string;
          accountEpoch: number;
          now: number;
          reservationExpiresAt: number;
        }>
      | {
          opaqueKey: string;
          generation: string;
          canonicalValue: string;
          kind: "password" | "sso";
          provider?: string;
          userId: string;
          operationId: string;
          passwordHash?: string;
          now: number;
          reservationExpiresAt: number;
        },
  ): Promise<RpcResult<{ userId: string }>> {
    if (!("version" in request)) {
      const legacy = request;
      const converted = {
        version: 1,
        operationId: legacy.operationId,
        payload: {
          locator: {
            opaqueKey: opaqueCredentialKey(legacy.opaqueKey),
            generation: legacy.generation,
            bucket: 0,
          },
          credential:
            legacy.kind === "password"
              ? {
                  kind: "password" as const,
                  canonicalValue: legacy.canonicalValue,
                  passwordHash: PasswordHash.create(legacy.passwordHash ?? ""),
                }
              : {
                  kind: "sso" as const,
                  canonicalValue: legacy.canonicalValue,
                  provider: SsoProvider.create(legacy.provider ?? ""),
                  verifiedEmail: Email.create("legacy@example.invalid"),
                },
          userId: legacy.userId,
          accountEpoch: 0,
          now: legacy.now,
          reservationExpiresAt: legacy.reservationExpiresAt,
        },
      } as const;
      return this.reserve(converted);
    }
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
  ): Promise<RpcResult<{ userId: string }>>;
  activate(request: {
    opaqueKey: string;
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<{ userId: string }>>;
  activate(
    request:
      | IdentityRpcMutation<{
          locator: CredentialLocator;
          userId: string;
          accountEpoch: number;
          now: number;
        }>
      | {
          opaqueKey: string;
          operationId: string;
          userId: string;
          now: number;
        },
  ): Promise<RpcResult<{ userId: string }>> {
    if (!("version" in request)) {
      return this.activate({
        version: 1,
        operationId: request.operationId,
        payload: {
          locator: {
            opaqueKey: opaqueCredentialKey(request.opaqueKey),
            generation: "generation-1",
            bucket: 0,
          },
          userId: request.userId,
          accountEpoch: 0,
          now: request.now,
        },
      });
    }
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
  ): Promise<RpcResult<PasswordCredential | null>>;
  lookupPassword(
    request: string,
  ): Promise<RpcResult<PasswordCredential | null>>;
  lookupPassword(
    request: IdentityRpcQuery<{ locator: CredentialLocator }> | string,
  ): Promise<RpcResult<PasswordCredential | null>> {
    if (typeof request === "string") {
      return this.lookupPassword(
        rpcQuery({
          locator: {
            opaqueKey: opaqueCredentialKey(request),
            generation: "generation-1",
            bucket: 0,
          },
        }),
      );
    }
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
      accountEpoch: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).purge(
          parseLocator(request.payload.locator),
          request.payload.accountEpoch,
        );
        return null;
      }),
    );
  }

  storePasswordReset(
    request: IdentityRpcMutation<{
      userId: string;
      tokenHash: string;
      expiresAt: number;
    }>,
  ): Promise<RpcResult<null>>;
  storePasswordReset(request: {
    tokenHash: string;
    userId: string;
    operationId: string;
    expiresAt: number;
  }): Promise<RpcResult<null>>;
  storePasswordReset(
    request:
      | IdentityRpcMutation<{
          userId: string;
          tokenHash: string;
          expiresAt: number;
        }>
      | {
          tokenHash: string;
          userId: string;
          operationId: string;
          expiresAt: number;
        },
  ): Promise<RpcResult<null>> {
    if (!("version" in request)) {
      return this.storePasswordReset({
        version: 1,
        operationId: request.operationId,
        payload: {
          userId: request.userId,
          tokenHash: request.tokenHash,
          expiresAt: request.expiresAt,
        },
      });
    }
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).storePasswordReset({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          tokenHash: request.payload.tokenHash,
          expiresAt: request.payload.expiresAt,
        });
        return null;
      }),
    );
  }

  consumePasswordReset(
    request: IdentityRpcMutation<{ tokenHash: string; now: number }>,
  ): Promise<RpcResult<{ userId: string } | null>>;
  consumePasswordReset(
    tokenHash: string,
    now: number,
  ): Promise<RpcResult<{ userId: string } | null>>;
  consumePasswordReset(
    request: IdentityRpcMutation<{ tokenHash: string; now: number }> | string,
    legacyNow?: number,
  ): Promise<RpcResult<{ userId: string } | null>> {
    if (typeof request === "string") {
      return this.consumePasswordReset({
        version: 1,
        operationId: `legacy-reset-consume:${legacyNow ?? 0}`,
        payload: { tokenHash: request, now: legacyNow ?? 0 },
      });
    }
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
}
