import { isRehydrationError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { type SsoUser, User } from "../entity";
import {
  PasswordHash,
  PlainPassword,
  SsoProvider,
  TrashRetentionDays,
  UserId,
} from "../valueObject";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-02T03:04:05.000Z");
const ID = "01950000-0000-7000-8000-000000000001";

const PLAINTEXT = PlainPassword.create("correct horse battery staple");
const HASH = PasswordHash.create("pbkdf2-sha256$1$c2FsdA==$aGFzaA==");

// Recursive scan rather than a key check: `PlainPassword` is a branded
// `string` with no `toJSON` to override, so the only guard against a
// plaintext reaching an event payload is asserting it is nowhere in the
// emitted value.
function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) {
    return value.some((item) => containsString(item, needle));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsString(item, needle));
  }
  return false;
}

describe("User.registerWithPassword", () => {
  it("starts at version 0 with both timestamps at `now` and the default retention", () => {
    const { entity } = User.registerWithPassword(
      { id: ID, email: "  User@Example.COM ", passwordHash: HASH },
      NOW,
    );

    expect(entity).toEqual({
      authMethod: "password",
      id: ID,
      email: "user@example.com",
      passwordHash: HASH,
      trashRetentionDays: 30,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("emits a single identity.userRegistered draft aggregated on the user", () => {
    const { entity, eventDrafts } = User.registerWithPassword(
      { id: ID, email: "user@example.com", passwordHash: HASH },
      NOW,
    );

    expect(eventDrafts).toEqual([
      {
        type: "identity.userRegistered",
        payload: { userId: entity.id, authMethod: "password" },
        occurredAt: NOW,
        aggregateId: entity.id,
      },
    ]);
  });

  // The plaintext-leak guard the type system cannot express.
  it("never carries the plaintext password or the hash into the event payload", () => {
    const { eventDrafts } = User.registerWithPassword(
      { id: ID, email: "user@example.com", passwordHash: HASH },
      NOW,
    );

    expect(Object.keys(eventDrafts[0]?.payload ?? {}).sort()).toEqual([
      "authMethod",
      "userId",
    ]);
    // Positive control: `registerWithPassword` takes no plaintext, so the
    // plaintext scan below can only ever pass. Prove the scanner reaches
    // the depth a payload sits at first, or it asserts nothing.
    expect(
      containsString([{ payload: { password: PLAINTEXT } }], PLAINTEXT),
    ).toBe(true);
    expect(containsString(eventDrafts, PLAINTEXT)).toBe(false);
    expect(containsString(eventDrafts, HASH)).toBe(false);
  });

  it("rejects an invalid email through the value object", () => {
    expect(() =>
      User.registerWithPassword(
        { id: ID, email: "not-an-email", passwordHash: HASH },
        NOW,
      ),
    ).toThrow();
  });
});

describe("User.registerWithSso", () => {
  it("starts at version 0 and trims the provider subject", () => {
    const { entity } = User.registerWithSso(
      {
        id: ID,
        email: "sso@example.com",
        provider: SsoProvider.create("google"),
        providerSubject: "  sub-123  ",
      },
      NOW,
    );

    expect(entity).toEqual({
      authMethod: "sso",
      id: ID,
      email: "sso@example.com",
      provider: "google",
      providerSubject: "sub-123",
      trashRetentionDays: 30,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("emits identity.userRegistered with authMethod sso", () => {
    const { eventDrafts } = User.registerWithSso(
      {
        id: ID,
        email: "sso@example.com",
        provider: SsoProvider.create("apple"),
        providerSubject: "sub-123",
      },
      NOW,
    );

    expect(eventDrafts).toHaveLength(1);
    expect(eventDrafts[0]?.type).toBe("identity.userRegistered");
    expect(eventDrafts[0]?.payload).toEqual({
      userId: ID,
      authMethod: "sso",
    });
  });

  it("rejects an empty provider subject", () => {
    expect(() =>
      User.registerWithSso(
        {
          id: ID,
          email: "sso@example.com",
          provider: SsoProvider.create("google"),
          providerSubject: "   ",
        },
        NOW,
      ),
    ).toThrow();
  });
});

describe("User.changePassword", () => {
  const { entity: user } = User.registerWithPassword(
    { id: ID, email: "user@example.com", passwordHash: HASH },
    NOW,
  );
  const NEXT_HASH = PasswordHash.create("pbkdf2-sha256$2$c2FsdA==$bmV3aA==");

  it("bumps the version, moves updatedAt and keeps createdAt", () => {
    const { entity } = User.changePassword(user, NEXT_HASH, LATER);

    expect(entity.passwordHash).toBe(NEXT_HASH);
    expect(entity.version).toBe(1);
    expect(entity.createdAt).toBe(NOW);
    expect(entity.updatedAt).toBe(LATER);
  });

  it("emits identity.passwordChanged carrying only the user id", () => {
    const { eventDrafts } = User.changePassword(user, NEXT_HASH, LATER);

    expect(eventDrafts).toEqual([
      {
        type: "identity.passwordChanged",
        payload: { userId: ID },
        occurredAt: LATER,
        aggregateId: ID,
      },
    ]);
    expect(containsString(eventDrafts, NEXT_HASH)).toBe(false);
  });

  it("rejects an SSO account at compile time", () => {
    const { entity: ssoUser } = User.registerWithSso(
      {
        id: ID,
        email: "sso@example.com",
        provider: SsoProvider.create("google"),
        providerSubject: "sub-123",
      },
      NOW,
    );

    expect(ssoUser.authMethod).toBe("sso");

    // The directive below is the whole assertion: widening the parameter back
    // to `User` makes this line compile and fails the suite. There is
    // deliberately no runtime guard (`entity.ts`, `changePassword`), so
    // invoking the call would assert nothing.
    // @ts-expect-error `changePassword` takes `PasswordUser`; an SSO account
    // has no password to change.
    const call = () => User.changePassword(ssoUser, NEXT_HASH, LATER);
    void call;
  });
});

describe("User.changeTrashRetentionDays", () => {
  const { entity: user } = User.registerWithPassword(
    { id: ID, email: "user@example.com", passwordHash: HASH },
    NOW,
  );

  it("bumps the version and emits identity.trashRetentionChanged", () => {
    const { entity, eventDrafts } = User.changeTrashRetentionDays(
      user,
      TrashRetentionDays.create(1),
      LATER,
    );

    expect(entity.trashRetentionDays).toBe(1);
    expect(entity.version).toBe(1);
    expect(entity.updatedAt).toBe(LATER);
    expect(eventDrafts).toEqual([
      {
        type: "identity.trashRetentionChanged",
        payload: { userId: ID, retentionDays: 1 },
        occurredAt: LATER,
        aggregateId: ID,
      },
    ]);
  });

  it("is a no-op when the value is unchanged", () => {
    const { entity, eventDrafts } = User.changeTrashRetentionDays(
      user,
      TrashRetentionDays.create(30),
      LATER,
    );

    expect(entity).toBe(user);
    expect(entity.version).toBe(0);
    expect(eventDrafts).toEqual([]);
  });
});

describe("User.reconstruct", () => {
  const passwordRow = {
    id: ID,
    email: "user@example.com",
    authMethod: "password",
    passwordHash: HASH as string,
    ssoProvider: null,
    ssoProviderSubject: null,
    trashRetentionDays: 30,
    version: 3,
    createdAt: NOW,
    updatedAt: LATER,
  };

  const ssoRow = {
    ...passwordRow,
    authMethod: "sso",
    passwordHash: null,
    ssoProvider: "google",
    ssoProviderSubject: "sub-123",
  };

  it("rehydrates a password row", () => {
    expect(User.reconstruct(passwordRow)).toEqual({
      authMethod: "password",
      id: ID,
      email: "user@example.com",
      passwordHash: HASH,
      trashRetentionDays: 30,
      version: 3,
      createdAt: NOW,
      updatedAt: LATER,
    });
  });

  it("rehydrates an SSO row", () => {
    const user = User.reconstruct(ssoRow);
    expect(User.isSsoUser(user)).toBe(true);
    expect((user as SsoUser).provider).toBe("google");
    expect((user as SsoUser).providerSubject).toBe("sub-123");
  });

  it.each([
    ["password row without a hash", { ...passwordRow, passwordHash: null }],
    ["unknown auth method", { ...passwordRow, authMethod: "magic-link" }],
    ["sso row without a provider", { ...ssoRow, ssoProvider: null }],
    ["sso row with an unsupported provider", { ...ssoRow, ssoProvider: "x" }],
    ["sso row without a subject", { ...ssoRow, ssoProviderSubject: null }],
    // The other direction of the same CHECK: a row carrying the columns
    // of the variant it is not. Dropping them silently would rehydrate a
    // user whose stored identity no longer matches the one in memory.
    [
      "password row carrying an SSO provider",
      { ...passwordRow, ssoProvider: "google" },
    ],
    [
      "password row carrying an SSO subject",
      { ...passwordRow, ssoProviderSubject: "sub-123" },
    ],
    [
      "sso row carrying a password hash",
      { ...ssoRow, passwordHash: HASH as string },
    ],
    ["empty id", { ...passwordRow, id: "" }],
    ["malformed email", { ...passwordRow, email: "not-an-email" }],
    ["retention below 1", { ...passwordRow, trashRetentionDays: 0 }],
    ["negative version", { ...passwordRow, version: -1 }],
  ])("wraps an inconsistent row in RehydrationError: %s", (_label, row) => {
    let caught: unknown;
    try {
      User.reconstruct(row);
    } catch (error) {
      caught = error;
    }
    expect(isRehydrationError(caught)).toBe(true);
  });

  it("preserves the original value-object failure as the cause", () => {
    let caught: unknown;
    try {
      User.reconstruct({ ...passwordRow, email: "nope" });
    } catch (error) {
      caught = error;
    }
    expect(isRehydrationError(caught) && caught.cause).toBeDefined();
  });
});

describe("User type guards", () => {
  it("discriminate on authMethod", () => {
    const { entity: passwordUser } = User.registerWithPassword(
      { id: ID, email: "user@example.com", passwordHash: HASH },
      NOW,
    );
    const { entity: ssoUser } = User.registerWithSso(
      {
        id: UserId.create(ID),
        email: "sso@example.com",
        provider: SsoProvider.create("google"),
        providerSubject: "sub-123",
      },
      NOW,
    );

    expect(User.isPasswordUser(passwordUser)).toBe(true);
    expect(User.isSsoUser(passwordUser)).toBe(false);
    expect(User.isPasswordUser(ssoUser)).toBe(false);
    expect(User.isSsoUser(ssoUser)).toBe(true);
  });
});
