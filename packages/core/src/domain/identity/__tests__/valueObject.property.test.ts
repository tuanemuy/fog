import { isBusinessRuleError } from "@repo/core/domain/error";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IdentityErrorCode } from "../errorCode";
import { Email, PlainPassword } from "../valueObject";

const EMAIL_MAX_LENGTH = 320;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const DOMAIN = "@example.com";

// An address of exactly `length` characters that satisfies the structural
// pattern, so the only thing under test is the length bound.
const emailOfLength = (length: number): string =>
  `${"a".repeat(length - DOMAIN.length)}${DOMAIN}`;

function rejectionCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return isBusinessRuleError(error) ? error.code : null;
  }
}

describe("Email length boundary", () => {
  // TC-registerWithPassword-005
  it("accepts exactly 320 characters (TC-registerWithPassword-005)", () => {
    const raw = emailOfLength(EMAIL_MAX_LENGTH);
    expect(raw).toHaveLength(EMAIL_MAX_LENGTH);
    expect(Email.create(raw)).toHaveLength(EMAIL_MAX_LENGTH);
  });

  // TC-registerWithPassword-004
  it("rejects 321 characters (TC-registerWithPassword-004)", () => {
    const raw = emailOfLength(EMAIL_MAX_LENGTH + 1);
    expect(raw).toHaveLength(EMAIL_MAX_LENGTH + 1);
    expect(rejectionCode(() => Email.create(raw))).toBe(
      IdentityErrorCode.InvalidEmail,
    );
  });

  it("accepts every structurally valid address up to 320 characters (TC-registerWithPassword-005)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: DOMAIN.length + 1, max: EMAIL_MAX_LENGTH }),
        (length) => {
          expect(Email.create(emailOfLength(length))).toHaveLength(length);
        },
      ),
    );
  });

  it("rejects every address longer than 320 characters (TC-registerWithPassword-004)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: EMAIL_MAX_LENGTH + 1, max: EMAIL_MAX_LENGTH + 500 }),
        (length) => {
          expect(rejectionCode(() => Email.create(emailOfLength(length)))).toBe(
            IdentityErrorCode.InvalidEmail,
          );
        },
      ),
    );
  });

  // The cap is applied to the normalised form, so padding must not push an
  // otherwise-legal address over the limit.
  it("measures the length after trimming", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (padding) => {
        const raw = emailOfLength(EMAIL_MAX_LENGTH);
        expect(
          Email.create(`${" ".repeat(padding)}${raw}${" ".repeat(padding)}`),
        ).toHaveLength(EMAIL_MAX_LENGTH);
      }),
    );
  });
});

describe("PlainPassword length boundary", () => {
  // TC-registerWithPassword-006
  it("rejects exactly 7 characters (TC-registerWithPassword-006)", () => {
    expect(
      rejectionCode(() =>
        PlainPassword.create("a".repeat(PASSWORD_MIN_LENGTH - 1)),
      ),
    ).toBe(IdentityErrorCode.PasswordTooWeak);
  });

  // TC-registerWithPassword-007
  it("accepts exactly 8 characters (TC-registerWithPassword-007)", () => {
    expect(PlainPassword.create("a".repeat(PASSWORD_MIN_LENGTH))).toHaveLength(
      PASSWORD_MIN_LENGTH,
    );
  });

  // TC-registerWithPassword-008
  it("accepts exactly 128 characters (TC-registerWithPassword-008)", () => {
    expect(PlainPassword.create("a".repeat(PASSWORD_MAX_LENGTH))).toHaveLength(
      PASSWORD_MAX_LENGTH,
    );
  });

  // TC-registerWithPassword-009
  it("rejects 129 characters (TC-registerWithPassword-009)", () => {
    expect(
      rejectionCode(() =>
        PlainPassword.create("a".repeat(PASSWORD_MAX_LENGTH + 1)),
      ),
    ).toBe(IdentityErrorCode.PasswordTooWeak);
  });

  it("accepts any password within 8..128 characters (TC-registerWithPassword-007 / TC-registerWithPassword-008)", () => {
    fc.assert(
      fc.property(
        fc
          .string({
            minLength: PASSWORD_MIN_LENGTH,
            maxLength: PASSWORD_MAX_LENGTH,
          })
          .filter(
            (s) =>
              s.length >= PASSWORD_MIN_LENGTH &&
              s.length <= PASSWORD_MAX_LENGTH,
          ),
        (raw) => {
          expect(PlainPassword.create(raw)).toBe(raw);
        },
      ),
    );
  });

  it("rejects any password shorter than 8 characters (TC-registerWithPassword-006 / TC-registerWithPassword-010)", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: PASSWORD_MIN_LENGTH - 1 })
          .filter((s) => s.length < PASSWORD_MIN_LENGTH),
        (raw) => {
          expect(rejectionCode(() => PlainPassword.create(raw))).toBe(
            IdentityErrorCode.PasswordTooWeak,
          );
        },
      ),
    );
  });

  it("rejects any password longer than 128 characters (TC-registerWithPassword-009)", () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: PASSWORD_MAX_LENGTH + 1,
          max: PASSWORD_MAX_LENGTH + 500,
        }),
        (length) => {
          expect(
            rejectionCode(() => PlainPassword.create("a".repeat(length))),
          ).toBe(IdentityErrorCode.PasswordTooWeak);
        },
      ),
    );
  });
});
