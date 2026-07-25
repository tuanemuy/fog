import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  displayError,
  renderErrorMessage,
  sanitizeRouteError,
} from "../errorDisplay";
import { AppServerError, type SerializedError } from "../errorResponse";

// `renderErrorMessage` is what the route error boundary shows when no
// form owns the failure, and it is the only place `FIELD_LABELS` is
// consulted — `toAuthErrorDisplay` routes `email` / `password` to their
// own fields and returns before ever reaching this function, so the auth
// suite cannot reach the label table.

describe("renderErrorMessage", () => {
  // The reason the table exists: `fieldErrors` keys are the transport
  // schema's internal names, and an untranslated `email: 必須です` reads
  // as a leaked variable name.
  it("labels the fields a transport validation error names", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: {
        email: ["必須です"],
        password: ["短すぎます"],
      },
    };

    expect(renderErrorMessage(error)).toBe(
      "メールアドレス: 必須です / パスワード: 短すぎます",
    );
  });

  it("shows only the first message per field", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { password: ["短すぎます", "記号が必要です"] },
    };

    expect(renderErrorMessage(error)).toBe("パスワード: 短すぎます");
  });

  // An unlabelled key must not be dropped and must not be shown raw: the
  // message survives, the internal key does not.
  it("keeps the message but not the key for a field with no label", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { redirect: ["リダイレクト先が不正です"] },
    };

    expect(renderErrorMessage(error)).toBe("リダイレクト先が不正です");
  });

  it("falls back to the code's wording when fieldErrors carries nothing usable", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
      fieldErrors: { email: [] },
    };

    expect(renderErrorMessage(error)).toBe(
      "メールアドレスまたはパスワードが正しくありません",
    );
  });

  it("falls back to the layer's own message for an untranslated validation code", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "SOMETHING_NEW",
      message: "Something new went wrong",
    };

    expect(renderErrorMessage(error)).toBe("Something new went wrong");
  });

  it.each([
    [
      "a malformed address",
      {
        kind: "business",
        code: IdentityErrorCode.InvalidEmail,
        message: "Invalid email address",
      },
      "メールアドレスの形式が正しくありません",
    ],
    [
      "a weak password",
      {
        kind: "business",
        code: IdentityErrorCode.PasswordTooWeak,
        message: "Password must be between 8 and 128 characters",
      },
      "パスワードは8文字以上128文字以下で入力してください",
    ],
    [
      "an already-registered address",
      {
        kind: "conflict",
        code: "EMAIL_ALREADY_REGISTERED",
        message: "That email address is already registered",
      },
      "このメールアドレスは登録済みです",
    ],
    [
      "a lost race",
      {
        kind: "conflict",
        code: "OPTIMISTIC_LOCK_FAILURE",
        message: "Concurrent modification",
      },
      "他の操作と競合しました。もう一度お試しください",
    ],
    [
      "a missing target",
      { kind: "notFound", code: "USER_NOT_FOUND", message: "Not found" },
      "対象が見つかりません",
    ],
    [
      "a missing session",
      { kind: "unauthorized", code: null, message: "Unauthorized" },
      "認証が必要です",
    ],
    [
      "a refused action",
      { kind: "forbidden", code: null, message: "Forbidden" },
      "権限がありません",
    ],
  ] as ReadonlyArray<readonly [string, SerializedError, string]>)(
    "renders %s in the user's language",
    (_label, error, expected) => {
      expect(renderErrorMessage(error)).toBe(expected);
    },
  );

  // `system` and `unknown` are the two kinds whose message can name a
  // driver, a table or a host. They get a fixed wording rather than a
  // fallback to `error.message`, so nothing internal can reach the screen
  // even if redaction upstream were skipped.
  it.each([
    [
      "system",
      {
        kind: "system",
        code: "DATABASE_ERROR",
        message: "SQLITE_BUSY on users_email_uq",
      },
      "システムエラーが発生しました",
    ],
    [
      "unknown",
      {
        kind: "unknown",
        code: null,
        message: "connect ECONNREFUSED 10.0.0.4:5432",
      },
      "エラーが発生しました",
    ],
  ] as ReadonlyArray<readonly [string, SerializedError, string]>)(
    "shows no internal detail for a %s failure",
    (_label, error, expected) => {
      const rendered = renderErrorMessage(error);

      expect(rendered).toBe(expected);
      expect(rendered).not.toContain(error.message);
    },
  );
});

describe("displayError", () => {
  it("reads the payload out of a transport error", () => {
    const error = new AppServerError({
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { email: ["必須です"] },
    });

    expect(displayError(error)).toBe("メールアドレス: 必須です");
  });

  it("treats a bare throw as an unknown failure", () => {
    expect(displayError(new Error("boom"))).toBe("エラーが発生しました");
  });
});

describe("sanitizeRouteError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the failure and never returns what it logged", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("connect ECONNREFUSED 10.0.0.4:5432");

    const rendered = sanitizeRouteError(error);

    expect(rendered).toBe("エラーが発生しました");
    expect(logged).toHaveBeenCalled();
  });
});
