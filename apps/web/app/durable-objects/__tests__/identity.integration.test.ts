import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import type { DirectoryKeyring } from "@repo/core/adapters/cloudflare/identityRouting";
import type {
  IdentitySagaFaultHook,
  IdentitySagaFaultPoint,
} from "@repo/core/application/identity/coordinator";
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
  return faultHook
    ? CloudflareIdentityGateway.withFaultInjectionForTest(
        bindings.IDENTITY_DIRECTORY as never,
        bindings.ACCOUNT_HOME as never,
        bindings.USER_DATA as never,
        routing,
        faultHook,
      )
    : new CloudflareIdentityGateway(
        bindings.IDENTITY_DIRECTORY as never,
        bindings.ACCOUNT_HOME as never,
        bindings.USER_DATA as never,
        routing,
      );
}

function failOnceAt(expected: IdentitySagaFaultPoint): IdentitySagaFaultHook {
  let armed = true;
  return (actual) => {
    if (armed && actual === expected) {
      armed = false;
      throw new Error(`INJECTED_FAULT:${actual}`);
    }
  };
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
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
    await expect(identity.registerWithPassword(input)).rejects.toThrow(
      `INJECTED_FAULT:${point}`,
    );
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
    await expect(identity.lookupOrCreateSso(input)).rejects.toThrow(
      `INJECTED_FAULT:${point}`,
    );
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
      new Set(
        authority?.credentials.flatMap((credential) =>
          credential.locators.map((item) => item.generation),
        ),
      ),
    ).toEqual(new Set(["generation-1", "generation-2"]));
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
              kind: "password",
              canonicalValue: "email:orphan@example.com",
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
      tokenHash: "unknown-reset-token-hash",
      expiresAt: 10_000,
      now: 2,
    });
    const known = await identity.requestPasswordReset({
      operationId: operationId("password-reset-request-known"),
      email,
      tokenHash: "known-reset-token-hash",
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
    expect(sso?.locators).toHaveLength(2);
    expect(linked).toMatchObject({ sessionEpoch: 1 });
    if (!sso?.locators[0]) throw new Error("SSO authority missing");

    await identity.unlinkCredential({
      operationId: operationId("logical-sso-unlink"),
      userId,
      locator: sso.locators[0],
      now: 3,
    });
    await identity.unlinkCredential({
      operationId: operationId("logical-sso-unlink"),
      userId,
      locator: sso.locators[0],
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
    await expect(identity.linkSso(input)).rejects.toThrow(
      `INJECTED_FAULT:${point}`,
    );
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
      if (!sso?.locators[0]) throw new Error("SSO authority missing");
      const identity = gateway(keyring, failOnceAt(point));
      const input = {
        operationId: operationId(`fault-${point}`),
        userId,
        locator: sso.locators[0],
        now: 3,
      };
      await expect(identity.unlinkCredential(input)).rejects.toThrow(
        `INJECTED_FAULT:${point}`,
      );
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
    await expect(identity.consumePasswordReset(input)).rejects.toThrow(
      `INJECTED_FAULT:${point}`,
    );
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
    await expect(identity.deleteAccount(input)).rejects.toThrow(
      `INJECTED_FAULT:${point}`,
    );
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
      authority?.credentials.flatMap((credential) =>
        credential.locators.map((item) => item.generation),
      ),
    ).toEqual([keyring.active.generation]);
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
});
