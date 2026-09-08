import { isBusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
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
import { isConflictError } from "../../errors";
import type { UsecaseContainer } from "../../types";
import type { IdentityGateway } from "../gateway";
import {
  INITIAL_CREDENTIAL_VERSION,
  registerWithPassword,
} from "../registerWithPassword";
import { createIdentityTuning } from "../tuning";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const TUNING = createIdentityTuning();
const PASSWORD = "password123";

type Call = Readonly<{ name: keyof IdentityGateway; args: unknown[] }>;

function trip(name: keyof IdentityGateway): never {
  throw new Error(`unexpected gateway call: ${name}`);
}

function locatorFor(credentialId: string): MappingLocator {
  return {
    credentialId,
    kind: "email",
    hmac: "hmac-value",
    generation: 1,
    bucketIndex: 0,
  };
}

function recordingGateway(
  calls: Call[],
  activate: () => boolean = () => true,
  commit: () => boolean = () => true,
): IdentityGateway {
  return trippingIdentityGateway(trip, {
    deriveCredentialLocator: async (kind, canonical, credentialId) => {
      calls.push({
        name: "deriveCredentialLocator",
        args: [kind, canonical, credentialId],
      });
      return locatorFor(credentialId);
    },
    reserveCredential: async (locator, input) => {
      calls.push({ name: "reserveCredential", args: [locator, input] });
    },
    initializeAccount: async (userId, input) => {
      calls.push({ name: "initializeAccount", args: [userId, input] });
    },
    commitSignupSaga: async (locator, operationId) => {
      calls.push({ name: "commitSignupSaga", args: [locator, operationId] });
      return commit();
    },
    activateReservation: async (locator, operationId, userId) => {
      calls.push({
        name: "activateReservation",
        args: [locator, operationId, userId],
      });
      return activate();
    },
    recordSignupLocator: async (userId, input) => {
      calls.push({ name: "recordSignupLocator", args: [userId, input] });
    },
  });
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
    passwordHasher: new FakePasswordHasher(),
  };
}

function argsOf(calls: readonly Call[], index: number): unknown[] {
  const call = calls[index];
  if (call === undefined) throw new Error(`no gateway call at index ${index}`);
  return call.args;
}

// The ids the usecase draws, in the order it draws them.
function expectedIds() {
  const ids = new FakeIdGenerator();
  return {
    userId: ids.next(),
    credentialId: ids.next(),
    operationId: ids.next(),
  };
}

describe("registerWithPassword", () => {
  it("drives the saga in order: derive, reserve, initialize, commit, activate, record", async () => {
    const calls: Call[] = [];
    const result = await registerWithPassword({
      container: makeContainer(recordingGateway(calls)),
      input: { email: "  User@Example.COM ", password: PASSWORD },
    });

    const { userId, credentialId, operationId } = expectedIds();
    expect(result).toEqual({ userId });
    expect(calls.map((call) => call.name)).toEqual([
      "deriveCredentialLocator",
      "reserveCredential",
      "initializeAccount",
      "commitSignupSaga",
      "activateReservation",
      "recordSignupLocator",
    ]);

    const locator = locatorFor(credentialId);
    const expectedVerifier = await new FakePasswordHasher().hash(
      PlainPassword.create(PASSWORD),
    );

    expect(argsOf(calls, 0)).toEqual([
      "email",
      "user@example.com",
      credentialId,
    ]);

    const [reserveLocator, reserveInput] = argsOf(calls, 1) as [
      MappingLocator,
      Record<string, unknown>,
    ];
    expect(reserveLocator).toEqual(locator);
    expect(reserveInput).toEqual({
      operationId,
      candidateUserId: userId,
      callerToken: expect.stringMatching(/^[0-9a-f]{32}$/),
      canonical: "user@example.com",
      passwordVerifier: expectedVerifier,
      reservedUntil: new Date(NOW.getTime() + TUNING.reservationTtlMs),
      coordinator: { role: "coordinator", locators: [locator] },
    });

    const [initUserId, initInput] = argsOf(calls, 2) as [
      string,
      Record<string, unknown>,
    ];
    expect(initUserId).toBe(userId);
    expect(initInput).toEqual({
      operationId,
      callerToken: reserveInput.callerToken,
      credentials: [
        {
          credentialId,
          kind: "email",
          label: "",
          usableForLogin: true,
        },
      ],
      locators: [locator],
    });

    expect(argsOf(calls, 3)).toEqual([locator, operationId]);
    expect(argsOf(calls, 4)).toEqual([locator, operationId, userId]);

    expect(argsOf(calls, 5)).toEqual([
      userId,
      {
        operationId,
        locator: {
          credentialId,
          kind: "email",
          mapping: `g${locator.generation}:b${locator.bucketIndex}:${locator.hmac}`,
          credentialVersion: INITIAL_CREDENTIAL_VERSION,
          usableForLogin: true,
          label: "",
        },
      },
    ]);
  });

  it("throws EMAIL_ALREADY_REGISTERED when the saga mark finds no reservation of its own", async () => {
    const calls: Call[] = [];
    const run = registerWithPassword({
      container: makeContainer(
        recordingGateway(
          calls,
          () => true,
          () => false,
        ),
      ),
      input: { email: "user@example.com", password: PASSWORD },
    });

    await expect(run).rejects.toSatisfy(
      (error) =>
        isConflictError(error) && error.code === "EMAIL_ALREADY_REGISTERED",
    );
    expect(calls.map((call) => call.name)).toEqual([
      "deriveCredentialLocator",
      "reserveCredential",
      "initializeAccount",
      "commitSignupSaga",
    ]);
  });

  it("throws EMAIL_ALREADY_REGISTERED when the reservation cannot be activated", async () => {
    const calls: Call[] = [];
    const run = registerWithPassword({
      container: makeContainer(recordingGateway(calls, () => false)),
      input: { email: "user@example.com", password: PASSWORD },
    });

    await expect(run).rejects.toSatisfy(
      (error) =>
        isConflictError(error) && error.code === "EMAIL_ALREADY_REGISTERED",
    );
    expect(calls.map((call) => call.name)).not.toContain("recordSignupLocator");
  });

  it.each([
    [
      "an invalid email",
      "not-an-email",
      PASSWORD,
      IdentityErrorCode.InvalidEmail,
    ],
    [
      "a 7-character password",
      "user@example.com",
      "1234567",
      IdentityErrorCode.PasswordTooWeak,
    ],
    [
      "a 129-character password",
      "user@example.com",
      "a".repeat(129),
      IdentityErrorCode.PasswordTooWeak,
    ],
  ])(
    "rejects %s with the business code before any gateway call",
    async (_label, email, password, code) => {
      const calls: Call[] = [];
      const run = registerWithPassword({
        container: makeContainer(recordingGateway(calls)),
        input: { email, password },
      });

      await expect(run).rejects.toSatisfy(
        (error) => isBusinessRuleError(error) && error.code === code,
      );
      expect(calls).toEqual([]);
    },
  );
});
