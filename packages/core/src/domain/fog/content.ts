import { BusinessRuleError } from "../error";

export type Actor =
  | Readonly<{ kind: "human"; userId: string; email: string }>
  | Readonly<{
      kind: "ai";
      userId: string;
      clientId: string;
      clientName: string;
    }>;

export type Memo = Readonly<{
  id: string;
  ownerId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}>;

export function memoBody(value: string): string {
  if (!value.trim() || value.length > 100_000) {
    throw new BusinessRuleError(
      "INVALID_MEMO_BODY",
      "本文は1〜100,000文字で入力してください。",
    );
  }
  return value;
}

export function emailAddress(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BusinessRuleError(
      "INVALID_EMAIL",
      "メールアドレスを確認してください。",
    );
  }
  return email;
}

export function passwordValue(value: string): string {
  if (value.length < 12 || value.length > 128) {
    throw new BusinessRuleError(
      "INVALID_PASSWORD",
      "パスワードは12〜128文字で入力してください。",
    );
  }
  return value;
}

export type RevisionActor = Readonly<{
  kind: "human" | "ai";
  id: string;
  name: string;
}>;
export type Topic = Readonly<{
  id: string;
  ownerId: string;
  title: string;
  description: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}>;
export type Document = Readonly<{
  id: string;
  ownerId: string;
  topicId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}>;
export type MemoRevision = Readonly<{
  version: number;
  body: string;
  createdAt: string;
  actor: RevisionActor;
}>;
export type DocumentRevision = MemoRevision &
  Readonly<{ title: string; reason: string }>;
export function contentTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 200)
    throw new BusinessRuleError(
      "INVALID_TITLE",
      "タイトルは1〜200文字で入力してください。",
    );
  return title;
}
export function topicDescription(value: string): string {
  if (value.length > 2000)
    throw new BusinessRuleError(
      "INVALID_DESCRIPTION",
      "説明は2,000文字以内で入力してください。",
    );
  return value;
}
export function documentBody(value: string): string {
  if (value.length > 1_000_000)
    throw new BusinessRuleError(
      "INVALID_DOCUMENT_BODY",
      "本文は1,000,000文字以内で入力してください。",
    );
  return value;
}
export function revisionReason(
  actor: Actor,
  value: string | undefined,
  fallback: string,
): string {
  const reason = value?.trim();
  if (actor.kind === "ai" && !reason)
    throw new BusinessRuleError(
      "REASON_REQUIRED",
      "AIによる変更には理由が必要です。",
    );
  if (reason && (reason.length > 1000 || /[\r\n]/.test(reason)))
    throw new BusinessRuleError(
      "INVALID_REASON",
      "変更理由は改行せず、1,000文字以内で入力してください。",
    );
  return reason || fallback;
}

export type TimelineKey = Readonly<{ createdAt: string; id: string }>;
export function timelineCursor(value: string): TimelineKey {
  const parts = value.split("|");
  const createdAt = parts[0];
  const id = parts[1];
  if (
    parts.length !== 2 ||
    !createdAt ||
    !id ||
    Number.isNaN(Date.parse(createdAt)) ||
    id.length > 200
  )
    throw new BusinessRuleError(
      "INVALID_CURSOR",
      "読み込み位置が正しくありません。",
    );
  return { createdAt, id };
}
export function timelineDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00+09:00`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new BusinessRuleError("INVALID_DATE", "日付を確認してください。");
  return value;
}
