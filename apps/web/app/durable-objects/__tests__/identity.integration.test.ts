import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import type { DirectoryKeyring } from "@repo/core/adapters/cloudflare/identityRouting";
import {
  canonicalPasswordCredential,
  credentialLocators,
  directoryObjectName,
} from "@repo/core/adapters/cloudflare/identityRouting";
import { opaqueCredentialKey } from "@repo/core/adapters/cloudflare/identityPhysical";
import {
  operationId,
  type RpcResult,
} from "@repo/core/application/identity/contracts";
import {
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountHomeDurableObject } from "../AccountHomeDurableObject";
import type { IdentityDirectoryDurableObject } from "../IdentityDirectoryDurableObject";
import type { UserDataDurableObject } from "../UserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectoryDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
};

const bindings = env as unknown as TestEnv;
const keyring = {
  active: {
    generation: "generation-2",
    secret: "active-routing-secret-32-bytes-minimum",
  },
  previous: {
    generation: "generation-1",
    secret: "previous-routing-secret-32-bytes-min",
  },
  buckets: 4,
} as const;

afterEach(() => reset());

function gateway(
  routing: DirectoryKeyring = keyring,
  faultHook?: IdentitySagaFaultHook,
): CloudflareIdentityGateway {
  return new CloudflareIdentityGateway(
    faultHook
      ? faultingNamespace(bindings.IDENTITY_DIRECTORY, faultHook)
      : (bindings.IDENTITY_DIRECTORY as never),
    faultHook
      ? faultingNamespace(bindings.ACCOUNT_HOME, faultHook)
      : (bindings.ACCOUNT_HOME as never),
    faultHook
      ? faultingNamespace(bindings.USER_DATA, faultHook)
      : (bindings.USER_DATA as never),
    routing,
    "stable-registry-auth-secret-32-bytes-minimum",
  );
}

type IdentitySagaFaultPoint =
  | "signup-after-reserve"
  | "signup-after-initialize"
  | "signup-after-activate"
  | "signup-after-finalize"
  | "sso-after-provider-reserve"
  | "sso-after-email-reserve"
  | "sso-after-provider-activate"
  | "sso-after-email-activate"
  | "link-after-reserve"
  | "link-after-initialize"
  | "link-after-activate"
  | "link-after-finalize"
  | "unlink-after-directory"
  | "unlink-after-authority"
  | "reset-after-consume"
  | "reset-after-hash"
  | "reset-after-epoch"
  | "change-after-hash"
  | "change-after-epoch"
  | "delete-after-user-data"
  | "delete-after-directory"
  | "delete-after-finish";

type IdentitySagaFaultHook = ((
  point: IdentitySagaFaultPoint,
) => void | Promise<void>) & {
  readonly expected: IdentitySagaFaultPoint;
};

function faultingNamespace(
  namespace: DurableObjectNamespace,
  hook: IdentitySagaFaultHook,
): never {
  const counts = new Map<string, number>();
  const checkpoint = async (method: string, args: readonly unknown[]) => {
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, count);
    const payload = args[0] as { payload?: { nextState?: string } } | undefined;
    const expected = hook.expected;
    const target: Partial<
      Record<
        IdentitySagaFaultPoint,
        { method: string; count?: number; nextState?: string }
      >
    > = {
      "signup-after-reserve": { method: "reserve", count: 1 },
      "signup-after-initialize": { method: "markInitialized", count: 1 },
      "signup-after-activate": { method: "activate", count: 1 },
      "signup-after-finalize": {
        method: "advanceOperation",
        nextState: "completed",
      },
      "sso-after-provider-reserve": { method: "reserve", count: 2 },
      "sso-after-email-reserve": { method: "reserve", count: 4 },
      "sso-after-provider-activate": { method: "activate", count: 2 },
      "sso-after-email-activate": { method: "activate", count: 4 },
      "link-after-reserve": { method: "reserve", count: 1 },
      "link-after-initialize": { method: "markInitialized", count: 1 },
      "link-after-activate": { method: "activate", count: 1 },
      "link-after-finalize": {
        method: "advanceOperation",
        nextState: "completed",
      },
      "unlink-after-directory": { method: "tombstone", count: 1 },
      "unlink-after-authority": {
        method: "removeCredentialLocator",
        count: 1,
      },
      "reset-after-consume": { method: "consumePasswordReset", count: 1 },
      "reset-after-hash": { method: "replacePassword", count: 1 },
      "reset-after-epoch": {
        method: "advanceOperation",
        nextState: "completed",
      },
      "change-after-hash": { method: "replacePassword", count: 1 },
      "change-after-epoch": {
        method: "advanceOperation",
        nextState: "completed",
      },
      "delete-after-user-data": { method: "identityDeleteAllV1", count: 1 },
      "delete-after-directory": { method: "purge", count: 1 },
      "delete-after-finish": { method: "finishDeletionV1", count: 1 },
    };
    const expectedTarget = target[expected];
    if (
      expectedTarget &&
      method === expectedTarget.method &&
      (expectedTarget.count === undefined || count === expectedTarget.count) &&
      (expectedTarget.nextState === undefined ||
        payload?.payload?.nextState === expectedTarget.nextState)
    ) {
      await hook(expected);
    }
  };
  return new Proxy(namespace, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "idFromName") {
        return (name: string) => namespace.idFromName(name);
      }
      if (property !== "get" && property !== "getByName") return value;
      return (...args: unknown[]) => {
        const stub =
          property === "get"
            ? namespace.get(args[0] as DurableObjectId)
            : namespace.getByName(args[0] as string);
        return new Proxy(stub as object, {
          get(stubTarget, method, stubReceiver) {
            const operation = Reflect.get(stubTarget, method, stubReceiver);
            if (typeof operation !== "function") return operation;
            return async (...methodArgs: unknown[]) => {
              const result = await Reflect.apply(
                operation,
                stubTarget,
                methodArgs,
              );
              await checkpoint(String(method), methodArgs);
              return result;
            };
          },
        });
      };
    },
  }) as never;
}

