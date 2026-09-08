import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { describe, expect, it } from "vitest";
import { ConflictError, isConflictError } from "../../errors";
import type { LoginCredentialDto, ReserveCredentialDto } from "../gateway";
import {
  registerOrLoginWithSso,
  ssoCanonicalOf,
} from "../registerOrLoginWithSso";
import {
  expectCode,
  type GatewayCall,
  makeContainer,
  recordingGateway,
} from "./unitContainer";

function locatorFor(
  kind: "email" | "sso",
  credentialId: string,
): MappingLocator {
  return {
    credentialId,
    kind,
    hmac: `hmac-${kind}`,
    generation: 1,
    bucketIndex: kind === "sso" ? 3 : 0,
  };
}

const KNOWN: LoginCredentialDto = {
  coordinate: {
    credentialId: "cred-sso",
    kind: "sso",
    mapping: "g1:b3:hmac-sso",
  },
  userId: "user-known",
  credentialVersion: 1,
  changeState: null,
  changeOrigin: null,
  failedAttempts: 0,
  nextAttemptAllowedAt: null,
  passwordVerifier: null,
};

describe("ssoCanonicalOf", () => {
  it("joins provider and subject with U+0000, so no subject can collide across providers", () => {
    expect(ssoCanonicalOf("google", "abc")).toBe("google\u0000abc");
    expect(ssoCanonicalOf("google", "abc")).not.toBe(
      ssoCanonicalOf("apple", "abc"),
    );
  });
});

describe("registerOrLoginWithSso", () => {
  it("logs a known subject in with no write", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      resolveSsoIdentity: async () => KNOWN,
    });
    const result = await registerOrLoginWithSso({
      container: makeContainer(gateway),
      input: {
        provider: "google",
        providerSubject: "abc",
        email: "a@example.com",
      },
    });
    expect(result).toEqual({ userId: "user-known", isNewUser: false });
    expect(calls.map((c) => c.name)).toEqual(["resolveSsoIdentity"]);
  });

  it("signs an unknown subject up with two reservations, the subject as coordinator", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      resolveSsoIdentity: async () => null,
      deriveCredentialLocator: async (kind, _canonical, credentialId) =>
        locatorFor(kind, credentialId),
      reserveCredential: async () => undefined,
      initializeAccount: async () => undefined,
      commitSignupSaga: async () => true,
      activateReservation: async () => true,
      recordSignupLocator: async () => undefined,
    });
    const result = await registerOrLoginWithSso({
      container: makeContainer(gateway),
      input: {
        provider: "google",
        providerSubject: "abc",
        email: "a@example.com",
      },
    });
    expect(result.isNewUser).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      "resolveSsoIdentity",
      "deriveCredentialLocator",
      "deriveCredentialLocator",
      "reserveCredential",
      "reserveCredential",
      "initializeAccount",
      "commitSignupSaga",
      "activateReservation",
      "activateReservation",
      "recordSignupLocator",
      "recordSignupLocator",
    ]);
    const [ssoReserve, emailReserve] = calls
      .filter((c) => c.name === "reserveCredential")
      .map((c) => c.args[1] as ReserveCredentialDto);
    expect(ssoReserve?.coordinator.role).toBe("coordinator");
    expect(ssoReserve?.passwordVerifier).toBeNull();
    expect(ssoReserve?.canonical).toBe("google\u0000abc");
    expect(emailReserve?.coordinator.role).toBe("member");
    expect(emailReserve?.canonical).toBe("a@example.com");
    expect(emailReserve?.passwordVerifier).toBeNull();
    // The same caller token binds both reservations to the account.
    expect(emailReserve?.callerToken).toBe(ssoReserve?.callerToken);

    const init = calls.find((c) => c.name === "initializeAccount")?.args[1] as {
      credentials: readonly {
        kind: string;
        usableForLogin: boolean;
        label: string;
      }[];
    };
    expect(init.credentials).toEqual([
      expect.objectContaining({
        kind: "sso",
        usableForLogin: true,
        label: "google",
      }),
      expect.objectContaining({
        kind: "email",
        usableForLogin: false,
        label: "",
      }),
    ]);
  });

  it("hands the subject's reservation back when the address is already held, and never auto-links", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      resolveSsoIdentity: async () => null,
      deriveCredentialLocator: async (kind, _canonical, credentialId) =>
        locatorFor(kind, credentialId),
      reserveCredential: async (locator) => {
        if (locator.kind === "email") {
          throw new ConflictError("EMAIL_ALREADY_REGISTERED", "held");
        }
      },
      cancelReservation: async () => undefined,
    });
    await expectCode(
      registerOrLoginWithSso({
        container: makeContainer(gateway),
        input: {
          provider: "google",
          providerSubject: "abc",
          email: "a@example.com",
        },
      }),
      isConflictError,
      "EMAIL_ALREADY_REGISTERED",
    );
    const cancel = calls.find((c) => c.name === "cancelReservation");
    expect(cancel).toBeDefined();
    expect((cancel?.args[0] as MappingLocator | undefined)?.kind).toBe("sso");
    expect(calls.some((c) => c.name === "initializeAccount")).toBe(false);
  });

  it("reports a lost subject reservation as SSO_IDENTITY_ALREADY_REGISTERED with nothing to hand back", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      resolveSsoIdentity: async () => null,
      deriveCredentialLocator: async (kind, _canonical, credentialId) =>
        locatorFor(kind, credentialId),
      reserveCredential: async () => {
        throw new ConflictError("EMAIL_ALREADY_REGISTERED", "held");
      },
    });
    await expectCode(
      registerOrLoginWithSso({
        container: makeContainer(gateway),
        input: {
          provider: "google",
          providerSubject: "abc",
          email: "a@example.com",
        },
      }),
      isConflictError,
      "SSO_IDENTITY_ALREADY_REGISTERED",
    );
    expect(calls.some((c) => c.name === "cancelReservation")).toBe(false);
  });
});
