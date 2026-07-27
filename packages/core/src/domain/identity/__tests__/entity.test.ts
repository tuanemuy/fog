import { describe, expect, it } from "vitest";
import { PasswordHash, SsoSubject, UserId, Email } from "../valueObject";
import { AccountIdentity } from "../accountIdentity";
import { Profile, Settings } from "../entity";
import { TrashRetentionDays } from "../valueObject";

const userId = UserId.create("00000000-0000-4000-8000-000000000001");
const email = Email.create("owner@example.com");
const passwordHash = PasswordHash.create("hash");

describe("AccountIdentity", () => {
  it("supports multiple logical credentials and keeps physical routing out", () => {
    const account = AccountIdentity.create({
      id: userId,
      status: "active",
      primaryEmail: email,
      sessionEpoch: 0,
      credentials: [
        {
          id: "password:owner@example.com",
          kind: "password",
          email,
          passwordHash,
        },
      ],
    });
    const linked = AccountIdentity.addCredential(account, {
      id: "sso:google:subject",
      kind: "sso",
      provider: "google",
      subject: SsoSubject.create("subject"),
      verifiedEmail: email,
    });
    expect(linked.credentials).toHaveLength(2);
    expect(linked.sessionEpoch).toBe(1);
    expect(Object.keys(linked)).not.toContain("locators");
  });

  it("rejects a primary email that is not backed by an active credential", () => {
    expect(() =>
      AccountIdentity.create({
        id: userId,
        status: "active",
        primaryEmail: Email.create("other@example.com"),
        sessionEpoch: 0,
        credentials: [
          {
            id: "password:owner@example.com",
            kind: "password",
            email,
            passwordHash,
          },
        ],
      }),
    ).toThrow(/Primary email/);
  });

  it("treats all routing generations as one logical credential", () => {
    const account = AccountIdentity.create({
      id: userId,
      status: "active",
      primaryEmail: email,
      sessionEpoch: 3,
      credentials: [
        {
          id: "password:owner@example.com",
          kind: "password",
          email,
          passwordHash,
        },
        {
          id: "sso:google:subject",
          kind: "sso",
          provider: "google",
          subject: SsoSubject.create("subject"),
          verifiedEmail: email,
        },
      ],
    });
    const unlinked = AccountIdentity.unlink(account, "sso:google:subject");
    expect(unlinked.credentials).toHaveLength(1);
    expect(unlinked.sessionEpoch).toBe(4);
    expect(() =>
      AccountIdentity.unlink(unlinked, "password:owner@example.com"),
    ).toThrow(/final login credential/i);
  });

  it("changes a password and invalidates prior sessions", () => {
    const account = AccountIdentity.create({
      id: userId,
      status: "active",
      primaryEmail: email,
      sessionEpoch: 4,
      credentials: [
        {
          id: "password:owner@example.com",
          kind: "password",
          email,
          passwordHash,
        },
      ],
    });
    const changed = AccountIdentity.replacePassword(
      account,
      "password:owner@example.com",
      PasswordHash.create("next-hash"),
    );
    expect(changed.sessionEpoch).toBe(5);
    expect(changed.credentials[0]).toMatchObject({ passwordHash: "next-hash" });
  });

  it("minimizes identity data after deletion", () => {
    const account = AccountIdentity.create({
      id: userId,
      status: "active",
      primaryEmail: email,
      sessionEpoch: 0,
      credentials: [
        {
          id: "password:owner@example.com",
          kind: "password",
          email,
          passwordHash,
        },
      ],
    });
    expect(
      AccountIdentity.markDeleted(AccountIdentity.markDeleting(account)),
    ).toEqual({
      id: userId,
      status: "deleted",
      primaryEmail: null,
      credentials: [],
      sessionEpoch: 1,
    });
  });
});

describe("Profile and Settings", () => {
  it("remain separate from authentication authority", () => {
    expect(Profile.create({ userId, displayName: "  Owner  " })).toEqual({
      userId,
      displayName: "Owner",
    });
    const settings = Settings.create({
      userId,
      trashRetentionDays: TrashRetentionDays.default(),
    });
    expect(
      Settings.changeTrashRetentionDays(
        settings,
        TrashRetentionDays.create(90),
      ),
    ).toMatchObject({ trashRetentionDays: 90 });
  });
});
