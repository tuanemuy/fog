import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { migrateIdentityDirectory } from "@repo/core/adapters/cloudflare/identity-directory/schema";
import { IdentityDirectoryStore } from "@repo/core/adapters/cloudflare/identity-directory/store";
import {
  decryptIdentityValue,
  encryptIdentityValue,
} from "@repo/core/adapters/cloudflare/identityEnvelope";
import type {
  IdentityRpcMutation,
  IdentityRpcQuery,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import { operationId } from "@repo/core/application/identity/contracts";
import type {
  PhysicalCredentialLocator,
  StoredCredentialRef,
  StoredDirectoryCredential,
} from "@repo/core/adapters/cloudflare/identityPhysical";
import { opaqueCredentialKey } from "@repo/core/adapters/cloudflare/identityPhysical";
import {
  rpcFailure,
  rpcOk,
  validatePayloadKeys,
  isSafeNonNegativeInteger,
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

type UserDataIdentityStub = {
  identityGetStatusV1(
    input: IdentityRpcQuery<{ userId: string }>,
  ): Promise<RpcResult<{ initialized: boolean; deleted: boolean }>>;
};

type StateEnv = {
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
  USER_DATA: DurableObjectNamespace;
  IDENTITY_MAIL_ENCRYPTION_KEY?: string;
  IDENTITY_MAIL_PROVIDER?: Fetcher;
};

const OPERATION_REPLAY_TTL_MS = 24 * 60 * 60_000;
const encoder = new TextEncoder();

function boundedString(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  if (typeof value !== "string") return false;
  const bytes = encoder.encode(value).byteLength;
  return bytes >= minimumBytes && bytes <= maximumBytes;
}

function digestHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

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
    const validation =
      code.startsWith("IDENTITY_RPC_") ||
      code.endsWith("_INVALID") ||
      code.endsWith("_REQUIRED");
    const conflict = conflictCodes.has(code);
    return rpcFailure(
      validation ? "validation" : conflict ? "conflict" : "infrastructure",
      validation || conflict ? code : "IDENTITY_STORAGE_ERROR",
      validation
        ? "Invalid identity payload"
        : conflict
          ? "Identity operation conflicted with current state"
          : "Identity storage operation failed",
      !validation && !conflict,
    );
  }
}

function parseLocator(
  input: PhysicalCredentialLocator,
): PhysicalCredentialLocator {
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

function parseCredential(input: StoredCredentialRef): StoredCredentialRef {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.credentialId !== "string" ||
    typeof input.canonicalValueEncrypted !== "string" ||
    new TextEncoder().encode(input.canonicalValueEncrypted).byteLength > 4096
  ) {
    throw new Error("IDENTITY_RPC_CREDENTIAL_INVALID");
  }
  if (input.kind === "password") {
    return {
      kind: "password",
      credentialId: input.credentialId,
      canonicalValueEncrypted: input.canonicalValueEncrypted,
      emailEncrypted: input.emailEncrypted,
      passwordHash: PasswordHash.create(input.passwordHash),
    };
  }
  if (input.kind === "sso") {
    return {
      kind: "sso",
      credentialId: input.credentialId,
      canonicalValueEncrypted: input.canonicalValueEncrypted,
      provider: SsoProvider.create(input.provider),
      subjectEncrypted: input.subjectEncrypted,
      verifiedEmailEncrypted: input.verifiedEmailEncrypted,
    };
  }
  throw new Error("IDENTITY_RPC_CREDENTIAL_INVALID");
}

function invalidPayload(
  payload: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): RpcResult<never> | null {
  const result = validatePayloadKeys(payload, required, optional);
  return result.ok ? null : result;
}

export class IdentityDirectoryDurableObject extends DurableObject<StateEnv> {
  private readonly sessionId = crypto.randomUUID();

  constructor(
    ctx: DurableObjectState,
    private readonly stateEnv: StateEnv,
  ) {
    super(ctx, stateEnv);
    ctx.blockConcurrencyWhile(async () => {
      migrateIdentityDirectory(ctx.storage, Date.now());
    });
  }

