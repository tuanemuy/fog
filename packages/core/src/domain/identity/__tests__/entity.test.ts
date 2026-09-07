import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { type CredentialRef, type CredentialRefInput, User } from "../entity";
import { IdentityErrorCode } from "../errorCode";
import { CredentialId } from "../valueObject";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const LATER = new Date("2026-09-08T01:00:00.000Z");

const EMAIL_CREDENTIAL: CredentialRefInput = {
  credentialId: "cred-email",
  kind: "email",
  label: "",
  usableForLogin: true,
};

const SSO_CREDENTIAL: CredentialRefInput = {
  credentialId: "cred-sso",
  kind: "sso",
  label: "google",
  usableForLogin: true,
};

function businessCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("User.registerWithPassword", () => {
  it("starts at version 0 with the default retention and both timestamps at now", () => {
    const user = User.registerWithPassword(
      { id: "user-1", credential: EMAIL_CREDENTIAL },
      NOW,
    );

    expect(user.id).toBe("user-1");
    expect(user.version).toBe(0);
    expect(user.trashRetentionDays).toBe(30);
    expect(user.createdAt).toBe(NOW);
    expect(user.updatedAt).toBe(NOW);
    expect(user.credentials).toEqual([EMAIL_CREDENTIAL]);
  });

  it("refuses an email credential that is not usable for login", () => {
    expect(
      businessCodeOf(() =>
        User.registerWithPassword(
          {
            id: "user-1",
            credential: { ...EMAIL_CREDENTIAL, usableForLogin: false },
          },
          NOW,
        ),
      ),
    ).toBe(IdentityErrorCode.LoginMethodRequired);
  });
});

describe("User.registerWithSso", () => {
  it("accepts an sso element plus an email reservation element that is not usable", () => {
    const user = User.registerWithSso(
      {
        id: "user-1",
        credentials: [
          SSO_CREDENTIAL,
          { ...EMAIL_CREDENTIAL, usableForLogin: false },
        ],
      },
      NOW,
    );

    expect(user.credentials).toHaveLength(2);
    expect(user.version).toBe(0);
  });

  it("refuses a set with no usable element", () => {
    expect(
      businessCodeOf(() =>
        User.registerWithSso(
          {
            id: "user-1",
            credentials: [
              { ...SSO_CREDENTIAL, usableForLogin: false },
              { ...EMAIL_CREDENTIAL, usableForLogin: false },
            ],
          },
          NOW,
        ),
      ),
    ).toBe(IdentityErrorCode.LoginMethodRequired);
  });

  it("refuses an empty set", () => {
    expect(
      businessCodeOf(() =>
        User.registerWithSso({ id: "user-1", credentials: [] }, NOW),
      ),
    ).toBe(IdentityErrorCode.LoginMethodRequired);
  });
});

describe("User.addCredential", () => {
  const base = User.registerWithPassword(
    { id: "user-1", credential: EMAIL_CREDENTIAL },
    NOW,
  );

  it("appends a new credential and bumps the version", () => {
    const sso: CredentialRef = {
      credentialId: CredentialId.create("cred-sso"),
      kind: "sso",
      label: "google",
      usableForLogin: true,
    };
    const user = User.addCredential(base, sso, LATER);

    expect(user.credentials).toEqual([EMAIL_CREDENTIAL, sso]);
    expect(user.version).toBe(1);
    expect(user.updatedAt).toBe(LATER);
    expect(user.createdAt).toBe(NOW);
  });

  it("replaces the element with the same credentialId", () => {
    const replacement: CredentialRef = {
      credentialId: CredentialId.create("cred-email"),
      kind: "email",
      label: "",
      usableForLogin: false,
    };
    const user = User.addCredential(base, replacement, LATER);

    expect(user.credentials).toEqual([replacement]);
    expect(user.version).toBe(1);
  });
});

describe("User.removeCredential", () => {
  const twoMethods = User.registerWithSso(
    { id: "user-1", credentials: [EMAIL_CREDENTIAL, SSO_CREDENTIAL] },
    NOW,
  );

  it("refuses to unlink an email credential", () => {
    expect(
      businessCodeOf(() =>
        User.removeCredential(
          twoMethods,
          CredentialId.create("cred-email"),
          LATER,
        ),
      ),
    ).toBe(IdentityErrorCode.LastCredentialRemoval);
  });

  it("refuses to remove the last usable login method", () => {
    const ssoOnly = User.registerWithSso(
      {
        id: "user-1",
        credentials: [
          SSO_CREDENTIAL,
          { ...EMAIL_CREDENTIAL, usableForLogin: false },
        ],
      },
      NOW,
    );

    expect(
      businessCodeOf(() =>
        User.removeCredential(ssoOnly, CredentialId.create("cred-sso"), LATER),
      ),
    ).toBe(IdentityErrorCode.LastCredentialRemoval);
  });

  it("removes an sso credential while another method remains and bumps the version", () => {
    const user = User.removeCredential(
      twoMethods,
      CredentialId.create("cred-sso"),
      LATER,
    );

    expect(user.credentials).toEqual([EMAIL_CREDENTIAL]);
    expect(user.version).toBe(1);
    expect(user.updatedAt).toBe(LATER);
  });
});

describe("User.changeTrashRetentionDays", () => {
  it("replaces the value and bumps the version", () => {
    const base = User.registerWithPassword(
      { id: "user-1", credential: EMAIL_CREDENTIAL },
      NOW,
    );
    const user = User.changeTrashRetentionDays(
      base,
      base.trashRetentionDays,
      LATER,
    );
    expect(user.version).toBe(1);
    expect(user.updatedAt).toBe(LATER);
  });
});

describe("User.reconstruct", () => {
  it("does not enforce the login-method invariant", () => {
    const user = User.reconstruct({
      id: "user-1",
      credentials: [],
      trashRetentionDays: 7,
      version: 3,
      createdAt: NOW,
      updatedAt: LATER,
    });

    expect(user.credentials).toEqual([]);
    expect(user.trashRetentionDays).toBe(7);
    expect(user.version).toBe(3);
    expect(user.createdAt).toBe(NOW);
    expect(user.updatedAt).toBe(LATER);
  });

  it("still validates the value objects it rebuilds", () => {
    expect(
      businessCodeOf(() =>
        User.reconstruct({
          id: "user-1",
          credentials: [],
          trashRetentionDays: 0,
          version: 0,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    ).toBe(IdentityErrorCode.InvalidTrashRetentionDays);
  });
});
