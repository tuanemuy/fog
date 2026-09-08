import { PlainPassword } from "@repo/core/domain/identity/valueObject";
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
  trippingTrashGateway,
} from "../../__tests__/fakes";
import { isValidationError } from "../../errors";
import type { UsecaseContainer } from "../../types";
import type {
  AttemptOutcomeDto,
  CredentialCoordinateDto,
  IdentityGateway,
  LoginCredentialDto,
} from "../gateway";
import {
  decayedFailedAttempts,
  lockoutWidthMs,
  loginWithPassword,
} from "../loginWithPassword";
import { createIdentityTuning } from "../tuning";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const TUNING = createIdentityTuning();
const CORRECT_PASSWORD = "correct-horse";
const WRONG_PASSWORD = "wrong-password";
const EMAIL = "user@example.com";

const COORDINATE: CredentialCoordinateDto = {
  credentialId: "cred-1",
  kind: "email",
  mapping: "g1:b0:hmac",
};

function trip(name: keyof IdentityGateway): never {
  throw new Error(`unexpected gateway call: ${name}`);
}

async function verifierFor(password: string): Promise<string> {
  // A throwaway instance so the digest never counts against the hasher under test.
  return new FakePasswordHasher().hash(PlainPassword.create(password));
}

async function resolvedRow(
  overrides: Partial<LoginCredentialDto> = {},
): Promise<LoginCredentialDto> {
  return {
    coordinate: COORDINATE,
    userId: "user-1",
    credentialVersion: 1,
    changeState: null,
    changeOrigin: null,
    failedAttempts: 0,
    nextAttemptAllowedAt: null,
    passwordVerifier: await verifierFor(CORRECT_PASSWORD),
    ...overrides,
  };
}

function makeContainer(
  gateway: IdentityGateway,
  hasher: FakePasswordHasher,
): UsecaseContainer {
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
      ssoProviders: [],
    },
    identityGateway: gateway,
    identityTuning: TUNING,
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`unexpected knowledge gateway call: ${name}`);
    }),
    searchGateway: trippingSearchGateway((name) => {
      throw new Error(`unexpected search gateway call: ${name}`);
    }),
    trashGateway: trippingTrashGateway((name) => {
      throw new Error(`unexpected trash gateway call: ${name}`);
    }),
    passwordHasher: hasher,
  };
}

async function invalidCredentialsFrom(
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isValidationError(error)) {
      expect(error.code).toBe("INVALID_CREDENTIALS");
      return;
    }
    throw error;
  }
  throw new Error("expected loginWithPassword to reject");
}

async function login(
  gateway: IdentityGateway,
  hasher: FakePasswordHasher,
  input = { email: EMAIL, password: CORRECT_PASSWORD },
) {
  return loginWithPassword({
    container: makeContainer(gateway, hasher),
    input,
  });
}

