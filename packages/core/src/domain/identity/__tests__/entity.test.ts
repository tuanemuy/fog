import {
  isBusinessRuleError,
  isRehydrationError,
} from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import type { CredentialRef } from "../entity";
import { User } from "../entity";
import { IdentityErrorCode } from "../errorCode";
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

function userWith(credentials: readonly CredentialRef[]) {
  return User.initialize({ id: ID, credentials }, NOW);
}

describe("User.initialize", () => {
  it("starts at version 0 with both timestamps at `now` and the default retention", () => {
    expect(userWith([PASSWORD])).toEqual({
      id: ID,
      credentials: [PASSWORD],
      trashRetentionDays: 30,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("rejects an empty id through the value object", () => {
    expect(() => User.initialize({ id: "  ", credentials: [] }, NOW)).toThrow();
  });
});

describe("User.addCredential", () => {
  it("appends and bumps the version", () => {
    const next = User.addCredential(userWith([PASSWORD]), SSO, LATER);

    expect(next.credentials).toEqual([PASSWORD, SSO]);
    expect(next.version).toBe(1);
    expect(next.createdAt).toBe(NOW);
    expect(next.updatedAt).toBe(LATER);
  });

  it("replaces an entry with the same credentialId rather than duplicating it", () => {
    const promoted = credential("cred-sso", { kind: "sso", label: "apple" });
    const next = User.addCredential(userWith([PASSWORD, SSO]), promoted, LATER);

    expect(next.credentials).toEqual([PASSWORD, promoted]);
  });
});

describe("User.removeCredential", () => {
  it("removes an entry when another way in remains", () => {
    const next = User.removeCredential(
      userWith([PASSWORD, SSO]),
      SSO.credentialId,
      LATER,
    );

    expect(next.credentials).toEqual([PASSWORD]);
    expect(next.version).toBe(1);
  });

  it("refuses to remove the last credential usable for login", () => {
    let caught: unknown;
    try {
      User.removeCredential(userWith([PASSWORD]), PASSWORD.credentialId, LATER);
    } catch (error) {
      caught = error;
    }

    expect(isBusinessRuleError(caught) && caught.code).toBe(
      IdentityErrorCode.LastLoginCredential,
    );
  });

  // An SSO-only account holds an email entry purely to reserve the address.
  // Counting entries instead of login-capable ones would let the SSO link be
  // removed and leave an account with no way in at all.
  it("does not count an address-only entry as a way in", () => {
    let caught: unknown;
    try {
      User.removeCredential(
        userWith([ADDRESS_ONLY, SSO]),
        SSO.credentialId,
        LATER,
      );
    } catch (error) {
      caught = error;
    }

    expect(isBusinessRuleError(caught) && caught.code).toBe(
      IdentityErrorCode.LastLoginCredential,
    );
  });

  it("removes an address-only entry without complaint", () => {
    const next = User.removeCredential(
      userWith([ADDRESS_ONLY, SSO]),
      ADDRESS_ONLY.credentialId,
      LATER,
    );

    expect(next.credentials).toEqual([SSO]);
  });

  it("is a no-op for an unknown credential", () => {
    const user = userWith([PASSWORD]);

    expect(
      User.removeCredential(user, CredentialId.create("absent"), LATER),
    ).toBe(user);
  });
});

describe("User.loginCredentialCount", () => {
  // Two rows of the same credential exist during a routing-key rotation.
  it("counts distinct credentialIds, not entries", () => {
    const duplicated = userWith([PASSWORD, { ...PASSWORD, label: "" }]);

    expect(User.loginCredentialCount(duplicated)).toBe(1);
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
