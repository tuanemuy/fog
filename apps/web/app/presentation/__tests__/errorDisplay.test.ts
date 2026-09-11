import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { KnowledgeErrorCode } from "@repo/core/domain/knowledge/errorCode";
import {
  ChangeReason,
  DOCUMENT_BODY_MAX_CODE_POINTS,
  DocumentBody,
  DocumentTitle,
  TopicDescription,
  TopicName,
} from "@repo/core/domain/knowledge/valueObject";
import { MemoErrorCode } from "@repo/core/domain/memo/errorCode";
import { MemoBody } from "@repo/core/domain/memo/valueObject";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  displayError,
  renderErrorMessage,
  reportRouteError,
} from "../errorDisplay";
import {
  AppServerError,
  extractSerializedError,
  redactForClient,
  type SerializedError,
  serializeError,
} from "../errorResponse";

// Built from the domain's constant rather than typed out, because
// `errorDisplay.ts` states the same number as a literal: the two only stay
// equal by hand, and this is where that drift turns red.
const BODY_TOO_LONG_MESSAGE = `本文は${DOCUMENT_BODY_MAX_CODE_POINTS.toLocaleString(
  "ja-JP",
)}文字以内で入力してください`;

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

  // The `""` key carries a top-level type mismatch (`null` POSTed in place
  // of the object), whose message is zod's raw English default — the one
  // fieldErrors entry no schema wrote Japanese wording for.
  it("substitutes generic wording for the field-less empty-string key", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: { "": ["Invalid input: expected object, received null"] },
    };

    const rendered = renderErrorMessage(error);

    expect(rendered).toBe("入力内容が正しくありません");
    expect(rendered).not.toContain("expected object");
  });

  // The substitution joins in as one part among the others rather than
  // replacing them — a superRefine can file a form-level issue alongside a
  // field-level one, and both must survive.
  it("keeps field entries alongside the substituted empty-string key", () => {
    const error: SerializedError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      fieldErrors: {
        "": ["Expected object, received null"],
        email: ["必須です"],
      },
    };

    expect(renderErrorMessage(error)).toBe(
      "入力内容が正しくありません / メールアドレス: 必須です",
    );
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
      "an over-long memo body",
      {
        kind: "business",
        code: MemoErrorCode.BodyTooLong,
        message: "Memo body exceeds maximum length (10000)",
      },
      "メモは10,000文字以内で入力してください",
    ],
    [
      "a blank memo body",
      {
        kind: "business",
        code: MemoErrorCode.EmptyBody,
        message: "Memo body cannot be empty",
      },
      "メモを入力してください",
    ],
    [
      "a blank topic name",
      {
        kind: "business",
        code: KnowledgeErrorCode.EmptyTopicName,
        message: "Topic name cannot be empty",
      },
      "トピック名を入力してください",
    ],
    [
      "a topic name carrying a line break",
      {
        kind: "business",
        code: KnowledgeErrorCode.TopicNameMultiline,
        message: "Topic name cannot contain a line break",
      },
      "トピック名に改行は使えません",
    ],
    [
      "an over-long topic name",
      {
        kind: "business",
        code: KnowledgeErrorCode.TopicNameTooLong,
        message: "Topic name exceeds maximum length (100)",
      },
      "トピック名は100文字以内で入力してください",
    ],
    [
      "a blank topic description",
      {
        kind: "business",
        code: KnowledgeErrorCode.EmptyTopicDescription,
        message: "Topic description cannot be empty",
      },
      "説明文を入力してください",
    ],
    [
      "an over-long topic description",
      {
        kind: "business",
        code: KnowledgeErrorCode.TopicDescriptionTooLong,
        message: "Topic description exceeds maximum length (500)",
      },
      "説明文は500文字以内で入力してください",
    ],
    [
      "a blank document title",
      {
        kind: "business",
        code: KnowledgeErrorCode.EmptyDocumentTitle,
        message: "Document title cannot be empty",
      },
      "タイトルを入力してください",
    ],
    [
      "a document title carrying a line break",
      {
        kind: "business",
        code: KnowledgeErrorCode.DocumentTitleMultiline,
        message: "Document title cannot contain a line break",
      },
      "タイトルに改行は使えません",
    ],
    [
      "an over-long document title",
      {
        kind: "business",
        code: KnowledgeErrorCode.DocumentTitleTooLong,
        message: "Document title exceeds maximum length (200)",
      },
      "タイトルは200文字以内で入力してください",
    ],
    [
      "an over-long document body",
      {
        kind: "business",
        code: KnowledgeErrorCode.DocumentBodyTooLong,
        message: "Document body exceeds maximum length (400000)",
      },
      BODY_TOO_LONG_MESSAGE,
    ],
    [
      "a blank change reason",
      {
        kind: "business",
        code: KnowledgeErrorCode.EmptyChangeReason,
        message: "Change reason cannot be empty",
      },
      "変更理由を入力してください",
    ],
    [
      "a change reason carrying a line break",
      {
        kind: "business",
        code: KnowledgeErrorCode.ChangeReasonMultiline,
        message: "Change reason cannot contain a line break",
      },
      "変更理由に改行は使えません",
    ],
    [
      "an over-long change reason",
      {
        kind: "business",
        code: KnowledgeErrorCode.ChangeReasonTooLong,
        message: "Change reason exceeds maximum length (200)",
      },
      "変更理由は200文字以内で入力してください",
    ],
    [
      "a patch whose target is not in the document",
      {
        kind: "business",
        code: KnowledgeErrorCode.PatchTargetNotFound,
        message: "The patch target was not found in the document",
      },
      "パッチの置換元が本文に見つかりません",
    ],
    [
      "a patch whose target appears more than once",
      {
        kind: "business",
        code: KnowledgeErrorCode.PatchTargetAmbiguous,
        message: "The patch target appears more than once",
      },
      "パッチの置換元が本文に複数あります",
    ],
    [
      "an AI client name the domain refuses",
      {
        kind: "business",
        code: IdentityErrorCode.InvalidClientName,
        message: "Client name must be 1 to 100 characters",
      },
      "クライアント名が正しくありません",
    ],
    [
      "an authorization request that no longer verifies",
      {
        kind: "validation",
        code: "AUTHORIZATION_REQUEST_INVALID",
        message: "The authorization request is invalid or has expired",
      },
      "認可リクエストが正しくありません。クライアントアプリからやり直してください",
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
      "an SSO identity held by another account",
      {
        kind: "conflict",
        code: "SSO_IDENTITY_ALREADY_REGISTERED",
        message: "This SSO identity is already registered",
      },
      "この外部アカウントは既に別のアカウントに連携されています",
    ],
    [
      "a spent reset link",
      {
        kind: "validation",
        code: "RESET_TOKEN_INVALID",
        message: "The reset link is invalid or has expired",
      },
      "リンクが無効か期限切れです",
    ],
    [
      "a wrong current password",
      {
        kind: "validation",
        code: "CURRENT_PASSWORD_MISMATCH",
        message: "The current password is not correct",
      },
      "現在のパスワードが正しくありません",
    ],
    [
      "a limited attempt",
      {
        kind: "validation",
        code: "TOO_MANY_ATTEMPTS",
        message: "Attempts are limited for now",
      },
      "試行回数の上限に達しました。しばらくしてからお試しください",
    ],
    [
      "the last login method",
      {
        kind: "business",
        code: IdentityErrorCode.LastCredentialRemoval,
        message: "Cannot remove the last credential",
      },
      "最後のログイン手段は解除できません",
    ],
    [
      "an account without a password",
      {
        kind: "business",
        code: IdentityErrorCode.PasswordNotSupported,
        message: "This account has no password credential",
      },
      "このアカウントにはパスワードが設定されていません",
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

  // What a screen holds is not always what it caught. `TimelineBoard` and
  // `LogoutButton` both keep `extractSerializedError(error)` in state and
  // render it on a later pass, so the value reaching here is the payload,
  // not the throw. Extracting it a second time answers `unknown`, and
  // every kind then reads as the same generic wording — an over-long memo
  // body among them.
  it.each([
    [
      "business",
      {
        kind: "business",
        code: MemoErrorCode.BodyTooLong,
        message: "Memo body exceeds maximum length (10000)",
      },
      "メモは10,000文字以内で入力してください",
    ],
    [
      "system",
      { kind: "system", code: null, message: "System error" },
      "システムエラーが発生しました",
    ],
    [
      "an export over the byte cap",
      { kind: "system", code: "EXPORT_TOO_LARGE", message: "System error" },
      "データ量が上限を超えているためエクスポートできません。サポートに連絡してください",
    ],
    [
      "a system error whose code is not public",
      { kind: "system", code: "DATABASE_ERROR", message: "System error" },
      "システムエラーが発生しました",
    ],
  ] as ReadonlyArray<readonly [string, SerializedError, string]>)(
    "renders a %s payload the caller had already extracted",
    (_label, serialized, expected) => {
      const held = extractSerializedError(new AppServerError(serialized));

      expect(displayError(held)).toBe(expected);
    },
  );

  // The whole hop the composer's failure takes, assembled from the real
  // parts: the rule that refuses the body, the server boundary's
  // projection and redaction, the island's `catch`, and the render pass
  // after it. Each half is pinned elsewhere; only together do they say
  // that a 10,001st character reaches the reader as a length.
  it("carries an over-long memo body from the domain rule to the wording on screen", () => {
    let thrown: unknown;
    try {
      MemoBody.create("あ".repeat(10_001));
    } catch (error) {
      thrown = error;
    }

    const held = extractSerializedError(
      new AppServerError(redactForClient(serializeError(thrown))),
    );

    expect(displayError(held)).toBe("メモは10,000文字以内で入力してください");
  });

  // The topic fields' transport ceilings (400 / 2,000) sit above the
  // domain's (100 / 500) on purpose, so an over-long value is typed,
  // posted and refused by the rule rather than the schema. Building the
  // throw from the value object is what ties the numbers in the wording to
  // the bounds `domain/knowledge/valueObject.ts` actually enforces.
  it.each([
    [
      "topic name",
      () => TopicName.create("あ".repeat(101)),
      "トピック名は100文字以内で入力してください",
    ],
    [
      "topic description",
      () => TopicDescription.create("あ".repeat(501)),
      "説明文は500文字以内で入力してください",
    ],
  ] as ReadonlyArray<readonly [string, () => unknown, string]>)(
    "carries an over-long %s from the domain rule to the wording on screen",
    (_label, build, expected) => {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }

      const held = extractSerializedError(
        new AppServerError(redactForClient(serializeError(thrown))),
      );

      expect(displayError(held)).toBe(expected);
    },
  );

  // `createDocumentSchema` deliberately does not restate the domain's rules:
  // its title ceiling (800 UTF-16 units) is a DoS bound, and `.min(1)` is
  // satisfied by whitespace. So every one of these reaches the value object
  // and comes back as a `BusinessRuleError` whose own message is English.
  it.each([
    [
      "a whitespace-only document title",
      () => DocumentTitle.create("   "),
      "タイトルを入力してください",
    ],
    [
      "an over-long document title",
      () => DocumentTitle.create("あ".repeat(201)),
      "タイトルは200文字以内で入力してください",
    ],
    [
      "a document title carrying a line break",
      () => DocumentTitle.create("前\n後"),
      "タイトルに改行は使えません",
    ],
    [
      "an over-long document body",
      () => DocumentBody.create("あ".repeat(400_001)),
      BODY_TOO_LONG_MESSAGE,
    ],
    [
      "an over-long change reason",
      () => ChangeReason.create("あ".repeat(201)),
      "変更理由は200文字以内で入力してください",
    ],
  ] as ReadonlyArray<readonly [string, () => unknown, string]>)(
    "carries %s from the domain rule to the wording on screen",
    (_label, build, expected) => {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }

      const held = extractSerializedError(
        new AppServerError(redactForClient(serializeError(thrown))),
      );

      const rendered = displayError(held);

      expect(rendered).toBe(expected);
      expect(rendered).not.toMatch(/[A-Za-z]/);
    },
  );
});

describe("reportRouteError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs what the boundary caught under vite dev", () => {
    vi.stubEnv("DEV", true);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("connect ECONNREFUSED 10.0.0.4:5432");

    reportRouteError(error);

    expect(logged).toHaveBeenCalledWith("Route error:", error);
  });

  it("logs only that one happened in a production build", () => {
    vi.stubEnv("DEV", false);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    reportRouteError(new Error("connect ECONNREFUSED 10.0.0.4:5432"));

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("Route error");
  });
});
