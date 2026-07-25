import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { describe, expect, it } from "vitest";
import type { SerializedError } from "@/presentation/errorResponse";
import { toAuthErrorDisplay } from "../errorField";

// AC-10 and AC-12 are decided here and nowhere else: which field an
// authentication failure lands under, whether the "already registered"
// case offers the way out, and the exact wording of the deliberately
// uninformative login failure. All of it is a pure function over
// `SerializedError`, so none of it needs a DOM.

describe("toAuthErrorDisplay", () => {
  it("reports no error for a null input", () => {
    expect(toAuthErrorDisplay(null)).toEqual({
      email: undefined,
      password: undefined,
      form: undefined,
      showLoginLink: false,
    });
  });

  // AC-12: a malformed address is actionable, so it belongs under the
  // field the user has to fix.
  it("puts a malformed address under the email field", () => {
    const error: SerializedError = {
      kind: "business",
      code: IdentityErrorCode.InvalidEmail,
      message: "Invalid email address",
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: "メールアドレスの形式が正しくありません",
      password: undefined,
      form: undefined,
      showLoginLink: false,
    });
  });

  it("puts a weak password under the password field", () => {
    const error: SerializedError = {
      kind: "business",
      code: IdentityErrorCode.PasswordTooWeak,
      message: "Password must be between 8 and 128 characters",
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: undefined,
      password: "パスワードは8文字以上128文字以下で入力してください",
      form: undefined,
      showLoginLink: false,
    });
  });

  // AC-12: "already registered" is only useful next to the way out, so
  // the login link rides along with the field message.
  it("offers the login link for an address that is already registered", () => {
    const error: SerializedError = {
      kind: "conflict",
      code: "EMAIL_ALREADY_REGISTERED",
      message: "That email address is already registered",
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: "このメールアドレスは登録済みです",
      password: undefined,
      form: undefined,
      showLoginLink: true,
    });
  });

  // AC-10 verbatim. Naming a field here would tell an attacker which
  // half of the pair was wrong, so it goes to the banner and offers no
  // login link — the user is already on the login screen.
  it("shows the uninformative credential failure above the form", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: undefined,
      password: undefined,
      form: "メールアドレスまたはパスワードが正しくありません",
      showLoginLink: false,
    });
  });

  it("routes transport field errors to the fields they name", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: {
        email: ["メールアドレスを入力してください"],
        password: ["パスワードを入力してください"],
      },
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: "メールアドレスを入力してください",
      password: "パスワードを入力してください",
      form: undefined,
      showLoginLink: false,
    });
  });

  it("routes a single transport field error without touching the other field", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { password: ["パスワードを入力してください"] },
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: undefined,
      password: "パスワードを入力してください",
      form: undefined,
      showLoginLink: false,
    });
  });

  // `fieldErrors` naming something the form does not render must not
  // swallow the message: it falls through to the banner.
  it("falls back to the banner when the named field is not on this form", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { redirect: ["リダイレクト先が不正です"] },
    };

    expect(toAuthErrorDisplay(error)).toEqual({
      email: undefined,
      password: undefined,
      form: "リダイレクト先が不正です",
      showLoginLink: false,
    });
  });

  // Anything without a field of its own is a banner message; nothing may
  // land silently nowhere.
  it.each([
    [
      "system",
      { kind: "system", code: null, message: "System error" },
      "システムエラーが発生しました",
    ] as const,
    [
      "unknown",
      { kind: "unknown", code: null, message: "Unexpected error" },
      "エラーが発生しました",
    ] as const,
    [
      "notFound",
      { kind: "notFound", code: "USER_NOT_FOUND", message: "Not found" },
      "対象が見つかりません",
    ] as const,
  ])("shows a %s failure above the form: %s", (_kind, error, message) => {
    expect(toAuthErrorDisplay(error as SerializedError)).toEqual({
      email: undefined,
      password: undefined,
      form: message,
      showLoginLink: false,
    });
  });
});
