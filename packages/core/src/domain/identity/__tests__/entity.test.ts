import { isRehydrationError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import type { CredentialRef } from "../entity";
import { User } from "../entity";
import { CredentialId, TrashRetentionDays } from "../valueObject";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-02T03:04:05.000Z");
const ID = "01950000-0000-7000-8000-000000000001";

function credential(
  id: string,
  overrides: Partial<CredentialRef> = {},
): CredentialRef {
  return {
    credentialId: CredentialId.create(id),
    kind: "email",
    label: "",
    usableForLogin: true,
    ...overrides,
  };
}

const PASSWORD = credential("cred-email");
const SSO = credential("cred-sso", { kind: "sso", label: "google" });
const ADDRESS_ONLY = credential("cred-email", { usableForLogin: false });

// `credentials` is a read projection of `credential_locators`, so a test
// standing in for a stored account overlays the set the way `find` does —
// there is no transition on the aggregate that writes it (ADR-070).
function userWith(credentials: readonly CredentialRef[]) {
  return { ...User.initialize({ id: ID }, NOW), credentials };
}

describe("User.initialize", () => {
  // Signup phase 2 runs before phase 4 writes any `credential_locators` row,
  // so an empty projection is the only truthful value at first persistence —
  // and taking no parameter is what stops a caller asserting otherwise.
  it("starts at version 0 with no credentials, both timestamps at `now` and the default retention", () => {
    expect(User.initialize({ id: ID }, NOW)).toEqual({
      id: ID,
      credentials: [],
      trashRetentionDays: 30,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("rejects an empty id through the value object", () => {
    expect(() => User.initialize({ id: "  " }, NOW)).toThrow();
  });
});

describe("User.loginCredentialCount", () => {
  // Two rows of the same credential exist during a routing-key rotation.
  it("counts distinct credentialIds, not entries", () => {
    const duplicated = userWith([PASSWORD, { ...PASSWORD, label: "" }]);

    expect(User.loginCredentialCount(duplicated)).toBe(1);
  });

  // An SSO-only account holds an email entry purely to reserve the address.
  // Counting entries instead of login-capable ones would let an unlink drop
  // the SSO link and leave the account with no way in at all. This predicate
  // is what #12 consults before deleting the locator rows.
  it("does not count an address-only entry as a way in", () => {
    expect(User.loginCredentialCount(userWith([ADDRESS_ONLY, SSO]))).toBe(1);
  });

  it("is zero while an account's locators have not been recorded yet", () => {
    expect(User.loginCredentialCount(User.initialize({ id: ID }, NOW))).toBe(0);
  });
});

describe("User.changeTrashRetentionDays", () => {
  const user = userWith([PASSWORD]);

  it("bumps the version and moves updatedAt", () => {
    const entity = User.changeTrashRetentionDays(
      user,
      TrashRetentionDays.create(1),
      LATER,
    );

    expect(entity.trashRetentionDays).toBe(1);
    expect(entity.version).toBe(1);
    expect(entity.updatedAt).toBe(LATER);
  });

  it("is a no-op when the value is unchanged", () => {
    // Identity, not equality: the no-op has to be detectable by the caller
    // so it can skip the `save` (and the OCC round trip that comes with it).
    const entity = User.changeTrashRetentionDays(
      user,
      TrashRetentionDays.create(30),
      LATER,
    );

    expect(entity).toBe(user);
    expect(entity.version).toBe(0);
  });
});

describe("User.reconstruct", () => {
  const row = {
    id: ID,
    credentials: [
      {
        credentialId: "cred-email",
        kind: "email",
        label: "",
        usableForLogin: true,
      },
    ],
    trashRetentionDays: 30,
    version: 3,
    createdAt: NOW,
    updatedAt: LATER,
  };

  it("rehydrates a stored row", () => {
    expect(User.reconstruct(row)).toEqual({
      id: ID,
      credentials: [PASSWORD],
      trashRetentionDays: 30,
      version: 3,
      createdAt: NOW,
      updatedAt: LATER,
    });
  });

  it.each([
    ["empty id", { ...row, id: "" }],
    ["retention below 1", { ...row, trashRetentionDays: 0 }],
    ["negative version", { ...row, version: -1 }],
    [
      "unknown credential kind",
      {
        ...row,
        credentials: [{ ...row.credentials[0], kind: "magic-link" }],
      },
    ],
    [
      "empty credential id",
      {
        ...row,
        credentials: [{ ...row.credentials[0], credentialId: " " }],
      },
    ],
  ])("wraps an inconsistent row in RehydrationError: %s", (_label, input) => {
    let caught: unknown;
    try {
      User.reconstruct(
        input as unknown as Parameters<typeof User.reconstruct>[0],
      );
    } catch (error) {
      caught = error;
    }
    expect(isRehydrationError(caught)).toBe(true);
  });

  it("preserves the original value-object failure as the cause", () => {
    let caught: unknown;
    try {
      User.reconstruct({ ...row, id: "" });
    } catch (error) {
      caught = error;
    }
    expect(isRehydrationError(caught) && caught.cause).toBeDefined();
  });
});