describe("loginWithPassword", () => {
  describe("paths that never reach a verifier pay one dummy derivation", () => {
    it.each<[string, () => Promise<LoginCredentialDto | null>]>([
      ["an unknown email", async () => null],
      ["a reservation with no user", () => resolvedRow({ userId: null })],
      ["a row with no verifier", () => resolvedRow({ passwordVerifier: null })],
      [
        "a credential change in flight",
        () => resolvedRow({ changeState: "pending" }),
      ],
      [
        "a throttled row",
        () =>
          resolvedRow({
            nextAttemptAllowedAt: new Date(NOW.getTime() + 1),
          }),
      ],
    ])("%s", async (_label, row) => {
      const resolved = await row();
      const hasher = new FakePasswordHasher();
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
      });

      await invalidCredentialsFrom(() => login(gateway, hasher));

      expect(hasher.hashCalls).toBe(1);
      expect(hasher.verifyCalls).toBe(0);
    });

    // Rule iii: a throttled attempt reports nothing and moves no counter — even
    // with the correct password, `recordAttemptOutcome` stays untouched.
    it("reports nothing for a throttled row", async () => {
      const resolved = await resolvedRow({
        failedAttempts: 5,
        nextAttemptAllowedAt: new Date(NOW.getTime() + 30_000),
      });
      const outcomes: AttemptOutcomeDto[] = [];
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        recordAttemptOutcome: async (_coordinate, outcome) => {
          outcomes.push(outcome);
        },
      });

      await invalidCredentialsFrom(() =>
        login(gateway, new FakePasswordHasher()),
      );

      expect(outcomes).toEqual([]);
    });
  });

  describe("malformed input", () => {
    it("folds an invalid email into INVALID_CREDENTIALS before any gateway call", async () => {
      const hasher = new FakePasswordHasher();
      await invalidCredentialsFrom(() =>
        login(trippingIdentityGateway(trip), hasher, {
          email: "not-an-email",
          password: CORRECT_PASSWORD,
        }),
      );
      expect(hasher.verifyCalls).toBe(0);
    });

    it("folds a 7-character password into INVALID_CREDENTIALS before any gateway call", async () => {
      const hasher = new FakePasswordHasher();
      await invalidCredentialsFrom(() =>
        login(trippingIdentityGateway(trip), hasher, {
          email: EMAIL,
          password: "1234567",
        }),
      );
      expect(hasher.verifyCalls).toBe(0);
    });
  });

  describe("a wrong password", () => {
    it("reports a failure outcome computed from the stored counter", async () => {
      const resolved = await resolvedRow({ failedAttempts: 4 });
      const hasher = new FakePasswordHasher();
      const outcomes: [CredentialCoordinateDto, AttemptOutcomeDto][] = [];
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        recordAttemptOutcome: async (coordinate, outcome) => {
          outcomes.push([coordinate, outcome]);
        },
      });

      await invalidCredentialsFrom(() =>
        login(gateway, hasher, { email: EMAIL, password: WRONG_PASSWORD }),
      );

      expect(hasher.hashCalls).toBe(0);
      expect(hasher.verifyCalls).toBe(1);
      expect(outcomes).toEqual([
        [
          COORDINATE,
          {
            outcome: "failure",
            observedFailedAttempts: 4,
            failedAttempts: 5,
            nextAttemptAllowedAt: new Date(
              NOW.getTime() + TUNING.loginLockoutBaseMs,
            ),
          },
        ],
      ]);
    });

    it("stays below the lockout threshold with a zero-width lockout", async () => {
      const resolved = await resolvedRow({ failedAttempts: 0 });
      const outcomes: AttemptOutcomeDto[] = [];
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        recordAttemptOutcome: async (_coordinate, outcome) => {
          outcomes.push(outcome);
        },
      });

      await invalidCredentialsFrom(() =>
        login(gateway, new FakePasswordHasher(), {
          email: EMAIL,
          password: WRONG_PASSWORD,
        }),
      );

      expect(outcomes).toEqual([
        {
          outcome: "failure",
          observedFailedAttempts: 0,
          failedAttempts: 1,
          nextAttemptAllowedAt: NOW,
        },
      ]);
    });

    it("decays the stored counter before adding the new failure", async () => {
      const resolved = await resolvedRow({
        failedAttempts: 6,
        nextAttemptAllowedAt: new Date(
          NOW.getTime() - 2 * TUNING.loginAttemptDecayMs,
        ),
      });
      const outcomes: AttemptOutcomeDto[] = [];
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        recordAttemptOutcome: async (_coordinate, outcome) => {
          outcomes.push(outcome);
        },
      });

      await invalidCredentialsFrom(() =>
        login(gateway, new FakePasswordHasher(), {
          email: EMAIL,
          password: WRONG_PASSWORD,
        }),
      );

      expect(outcomes).toEqual([
        {
          outcome: "failure",
          observedFailedAttempts: 6,
          failedAttempts: 5,
          nextAttemptAllowedAt: new Date(
            NOW.getTime() + TUNING.loginLockoutBaseMs,
          ),
        },
      ]);
    });
  });

  describe("the reachability check", () => {
    it("rejects a verified password whose locator is missing", async () => {
      const resolved = await resolvedRow();
      const hasher = new FakePasswordHasher();
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        findCredentialLocator: async () => null,
      });

      await invalidCredentialsFrom(() => login(gateway, hasher));
      expect(hasher.verifyCalls).toBe(1);
    });

    it("rejects a verified password whose credentialVersion disagrees", async () => {
      const resolved = await resolvedRow({ credentialVersion: 1 });
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async () => resolved,
        findCredentialLocator: async () => ({
          credentialId: "cred-1",
          kind: "email",
          mapping: COORDINATE.mapping,
          credentialVersion: 2,
          usableForLogin: true,
          label: "",
        }),
      });

      await invalidCredentialsFrom(() =>
        login(gateway, new FakePasswordHasher()),
      );
    });
  });

  describe("success", () => {
    it("reports success only after the reachability check and returns the userId", async () => {
      const resolved = await resolvedRow({ failedAttempts: 3 });
      const hasher = new FakePasswordHasher();
      const calls: string[] = [];
      const outcomes: AttemptOutcomeDto[] = [];
      const gateway = trippingIdentityGateway(trip, {
        resolveLoginCredential: async (canonical) => {
          calls.push(`resolve:${canonical}`);
          return resolved;
        },
        findCredentialLocator: async (userId, credentialId) => {
          calls.push(`locate:${userId}:${credentialId}`);
          return {
            credentialId,
            kind: "email",
            mapping: COORDINATE.mapping,
            credentialVersion: 1,
            usableForLogin: true,
            label: "",
          };
        },
        recordAttemptOutcome: async (_coordinate, outcome) => {
          calls.push("record");
          outcomes.push(outcome);
        },
      });

      const result = await login(gateway, hasher, {
        email: "  User@Example.COM ",
        password: CORRECT_PASSWORD,
      });

      expect(result).toEqual({ userId: "user-1" });
      expect(calls).toEqual([
        `resolve:${EMAIL}`,
        "locate:user-1:cred-1",
        "record",
      ]);
      expect(outcomes).toEqual([{ outcome: "success" }]);
      expect(hasher.hashCalls).toBe(0);
      expect(hasher.verifyCalls).toBe(1);
    });
  });
});

