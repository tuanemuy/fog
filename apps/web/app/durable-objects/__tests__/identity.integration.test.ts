import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import type { DirectoryKeyring } from "@repo/core/adapters/cloudflare/identityRouting";
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
): CloudflareIdentityGateway {
  return new CloudflareIdentityGateway(
    bindings.IDENTITY_DIRECTORY as never,
    bindings.ACCOUNT_HOME as never,
    bindings.USER_DATA as never,
    routing,
  );
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("identity Durable Object contract", () => {
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
    expect(new Set(authority?.locators.map((item) => item.generation))).toEqual(
      new Set(["generation-1", "generation-2"]),
    );
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

  it("keeps SSO provider boundaries and blocks verified-email auto-link", async () => {
    const identity = gateway();
    const created = await identity.lookupOrCreateSso({
      operationId: operationId("sso-create-google"),
      provider: SsoProvider.create("google"),
      subject: "same-subject",
      email: Email.create("sso@example.com"),
      proposedUserId: UserId.create("sso-create-google"),
      now: 10,
    });
    await expect(
      identity.lookupOrCreateSso({
        operationId: operationId("sso-create-apple"),
        provider: SsoProvider.create("apple"),
        subject: "same-subject",
        email: Email.create("sso@example.com"),
        proposedUserId: UserId.create("sso-create-apple"),
        now: 11,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ALREADY_REGISTERED" });
    expect(created.userId).toBe("sso-create-google");
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
});
