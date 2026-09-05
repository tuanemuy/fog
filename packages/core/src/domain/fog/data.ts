import { BusinessRuleError } from "../error";

export function retentionPeriod(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3650)
    throw new BusinessRuleError(
      "INVALID_RETENTION_DAYS",
      "保持期限は1〜3,650日の整数で指定してください。",
    );
  return value;
}
export function searchQuery(value: string): string {
  const query = value.trim();
  if (query.length > 500)
    throw new BusinessRuleError(
      "INVALID_QUERY",
      "キーワードは500文字以内で入力してください。",
    );
  return query;
}
export type SearchKey = Readonly<{
  createdAt: string;
  id: string;
  kind: "memo" | "document";
}>;
export function searchPosition(value: string, scope: string): SearchKey {
  const [createdAt, id, kind, ...rest] = value.split("|");
  if (
    !createdAt ||
    Number.isNaN(Date.parse(createdAt)) ||
    !id ||
    id.length > 200 ||
    (kind !== "memo" && kind !== "document") ||
    rest.join("|") !== scope
  )
    throw new BusinessRuleError(
      "INVALID_CURSOR",
      "読み込み位置が正しくありません。検索し直してください。",
    );
  return { createdAt, id, kind };
}