describe("lockoutWidthMs", () => {
  it("is zero below the threshold", () => {
    expect(lockoutWidthMs(TUNING.loginLockoutThreshold - 1, TUNING)).toBe(0);
  });

  it("starts at the base width at the threshold and doubles per failure", () => {
    const t = TUNING.loginLockoutThreshold;
    expect(lockoutWidthMs(t, TUNING)).toBe(TUNING.loginLockoutBaseMs);
    expect(lockoutWidthMs(t + 1, TUNING)).toBe(2 * TUNING.loginLockoutBaseMs);
    expect(lockoutWidthMs(t + 2, TUNING)).toBe(4 * TUNING.loginLockoutBaseMs);
  });

  it("stops at the cap", () => {
    const t = TUNING.loginLockoutThreshold;
    expect(lockoutWidthMs(t + 5, TUNING)).toBe(TUNING.loginLockoutMaxMs);
    expect(lockoutWidthMs(t + 40, TUNING)).toBe(TUNING.loginLockoutMaxMs);
  });
});

describe("decayedFailedAttempts", () => {
  it("leaves the counter alone when no attempt time is stored", () => {
    expect(decayedFailedAttempts(3, null, NOW, TUNING)).toBe(3);
  });

  it("leaves the counter alone while the attempt time is still ahead", () => {
    const ahead = new Date(NOW.getTime() + 1);
    expect(decayedFailedAttempts(3, ahead, NOW, TUNING)).toBe(3);
    expect(decayedFailedAttempts(3, NOW, NOW, TUNING)).toBe(3);
  });

  it("forgives one failure per decay window elapsed", () => {
    const oneWindow = new Date(NOW.getTime() - TUNING.loginAttemptDecayMs);
    const almostTwo = new Date(
      NOW.getTime() - 2 * TUNING.loginAttemptDecayMs + 1,
    );
    expect(decayedFailedAttempts(3, oneWindow, NOW, TUNING)).toBe(2);
    expect(decayedFailedAttempts(3, almostTwo, NOW, TUNING)).toBe(2);
  });

  it("never goes below zero", () => {
    const longAgo = new Date(NOW.getTime() - 10 * TUNING.loginAttemptDecayMs);
    expect(decayedFailedAttempts(3, longAgo, NOW, TUNING)).toBe(0);
  });
});
