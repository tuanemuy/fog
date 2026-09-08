import { isBusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { describe, expect, it } from "vitest";
import {
  FakeIdGenerator,
  FakeLogger,
  FakePasswordHasher,
  FakeTokenGenerator,
  trippingIdentityGateway,
  trippingKnowledgeGateway,
  trippingMemoGateway,
  trippingSearchGateway,
} from "../../__tests__/fakes";
import {
  isNotFoundError,
  isSystemError,
  SystemError,
  SystemErrorCode,
} from "../../errors";
import type { UsecaseContainer } from "../../types";
import type {
  CredentialCoordinateDto,
  CurrentUserDto,
  IdentityGateway,
} from "../gateway";
import { getCurrentUser } from "../getCurrentUser";
import { createIdentityTuning } from "../tuning";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function trip(name: keyof IdentityGateway): never {
  throw new Error(`unexpected gateway call: ${name}`);
}

function makeContainer(gateway: IdentityGateway): UsecaseContainer {
  return {
    clock: { now: () => NOW },
    idGenerator: new FakeIdGenerator(),
    tokenGenerator: new FakeTokenGenerator(),
    logger: new FakeLogger(),
    config: {
      appUrl: "http://localhost",
      siteName: "fog",
      defaultTitle: "fog",
      defaultDescription: "",
      themeColor: "#000",
    },
    identityGateway: gateway,
    identityTuning: createIdentityTuning(),
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`unexpected knowledge gateway call: ${name}`);
    }),
    searchGateway: trippingSearchGateway((name) => {
      throw new Error(`unexpected search gateway call: ${name}`);
    }),
    passwordHasher: new FakePasswordHasher(),
  };
}

const CURRENT: CurrentUserDto = {
  userId: "user-1",
  trashRetentionDays: 30,
  credentials: [
    {
      credentialId: "cred-sso",
      kind: "sso",
      label: "google",
      usableForLogin: true,
    },
    {
      credentialId: "cred-email",
      kind: "email",
      label: "",
      usableForLogin: true,
    },
  ],
  locators: [
    {
      credentialId: "cred-email",
      kind: "email",
      mapping: "g1:b0:hmac",
      credentialVersion: 1,
      usableForLogin: true,
      label: "",
    },
  ],
};

function run(gateway: IdentityGateway, userId = "user-1") {
  return getCurrentUser({
    container: makeContainer(gateway),
    input: { userId },
  });
}

describe("getCurrentUser", () => {
  it("returns the view with the decrypted address", async () => {
    const reveals: [CredentialCoordinateDto, string][] = [];
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => CURRENT,
      revealCanonical: async (coordinate, userId) => {
        reveals.push([coordinate, userId]);
        return "user@example.com";
      },
    });

    await expect(run(gateway)).resolves.toEqual({
      userId: "user-1",
      email: "user@example.com",
      credentials: CURRENT.credentials,
      trashRetentionDays: 30,
    });
    expect(reveals).toEqual([
      [
        { credentialId: "cred-email", kind: "email", mapping: "g1:b0:hmac" },
        "user-1",
      ],
    ]);
  });

  it("throws USER_NOT_FOUND when the account is unknown", async () => {
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => null,
    });

    await expect(run(gateway)).rejects.toSatisfy(
      (error) => isNotFoundError(error) && error.code === "USER_NOT_FOUND",
    );
  });

  // `USER_NOT_FOUND` is for an initialised object with no settings row. A
  // never-initialised object is a system condition the gateway reports as
  // `SystemError(NotInitialized)`, and the usecase does not re-read it.
  it("passes SystemError(NotInitialized) through unchanged", async () => {
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => {
        throw new SystemError(
          SystemErrorCode.NotInitialized,
          "The Durable Object has not been initialised",
        );
      },
    });

    await expect(run(gateway)).rejects.toSatisfy(
      (error) =>
        isSystemError(error) && error.code === SystemErrorCode.NotInitialized,
    );
  });

  it("treats a missing email credential as drift", async () => {
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => ({
        ...CURRENT,
        credentials: CURRENT.credentials.filter((c) => c.kind !== "email"),
      }),
    });

    await expect(run(gateway)).rejects.toSatisfy(
      (error) =>
        isSystemError(error) &&
        error.code === SystemErrorCode.DataIntegrityError,
    );
  });

  it("treats a missing reverse-index locator as drift", async () => {
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => ({ ...CURRENT, locators: [] }),
    });

    await expect(run(gateway)).rejects.toSatisfy(
      (error) =>
        isSystemError(error) &&
        error.code === SystemErrorCode.DataIntegrityError,
    );
  });

  it("treats an address that cannot be revealed as drift", async () => {
    const gateway = trippingIdentityGateway(trip, {
      readCurrentUser: async () => CURRENT,
      revealCanonical: async () => null,
    });

    await expect(run(gateway)).rejects.toSatisfy(
      (error) =>
        isSystemError(error) &&
        error.code === SystemErrorCode.DataIntegrityError,
    );
  });

  it("rejects a blank userId before reaching the gateway", async () => {
    await expect(run(trippingIdentityGateway(trip), "  ")).rejects.toSatisfy(
      (error) =>
        isBusinessRuleError(error) &&
        error.code === IdentityErrorCode.InvalidUserId,
    );
  });
});
