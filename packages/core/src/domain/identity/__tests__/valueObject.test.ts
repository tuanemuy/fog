import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { IdentityErrorCode } from "../errorCode";
import {
  Actor,
  AiClientConnectionId,
  ClientName,
  CredentialId,
  Email,
  PasswordHash,
  PlainPassword,
  SsoProvider,
  ssoCanonical,
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

describe("CredentialId", () => {
  it("accepts a non-empty id and trims", () => {
    expect(CredentialId.create("  cred-1 ")).toBe("cred-1");
  });

  it("rejects an empty id", () => {
    expect(codeOf(() => CredentialId.create("  "))).toBe(
      IdentityErrorCode.InvalidCredentialId,
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

  // A full-width local part is an IME accident, and folding it would send the
  // reset link — the only proof of address ownership the design has — to a
  // different mailbox. Rejecting it surfaces the mistake before registration.
  it("rejects a non-ASCII local part rather than folding it", () => {
    expect(codeOf(() => Email.create("\uff41\uff42\uff43@example.com"))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("folds case in the local part", () => {
    expect(Email.create("Foo.Bar@example.com")).toBe("foo.bar@example.com");
  });

  // NFKC is applied to the domain and only to the domain.
  it("NFKC-normalises a full-width domain", () => {
    expect(
      Email.create("user@\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45.com"),
    ).toBe("user@example.com");
  });

  it("punycodes a non-ASCII domain", () => {
    expect(Email.create("user@\u65e5\u672c\u8a9e.jp")).toBe(
      "user@xn--wgv71a119e.jp",
    );
  });

  // Punycode lengthens, so an address that fits before conversion can exceed
  // the RFC 5321 path limit after it. 267 characters in, 417 out.
  it("re-checks the length after punycode conversion", () => {
    const syllables =
      "\u3042\u3044\u3046\u3048\u304a\u304b\u304d\u304f\u3051\u3053";
    const label = syllables.repeat(3).slice(0, 25);
    const domain = `${Array.from({ length: 10 }, () => label).join(".")}.jp`;

    expect(codeOf(() => Email.create(`user@${domain}`))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  // The structural check admits `:`, `/`, `?` and `#`, and the punycode step
  // goes through `URL` — which parses them off as port, path, query and
  // fragment. Dropping them would collapse four distinct inputs onto one
  // canonical, at the position that is simultaneously the uniqueness authority
  // and the address a reset link is mailed to. Rejecting is what "validate at
  // the boundary" means; truncating at one is not.
  it.each([
    ["a port", "user@日本語.jp:8080"],
    ["a path", "user@日本語.jp/x"],
    ["a query", "user@日本語.jp?q=1"],
    ["a fragment", "user@日本語.jp#f"],
  ])("rejects a non-ASCII domain carrying %s", (_label, input) => {
    expect(codeOf(() => Email.create(input))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("still accepts the bare non-ASCII domain those cases were built from", () => {
    expect(Email.create("user@日本語.jp")).toBe("user@xn--wgv71a119e.jp");
  });

  // The **ASCII** route never reaches `URL`, so without the label grammar
  // nothing would look at the domain at all and `a@example.com/evil` would
  // become a canonical address — a uniqueness key, an HMAC input and a mail
  // recipient that no mail can reach. The grammar runs on the converted form,
  // so both routes pass one gate.
  it.each([
    ["a port", "user@example.com:8080"],
    ["a path", "user@example.com/evil"],
    ["a query", "user@example.com?q=1"],
    ["a fragment", "user@example.com#f"],
    ["an underscore", "user@exa_mple.com"],
    ["a leading hyphen", "user@-example.com"],
    ["a trailing hyphen", "user@example-.com"],
    ["an empty label", "user@example..com"],
    ["a trailing dot", "user@example.com."],
    ["an over-long label", `user@${"a".repeat(64)}.com`],
  ])("rejects an ASCII domain carrying %s", (_label, input) => {
    expect(codeOf(() => Email.create(input))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it.each([
    ["a hyphen inside a label", "user@my-host.example.com"],
    ["digits", "user@host1.example2.com"],
    ["a 63-character label", `user@${"a".repeat(63)}.com`],
    ["a single-label domain", "user@localhost"],
  ])("still accepts an ASCII domain with %s", (_label, input) => {
    expect(Email.create(input)).toBe(input);
  });
});

describe("ssoCanonical", () => {
  it("folds the provider name's case", () => {
    expect(ssoCanonical("Google" as never, "sub-1")).toBe(
      ssoCanonical("google", "sub-1"),
    );
  });

  // The subject is opaque provider output: normalising it would put our notion
  // of sameness out of step with theirs.
  it("leaves the subject's case and width alone", () => {
    expect(ssoCanonical("google", "Sub-\uff11")).not.toBe(
      ssoCanonical("google", "sub-1"),
    );
  });

  it("trims only the subject's surrounding whitespace", () => {
    expect(ssoCanonical("google", "  sub-1  ")).toBe(
      ssoCanonical("google", "sub-1"),
    );
  });

  it("keeps the same subject distinct across providers", () => {
    expect(ssoCanonical("google", "sub-1")).not.toBe(
      ssoCanonical("apple", "sub-1"),
    );
  });

  it("rejects an empty subject", () => {
    expect(codeOf(() => ssoCanonical("google", "   "))).toBe(
      IdentityErrorCode.InvalidSsoProviderSubject,
    );
  });
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
