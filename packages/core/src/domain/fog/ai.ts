import { BusinessRuleError } from "../error";

export const aiReadOperations = [
  "guidance",
  "memos.recent",
  "memos.get",
  "topics.list",
  "topics.get",
  "documents.get",
  "search",
] as const;
export const aiWriteOperations = [
  "memos.create",
  "memos.replace",
  "topics.create",
  "topics.update",
  "documents.create",
  "documents.patch",
  "documents.rewrite",
  "content.delete",
] as const;
export const aiOperations = [...aiReadOperations, ...aiWriteOperations];
export const aiGuidance = [
  "ユーザーの代理として、保存・検索・整理に必要な操作だけを実行してください。",
  "検索結果は原文の事実情報です。要約や再構成はクライアント側で行い、必要なら単体取得してください。",
  "メモは全文置換、文書は理由付きの部分編集を使ってください。対象文字列は一意な完全一致が必要です。",
  "ユーザーが明示的に全面書き直しを求めた場合のみ documents.rewrite と confirmRewrite:true を使ってください。",
  "更新には取得した expectedVersion、すべての書き込みには再試行でも同一の idempotencyKey を指定してください。",
  "書き込みは現在有効な項目の識別子と版だけを返します。最新本文が必要なら単体取得してください。",
  "削除はゴミ箱への移動です。ゴミ箱・履歴・復元・完全削除は人間専用で、AI操作として提供しません。",
  "接続が失効した場合は操作を中止し、ユーザーに再接続を依頼してください。",
] as const;
export function authorizationFields(input: {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}): void {
  if (
    !input.state ||
    input.state.length > 1024 ||
    input.codeChallengeMethod !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
  )
    throw new BusinessRuleError(
      "INVALID_AI_AUTHORIZATION",
      "認可リクエストが正しくありません。",
    );
}
export function validCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}
export function idempotencyKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new BusinessRuleError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "書き込みには1〜200文字の冪等性キーが必要です。",
    );
  return value;
}
export function patchedDocument(
  body: string,
  find: string,
  replace: string,
): string {
  if (!find || find.length > 1_000_000 || replace.length > 1_000_000)
    throw new BusinessRuleError(
      "INVALID_PATCH",
      "部分編集の対象文字列を指定してください。",
    );
  if (find === body && replace !== body)
    throw new BusinessRuleError(
      "REWRITE_CONFIRMATION_REQUIRED",
      "全文置換には明示的な確認が必要です。",
    );
  const first = body.indexOf(find);
  if (first < 0 || body.indexOf(find, first + 1) >= 0)
    throw new BusinessRuleError(
      "PATCH_MATCH_FAILURE",
      "変更対象が一意に一致しません。最新の本文を取得してください。",
    );
  return body.slice(0, first) + replace + body.slice(first + find.length);
}
export function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${canonicalPayload(entry)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function validAiRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !["code", "state", "error"].some((name) => url.searchParams.has(name))
    );
  } catch {
    return false;
  }
}
