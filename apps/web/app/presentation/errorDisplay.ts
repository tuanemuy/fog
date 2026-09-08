import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { KnowledgeErrorCode } from "@repo/core/domain/knowledge/errorCode";
import { MemoErrorCode } from "@repo/core/domain/memo/errorCode";
import {
  asSerializedError,
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";

function renderConflictMessage(code: string | null): string {
  switch (code) {
    case "EMAIL_ALREADY_REGISTERED":
      return "このメールアドレスは登録済みです";
    case "SSO_IDENTITY_ALREADY_REGISTERED":
      return "この外部アカウントは既に別のアカウントに連携されています";
    case "OPTIMISTIC_LOCK_FAILURE":
      return "他の操作と競合しました。もう一度お試しください";
    case "UNIQUE_VIOLATION":
      return "すでに登録されています";
    case "FOREIGN_KEY_VIOLATION":
      return "依存関係があるため操作できません";
    default:
      return "他の操作と競合しました。もう一度お試しください";
  }
}

// `business` and `validation` both carry the message the layer that threw
// wrote in English. Codes we have a user-facing wording for are translated
// here; everything else keeps falling through to that message, so adding a
// new error does not silently produce a blank UI.
//
// Every bound quoted below is a literal, including the document body's, so
// that one wording does not read differently from the others sitting next
// to it. What keeps them honest is on the test side: `errorDisplay.test.ts`
// builds the expected wording from the domain's constant, so the two turn
// red when they drift. That pin exists for `DocumentBody` alone.
function renderBusinessMessage(code: string | null): string | null {
  switch (code) {
    case IdentityErrorCode.PasswordTooWeak:
      return "パスワードは8文字以上128文字以下で入力してください";
    case IdentityErrorCode.InvalidEmail:
      return "メールアドレスの形式が正しくありません";
    case IdentityErrorCode.LastCredentialRemoval:
    case IdentityErrorCode.LoginMethodRequired:
      return "最後のログイン手段は解除できません";
    case IdentityErrorCode.PasswordNotSupported:
      return "このアカウントにはパスワードが設定されていません";
    case IdentityErrorCode.UnsupportedSsoProvider:
      return "対応していない外部アカウントです";
    case MemoErrorCode.BodyTooLong:
      return "メモは10,000文字以内で入力してください";
    case MemoErrorCode.EmptyBody:
      return "メモを入力してください";
    case KnowledgeErrorCode.EmptyTopicName:
      return "トピック名を入力してください";
    case KnowledgeErrorCode.TopicNameMultiline:
      return "トピック名に改行は使えません";
    case KnowledgeErrorCode.TopicNameTooLong:
      return "トピック名は100文字以内で入力してください";
    case KnowledgeErrorCode.EmptyTopicDescription:
      return "説明文を入力してください";
    case KnowledgeErrorCode.TopicDescriptionTooLong:
      return "説明文は500文字以内で入力してください";
    case KnowledgeErrorCode.EmptyDocumentTitle:
      return "タイトルを入力してください";
    case KnowledgeErrorCode.DocumentTitleMultiline:
      return "タイトルに改行は使えません";
    case KnowledgeErrorCode.DocumentTitleTooLong:
      return "タイトルは200文字以内で入力してください";
    case KnowledgeErrorCode.DocumentBodyTooLong:
      return "本文は400,000文字以内で入力してください";
    // **The three change-reason codes reach no screen yet.** A change reason
    // is posted only by the editor's edit mode, which the slice that owns
    // editing brings; the wording waits here so that slice adds a field
    // rather than a row of this table.
    case KnowledgeErrorCode.EmptyChangeReason:
      return "変更理由を入力してください";
    case KnowledgeErrorCode.ChangeReasonMultiline:
      return "変更理由に改行は使えません";
    case KnowledgeErrorCode.ChangeReasonTooLong:
      return "変更理由は200文字以内で入力してください";
    default:
      return null;
  }
}

function renderValidationMessage(code: string | null): string | null {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "メールアドレスまたはパスワードが正しくありません";
    case "RESET_TOKEN_INVALID":
      return "リンクが無効か期限切れです";
    case "CURRENT_PASSWORD_MISMATCH":
      return "現在のパスワードが正しくありません";
    case "TOO_MANY_ATTEMPTS":
      return "試行回数の上限に達しました。しばらくしてからお試しください";
    default:
      return null;
  }
}

// Field keys come from the transport schemas and are internal names. A key
// with no entry here is dropped rather than shown raw.
const FIELD_LABELS: Readonly<Record<string, string>> = {
  email: "メールアドレス",
  password: "パスワード",
  currentPassword: "現在のパスワード",
  newPassword: "新しいパスワード",
  token: "リンク",
};

// The `""` key is `validateInput`'s flatten of an issue with an empty
// `issue.path` — a top-level type mismatch (`null` POSTed in place of the
// object). No schema wrote wording for it, so its message is zod's raw
// English default; substitute this instead of rendering it.
const FORM_LEVEL_MESSAGE = "入力内容が正しくありません";

function formatFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>>,
): string | null {
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const first = messages[0];
    if (first === undefined) continue;
    if (field === "") {
      parts.push(FORM_LEVEL_MESSAGE);
      continue;
    }
    const label = FIELD_LABELS[field];
    parts.push(label === undefined ? first : `${label}: ${first}`);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function renderErrorMessage(error: SerializedError): string {
  switch (error.kind) {
    case "business":
      return renderBusinessMessage(error.code) ?? error.message;
    case "notFound":
      return "対象が見つかりません";
    case "conflict":
      return renderConflictMessage(error.code);
    case "unauthorized":
      return "認証が必要です";
    case "forbidden":
      return "権限がありません";
    case "validation": {
      if (error.fieldErrors !== undefined) {
        const formatted = formatFieldErrors(error.fieldErrors);
        if (formatted !== null) return formatted;
      }
      return renderValidationMessage(error.code) ?? error.message;
    }
    case "system":
      return "システムエラーが発生しました";
    case "unknown":
      return "エラーが発生しました";
  }
}

/**
 * What the two display entry points render, from anything a UI holds.
 *
 * **Not every such value is a thrown one.** A form that keeps its failure
 * in state stores the payload its `catch` already extracted and renders it
 * on later passes; `extractSerializedError` reads a *thrown value*, so a
 * payload handed back to it matches neither stage and lands on `unknown` —
 * the whole `kind` table collapses to one wording. Recognising a payload
 * that is already well-formed is what makes rendering idempotent.
 *
 * Display-only, and deliberately so: the stage decides wording alone.
 * Status, redaction and the server-side log are settled at the transport
 * boundary before any payload can reach a screen, so this widens nothing
 * `extractSerializedError`'s invariant holds shut.
 */
export function toDisplayError(error: unknown): SerializedError {
  return asSerializedError(error) ?? extractSerializedError(error);
}

export function displayError(error: unknown): string {
  return renderErrorMessage(toDisplayError(error));
}

/** The OCC signal a screen answers by reloading and asking for a retry. */
export function isOptimisticLockFailure(error: unknown): boolean {
  const serialized = toDisplayError(error);
  return (
    serialized.kind === "conflict" &&
    serialized.code === "OPTIMISTIC_LOCK_FAILURE"
  );
}

export function sanitizeRouteError(error: unknown): string {
  if (import.meta.env.DEV) {
    console.error("Route error:", error);
  } else {
    console.error("Route error");
  }
  return renderErrorMessage(toDisplayError(error));
}