  async reserve(
    request: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      credential: StoredCredentialRef;
      userId: string;
      accountEpoch: number;
      now: number;
      reservationExpiresAt: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return validated;
    const invalid = invalidPayload(request.payload, [
      "locator",
      "credential",
      "userId",
      "accountEpoch",
      "now",
      "reservationExpiresAt",
    ]);
    if (
      invalid ||
      !isSafeNonNegativeInteger(request.payload.accountEpoch) ||
      !isSafeNonNegativeInteger(request.payload.now) ||
      !isSafeNonNegativeInteger(request.payload.reservationExpiresAt) ||
      request.payload.reservationExpiresAt < request.payload.now
    ) {
      return (
        invalid ??
        rpcFailure(
          "validation",
          "IDENTITY_RPC_PAYLOAD_INVALID",
          "Invalid identity payload",
        )
      );
    }
    const result = execute(() => ({
      userId: new IdentityDirectoryStore(this.ctx.storage).reserve({
        operationId: operationId(request.operationId),
        userId: UserId.create(request.payload.userId),
        locator: parseLocator(request.payload.locator),
        credential: parseCredential(request.payload.credential),
        accountEpoch: request.payload.accountEpoch,
        now: request.payload.now,
        reservationExpiresAt: request.payload.reservationExpiresAt,
      }),
    }));
    if (result.ok) {
      const store = new IdentityDirectoryStore(this.ctx.storage);
      const scheduledAt = Math.max(
        request.payload.reservationExpiresAt,
        Date.now() + 15 * 60_000,
      );
      store.enqueueReconcile(scheduledAt, request.payload.now);
      await this.scheduleAlarm(scheduledAt);
    }
    return result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const store = new IdentityDirectoryStore(this.ctx.storage);
    let reconcileNext: number | null = null;
    let reconcileFailure: unknown;
    try {
      reconcileNext = await this.runReconcile(now, store);
    } catch (error) {
      reconcileNext = store.failReconcile(
        error instanceof Error ? error.message : "RECONCILE_FAILED",
        now,
      );
      reconcileFailure = error;
    }
    const mailNext = await this.runIdentityMail(now, store);
    store.purgeExpiredOperationRegistries(now);
    const next = [reconcileNext, mailNext]
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0];
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
    if (reconcileFailure) throw reconcileFailure;
  }

  private async runReconcile(
    now: number,
    store: IdentityDirectoryStore,
  ): Promise<number | null> {
    const job = store.claimReconcile(now);
    if (!job) {
      return store.finishReconcile(now);
    }
    const rows = store.expiredReservations(now, 100);
    for (const row of rows) {
      try {
        const userData = this.stateEnv.USER_DATA.getByName(
          row.userId,
        ) as unknown as UserDataIdentityStub;
        const userDataResult = await userData.identityGetStatusV1({
          version: 1,
          payload: { userId: row.userId },
        });
        if (!userDataResult.ok) {
          throw new Error(userDataResult.error.code);
        }
        const account = this.stateEnv.ACCOUNT_HOME.getByName(row.userId);
        const [authorityResult, operationResult] = await Promise.all([
          account.getAuthSummary({ version: 1, payload: {} }),
          account.getOperation({
            version: 1,
            payload: { operationId: row.operationId },
          }),
        ]);
        if (!authorityResult.ok || !operationResult.ok) {
          throw new Error(
            !authorityResult.ok
              ? authorityResult.error.code
              : operationResult.ok
                ? "ACCOUNT_OPERATION_UNAVAILABLE"
                : operationResult.error.code,
          );
        }
        const authority = authorityResult.value;
        let operation = operationResult.value;
        if (
          userDataResult.value.initialized &&
          !userDataResult.value.deleted &&
          authority &&
          operation &&
          !["deleting", "deleted"].includes(authority.status)
        ) {
          if (operation.state === "credential-reserved") {
            const advanced = await account.advanceOperation({
              version: 1,
              operationId: row.operationId,
              payload: {
                userId: row.userId,
                expectedState: "credential-reserved",
                nextState: "user-data-initialized",
                now,
              },
            });
            if (!advanced.ok) throw new Error(advanced.error.code);
            operation = advanced.value;
          }
          if (
            ["user-data-initialized", "directory-active", "completed"].includes(
              operation.state,
            )
          ) {
            store.activate({
              operationId: row.operationId,
              userId: row.userId,
              locator: row.locator,
              accountEpoch: authority.operationEpoch,
              now,
            });
            if (operation.state === "user-data-initialized") {
              const advanced = await account.advanceOperation({
                version: 1,
                operationId: row.operationId,
                payload: {
                  userId: row.userId,
                  expectedState: "user-data-initialized",
                  nextState: "directory-active",
                  now,
                },
              });
              if (!advanced.ok) throw new Error(advanced.error.code);
              operation = advanced.value;
            }
            if (operation.state === "directory-active") {
              const completed = await account.advanceOperation({
                version: 1,
                operationId: row.operationId,
                payload: {
                  userId: row.userId,
                  expectedState: "directory-active",
                  nextState: "completed",
                  now,
                },
              });
              if (!completed.ok) throw new Error(completed.error.code);
            }
          }
        } else {
          store.tombstone({
            locator: row.locator,
            userId: row.userId,
            accountEpoch: authority?.operationEpoch ?? row.accountEpoch,
            now,
          });
          if (operation && ["signup", "sso-create"].includes(operation.kind)) {
            const compensated = await account.compensateCreate({
              version: 1,
              operationId: row.operationId,
              payload: { userId: row.userId, now },
            });
            if (!compensated.ok) throw new Error(compensated.error.code);
          }
        }
        store.clearReconcileFailure(row.operationId);
      } catch (error) {
        store.failReconcileOperation(
          row.operationId,
          error instanceof Error ? error.message : "RECONCILE_ROW_FAILED",
          now,
        );
      }
    }
    return store.finishReconcile(now);
  }

  private async runIdentityMail(
    now: number,
    store: IdentityDirectoryStore,
  ): Promise<number | null> {
    const ownerToken = `${this.sessionId}:${crypto.randomUUID()}`;
    const job = store.claimIdentityMail(now, ownerToken);
    if (!job) return store.nextIdentityMailRun();
    const encryptionKey = this.stateEnv.IDENTITY_MAIL_ENCRYPTION_KEY;
    const provider = this.stateEnv.IDENTITY_MAIL_PROVIDER;
    if (!encryptionKey || new TextEncoder().encode(encryptionKey).length < 32) {
      return store.failIdentityMail({
        operationId: job.operationId,
        ownerToken,
        errorCode: "IDENTITY_MAIL_ENCRYPTION_KEY_UNAVAILABLE",
        retryable: true,
        now,
      });
    }
    if (!provider) {
      return store.failIdentityMail({
        operationId: job.operationId,
        ownerToken,
        errorCode: "IDENTITY_MAIL_PROVIDER_UNAVAILABLE",
        retryable: true,
        now,
      });
    }
    let deliveryPayload: {
      email: string;
      resetSecret: string;
      expiresAt: number;
    };
    try {
      const decrypted = await decryptIdentityValue(
        job.deliveryPayloadEncrypted,
        { active: { generation: "mail-v1", secret: encryptionKey } },
        `mail:${job.operationId}:delivery`,
      );
      const parsed = JSON.parse(decrypted) as Partial<typeof deliveryPayload>;
      if (
        typeof parsed.email !== "string" ||
        typeof parsed.resetSecret !== "string" ||
        !isSafeNonNegativeInteger(parsed.expiresAt)
      ) {
        throw new Error("IDENTITY_MAIL_PAYLOAD_INVALID");
      }
      deliveryPayload = {
        email: parsed.email,
        resetSecret: parsed.resetSecret,
        expiresAt: parsed.expiresAt,
      };
    } catch (error) {
      return store.failIdentityMail({
        operationId: job.operationId,
        ownerToken,
        errorCode:
          error instanceof Error
            ? error.message
            : "IDENTITY_MAIL_DECRYPT_FAILED",
        retryable: false,
        now,
      });
    }
    try {
      const response = await provider.fetch(
        "https://identity-mail.invalid/password-reset",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": job.providerIdempotencyKey,
          },
          body: JSON.stringify({
            kind: "password-reset",
            deliveryPayload,
            idempotencyKey: job.providerIdempotencyKey,
          }),
        },
      );
      if (response.ok) {
        store.completeIdentityMail(job.operationId, ownerToken, now);
        return store.nextIdentityMailRun();
      }
      return store.failIdentityMail({
        operationId: job.operationId,
        ownerToken,
        errorCode: `IDENTITY_MAIL_PROVIDER_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
        now,
      });
    } catch (error) {
      return store.failIdentityMail({
        operationId: job.operationId,
        ownerToken,
        errorCode:
          error instanceof Error
            ? error.message
            : "IDENTITY_MAIL_PROVIDER_FAILED",
        retryable: true,
        now,
      });
    }
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  lookupPasswordSignup(
    request: IdentityRpcQuery<{ opaqueOperationKey: string; now: number }>,
  ): Promise<
    RpcResult<{
      userId: string;
      emailEncrypted: string;
      passwordHash: string;
      payloadFingerprint: string;
      preparedAt: number;
    } | null>
  > {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "opaqueOperationKey",
      "now",
    ]);
    if (invalid) return Promise.resolve(invalid);
    if (
      !digestHex(request.payload.opaqueOperationKey) ||
      !isSafeNonNegativeInteger(request.payload.now)
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
        new IdentityDirectoryStore(this.ctx.storage).lookupPasswordSignup(
          request.payload.opaqueOperationKey,
          request.payload.now,
        ),
      ),
    );
  }

  async preparePasswordSignup(
    request: IdentityRpcMutation<{
      opaqueOperationKey: string;
      proposedUserId: string;
      emailEncrypted: string;
      payloadFingerprint: string;
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
  > {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "opaqueOperationKey",
      "proposedUserId",
      "emailEncrypted",
      "payloadFingerprint",
      "passwordHash",
      "now",
    ]);
    if (
      invalid ||
      !digestHex(request.payload.opaqueOperationKey) ||
      !digestHex(request.payload.payloadFingerprint) ||
      !boundedString(request.payload.emailEncrypted, 1, 4096) ||
      !boundedString(request.payload.passwordHash, 1, 2048) ||
      !boundedString(request.payload.proposedUserId, 1, 128) ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
    const result = execute(() =>
      new IdentityDirectoryStore(this.ctx.storage).preparePasswordSignup({
        opaqueOperationKey: request.payload.opaqueOperationKey,
        proposedUserId: UserId.create(request.payload.proposedUserId),
        emailEncrypted: request.payload.emailEncrypted,
        payloadFingerprint: request.payload.payloadFingerprint,
        passwordHash: PasswordHash.create(request.payload.passwordHash),
        now: request.payload.now,
      }),
    );
    if (result.ok) {
      await this.scheduleAlarm(request.payload.now + OPERATION_REPLAY_TTL_MS);
    }
    return result;
  }

  async prepareSsoCreate(
    request: IdentityRpcMutation<{
      opaqueOperationKey: string;
      proposedUserId: string;
      provider: string;
      subjectEncrypted: string;
      emailEncrypted: string;
      payloadFingerprint: string;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string; replayed: boolean }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "opaqueOperationKey",
      "proposedUserId",
      "provider",
      "subjectEncrypted",
      "emailEncrypted",
      "payloadFingerprint",
      "now",
    ]);
    if (
      invalid ||
      !digestHex(request.payload.opaqueOperationKey) ||
      !digestHex(request.payload.payloadFingerprint) ||
      !boundedString(request.payload.proposedUserId, 1, 128) ||
      !boundedString(request.payload.subjectEncrypted, 1, 4096) ||
      !boundedString(request.payload.emailEncrypted, 1, 4096) ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
    const result = execute(() =>
      new IdentityDirectoryStore(this.ctx.storage).prepareSsoCreate({
        opaqueOperationKey: request.payload.opaqueOperationKey,
        proposedUserId: UserId.create(request.payload.proposedUserId),
        provider: SsoProvider.create(request.payload.provider),
        subjectEncrypted: request.payload.subjectEncrypted,
        emailEncrypted: request.payload.emailEncrypted,
        payloadFingerprint: request.payload.payloadFingerprint,
        now: request.payload.now,
      }),
    );
    if (result.ok) {
      await this.scheduleAlarm(request.payload.now + OPERATION_REPLAY_TTL_MS);
    }
    return result;
  }

  async preparePasswordResetRequest(
    request: IdentityRpcMutation<{
      userId: string;
      payloadFingerprint: string;
      resetSecretEncrypted: string;
      tokenHash: string;
      expiresAt: number;
      now: number;
    }>,
  ): Promise<
    RpcResult<{
      resetSecretEncrypted: string;
      tokenHash: string;
      expiresAt: number;
      replayed: boolean;
    }>
  > {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "userId",
      "payloadFingerprint",
      "resetSecretEncrypted",
      "tokenHash",
      "expiresAt",
      "now",
    ]);
    if (
      invalid ||
      !boundedString(request.payload.userId, 1, 128) ||
      !digestHex(request.payload.payloadFingerprint) ||
      !boundedString(request.payload.resetSecretEncrypted, 1, 4096) ||
      !digestHex(request.payload.tokenHash) ||
      !isSafeNonNegativeInteger(request.payload.expiresAt) ||
      request.payload.expiresAt <= request.payload.now ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
    const result = execute(() =>
      new IdentityDirectoryStore(this.ctx.storage).preparePasswordResetRequest({
        operationId: operationId(request.operationId),
        userId: UserId.create(request.payload.userId),
        payloadFingerprint: request.payload.payloadFingerprint,
        resetSecretEncrypted: request.payload.resetSecretEncrypted,
        tokenHash: request.payload.tokenHash,
        expiresAt: request.payload.expiresAt,
        now: request.payload.now,
      }),
    );
    if (result.ok) {
      await this.scheduleAlarm(
        Math.max(
          request.payload.expiresAt,
          request.payload.now + OPERATION_REPLAY_TTL_MS,
        ),
      );
    }
    return result;
  }

  markInitialized(
    request: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      userId: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "now",
    ]);
    if (invalid || !isSafeNonNegativeInteger(request.payload.now)) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string }>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "accountEpoch",
      "now",
    ]);
    if (
      invalid ||
      !isSafeNonNegativeInteger(request.payload.accountEpoch) ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    request: IdentityRpcQuery<{ locator: PhysicalCredentialLocator }>,
  ): Promise<RpcResult<StoredDirectoryCredential | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, ["locator"]);
    if (invalid) return Promise.resolve(invalid);
    return Promise.resolve(
      execute(() =>
        new IdentityDirectoryStore(this.ctx.storage).lookupPassword(
          parseLocator(request.payload.locator),
        ),
      ),
    );
  }

  lookup(
    request: IdentityRpcQuery<{ locator: PhysicalCredentialLocator }>,
  ): Promise<RpcResult<StoredDirectoryCredential | null>> {
    const validated = validateRpcQuery(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, ["locator"]);
    if (invalid) return Promise.resolve(invalid);
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
      locator: PhysicalCredentialLocator;
      userId: string;
      passwordHash: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "passwordHash",
      "accountEpoch",
      "now",
    ]);
    if (
      invalid ||
      !isSafeNonNegativeInteger(request.payload.accountEpoch) ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "accountEpoch",
      "now",
    ]);
    if (
      invalid ||
      !isSafeNonNegativeInteger(request.payload.accountEpoch) ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
      locator: PhysicalCredentialLocator;
      userId: string;
      accountEpoch: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "accountEpoch",
    ]);
    if (invalid || !isSafeNonNegativeInteger(request.payload.accountEpoch)) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
      locator: PhysicalCredentialLocator;
      userId: string;
      tokenHash: string;
      expiresAt: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "userId",
      "tokenHash",
      "expiresAt",
    ]);
    if (
      invalid ||
      typeof request.payload.tokenHash !== "string" ||
      request.payload.tokenHash.length === 0 ||
      request.payload.tokenHash.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.expiresAt)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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

  async enqueuePasswordResetMail(
    request: IdentityRpcMutation<{
      userId: string;
      email: string;
      resetSecret: string;
      expiresAt: number;
      providerIdempotencyKey: string;
      now: number;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "userId",
      "email",
      "resetSecret",
      "expiresAt",
      "providerIdempotencyKey",
      "now",
    ]);
    if (
      invalid ||
      (() => {
        try {
          Email.create(request.payload.email);
          UserId.create(request.payload.userId);
          return false;
        } catch {
          return true;
        }
      })() ||
      typeof request.payload.resetSecret !== "string" ||
      request.payload.resetSecret.length < 16 ||
      request.payload.resetSecret.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.expiresAt) ||
      request.payload.expiresAt <= request.payload.now ||
      typeof request.payload.providerIdempotencyKey !== "string" ||
      request.payload.providerIdempotencyKey.length === 0 ||
      request.payload.providerIdempotencyKey.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
    const encryptionKey = this.stateEnv.IDENTITY_MAIL_ENCRYPTION_KEY;
    if (!encryptionKey || new TextEncoder().encode(encryptionKey).length < 32) {
      return rpcFailure(
        "infrastructure",
        "IDENTITY_MAIL_ENCRYPTION_KEY_UNAVAILABLE",
        "Identity mail delivery is temporarily unavailable",
        true,
      );
    }
    const keyring = {
      active: { generation: "mail-v1", secret: encryptionKey },
    } as const;
    const [emailEncrypted, deliveryPayloadEncrypted] = await Promise.all([
      encryptIdentityValue(
        request.payload.email,
        keyring,
        `mail:${request.operationId}:email`,
      ),
      encryptIdentityValue(
        JSON.stringify({
          email: request.payload.email,
          resetSecret: request.payload.resetSecret,
          expiresAt: request.payload.expiresAt,
        }),
        keyring,
        `mail:${request.operationId}:delivery`,
      ),
    ]);
    const result = execute(() => {
      new IdentityDirectoryStore(this.ctx.storage).enqueuePasswordResetMail({
        operationId: operationId(request.operationId),
        userId: UserId.create(request.payload.userId),
        emailEncrypted,
        deliveryPayloadEncrypted,
        providerIdempotencyKey: request.payload.providerIdempotencyKey,
        expiresAt: request.payload.expiresAt,
        now: request.payload.now,
      });
      return null;
    });
    if (result.ok) await this.scheduleAlarm(request.payload.now);
    return result;
  }

  lookupPasswordReset(
    request: IdentityRpcMutation<{
      locator: PhysicalCredentialLocator;
      tokenHash: string;
      now: number;
    }>,
  ): Promise<RpcResult<{ userId: string } | null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "locator",
      "tokenHash",
      "now",
    ]);
    if (
      invalid ||
      typeof request.payload.tokenHash !== "string" ||
      request.payload.tokenHash.length === 0 ||
      request.payload.tokenHash.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    const invalid = invalidPayload(request.payload, ["tokenHash", "now"]);
    if (
      invalid ||
      typeof request.payload.tokenHash !== "string" ||
      request.payload.tokenHash.length === 0 ||
      request.payload.tokenHash.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    const invalid = invalidPayload(
      request.payload,
      ["generation", "limit"],
      ["cursor"],
    );
    if (
      invalid ||
      typeof request.payload.generation !== "string" ||
      request.payload.generation.length === 0 ||
      request.payload.generation.length > 64 ||
      !isSafeNonNegativeInteger(request.payload.limit) ||
      request.payload.limit < 1 ||
      request.payload.limit > 100 ||
      (request.payload.cursor !== undefined &&
        (typeof request.payload.cursor !== "string" ||
          request.payload.cursor.length > 256))
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    const invalid = invalidPayload(
      request.payload,
      ["generation", "bucket", "limit"],
      ["cursor"],
    );
    if (
      invalid ||
      typeof request.payload.generation !== "string" ||
      request.payload.generation.length === 0 ||
      request.payload.generation.length > 64 ||
      !isSafeNonNegativeInteger(request.payload.bucket) ||
      request.payload.bucket > 1023 ||
      !isSafeNonNegativeInteger(request.payload.limit) ||
      request.payload.limit < 1 ||
      request.payload.limit > 100 ||
      (request.payload.cursor !== undefined &&
        (typeof request.payload.cursor !== "string" ||
          request.payload.cursor.length > 256))
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
      accountHomeActive: number;
      completedAt: number | null;
    }>,
  ): Promise<RpcResult<null>> {
    const validated = validateRpcMutation(request);
    if (!validated.ok) return Promise.resolve(validated);
    const invalid = invalidPayload(request.payload, [
      "generation",
      "bucket",
      "cursor",
      "scanned",
      "moved",
      "conflicts",
      "accountHomeActive",
      "completedAt",
    ]);
    if (
      invalid ||
      typeof request.payload.generation !== "string" ||
      request.payload.generation.length === 0 ||
      request.payload.generation.length > 64 ||
      !isSafeNonNegativeInteger(request.payload.bucket) ||
      request.payload.bucket > 1023 ||
      !isSafeNonNegativeInteger(request.payload.scanned) ||
      !isSafeNonNegativeInteger(request.payload.moved) ||
      !isSafeNonNegativeInteger(request.payload.conflicts) ||
      !isSafeNonNegativeInteger(request.payload.accountHomeActive) ||
      (request.payload.cursor !== null &&
        (typeof request.payload.cursor !== "string" ||
          request.payload.cursor.length > 256)) ||
      (request.payload.completedAt !== null &&
        !isSafeNonNegativeInteger(request.payload.completedAt))
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
    return Promise.resolve(
      execute(() => {
        new IdentityDirectoryStore(this.ctx.storage).saveRotationCheckpoint({
          operationId: operationId(request.operationId),
          ...request.payload,
        });
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
    const invalid = invalidPayload(request.payload, ["generation", "bucket"]);
    if (
      invalid ||
      typeof request.payload.generation !== "string" ||
      request.payload.generation.length === 0 ||
      request.payload.generation.length > 64 ||
      !isSafeNonNegativeInteger(request.payload.bucket) ||
      request.payload.bucket > 1023
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    const invalid = invalidPayload(request.payload, []);
    if (invalid) return Promise.resolve(invalid);
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
    const invalid = invalidPayload(request.payload, ["marker", "now"]);
    if (
      invalid ||
      typeof request.payload.marker !== "string" ||
      request.payload.marker.length === 0 ||
      request.payload.marker.length > 256 ||
      !isSafeNonNegativeInteger(request.payload.now)
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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
    const invalid = invalidPayload(request.payload, ["now", "limit"]);
    if (
      invalid ||
      !isSafeNonNegativeInteger(request.payload.now) ||
      !isSafeNonNegativeInteger(request.payload.limit) ||
      request.payload.limit < 1 ||
      request.payload.limit > 100
    ) {
      return Promise.resolve(
        invalid ??
          rpcFailure(
            "validation",
            "IDENTITY_RPC_PAYLOAD_INVALID",
            "Invalid identity payload",
          ),
      );
    }
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

  async operatorPrepareRestoreProof(
    proofId: string,
  ): Promise<{ sessionId: string }> {
    if (
      proofId.length === 0 ||
      new TextEncoder().encode(proofId).byteLength > 128
    ) {
      throw new Error("PITR_PROOF_ID_INVALID");
    }
    await this.ctx.storage.put(`pitr-proof:${proofId}`, this.sessionId);
    return { sessionId: this.sessionId };
  }

  async operatorRestartSession(): Promise<void> {
    this.ctx.abort("PITR_RESTART_REQUESTED");
  }

  async operatorVerifyRestoredSession(
    bookmark: string,
    proof?: {
      id: string;
      previousSessionId: string;
      undoBookmark: string;
    },
  ): Promise<string> {
    const current = await this.ctx.storage.getCurrentBookmark();
    if (
      !proof ||
      proof.id.length === 0 ||
      proof.previousSessionId === this.sessionId ||
      current < proof.undoBookmark ||
      (await this.ctx.storage.get(`pitr-proof:${proof.id}`)) !== undefined
    ) {
      throw new Error("PITR_RESTORE_NOT_APPLIED");
    }
    if (current < bookmark) throw new Error("PITR_BOOKMARK_INVALID");
    new IdentityDirectoryStore(this.ctx.storage).markRestoredSession(
      bookmark,
      Date.now(),
    );
    return current;
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
        authority.value.credentials.some((credential) =>
          credential.locators.some(
            (candidate) =>
              candidate.generation === row.locator.generation &&
              candidate.bucket === row.locator.bucket &&
              candidate.opaqueKey === row.locator.opaqueKey,
          ),
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
