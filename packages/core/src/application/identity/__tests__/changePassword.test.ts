import { isBusinessRuleError } from "@repo/core/domain/error";
import { PlainPassword } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { FakePasswordHasher } from "../../__tests__/fakes";
import { isConflictError, isValidationError } from "../../errors";
import { changePassword } from "../changePassword";
import type {
  BeginCredentialChangeDto,
  CurrentUserDto,
  LoginCredentialDto,
} from "../gateway";
import {
  expectCode,
  type GatewayCall,
  makeContainer,
  NOW,
  recordingGateway,
} from "./unitContainer";

const USER: CurrentUserDto = {
  userId: "user-1",
  credentials: [
    { credentialId: "cred-1", kind: "email", label: "", usableForLogin: true },
  ],
  locators: [],
  trashRetentionDays: 30,
};

async function row(
  overrides: Partial<LoginCredentialDto> = {},
): Promise<LoginCredentialDto> {
  return {
    coordinate: { credentialId: "cred-1", kind: "email", mapping: "g1:b0:h" },
    userId: "user-1",
    credentialVersion: 3,
    changeState: null,
    changeOrigin: null,
    failedAttempts: 0,
    nextAttemptAllowedAt: null,
    passwordVerifier: await new FakePasswordHasher().hash(
      PlainPassword.create("current-pass"),
    ),
    ...overrides,
  };
}

function baseGateway(calls: GatewayCall[], record: LoginCredentialDto) {
  return recordingGateway(calls, {
    readCurrentUser: async () => USER,
    findCredentialLocator: async () => ({
      credentialId: "cred-1",
      kind: "email",
      mapping: "g1:b0:h",
      credentialVersion: 3,
      usableForLogin: true,
      label: "",
    }),
    readCredentialForChange: async () => record,
    recordAttemptOutcome: async () => undefined,
    beginCredentialChange: async () => true,
    applyCredentialChange: async () => ({ credentialVersion: 4 }),
    markCredentialChangeAdvanced: async () => true,
    promoteVerifier: async () => true,
  });
}

const input = {
  userId: "user-1",
  currentPassword: "current-pass",
  newPassword: "brand-new-pass",
};

describe("changePassword", () => {
  it("refuses a locked-out row before any verification", async () => {
    const calls: GatewayCall[] = [];
    const hasher = new FakePasswordHasher();
    const gateway = baseGateway(
      calls,
      await row({ nextAttemptAllowedAt: new Date(NOW.getTime() + 1000) }),
    );
    await expectCode(
      changePassword({
        container: makeContainer(gateway, { passwordHasher: hasher }),
        input,
      }),
      isValidationError,
      "TOO_MANY_ATTEMPTS",
    );
    expect(hasher.verifyCalls).toBe(0);
    expect(calls.some((c) => c.name === "beginCredentialChange")).toBe(false);
  });

  it("records a wrong current password against the login counter", async () => {
    const calls: GatewayCall[] = [];
    const gateway = baseGateway(calls, await row({ failedAttempts: 1 }));
    await expectCode(
      changePassword({
        container: makeContainer(gateway),
        input: { ...input, currentPassword: "not-the-one" },
      }),
      isValidationError,
      "CURRENT_PASSWORD_MISMATCH",
    );
    const outcome = calls.find((c) => c.name === "recordAttemptOutcome");
    expect(outcome?.args[1]).toMatchObject({
      outcome: "failure",
      observedFailedAttempts: 1,
      failedAttempts: 2,
    });
    expect(calls.some((c) => c.name === "beginCredentialChange")).toBe(false);
  });

  it("refuses an account without a password credential", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      readCurrentUser: async () => ({
        ...USER,
        credentials: [
          {
            credentialId: "cred-1",
            kind: "email",
            label: "",
            usableForLogin: false,
          },
        ],
      }),
    });
    await expectCode(
      changePassword({ container: makeContainer(gateway), input }),
      isBusinessRuleError,
      "PASSWORD_NOT_SUPPORTED",
    );
  });

  it("refuses a row another change is holding", async () => {
    const calls: GatewayCall[] = [];
    const gateway = baseGateway(calls, await row({ changeState: "pending" }));
    await expectCode(
      changePassword({ container: makeContainer(gateway), input }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
  });

  it("runs the credential-change saga with origin password-change and the returned version", async () => {
    const calls: GatewayCall[] = [];
    const gateway = baseGateway(calls, await row());
    await changePassword({ container: makeContainer(gateway), input });
    expect(calls.map((c) => c.name)).toEqual([
      "readCurrentUser",
      "findCredentialLocator",
      "readCredentialForChange",
      "beginCredentialChange",
      "applyCredentialChange",
      "markCredentialChangeAdvanced",
      "promoteVerifier",
    ]);
    const begin = calls.find((c) => c.name === "beginCredentialChange")
      ?.args[1] as BeginCredentialChangeDto;
    expect(begin.origin).toBe("password-change");
    expect(begin.changeAuthToken).toBeNull();
    expect(begin.userId).toBe("user-1");
    expect(begin.pendingVerifier).not.toContain("brand-new-pass");
    expect(
      calls.find((c) => c.name === "applyCredentialChange")?.args[1],
    ).toEqual({
      credentialId: "cred-1",
      resetCompletion: false,
    });
    expect(calls.find((c) => c.name === "promoteVerifier")?.args[1]).toEqual({
      operationId: begin.operationId,
      credentialVersion: 4,
    });
  });

  it("surfaces a lost phase as OPTIMISTIC_LOCK_FAILURE", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      readCurrentUser: async () => USER,
      findCredentialLocator: async () => ({
        credentialId: "cred-1",
        kind: "email",
        mapping: "g1:b0:h",
        credentialVersion: 3,
        usableForLogin: true,
        label: "",
      }),
      readCredentialForChange: async () => row(),
      beginCredentialChange: async () => false,
    });
    await expectCode(
      changePassword({ container: makeContainer(gateway), input }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
  });
});
