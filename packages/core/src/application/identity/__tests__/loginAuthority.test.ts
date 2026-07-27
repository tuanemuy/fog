import type { RequestContainer } from "@repo/core/application/di/types";
import { directoryReference } from "@repo/core/application/identity/contracts";
import { loginWithPassword } from "@repo/core/application/identity/loginWithPassword";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import {
  Email,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";

const userId = UserId.create("authority-user");
const reference = directoryReference("opaque-authority-reference");

function container(
  status: "active" | "pending" | "deleting" | "deleted",
): RequestContainer {
  return {
    config: { ...content, appUrl: "https://example.com" },
    identity: {
      preparePasswordSignup: async () => {
        throw new Error("login must not prepare signup");
      },
      registerWithPassword: async () => ({ sessionEpoch: 0 }),
      findPasswordCredential: async () => ({
        userId,
        credentialId: "password-credential",
        email: Email.create("person@example.com"),
        passwordHash: PasswordHash.create("stored-hash"),
        directoryReference: reference,
        accountEpoch: 2,
      }),
      getAccountAuthority: async () => ({
        userId,
        status,
        primaryEmail: Email.create("person@example.com"),
        authMethods: ["password"],
        credentials: [
          {
            credentialId: "password-credential",
            kind: "password",
            email: Email.create("person@example.com"),
            passwordHash: PasswordHash.create("stored-hash"),
            directoryReferences: [reference],
          },
        ],
        sessionEpoch: 4,
        operationEpoch: 2,
      }),
      getCurrentAccount: async () => null,
    },
    passwordHasher: {
      hash: async () => PasswordHash.create("unused"),
      verify: async () => true,
    },
    sessionCodec: {
      issue: async () => "unused",
      verify: async () => null,
    },
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

describe("login Account Home authority", () => {
  it.each(["pending", "deleting", "deleted"] as const)(
    "collapses %s authority to the public credential error",
    async (status) => {
      await expect(
        loginWithPassword({
          container: container(status),
          input: {
            email: "person@example.com",
            password: "password123",
          },
        }),
      ).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      });
    },
  );

  it("returns the authority epoch only after mapping and epoch match", async () => {
    await expect(
      loginWithPassword({
        container: container("active"),
        input: { email: "person@example.com", password: "password123" },
      }),
    ).resolves.toEqual({ userId, sessionEpoch: 4 });
  });
});