function failOnceAt(expected: IdentitySagaFaultPoint): IdentitySagaFaultHook {
  let armed = true;
  const hook = (actual: IdentitySagaFaultPoint) => {
    if (armed && actual === expected) {
      armed = false;
      throw new Error(`INJECTED_FAULT:${actual}`);
    }
  };
  return Object.assign(hook, { expected });
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function overrideIdentityEnv(
  instance: unknown,
  overrides: Record<string, unknown>,
): void {
  const current = (instance as unknown as { stateEnv: Record<string, unknown> })
    .stateEnv;
  Object.defineProperty(instance, "stateEnv", {
    configurable: true,
    value: { ...current, ...overrides },
  });
}

async function sha256Hex(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("identity Durable Object contract", () => {
  it.each([
    "signup-after-reserve",
    "signup-after-initialize",
    "signup-after-activate",
    "signup-after-finalize",
  ] as const)("resumes signup after %s", async (point) => {
    const identity = gateway(keyring, failOnceAt(point));
    const input = {
      operationId: operationId(`fault-${point}`),
      userId: UserId.create(`user-${point}`),
      email: Email.create(`${point}@example.com`),
      passwordHash: PasswordHash.create(`hash-${point}`),
      now: 1,
    };
    await expect(identity.registerWithPassword(input)).rejects.toThrow();
    await expect(identity.registerWithPassword(input)).resolves.toEqual({
      sessionEpoch: 0,
    });
    await expect(
      identity.getAccountAuthority(input.userId),
    ).resolves.toMatchObject({ status: "active" });
  });

  it.each([
    "sso-after-provider-reserve",
    "sso-after-email-reserve",
    "sso-after-provider-activate",
    "sso-after-email-activate",
  ] as const)("resumes SSO create after %s", async (point) => {
    const identity = gateway(keyring, failOnceAt(point));
    const input = {
      operationId: operationId(`fault-${point}`),
      provider: SsoProvider.create("google"),
      subject: `subject-${point}`,
      email: Email.create(`${point}@example.com`),
      now: 1,
    };
    await expect(identity.lookupOrCreateSso(input)).rejects.toThrow();
    await expect(identity.lookupOrCreateSso(input)).resolves.toMatchObject({
      userId: expect.any(String),
      sessionEpoch: 0,
    });
  });

  it("resumes the same signup operation and preserves one authority", async () => {
    const identity = gateway();
    const input = {
      operationId: operationId("signup-stable-operation"),
      userId: UserId.create("signup-stable-operation"),
      email: Email.create("person@example.com"),
      passwordHash: PasswordHash.create("encoded-password-hash"),
      now: 1,
    };

    await expect(identity.registerWithPassword(input)).resolves.toEqual({
      sessionEpoch: 0,
    });
    await expect(identity.registerWithPassword(input)).resolves.toEqual({
      sessionEpoch: 0,
    });

    const credential = await identity.findPasswordCredential(input.email);
    expect(credential?.userId).toBe(input.userId);
    const authority = await identity.getAccountAuthority(input.userId);
    expect(authority).toMatchObject({
      status: "active",
      userId: input.userId,
      sessionEpoch: 0,
      operationEpoch: 0,
    });
    expect(
      authority?.credentials.flatMap(
        (credential) => credential.directoryReferences,
      ),
    ).toHaveLength(2);
  });

  it("de-identifies the losing Account Home during concurrent password signup", async () => {
    const identity = gateway();
    const email = Email.create("concurrent-signup@example.com");
    const inputs = [
      {
        operationId: operationId("concurrent-signup-a"),
        userId: UserId.create("concurrent-signup-user-a"),
        email,
        passwordHash: PasswordHash.create("concurrent-signup-hash-a"),
        now: 1,
      },
      {
        operationId: operationId("concurrent-signup-b"),
        userId: UserId.create("concurrent-signup-user-b"),
        email,
        passwordHash: PasswordHash.create("concurrent-signup-hash-b"),
        now: 1,
      },
    ] as const;

    const results = await Promise.allSettled(
      inputs.map((input) => identity.registerWithPassword(input)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = await identity.findPasswordCredential(email);
    expect(winner).not.toBeNull();
    const loser = inputs.find((input) => input.userId !== winner?.userId);
    if (!loser) throw new Error("Concurrent signup did not produce a loser");
    await expect(
      identity.getAccountAuthority(loser.userId),
    ).resolves.toMatchObject({
      status: "deleted",
      primaryEmail: null,
      credentials: [],
    });
  });

  it("rejects an unknown RPC version before creating a mapping", async () => {
    const object = bindings.IDENTITY_DIRECTORY.get(
      bindings.IDENTITY_DIRECTORY.idFromName("generation-2:0"),
    );
    const rejected = await object.reserve({
      version: 99,
      operationId: "unsupported",
      payload: {},
    } as never);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "IDENTITY_RPC_VERSION_OR_SHAPE_INVALID" },
    });

    const lookup = await object.lookup({
      version: 1,
      payload: {
        locator: {
          generation: "generation-2",
          bucket: 0,
          opaqueKey: "not-created" as never,
        },
      },
    });
    expect(value(lookup)).toBeNull();
  });

  it("reconciles every restored mapping against Account Home authority", async () => {
    const object = bindings.IDENTITY_DIRECTORY.getByName("generation-2:0");
    const locator = {
      generation: "generation-2",
      bucket: 0,
      opaqueKey: "orphan-restored-mapping" as never,
    };
    expect(
      value(
        await object.reserve({
          version: 1,
          operationId: "orphan-restore-operation",
          payload: {
            locator,
            credential: {
              credentialId: "orphan-password",
              kind: "password",
              canonicalValueEncrypted: "encrypted-canonical",
              emailEncrypted: "encrypted-email",
              passwordHash: PasswordHash.create("orphan-password-hash"),
            },
            userId: "orphan-restored-user",
            accountEpoch: 0,
            now: 1,
            reservationExpiresAt: 100,
          },
        }),
      ),
    ).toEqual({ userId: "orphan-restored-user" });

    await expect(
      object.operatorReconcileRestoredPage({
        generation: "generation-2",
        bucket: 0,
        limit: 100,
        now: 2,
      }),
    ).resolves.toEqual({
      scanned: 1,
      tombstoned: 1,
      conflicts: 0,
      nextCursor: null,
      complete: true,
    });
    const status = value(
      await object.operatorGetShardAuthorityStatus({
        version: 1,
        payload: {},
      }),
    );
    expect(status).toMatchObject({ mappings: 1, tombstoned: 1, active: 0 });
  });

  it("keeps SSO provider boundaries and blocks verified-email auto-link", async () => {
    const identity = gateway();
    const created = await identity.lookupOrCreateSso({
      operationId: operationId("sso-create-google"),
      provider: SsoProvider.create("google"),
      subject: "same-subject",
      email: Email.create("sso@example.com"),
      now: 10,
    });
    await expect(
      identity.lookupOrCreateSso({
        operationId: operationId("sso-create-apple"),
        provider: SsoProvider.create("apple"),
        subject: "same-subject",
        email: Email.create("sso@example.com"),
        now: 11,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ALREADY_REGISTERED" });
    expect(created.userId).toEqual(expect.any(String));
  });

  it("uses one deletion epoch for retries and leaves no active authority", async () => {
    const identity = gateway();
    const userId = UserId.create("delete-stable-operation");
    await identity.registerWithPassword({
      operationId: operationId("delete-stable-operation"),
      userId,
      email: Email.create("delete@example.com"),
      passwordHash: PasswordHash.create("encoded-password-hash"),
      now: 1,
    });
    const deletion = {
      operationId: operationId("delete-account-operation"),
      userId,
      now: 2,
    };
    await identity.deleteAccount(deletion);
    await identity.deleteAccount(deletion);

    await expect(identity.getAccountAuthority(userId)).resolves.toMatchObject({
      status: "deleted",
      sessionEpoch: 1,
      operationEpoch: 1,
    });
    await expect(
      identity.findPasswordCredential(Email.create("delete@example.com")),
    ).resolves.toBeNull();
  });

  it("consumes a reset once, updates the password mapping, and bumps one epoch", async () => {
    const identity = gateway();
    const userId = UserId.create("reset-stable-operation");
    const email = Email.create("reset@example.com");
    await identity.registerWithPassword({
      operationId: operationId("reset-stable-operation"),
      userId,
      email,
      passwordHash: PasswordHash.create("old-password-hash"),
      now: 1,
    });
    await identity.storePasswordReset({
      operationId: operationId("reset-token-store"),
      userId,
      email,
      tokenHash: "one-time-token-hash",
      expiresAt: 100,
    });
    const reset = {
      operationId: operationId("reset-token-consume"),
      tokenHash: "one-time-token-hash",
      email,
      passwordHash: PasswordHash.create("new-password-hash"),
      now: 2,
    };
    await expect(identity.consumePasswordReset(reset)).resolves.toEqual({
      userId,
      sessionEpoch: 1,
    });
    await expect(identity.consumePasswordReset(reset)).resolves.toEqual({
      userId,
      sessionEpoch: 1,
    });
    await expect(
      identity.consumePasswordReset({
        ...reset,
        operationId: operationId("different-reset-consumer"),
      }),
    ).resolves.toBeNull();
    await expect(identity.findPasswordCredential(email)).resolves.toMatchObject(
      {
        userId,
        passwordHash: "new-password-hash",
      },
    );
  });

  it("keeps reset-request responses uniform and resumes password change", async () => {
    const identity = gateway();
    const userId = UserId.create("password-change-user");
    const email = Email.create("password-change@example.com");
    await identity.registerWithPassword({
      operationId: operationId("password-change-signup"),
      userId,
      email,
      passwordHash: PasswordHash.create("password-change-old-hash"),
      now: 1,
    });

    const unknown = await identity.requestPasswordReset({
      operationId: operationId("password-reset-request-unknown"),
      email: Email.create("unknown-password-reset@example.com"),
      expiresAt: 10_000,
      now: 2,
    });
    const known = await identity.requestPasswordReset({
      operationId: operationId("password-reset-request-known"),
      email,
      expiresAt: 10_000,
      now: 2,
    });
    expect(unknown).toEqual({ accepted: true });
    expect(known).toEqual(unknown);

    await expect(
      identity.changePassword({
        operationId: operationId("password-change-operation"),
        userId,
        email,
        passwordHash: PasswordHash.create("password-change-new-hash"),
        now: 3,
      }),
    ).resolves.toEqual({ sessionEpoch: 1 });
    await expect(identity.findPasswordCredential(email)).resolves.toMatchObject(
      { userId, passwordHash: "password-change-new-hash" },
    );
  });

  it("reuses the reset secret after partial reset-request persistence", async () => {
    const identity = gateway();
    const userId = UserId.create("reset-request-replay-user");
    const email = Email.create("reset-request-replay@example.com");
    await identity.registerWithPassword({
      operationId: operationId("reset-request-replay-signup"),
      userId,
      email,
      passwordHash: PasswordHash.create("reset-request-replay-hash"),
      now: 1,
    });
    const requestNow = Date.now();
    const request = {
      operationId: operationId("reset-request-replay-operation"),
      email,
      expiresAt: requestNow + 60_000,
      now: requestNow,
    };
    await identity.requestPasswordReset(request);
    const locators = await credentialLocators(
      canonicalPasswordCredential(email),
      keyring,
    );
    const tokenHashes: string[] = [];
    for (const locator of locators) {
      const stub = bindings.IDENTITY_DIRECTORY.getByName(
        directoryObjectName(locator),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        tokenHashes.push(
          state.storage.sql
            .exec<{ token_hash: string }>(
              "SELECT token_hash FROM reset_tokens WHERE operation_id = ?",
              request.operationId,
            )
            .one().token_hash,
        );
        state.storage.sql.exec(
          "DELETE FROM reset_tokens WHERE operation_id = ?",
          request.operationId,
        );
        state.storage.sql.exec(
          "DELETE FROM identity_mail_jobs WHERE operation_id = ?",
          request.operationId,
        );
      });
    }
    expect(new Set(tokenHashes).size).toBe(1);

    await identity.requestPasswordReset({ ...request, now: requestNow + 1 });
    const replayedHashes: string[] = [];
    for (const locator of locators) {
      const stub = bindings.IDENTITY_DIRECTORY.getByName(
        directoryObjectName(locator),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        replayedHashes.push(
          state.storage.sql
            .exec<{ token_hash: string }>(
              "SELECT token_hash FROM reset_tokens WHERE operation_id = ?",
              request.operationId,
            )
            .one().token_hash,
        );
      });
    }
    expect(new Set(replayedHashes)).toEqual(new Set(tokenHashes));
  });

  it("links and unlinks every generation of one logical SSO credential", async () => {
    const identity = gateway();
    const userId = UserId.create("logical-credential-operation");
    const email = Email.create("logical@example.com");
    await identity.registerWithPassword({
      operationId: operationId("logical-password-signup"),
      userId,
      email,
      passwordHash: PasswordHash.create("logical-password-hash"),
      now: 1,
    });
    const link = {
      operationId: operationId("logical-sso-link"),
      userId,
      provider: SsoProvider.create("google"),
      subject: "logical-subject",
      email,
      now: 2,
    };
    await identity.linkSso(link);
    await identity.linkSso(link);

    const linked = await identity.getAccountAuthority(userId);
    const sso = linked?.credentials.find((item) => item.kind === "sso");
    expect(sso?.directoryReferences).toHaveLength(2);
    expect(linked).toMatchObject({ sessionEpoch: 1 });
    if (!sso) throw new Error("SSO authority missing");

    await identity.unlinkCredential({
      operationId: operationId("logical-sso-unlink"),
      userId,
      credentialId: sso.credentialId,
      now: 3,
    });
    await identity.unlinkCredential({
      operationId: operationId("logical-sso-unlink"),
      userId,
      credentialId: sso.credentialId,
      now: 3,
    });

    const unlinked = await identity.getAccountAuthority(userId);
    expect(unlinked?.credentials).toHaveLength(1);
    expect(unlinked?.credentials[0]?.kind).toBe("password");
    expect(unlinked?.sessionEpoch).toBe(2);
  });

  it.each([
    "link-after-reserve",
    "link-after-activate",
    "link-after-finalize",
  ] as const)("resumes SSO link after %s", async (point) => {
    const userId = UserId.create(`user-${point}`);
    const email = Email.create(`${point}@example.com`);
    await gateway().registerWithPassword({
      operationId: operationId(`signup-${point}`),
      userId,
      email,
      passwordHash: PasswordHash.create(`hash-${point}`),
      now: 1,
    });
    const identity = gateway(keyring, failOnceAt(point));
    const input = {
      operationId: operationId(`fault-${point}`),
      userId,
      provider: SsoProvider.create("google"),
      subject: `subject-${point}`,
      email,
      now: 2,
    };
    await expect(identity.linkSso(input)).rejects.toThrow();
    await expect(identity.linkSso(input)).resolves.toBeUndefined();
    const authority = await identity.getAccountAuthority(userId);
    expect(authority?.credentials.map((item) => item.kind).sort()).toEqual([
      "password",
      "sso",
    ]);
    expect(authority?.sessionEpoch).toBe(1);
  });

  it.each(["unlink-after-directory", "unlink-after-authority"] as const)(
    "resumes SSO unlink after %s",
    async (point) => {
      const userId = UserId.create(`user-${point}`);
      const email = Email.create(`${point}@example.com`);
      const setup = gateway();
      await setup.registerWithPassword({
        operationId: operationId(`signup-${point}`),
        userId,
        email,
        passwordHash: PasswordHash.create(`hash-${point}`),
        now: 1,
      });
      await setup.linkSso({
        operationId: operationId(`link-${point}`),
        userId,
        provider: SsoProvider.create("google"),
        subject: `subject-${point}`,
        email,
        now: 2,
      });
      const sso = (await setup.getAccountAuthority(userId))?.credentials.find(
        (item) => item.kind === "sso",
      );
      if (!sso) throw new Error("SSO authority missing");
      const identity = gateway(keyring, failOnceAt(point));
      const input = {
        operationId: operationId(`fault-${point}`),
        userId,
        credentialId: sso.credentialId,
        now: 3,
      };
      await expect(identity.unlinkCredential(input)).rejects.toThrow();
      await expect(identity.unlinkCredential(input)).resolves.toBeUndefined();
      const authority = await identity.getAccountAuthority(userId);
      expect(authority?.credentials.map((item) => item.kind)).toEqual([
        "password",
      ]);
      expect(authority?.sessionEpoch).toBe(2);
    },
  );

  it.each([
    "reset-after-consume",
    "reset-after-hash",
    "reset-after-epoch",
  ] as const)("resumes password reset after %s", async (point) => {
    const userId = UserId.create(`user-${point}`);
    const email = Email.create(`${point}@example.com`);
    const setup = gateway();
    await setup.registerWithPassword({
      operationId: operationId(`signup-${point}`),
      userId,
      email,
      passwordHash: PasswordHash.create(`old-hash-${point}`),
      now: 1,
    });
    await setup.storePasswordReset({
      operationId: operationId(`store-${point}`),
      userId,
      email,
      tokenHash: `token-${point}`,
      expiresAt: 100,
    });
    const identity = gateway(keyring, failOnceAt(point));
    const input = {
      operationId: operationId(`fault-${point}`),
      tokenHash: `token-${point}`,
      email,
      passwordHash: PasswordHash.create(`new-hash-${point}`),
      now: 2,
    };
    await expect(identity.consumePasswordReset(input)).rejects.toThrow();
    await expect(identity.consumePasswordReset(input)).resolves.toEqual({
      userId,
      sessionEpoch: 1,
    });
    await expect(identity.findPasswordCredential(email)).resolves.toMatchObject(
      { passwordHash: `new-hash-${point}` },
    );
  });

  it.each([
    "delete-after-user-data",
    "delete-after-directory",
    "delete-after-finish",
  ] as const)("resumes account deletion after %s", async (point) => {
    const userId = UserId.create(`user-${point}`);
    const email = Email.create(`${point}@example.com`);
    await gateway().registerWithPassword({
      operationId: operationId(`signup-${point}`),
      userId,
      email,
      passwordHash: PasswordHash.create(`hash-${point}`),
      now: 1,
    });
    const identity = gateway(keyring, failOnceAt(point));
    const input = {
      operationId: operationId(`fault-${point}`),
      userId,
      now: 2,
    };
    await expect(identity.deleteAccount(input)).rejects.toThrow();
    await expect(identity.deleteAccount(input)).resolves.toBeUndefined();
    await expect(identity.getAccountAuthority(userId)).resolves.toMatchObject({
      status: "deleted",
      sessionEpoch: 1,
      operationEpoch: 1,
    });
    await expect(identity.findPasswordCredential(email)).resolves.toBeNull();
  });

  it("checkpoints two consecutive routing-key rotations", async () => {
    const v1 = {
      active: {
        generation: "generation-1",
        secret: "routing-secret-generation-one-minimum",
      },
      buckets: 4,
    } as const;
    const userId = UserId.create("rotation-stable-operation");
    const email = Email.create("rotation@example.com");
    await gateway(v1).registerWithPassword({
      operationId: operationId("rotation-stable-operation"),
      userId,
      email,
      passwordHash: PasswordHash.create("rotation-password-hash"),
      now: 1,
    });
    const v2 = gateway({
      active: {
        generation: "generation-2",
        secret: "routing-secret-generation-two-minimum",
      },
      previous: v1.active,
      buckets: 4,
    });
    await expect(
      v2.rotatePreviousGeneration({ now: 2 }),
    ).resolves.toMatchObject({
      scanned: 1,
      moved: 1,
      conflicts: 0,
    });
    const v3 = gateway({
      active: {
        generation: "generation-3",
        secret: "routing-secret-generation-three-min",
      },
      previous: {
        generation: "generation-2",
        secret: "routing-secret-generation-two-minimum",
      },
      buckets: 4,
    });
    await expect(
      v3.rotatePreviousGeneration({ now: 3 }),
    ).resolves.toMatchObject({
      scanned: 1,
      moved: 1,
      conflicts: 0,
    });
    const currentOnly = gateway({
      active: {
        generation: "generation-3",
        secret: "routing-secret-generation-three-min",
      },
      buckets: 4,
    });
    await expect(
      currentOnly.findPasswordCredential(email),
    ).resolves.toMatchObject({
      userId,
    });
  });

  it("retires a previous locator created during dual-write signup", async () => {
    const identity = gateway(keyring);
    const userId = UserId.create("dual-write-rotation-user");
    const email = Email.create("dual-write-rotation@example.com");
    await identity.registerWithPassword({
      operationId: operationId("dual-write-rotation-signup"),
      userId,
      email,
      passwordHash: PasswordHash.create("dual-write-rotation-hash"),
      now: 1,
    });

    await expect(
      identity.rotatePreviousGeneration({ now: 2 }),
    ).resolves.toMatchObject({ scanned: 1, moved: 1, conflicts: 0 });

    const authority = await identity.getAccountAuthority(userId);
    expect(
      authority?.credentials.flatMap(
        (credential) => credential.directoryReferences,
      ),
    ).toHaveLength(1);
    const previous = (
      await credentialLocators(canonicalPasswordCredential(email), keyring)
    ).find((candidate) => candidate.generation === keyring.previous.generation);
    if (!previous) throw new Error("previous locator missing");
    await expect(
      identity.getDirectoryShardAuthorityStatus(previous),
    ).resolves.toMatchObject({
      active: 0,
      tombstoned: 1,
      accountHomeActive: 0,
      retirementReady: true,
    });
    await expect(identity.findPasswordCredential(email)).resolves.toMatchObject(
      {
        userId,
      },
    );
  });

  it("keeps signup replay identity stable across routing-key removal", async () => {
    const first = gateway({
      active: {
        generation: "signup-generation-1",
        secret: "signup-routing-secret-generation-one",
      },
      buckets: 4,
    });
    const input = {
      operationId: operationId("signup-key-independent-operation"),
      proposedUserId: UserId.create("signup-key-independent-user"),
      email: Email.create("key-independent@example.com"),
      passwordHash: PasswordHash.create("first-signup-hash"),
      now: 1,
    };
    await expect(first.preparePasswordSignup(input)).resolves.toMatchObject({
      userId: input.proposedUserId,
      passwordHash: input.passwordHash,
      replayed: false,
    });

    const afterRemoval = gateway({
      active: {
        generation: "signup-generation-3",
        secret: "signup-routing-secret-generation-three",
      },
      buckets: 4,
    });
    await expect(
      afterRemoval.preparePasswordSignup({
        ...input,
        proposedUserId: UserId.create("must-not-replace-original-user"),
        passwordHash: PasswordHash.create("new-random-salt-hash"),
        now: 2,
      }),
    ).resolves.toMatchObject({
      userId: input.proposedUserId,
      passwordHash: input.passwordHash,
      replayed: true,
    });
  });

  it("encrypts and delivers reset mail once after Durable Object eviction", async () => {
    const stub = bindings.IDENTITY_DIRECTORY.getByName("mail-success");
    const request = {
      version: 1 as const,
      operationId: "mail-success-operation",
      payload: {
        userId: "mail-success-user",
        email: "mail-success@example.com",
        resetSecret: "reset-secret-at-least-sixteen",
        expiresAt: Date.now() + 60_000,
        providerIdempotencyKey: "mail-success-idempotency",
        now: Date.now(),
      },
    };
    value(await stub.enqueuePasswordResetMail(request));
    value(await stub.enqueuePasswordResetMail(request));
    await evictDurableObject(stub);

    const deliveries: unknown[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      overrideIdentityEnv(instance, {
        IDENTITY_MAIL_PROVIDER: {
          fetch: async (_input: unknown, init?: { body?: unknown }) => {
            deliveries.push(JSON.parse(String(init?.body)));
            return new Response(null, { status: 204 });
          },
        } as unknown as Fetcher,
      });
      state.storage.sql.exec(
        "UPDATE identity_mail_jobs SET next_run_at = ? WHERE operation_id = ?",
        Date.now() - 1,
        request.operationId,
      );
      await (instance as IdentityDirectoryDurableObject).alarm();
      const row = state.storage.sql
        .exec<{
          email: string;
          token_hash: string;
          delivery_payload_encrypted: string;
          state: string;
          attempt: number;
        }>(
          `SELECT email, token_hash, delivery_payload_encrypted, state, attempt
           FROM identity_mail_jobs WHERE operation_id = ?`,
          request.operationId,
        )
        .one();
      expect(row.state).toBe("completed");
      expect(row.attempt).toBe(2);
      expect(`${row.email}${row.delivery_payload_encrypted}`).not.toContain(
        request.payload.email,
      );
      expect(
        `${row.token_hash}${row.delivery_payload_encrypted}`,
      ).not.toContain(request.payload.resetSecret);
    });
    expect(deliveries).toEqual([
      {
        kind: "password-reset",
        deliveryPayload: {
          email: request.payload.email,
          resetSecret: request.payload.resetSecret,
          expiresAt: request.payload.expiresAt,
        },
        idempotencyKey: request.payload.providerIdempotencyKey,
      },
    ]);
  });

  it("does not call the mail provider after the reset secret expires", async () => {
    const stub = bindings.IDENTITY_DIRECTORY.getByName("mail-expired");
    const now = Date.now();
    value(
      await stub.enqueuePasswordResetMail({
        version: 1,
        operationId: "mail-expired-operation",
        payload: {
          userId: "mail-expired-user",
          email: "mail-expired@example.com",
          resetSecret: "mail-expired-secret-value",
          expiresAt: now + 60_000,
          providerIdempotencyKey: "mail-expired-idempotency",
          now,
        },
      }),
    );
    await runInDurableObject(stub, async (instance, state) => {
      let providerCalls = 0;
      overrideIdentityEnv(instance, {
        IDENTITY_MAIL_PROVIDER: {
          fetch: async () => {
            providerCalls += 1;
            return new Response(null, { status: 204 });
          },
        } as unknown as Fetcher,
      });
      state.storage.sql.exec(
        `UPDATE identity_mail_jobs SET expires_at = ?
         WHERE operation_id = ?`,
        now - 1,
        "mail-expired-operation",
      );
      await (instance as IdentityDirectoryDurableObject).alarm();
      expect(providerCalls).toBe(0);
      expect(
        state.storage.sql
          .exec<{
            state: string;
            email: string;
            delivery_payload_encrypted: string | null;
          }>(
            `SELECT state, email, delivery_payload_encrypted
             FROM identity_mail_jobs WHERE operation_id = ?`,
            "mail-expired-operation",
          )
          .one(),
      ).toEqual({
        state: "poison",
        email: "",
        delivery_payload_encrypted: null,
      });
    });
  });

  it("backs off reset mail and poisons it after five retryable failures", async () => {
    const stub = bindings.IDENTITY_DIRECTORY.getByName("mail-poison");
    value(
      await stub.enqueuePasswordResetMail({
        version: 1,
        operationId: "mail-poison-operation",
        payload: {
          userId: "mail-poison-user",
          email: "mail-poison@example.com",
          resetSecret: "mail-poison-secret-value",
          expiresAt: Date.now() + 60_000,
          providerIdempotencyKey: "mail-poison-idempotency",
          now: Date.now(),
        },
      }),
    );
    await runInDurableObject(stub, async (instance, state) => {
      let providerAttempt = 0;
      overrideIdentityEnv(instance, {
        IDENTITY_MAIL_PROVIDER: {
          fetch: async () => {
            providerAttempt += 1;
            return new Response(null, {
              status: providerAttempt === 1 ? 429 : 503,
            });
          },
        } as unknown as Fetcher,
      });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        state.storage.sql.exec(
          "UPDATE identity_mail_jobs SET next_run_at = ? WHERE operation_id = ?",
          Date.now() - 1,
          "mail-poison-operation",
        );
        await (instance as IdentityDirectoryDurableObject).alarm();
        const row = state.storage.sql
          .exec<{
            state: string;
            attempt: number;
            next_run_at: number;
            poison_reason: string | null;
          }>(
            `SELECT state, attempt, next_run_at, poison_reason
             FROM identity_mail_jobs WHERE operation_id = ?`,
            "mail-poison-operation",
          )
          .one();
        expect(row.attempt).toBe(attempt);
        expect(row.state).toBe(attempt === 5 ? "poison" : "pending");
        expect(row.next_run_at).toBeGreaterThan(Date.now() - 1);
        expect(row.poison_reason === null).toBe(attempt < 5);
      }
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      const terminal = state.storage.sql
        .exec<{
          email: string;
          delivery_payload_encrypted: string | null;
        }>(
          `SELECT email, delivery_payload_encrypted FROM identity_mail_jobs
           WHERE operation_id = ?`,
          "mail-poison-operation",
        )
        .one();
      expect(terminal.email).toBe("");
      expect(terminal.delivery_payload_encrypted).toBeNull();
      state.storage.sql.exec(
        `UPDATE identity_mail_jobs SET terminal_at = ?
         WHERE operation_id = ?`,
        Date.now() - 24 * 60 * 60_000 - 1,
        "mail-poison-operation",
      );
      await (instance as IdentityDirectoryDurableObject).alarm();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM identity_mail_jobs
             WHERE operation_id = ?`,
            "mail-poison-operation",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("lazily evicts expired encrypted operation registry PII", async () => {
    const identity = gateway();
    const operation = operationId("registry-ttl-operation");
    const email = Email.create("registry-ttl@example.com");
    await identity.preparePasswordSignup({
      operationId: operation,
      proposedUserId: UserId.create("registry-ttl-user"),
      email,
      passwordHash: PasswordHash.create("registry-ttl-hash"),
      now: Date.now(),
    });
    const digest = await sha256Hex(operation);
    const registry = bindings.IDENTITY_DIRECTORY.getByName(
      `signup-operation:${digest}`,
    );
    await runInDurableObject(registry, async (_instance, state) => {
      const stored = state.storage.sql
        .exec<{ email: string; expires_at: number }>(
          `SELECT email, expires_at FROM signup_operations
           WHERE opaque_operation_key = ?`,
          digest,
        )
        .one();
      expect(stored.email).not.toContain(email);
      expect(stored.expires_at).toBeGreaterThan(Date.now());
      state.storage.sql.exec(
        "UPDATE signup_operations SET expires_at = ?",
        Date.now() - 1,
      );
    });
    await expect(
      identity.preparePasswordSignup({
        operationId: operation,
        proposedUserId: UserId.create("registry-ttl-reused-user"),
        email,
        passwordHash: PasswordHash.create("registry-ttl-reused-hash"),
        now: Date.now(),
      }),
    ).resolves.toMatchObject({
      userId: "registry-ttl-reused-user",
      replayed: false,
    });
    await runInDurableObject(registry, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM signup_operations",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("returns validation failures for malformed Account Home locators", async () => {
    const stub = bindings.ACCOUNT_HOME.getByName("malformed-locator-user");
    const result = await (
      stub as unknown as {
        replaceCredentialLocator(input: unknown): Promise<RpcResult<null>>;
      }
    ).replaceCredentialLocator({
      version: 1,
      operationId: "malformed-locator-operation",
      payload: {
        userId: "malformed-locator-user",
        previous: null,
        active: {
          generation: "generation-2",
          bucket: 0,
          opaqueKey: "opaque",
        },
        kind: "password",
        now: Date.now(),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "IDENTITY_RPC_LOCATOR_INVALID" },
    });
  });

  it("stores credential PII only in encrypted envelopes", async () => {
    const identity = gateway();
    const email = Email.create("credential-envelope@example.com");
    await identity.registerWithPassword({
      operationId: operationId("credential-envelope-operation"),
      userId: UserId.create("credential-envelope-user"),
      email,
      passwordHash: PasswordHash.create("credential-envelope-hash"),
      now: Date.now(),
    });
    const locator = (
      await credentialLocators(canonicalPasswordCredential(email), keyring)
    ).find((candidate) => candidate.generation === keyring.active.generation);
    if (!locator) throw new Error("active locator missing");
    const shard = bindings.IDENTITY_DIRECTORY.getByName(
      directoryObjectName(locator),
    );
    await runInDurableObject(shard, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ canonical_value: string; verified_email: string }>(
          `SELECT canonical_value, verified_email FROM credential_mappings
           WHERE opaque_key = ?`,
          locator.opaqueKey,
        )
        .one();
      expect(row.canonical_value).not.toContain(email);
      expect(row.verified_email).not.toContain(email);
      expect(row.canonical_value).not.toContain(
        canonicalPasswordCredential(email),
      );
    });
  });

  it("uses the minimum pending operation id as the reservation winner", async () => {
    const locator = {
      generation: "winner-generation",
      bucket: 0,
      opaqueKey: opaqueCredentialKey("winner-opaque-key"),
    } as const;
    const stub = bindings.IDENTITY_DIRECTORY.getByName(
      directoryObjectName(locator),
    );
    const reserve = (id: string, userId: string) =>
      stub.reserve({
        version: 1,
        operationId: id,
        payload: {
          locator,
          credential: {
            credentialId: `credential-${id}`,
            kind: "password" as const,
            canonicalValueEncrypted: `encrypted-canonical-${id}`,
            emailEncrypted: `encrypted-email-${id}`,
            passwordHash: PasswordHash.create(`hash-${id}`),
          },
          userId,
          accountEpoch: 0,
          now: 1,
          reservationExpiresAt: Date.now() + 60_000,
        },
      });
    value(await reserve("winner-z", "winner-user-z"));
    value(await reserve("winner-a", "winner-user-a"));
    expect(
      value(await stub.lookup({ version: 1, payload: { locator } })),
    ).toMatchObject({
      userId: "winner-user-a",
      operationId: "winner-a",
      state: "reserved",
    });

    const ssoLocator = {
      generation: "winner-generation",
      bucket: 0,
      opaqueKey: opaqueCredentialKey("winner-sso-opaque-key"),
    } as const;
    const reserveSso = (id: string, userId: string) =>
      stub.reserve({
        version: 1,
        operationId: id,
        payload: {
          locator: ssoLocator,
          credential: {
            credentialId: `sso-credential-${id}`,
            kind: "sso" as const,
            canonicalValueEncrypted: `encrypted-sso-canonical-${id}`,
            provider: SsoProvider.create("google"),
            subjectEncrypted: `encrypted-subject-${id}`,
            verifiedEmailEncrypted: `encrypted-verified-email-${id}`,
          },
          userId,
          accountEpoch: 0,
          now: 1,
          reservationExpiresAt: Date.now() + 60_000,
        },
      });
    value(await reserveSso("sso-winner-z", "sso-winner-user-z"));
    value(await reserveSso("sso-winner-a", "sso-winner-user-a"));
    expect(
      value(
        await stub.lookup({ version: 1, payload: { locator: ssoLocator } }),
      ),
    ).toMatchObject({
      userId: "sso-winner-user-a",
      operationId: "sso-winner-a",
      state: "reserved",
    });
  });

  it("backs off and poisons a failing reconcile operation without a hot loop", async () => {
    const locator = {
      generation: "reconcile-generation",
      bucket: 0,
      opaqueKey: opaqueCredentialKey("reconcile-opaque-key"),
    } as const;
    const stub = bindings.IDENTITY_DIRECTORY.getByName(
      directoryObjectName(locator),
    );
    value(
      await stub.reserve({
        version: 1,
        operationId: "reconcile-poison-operation",
        payload: {
          locator,
          credential: {
            credentialId: "reconcile-credential",
            kind: "password",
            canonicalValueEncrypted: "reconcile-canonical-encrypted",
            emailEncrypted: "reconcile-email-encrypted",
            passwordHash: PasswordHash.create("reconcile-hash"),
          },
          userId: "reconcile-user",
          accountEpoch: 0,
          now: 1,
          reservationExpiresAt: 1,
        },
      }),
    );
    await runInDurableObject(stub, async (instance, state) => {
      overrideIdentityEnv(instance, {
        USER_DATA: {
          getByName: () => ({
            identityGetStatusV1: async () => ({
              ok: false,
              error: {
                kind: "infrastructure",
                code: "RECONCILE_DEPENDENCY_UNAVAILABLE",
                message: "unavailable",
                retryable: true,
              },
            }),
          }),
        },
      });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        state.storage.sql.exec(
          "UPDATE directory_reconcile_jobs SET next_run_at = ?",
          Date.now() - 1,
        );
        state.storage.sql.exec(
          `UPDATE directory_reconcile_failures SET next_run_at = ?
           WHERE operation_id = ?`,
          Date.now() - 1,
          "reconcile-poison-operation",
        );
        await (instance as IdentityDirectoryDurableObject).alarm();
        const failure = state.storage.sql
          .exec<{
            attempt: number;
            next_run_at: number;
            poison_reason: string | null;
          }>(
            `SELECT attempt, next_run_at, poison_reason
             FROM directory_reconcile_failures WHERE operation_id = ?`,
            "reconcile-poison-operation",
          )
          .one();
        expect(failure.attempt).toBe(attempt);
        expect(failure.next_run_at).toBeGreaterThan(Date.now() - 1);
        expect(failure.poison_reason === null).toBe(attempt < 5);
      }
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
