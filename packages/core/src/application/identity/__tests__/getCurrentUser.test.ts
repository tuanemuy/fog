import type { RequestContainer } from "@repo/core/application/di/types";
import type {
  AccountHomePort,
  CredentialDirectoryPort,
  UserDataIdentityPort,
} from "@repo/core/application/identity/contracts";
import { IdentityCoordinator } from "@repo/core/application/identity/coordinator";
import { getCurrentUser } from "@repo/core/application/identity/getCurrentUser";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { content } from "@repo/core/config";
import {
  Email,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { FakeLogger } from "../../__tests__/fakes";

const userId = UserId.create("current-user-partial-failure");

function container(
  failingPort: "account-home" | "user-data",
): RequestContainer {
  const unavailable = new SystemError(
    SystemErrorCode.NetworkError,
    `${failingPort} unavailable`,
  );
  const accountHome = {
    getAuthSummary: async () => {
      if (failingPort === "account-home") throw unavailable;
      return {
        userId,
        status: "active",
        primaryEmail: Email.create("person@example.com"),
        authMethods: ["password"],
        credentials: [
          {
            credentialId: "password-credential",
            kind: "password",
            email: Email.create("person@example.com"),
            passwordHash: PasswordHash.create("stored-hash"),
            directoryReferences: [],
          },
        ],
        sessionEpoch: 1,
        operationEpoch: 1,
      } as const;
    },
  } as unknown as AccountHomePort;
  const userData = {
    getProfile: async () => {
      if (failingPort === "user-data") throw unavailable;
      return { userId, displayName: "Person", trashRetentionDays: 30 };
    },
  } as unknown as UserDataIdentityPort;
  const identity = new IdentityCoordinator({
    directory: {} as CredentialDirectoryPort,
    accountHome,
    userData,
    newUserId: () => userId,
  });

  return {
    config: { ...content, appUrl: "https://example.com" },
    identity,
    passwordHasher: {
      hash: async () => {
        throw new Error("current-user must not hash");
      },
      verify: async () => {
        throw new Error("current-user must not verify");
      },
    },
    sessionCodec: {
      issue: async () => {
        throw new Error("current-user must not issue a session");
      },
      verify: async () => null,
    },
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: new FakeLogger(),
  };
}

describe("current-user partial dependency failure", () => {
  it.each(["account-home", "user-data"] as const)(
    "rejects a retryable error instead of a partial view when %s is unavailable",
    async (failingPort) => {
      await expect(
        getCurrentUser({
          container: container(failingPort),
          input: { userId },
        }),
      ).rejects.toMatchObject({
        code: SystemErrorCode.NetworkError,
        retryable: true,
      });
    },
  );
});
