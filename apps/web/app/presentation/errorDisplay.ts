import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";

function renderConflictMessage(code: string | null): string {
  switch (code) {
    case "EMAIL_ALREADY_REGISTERED":
      return "このメールアドレスは登録済みです";
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
function renderBusinessMessage(code: string | null): string | null {
  switch (code) {
    case IdentityErrorCode.PasswordTooWeak:
      return "パスワードは8文字以上128文字以下で入力してください";
    case IdentityErrorCode.InvalidEmail:
      return "メールアドレスの形式が正しくありません";
    default:
      return null;
  }
}

function renderValidationMessage(code: string | null): string | null {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "メールアドレスまたはパスワードが正しくありません";
    default:
      return null;
  }
}

function formatFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>>,
): string | null {
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const first = messages[0];
    if (first === undefined) continue;
    parts.push(field ? `${field}: ${first}` : first);
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

export function displayError(error: unknown): string {
  return renderErrorMessage(extractSerializedError(error));
}

export function sanitizeRouteError(error: unknown): string {
  if (import.meta.env.DEV) {
    console.error("Route error:", error);
  } else {
    console.error("Route error");
  }
  return renderErrorMessage(extractSerializedError(error));
}
