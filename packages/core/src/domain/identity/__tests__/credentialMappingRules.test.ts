import { describe, expect, it } from "vitest";
import {
  holdsPasswordVerifier,
  isResetRequestAllowed,
  isSettled,
  isUsableForLogin,
} from "../credentialMappingRules";
import type { CredentialMapping } from "../ports/credentialMappingRepository";
import { CredentialId } from "../valueObject";

const NOW = 1_800_000_000_000;
const WINDOW_MS = 60_000;

function mapping(
  overrides: Partial<CredentialMapping> = {},
): CredentialMapping {
  return {
    credentialId: CredentialId.create("cred-1"),
    userId: "user-1",
    candidateUserId: null,
    kind: "email",
    status: "active",
    passwordVerifier: "pbkdf2-sha256$1$s$d",
    credentialVersion: 0,
    changeState: null,
    changeOrigin: null,
    failedAttempts: 0,
    nextAttemptAllowedAt: null,
    lastResetRequestedAt: null,
    operationId: null,
    callerToken: null,
    reservedUntil: 0,
    sagaCommitted: true,
    generation: 1,
    hmac: "0".repeat(64),
    ...overrides,
  };
}

describe("isSettled", () => {
  it("holds for an activated mapping with no change in flight", () => {
    expect(isSettled(mapping())).toBe(true);
  });

  // A phase-1a reservation already carries its verifier, so treating a
  // `reserved` row as settled would hand an unactivated signup's material out.
  it("is false for a reservation that has not been activated", () => {
    expect(isSettled(mapping({ status: "reserved" }))).toBe(false);
  });

  it.each(["pending", "advanced"] as const)(
    "is false while a change is %s (fail closed)",
    (changeState) => {
      expect(isSettled(mapping({ changeState }))).toBe(false);
    },
  );
});

describe("holdsPasswordVerifier", () => {
  it("is true for a mapping carrying verification material", () => {
    expect(holdsPasswordVerifier(mapping())).toBe(true);
  });

  // An SSO-only account's address reservation is a credential and has a stored
  // original; "is there a credential" would answer yes and mail a link that
  // promotes the reservation into a way in.
  it("is false for an address reservation with no verifier", () => {
    expect(holdsPasswordVerifier(mapping({ passwordVerifier: null }))).toBe(
      false,
    );
  });

  it("accepts any row projection carrying the field", () => {
    expect(holdsPasswordVerifier({ passwordVerifier: null })).toBe(false);
    expect(holdsPasswordVerifier({ passwordVerifier: "x" })).toBe(true);
  });
});

describe("isUsableForLogin", () => {
  it("holds for a settled mapping outside its backoff", () => {
    expect(isUsableForLogin(mapping(), NOW)).toBe(true);
  });

  it("is false while the failed-attempt backoff has not elapsed", () => {
    expect(
      isUsableForLogin(mapping({ nextAttemptAllowedAt: NOW + 1 }), NOW),
    ).toBe(false);
  });

  it("becomes true again once the backoff instant is reached", () => {
    expect(isUsableForLogin(mapping({ nextAttemptAllowedAt: NOW }), NOW)).toBe(
      true,
    );
  });

  // SSO rows are usable and hold no verifier; the caller tests that separately.
  it("does not require verification material", () => {
    expect(
      isUsableForLogin(mapping({ kind: "sso", passwordVerifier: null }), NOW),
    ).toBe(true);
  });
});

describe("isResetRequestAllowed", () => {
  it("holds for a settled mapping that has never asked", () => {
    expect(isResetRequestAllowed(mapping(), NOW, WINDOW_MS)).toBe(true);
  });

  // `NOW` is a window boundary, so `NOW + WINDOW_MS / 2` is the same window.
  it("is false for a second request inside the same window", () => {
    expect(
      isResetRequestAllowed(
        mapping({ lastResetRequestedAt: NOW }),
        NOW + WINDOW_MS / 2,
        WINDOW_MS,
      ),
    ).toBe(false);
  });

  it("holds again at the first instant of the next window", () => {
    expect(
      isResetRequestAllowed(
        mapping({ lastResetRequestedAt: NOW }),
        NOW + WINDOW_MS,
        WINDOW_MS,
      ),
    ).toBe(true);
  });

  /**
   * The regression that made the sliding form unusable: the stamp advances on
   * every request, so an unauthenticated third party asking just inside the
   * window kept `last + window <= now` false forever and the victim could never
   * receive a link again. Under window numbers the request one millisecond
   * before the boundary cannot push the next window out.
   */
  it("cannot be held shut by a request just before the boundary", () => {
    expect(
      isResetRequestAllowed(
        mapping({ lastResetRequestedAt: NOW + WINDOW_MS - 1 }),
        NOW + WINDOW_MS,
        WINDOW_MS,
      ),
    ).toBe(true);
  });

  // The other half of the same rule: an attacker hammering every few seconds
  // still lets one request through per window, forever.
  it("lets one request through per window under a sustained flood", () => {
    const perWindow = 16;
    const windows = 10;
    const flood = perWindow * windows;
    let last: number | null = null;
    let eligible = 0;
    for (let i = 0; i < flood; i += 1) {
      const at = NOW + (i * WINDOW_MS) / perWindow;
      const allowed = isResetRequestAllowed(
        mapping({ lastResetRequestedAt: last }),
        at,
        WINDOW_MS,
      );
      if (allowed) eligible += 1;
      // The adapter stamps unconditionally, eligible or not.
      last = at;
    }
    expect(eligible).toBe(windows);
  });

  it("is false without verification material (an SSO-only account)", () => {
    expect(
      isResetRequestAllowed(
        mapping({ passwordVerifier: null }),
        NOW,
        WINDOW_MS,
      ),
    ).toBe(false);
  });

  // Recovery must not be gated by the login backoff, or failing logins against
  // somebody would lock them out of the one path back in.
  it("ignores the failed-attempt backoff", () => {
    expect(
      isResetRequestAllowed(
        mapping({ nextAttemptAllowedAt: NOW + 60_000 }),
        NOW,
        WINDOW_MS,
      ),
    ).toBe(true);
  });
});
