import { BusinessRuleError } from "../error";

export function googleReturnTo(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32) ||
    value.length > 2000
  )
    throw new BusinessRuleError(
      "INVALID_RETURN_TO",
      "戻り先が正しくありません。",
    );
  return value;
}
export function browserBinding(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value))
    throw new BusinessRuleError(
      "INVALID_BROWSER_BINDING",
      "ブラウザの認証状態を確認できません。もう一度お試しください。",
    );
  return value;
}
