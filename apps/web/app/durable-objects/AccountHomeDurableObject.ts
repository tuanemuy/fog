import { DurableObject } from "cloudflare:workers";
import { migrateAccountHome } from "@repo/core/adapters/cloudflare/account-home/schema";
import { AccountHomeStore } from "@repo/core/adapters/cloudflare/account-home/store";
import type {
  AccountAuthSummary,
  CredentialKind,
  CredentialLocator,
  IdentityOperation,
  IdentityOperationKind,
  IdentityOperationState,
  IdentityRpcMutation,
  IdentityRpcQuery,
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
import { Email, UserId } from "@repo/core/domain/identity/valueObject";

type BeginOperationPayload = {
  userId: string;
  kind: IdentityOperationKind;
  payloadDigest: string;
  primaryEmail?: string;
  now: number;
};

type AdvanceOperationPayload = {
  userId: string;
  expectedState: IdentityOperationState;
  nextState: IdentityOperationState;
  locator?: CredentialLocator;
  credentialKind?: CredentialKind;
  primaryEmail?: string;
  bumpSessionEpoch?: boolean;
  now: number;
};

const conflictCodes = new Set([
  "ACCOUNT_OWNER_MISMATCH",
  "ACCOUNT_DELETED",
  "ACCOUNT_AUTHORITY_MISMATCH",
  "IDENTITY_OPERATION_PAYLOAD_CONFLICT",
  "IDENTITY_OPERATION_PHASE_CONFLICT",
  "LAST_CREDENTIAL_UNLINK_FORBIDDEN",
]);

function execute<T>(operation: () => T): RpcResult<T> {
  try {
    return rpcOk(operation());
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "IDENTITY_STORAGE_ERROR";
    return rpcFailure(
      conflictCodes.has(code) ? "conflict" : "infrastructure",
      conflictCodes.has(code) ? code : "IDENTITY_STORAGE_ERROR",
      conflictCodes.has(code)
        ? "Identity operation conflicted with current state"
        : "Identity storage operation failed",
      !conflictCodes.has(code),
    );
  }
}

function locator(input: CredentialLocator): CredentialLocator {
  if (
    !Number.isInteger(input.bucket) ||
    input.bucket < 0 ||
    input.bucket > 1023 ||
    input.generation.trim().length === 0
  ) {
    throw new Error("IDENTITY_RPC_LOCATOR_INVALID");
  }
  return {
    generation: input.generation,
    bucket: input.bucket,
    opaqueKey: opaqueCredentialKey(input.opaqueKey),
  };
}

export class AccountHomeDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateAccountHome(ctx.storage, Date.now());
    });
  }

  beginOperation(
    request: IdentityRpcMutation<BeginOperationPayload>,
  ): Promise<RpcResult<IdentityOperation>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const payload = request.payload;
    if (
      typeof payload.userId !== "string" ||
      typeof payload.kind !== "string" ||
      typeof payload.payloadDigest !== "string" ||
      typeof payload.now !== "number"
    ) {
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
        new AccountHomeStore(this.ctx.storage).beginOperation({
          operationId: operationId(request.operationId),
          userId: UserId.create(payload.userId),
          kind: payload.kind,
          payloadDigest: payload.payloadDigest,
          ...(payload.primaryEmail
            ? { primaryEmail: Email.create(payload.primaryEmail) }
            : {}),
          now: payload.now,
        }),
      ),
    );
  }

  advanceOperation(
    request: IdentityRpcMutation<AdvanceOperationPayload>,
  ): Promise<RpcResult<IdentityOperation>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        const payload = request.payload;
        return new AccountHomeStore(this.ctx.storage).advanceOperation({
          operationId: operationId(request.operationId),
          userId: UserId.create(payload.userId),
          expectedState: payload.expectedState,
          nextState: payload.nextState,
          ...(payload.locator ? { locator: locator(payload.locator) } : {}),
          ...(payload.credentialKind
            ? { credentialKind: payload.credentialKind }
            : {}),
          ...(payload.primaryEmail
            ? { primaryEmail: Email.create(payload.primaryEmail) }
            : {}),
          bumpSessionEpoch: payload.bumpSessionEpoch ?? false,
          now: payload.now,
        });
      }),
    );
  }

  getOperation(
    request: IdentityRpcQuery<{ operationId: string }>,
  ): Promise<RpcResult<IdentityOperation | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new AccountHomeStore(this.ctx.storage).getOperation(
          operationId(request.payload.operationId),
        ),
      ),
    );
  }

  getAuthSummary(
    request: IdentityRpcQuery<Record<string, never>>,
  ): Promise<RpcResult<AccountAuthSummary | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => new AccountHomeStore(this.ctx.storage).authSummary()),
    );
  }

  addCredentialLocator(
    request: IdentityRpcMutation<{
      userId: string;
      locator: CredentialLocator;
      kind: CredentialKind;
      primaryEmail?: string;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<AccountAuthSummary>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new AccountHomeStore(this.ctx.storage).addCredentialLocator({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          locator: locator(request.payload.locator),
          kind: request.payload.kind,
          ...(request.payload.primaryEmail
            ? { primaryEmail: Email.create(request.payload.primaryEmail) }
            : {}),
          bumpSessionEpoch: request.payload.bumpSessionEpoch,
          now: request.payload.now,
        }),
      ),
    );
  }

  removeCredentialLocator(
    request: IdentityRpcMutation<{
      userId: string;
      locator: CredentialLocator;
      bumpSessionEpoch: boolean;
      now: number;
    }>,
  ): Promise<RpcResult<AccountAuthSummary>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new AccountHomeStore(this.ctx.storage).removeCredentialLocator({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          locator: locator(request.payload.locator),
          bumpSessionEpoch: request.payload.bumpSessionEpoch,
          now: request.payload.now,
        }),
      ),
    );
  }

  replaceCredentialLocator(
    request: IdentityRpcMutation<{
      userId: string;
      previous: CredentialLocator;
      active: CredentialLocator;
      kind: CredentialKind;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => {
        new AccountHomeStore(this.ctx.storage).replaceCredentialLocator({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          previous: locator(request.payload.previous),
          active: locator(request.payload.active),
          kind: request.payload.kind,
          now: request.payload.now,
        });
        return null;
      }),
    );
  }

  beginDeletionV1(
    request: IdentityRpcMutation<{ userId: string; now: number }>,
  ): Promise<
    RpcResult<{
      epoch: number;
      state: IdentityOperationState;
      locators: readonly CredentialLocator[];
    }>
  > {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() =>
        new AccountHomeStore(this.ctx.storage).beginDeletion({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          now: request.payload.now,
        }),
      ),
    );
  }

  finishDeletionV1(
    request: IdentityRpcMutation<{
      userId: string;
      epoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ completed: boolean }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    return Promise.resolve(
      execute(() => ({
        completed: new AccountHomeStore(this.ctx.storage).finishDeletion({
          operationId: operationId(request.operationId),
          userId: UserId.create(request.payload.userId),
          epoch: request.payload.epoch,
          now: request.payload.now,
        }),
      })),
    );
  }

  beginSignup(input: {
    operationId: string;
    userId: string;
    email: string;
    opaqueKey: string;
    generation: string;
    now: number;
  }): Promise<RpcResult<{ state: string }>> {
    return this.beginOperation({
      version: 1,
      operationId: input.operationId,
      payload: {
        userId: input.userId,
        kind: "signup",
        payloadDigest: `legacy:${input.opaqueKey}`,
        primaryEmail: input.email,
        now: input.now,
      },
    }).then(async (result) => {
      if (!result.ok) return result;
      const added = await this.addCredentialLocator({
        version: 1,
        operationId: input.operationId,
        payload: {
          userId: input.userId,
          locator: {
            opaqueKey: opaqueCredentialKey(input.opaqueKey),
            generation: input.generation,
            bucket: 0,
          },
          kind: "password",
          primaryEmail: input.email,
          bumpSessionEpoch: false,
          now: input.now,
        },
      });
      return added.ok ? rpcOk({ state: result.value.state }) : added;
    });
  }

  async beginDeletion(
    now: number,
  ): Promise<RpcResult<{ epoch: number; locators: readonly string[] }>> {
    const authority = new AccountHomeStore(this.ctx.storage).authSummary();
    if (!authority) {
      return rpcFailure(
        "not-found",
        "ACCOUNT_NOT_FOUND",
        "Account was not found",
      );
    }
    const result = await this.beginDeletionV1({
      version: 1,
      operationId: `legacy-delete:${now}`,
      payload: { userId: authority.userId, now },
    });
    return result.ok
      ? rpcOk({
          epoch: result.value.epoch,
          locators: result.value.locators.map((item) => item.opaqueKey),
        })
      : result;
  }

  async finishDeletion(
    epoch: number,
    now: number,
  ): Promise<RpcResult<{ completed: boolean }>> {
    const authority = new AccountHomeStore(this.ctx.storage).authSummary();
    if (!authority) {
      return rpcFailure(
        "not-found",
        "ACCOUNT_NOT_FOUND",
        "Account was not found",
      );
    }
    return this.finishDeletionV1({
      version: 1,
      operationId: `legacy-delete:${now - 1}`,
      payload: { userId: authority.userId, epoch, now },
    });
  }

  authority(): Promise<RpcResult<{ status: string; epoch: number } | null>> {
    return Promise.resolve(
      execute(() => {
        const authority = new AccountHomeStore(this.ctx.storage).authSummary();
        return authority
          ? { status: authority.status, epoch: authority.operationEpoch }
          : null;
      }),
    );
  }

  async restore(): Promise<RpcResult<never>> {
    return rpcFailure(
      "validation",
      "ACCOUNT_HOME_RESTORE_FORBIDDEN",
      "Account Home is authoritative and cannot be restored",
    );
  }
}
