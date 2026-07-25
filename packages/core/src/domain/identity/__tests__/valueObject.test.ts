import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { IdentityErrorCode } from "../errorCode";
import {
  Actor,
  AiClientConnectionId,
  ClientName,
  Email,
  PasswordHash,
  PlainPassword,
  SsoProvider,
  TrashRetentionDays,
  UserId,
} from "../valueObject";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  throw new Error("expected the factory to throw");
}

describe("UserId", () => {
  it("accepts a non-empty id and trims surrounding whitespace", () => {
    expect(UserId.create("  01950000-0000-7000-8000-000000000001  ")).toBe(
      "01950000-0000-7000-8000-000000000001",
    );
  });

  it("rejects an empty id with BusinessRuleError (TC-getCurrentUser-008)", () => {
    expect(codeOf(() => UserId.create(""))).toBe(
      IdentityErrorCode.InvalidUserId,
    );
  });

  it("rejects a whitespace-only id with BusinessRuleError (TC-getCurrentUser-008)", () => {
    expect(codeOf(() => UserId.create("   \t\n "))).toBe(
      IdentityErrorCode.InvalidUserId,
    );
  });
});

describe("Email", () => {
  it("normalises by trimming and lowercasing (TC-registerWithPassword-002)", () => {
    expect(Email.create("  User@Example.COM  ")).toBe("user@example.com");
  });

  it("leaves an already normalised address untouched", () => {
    expect(Email.create("user@example.com")).toBe("user@example.com");
  });

  it.each([
    ["missing @", "userexample.com"],
    ["empty domain", "local@"],
    ["empty local part", "@example.com"],
    ["inner whitespace", "us er@example.com"],
    ["two @", "user@@example.com"],
    ["empty string", ""],
  ])(
    "rejects a malformed address: %s (TC-registerWithPassword-003)",
    (_label, raw) => {
      expect(codeOf(() => Email.create(raw))).toBe(
        IdentityErrorCode.InvalidEmail,
      );
    },
  );
});

describe("PlainPassword", () => {
  it("rejects a 7-character password (TC-registerWithPassword-006)", () => {
    expect(codeOf(() => PlainPassword.create("a".repeat(7)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  it("rejects the empty password (TC-registerWithPassword-010)", () => {
    expect(codeOf(() => PlainPassword.create(""))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  // Whitespace is part of what the user typed and must reach the hasher
  // verbatim, so unlike every other identity VO this one does not trim.
  it("keeps surrounding whitespace and counts it towards the length", () => {
    expect(PlainPassword.create("  pass  ")).toBe("  pass  ");
    expect(codeOf(() => PlainPassword.create("  pass "))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  // The bound is code points: four emoji are four characters, however
  // many UTF-16 units they occupy. Counting units would let them pass an
  // eight-character minimum.
  it("measures length in code points, not UTF-16 units", () => {
    expect(codeOf(() => PlainPassword.create("😀".repeat(4)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
    expect(PlainPassword.create("😀".repeat(8))).toBe("😀".repeat(8));
    expect(PlainPassword.create("😀".repeat(128))).toBe("😀".repeat(128));
    expect(codeOf(() => PlainPassword.create("😀".repeat(129)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });
});

describe("PasswordHash", () => {
  it("accepts any non-empty encoding", () => {
    expect(PasswordHash.create("pbkdf2-sha256$1$c2FsdA==$aGFzaA==")).toBe(
      "pbkdf2-sha256$1$c2FsdA==$aGFzaA==",
    );
  });

  it("rejects an empty hash", () => {
    expect(codeOf(() => PasswordHash.create(""))).toBe(
      IdentityErrorCode.InvalidPasswordHash,
    );
  });
});

describe("SsoProvider", () => {
  it.each(["google", "apple"])("accepts %s", (raw) => {
    expect(SsoProvider.create(raw)).toBe(raw);
  });

  it("rejects an unsupported provider", () => {
    expect(codeOf(() => SsoProvider.create("github"))).toBe(
      IdentityErrorCode.UnsupportedSsoProvider,
    );
  });
});

describe("AiClientConnectionId", () => {
  it("accepts a non-empty id and trims", () => {
    expect(AiClientConnectionId.create("  conn-1 ")).toBe("conn-1");
  });

  it("rejects an empty id", () => {
    expect(codeOf(() => AiClientConnectionId.create(" "))).toBe(
      IdentityErrorCode.InvalidAiClientConnectionId,
    );
  });
});

describe("ClientName", () => {
  it("accepts a name and trims", () => {
    expect(ClientName.create("  Claude  ")).toBe("Claude");
  });

  it("rejects an empty name", () => {
    expect(codeOf(() => ClientName.create("   "))).toBe(
      IdentityErrorCode.InvalidClientName,
    );
  });

  it("accepts exactly 100 characters and rejects 101", () => {
    expect(ClientName.create("c".repeat(100))).toHaveLength(100);
    expect(codeOf(() => ClientName.create("c".repeat(101)))).toBe(
      IdentityErrorCode.InvalidClientName,
    );
  });
});

describe("TrashRetentionDays", () => {
  it("defaults to 30", () => {
    expect(TrashRetentionDays.default()).toBe(30);
  });

  it("accepts 1 as the lower bound", () => {
    expect(TrashRetentionDays.create(1)).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects %s", (raw) => {
    expect(codeOf(() => TrashRetentionDays.create(raw))).toBe(
      IdentityErrorCode.InvalidTrashRetentionDays,
    );
  });
});

describe("Actor", () => {
  const userId = UserId.create("01950000-0000-7000-8000-000000000001");

  it("builds a user actor", () => {
    expect(Actor.user(userId)).toEqual({ kind: "user", userId });
  });

  it("snapshots the client name on an AI client actor", () => {
    const actor = Actor.aiClient(
      userId,
      AiClientConnectionId.create("conn-1"),
      ClientName.create("Claude"),
    );
    expect(actor).toEqual({
      kind: "aiClient",
      userId,
      connectionId: "conn-1",
      clientName: "Claude",
    });
  });
});
