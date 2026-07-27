import type { IdentityApplicationPort } from "../contracts";
import type { UsecaseContainer } from "../../types";
import { PasswordHash } from "../../../domain/identity/valueObject";
import { describe, expect, it, vi } from "vitest";
import { registerWithPassword } from "../registerWithPassword";

function fixture(): {
  container: UsecaseContainer;
  identity: IdentityApplicationPort;
  prepare: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  setNow: (value: number) => void;
} {
  let prepared:
    | {
        userId: Parameters<
          IdentityApplicationPort["preparePasswordSignup"]
        >[0]["proposedUserId"];
        passwordHash: Parameters<
          IdentityApplicationPort["preparePasswordSignup"]
        >[0]["passwordHash"];
        preparedAt: number;
      }
    | undefined;
  let nextId = 0;
  let now = 1;
  const prepare = vi.fn(
    async (
      input: Parameters<IdentityApplicationPort["preparePasswordSignup"]>[0],
    ) => {
      if (prepared) return { ...prepared, replayed: true };
      prepared = {
        userId: input.proposedUserId,
        passwordHash: input.passwordHash,
        preparedAt: input.now,
      };
      return { ...prepared, replayed: false };
    },
  );
  const register = vi.fn(async () => ({ sessionEpoch: 0 }));
  const identity = {
    preparePasswordSignup: prepare,
    registerWithPassword: register,
    findPasswordCredential: async () => null,
    getAccountAuthority: async () => null,
    getCurrentAccount: async () => null,
  } satisfies IdentityApplicationPort;
  return {
    identity,
    prepare,
    register,
    setNow: (value) => {
      now = value;
    },
    container: {
      config: {
        appUrl: "https://example.com",
        siteName: "Fog",
        defaultTitle: "Fog",
        defaultDescription: "Fog",
        themeColor: "#000000",
      },
      identity,
      clock: { now: () => new Date(now) },
      idGenerator: {
        next: () => `server-generated-user-${++nextId}`,
        validate: (value) => value.startsWith("server-generated-user-"),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      passwordHasher: {
        hash: async (password) => PasswordHash.create(`hash:${password}`),
        verify: async (password, hash) => hash === `hash:${password}`,
      },
    },
  };
}

describe("registerWithPassword public idempotency", () => {
  it("keeps the caller operation id separate from the server user id", async () => {
    const { container, prepare, register } = fixture();
    const result = await registerWithPassword({
      container,
      input: {
        operationId: "0197f160-76f5-7000-8000-000000000019",
        email: "person@example.com",
        password: "password123",
      },
    });

    expect(result.userId).toBe("server-generated-user-1");
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "0197f160-76f5-7000-8000-000000000019",
        proposedUserId: "server-generated-user-1",
      }),
    );
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "server-generated-user-1" }),
    );
  });

  it("reuses the original user and hash on a public replay", async () => {
    const { container, register, setNow } = fixture();
    const input = {
      operationId: "0197f160-76f5-7000-8000-000000000019",
      email: "person@example.com",
      password: "password123",
    };

    await registerWithPassword({ container, input });
    setNow(99_999);
    const replay = await registerWithPassword({ container, input });

    expect(replay.userId).toBe("server-generated-user-1");
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: "server-generated-user-1",
        passwordHash: "hash:password123",
        now: 1,
      }),
    );
  });

  it("rejects a replay that changes the password", async () => {
    const { container, register } = fixture();
    const operationId = "0197f160-76f5-7000-8000-000000000019";
    await registerWithPassword({
      container,
      input: {
        operationId,
        email: "person@example.com",
        password: "password123",
      },
    });

    await expect(
      registerWithPassword({
        container,
        input: {
          operationId,
          email: "person@example.com",
          password: "different-password",
        },
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_OPERATION_PAYLOAD_CONFLICT" });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
