import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { IdentityErrorCode } from "../errorCode";
import {
  Actor,
  AiClientConnectionId,
  CLIENT_NAME_MAX_CODE_POINTS,
  ClientName,
  CredentialId,
  Email,
  type HumanPermission,
  PLAIN_PASSWORD_MAX_CODE_POINTS,
  PLAIN_PASSWORD_MIN_CODE_POINTS,
  PlainPassword,
  SsoProvider,
  TokenScope,
  TrashRetentionDays,
  UserId,
} from "../valueObject";

const EMOJI = "🙂";

function businessCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

function emailOfLength(total: number, domain = "example.com"): string {
  return `${"a".repeat(total - domain.length - 1)}@${domain}`;
}

describe("Email", () => {
  it("trims and lowercases both the local part and the domain", () => {
    expect(Email.create("  User@Example.COM  ")).toBe("user@example.com");
  });

  // Step 5: the local part is lowercased but never NFKC-folded — a fullwidth
  // letter is refused rather than folded onto the ASCII mailbox.
  it("rejects a non-ASCII local part instead of folding it", () => {
    expect(businessCodeOf(() => Email.create("ｕser@example.com"))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
    expect(businessCodeOf(() => Email.create("usér@example.com"))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("folds NFKC in the domain", () => {
    expect(Email.create("user@ｅｘａｍｐｌｅ.com")).toBe("user@example.com");
  });

  it("converts a non-ASCII domain to its punycode form", () => {
    expect(Email.create("user@日本語.jp")).toBe("user@xn--wgv71a119e.jp");
  });

  // UTS46 maps `。` to `.`; NFKC alone would not, which is why the trailing
  // dot is dropped after the IDNA conversion rather than before it.
  it("maps the ideographic full stop to a label separator", () => {
    expect(Email.create("user@example。com")).toBe("user@example.com");
  });

  it("drops exactly one trailing dot in the domain", () => {
    expect(Email.create("user@example.com.")).toBe("user@example.com");
    expect(Email.create("user@日本語.jp.")).toBe("user@xn--wgv71a119e.jp");
    expect(businessCodeOf(() => Email.create("user@example.com.."))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("is a fixed point of its own canonicalisation", () => {
    const canonical = Email.create("  User@日本語.JP. ");
    expect(Email.create(canonical)).toBe(canonical);
  });

  it.each([
    ["an empty label", "a@b..c"],
    ["a missing @", "user.example.com"],
    ["an empty local part", "@example.com"],
    ["an empty domain", "user@"],
    ["a blank string", "   "],
    ["a space in the local part", "us er@example.com"],
    ["a space in the domain", "user@exam ple.com"],
    ["a domain that is only a dot", "user@."],
  ])("rejects %s", (_label, raw) => {
    expect(businessCodeOf(() => Email.create(raw))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("accepts exactly 320 characters", () => {
    const raw = emailOfLength(320);
    expect(raw).toHaveLength(320);
    expect(Email.create(raw)).toBe(raw);
  });

  it("rejects 321 characters", () => {
    const raw = emailOfLength(321);
    expect(raw).toHaveLength(321);
    expect(businessCodeOf(() => Email.create(raw))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  // Step 8: the bound is checked again after IDNA conversion, which lengthens
  // `日本語.jp` (8 code points) to `xn--wgv71a119e.jp` (17).
  it("rejects an address that only exceeds 320 after punycode conversion", () => {
    const raw = emailOfLength(320, "日本語.jp");
    expect([...raw]).toHaveLength(320);
    expect(businessCodeOf(() => Email.create(raw))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });
});

describe("PlainPassword", () => {
  it("rejects 7 code points", () => {
    expect(businessCodeOf(() => PlainPassword.create("a".repeat(7)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  it("accepts 8 and 128 code points", () => {
    const min = "a".repeat(PLAIN_PASSWORD_MIN_CODE_POINTS);
    const max = "a".repeat(PLAIN_PASSWORD_MAX_CODE_POINTS);
    expect(PlainPassword.create(min)).toBe(min);
    expect(PlainPassword.create(max)).toBe(max);
  });

  it("rejects 129 code points", () => {
    expect(businessCodeOf(() => PlainPassword.create("a".repeat(129)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  it("rejects an empty password", () => {
    expect(businessCodeOf(() => PlainPassword.create(""))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });

  // Counting UTF-16 units would let 4 emoji pass the minimum and refuse 65 at
  // the maximum; both bounds are code points.
  it("counts non-BMP characters as one code point each", () => {
    expect(businessCodeOf(() => PlainPassword.create(EMOJI.repeat(7)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
    expect(PlainPassword.create(EMOJI.repeat(8))).toBe(EMOJI.repeat(8));
    expect(PlainPassword.create(EMOJI.repeat(128))).toBe(EMOJI.repeat(128));
    expect(businessCodeOf(() => PlainPassword.create(EMOJI.repeat(129)))).toBe(
      IdentityErrorCode.PasswordTooWeak,
    );
  });
});

describe("TrashRetentionDays", () => {
  it("rejects 0", () => {
    expect(businessCodeOf(() => TrashRetentionDays.create(0))).toBe(
      IdentityErrorCode.InvalidTrashRetentionDays,
    );
  });

  it("rejects a non-integer", () => {
    expect(businessCodeOf(() => TrashRetentionDays.create(1.5))).toBe(
      IdentityErrorCode.InvalidTrashRetentionDays,
    );
  });

  it("accepts 1", () => {
    expect(TrashRetentionDays.create(1)).toBe(1);
  });

  it("defaults to 30", () => {
    expect(TrashRetentionDays.default()).toBe(30);
  });
});

describe("SsoProvider", () => {
  it.each(["google", "apple"])("accepts %s", (raw) => {
    expect(SsoProvider.create(raw)).toBe(raw);
  });

  it("rejects an unknown provider", () => {
    expect(businessCodeOf(() => SsoProvider.create("other"))).toBe(
      IdentityErrorCode.UnsupportedSsoProvider,
    );
  });
});

describe("ClientName", () => {
  it("trims", () => {
    expect(ClientName.create("  Claude  ")).toBe("Claude");
  });

  it("rejects an empty name", () => {
    expect(businessCodeOf(() => ClientName.create("   "))).toBe(
      IdentityErrorCode.InvalidClientName,
    );
  });

  it("accepts 100 code points", () => {
    const name = "あ".repeat(CLIENT_NAME_MAX_CODE_POINTS);
    expect(ClientName.create(name)).toBe(name);
  });

  it("rejects 101 code points", () => {
    expect(businessCodeOf(() => ClientName.create("あ".repeat(101)))).toBe(
      IdentityErrorCode.InvalidClientName,
    );
  });
});

describe("opaque ids", () => {
  it("trims and refuses blanks", () => {
    expect(UserId.create(" u1 ")).toBe("u1");
    expect(businessCodeOf(() => UserId.create(" "))).toBe(
      IdentityErrorCode.InvalidUserId,
    );
    expect(businessCodeOf(() => CredentialId.create(""))).toBe(
      IdentityErrorCode.InvalidCredentialId,
    );
    expect(businessCodeOf(() => AiClientConnectionId.create(""))).toBe(
      IdentityErrorCode.InvalidAiClientConnectionId,
    );
  });
});

describe("TokenScope.allows", () => {
  const EVERY_PERMISSION: readonly HumanPermission[] = [
    "read",
    "write",
    "hardDelete",
    "trash",
    "history",
  ];

  it.each(EVERY_PERMISSION)("grants %s to a human session", (permission) => {
    expect(TokenScope.allows(TokenScope.human(), permission)).toBe(true);
  });

  it.each(EVERY_PERMISSION)(
    "grants %s to an AI token only when it is read or write",
    (permission) => {
      expect(TokenScope.allows(TokenScope.ai(), permission)).toBe(
        permission === "read" || permission === "write",
      );
    },
  );
});

describe("Actor", () => {
  it("builds a user actor", () => {
    const userId = UserId.create("u1");
    expect(Actor.user(userId)).toEqual({ kind: "user", userId: "u1" });
  });

  it("builds an AI client actor carrying the name snapshot", () => {
    const userId = UserId.create("u1");
    const connectionId = AiClientConnectionId.create("conn-1");
    const clientName = ClientName.create("Claude");
    expect(Actor.aiClient(userId, connectionId, clientName)).toEqual({
      kind: "aiClient",
      userId: "u1",
      connectionId: "conn-1",
      clientName: "Claude",
    });
  });
});
