import type { Actor, Document, Memo } from "@repo/core/domain/fog/content";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { FogUnitOfWork, FogUnitOfWorkProvider } from "./ports";
import type { DocumentView, MemoView } from "./types";
export type ContentDependencies = {
  unitOfWork: FogUnitOfWorkProvider;
  clock: Clock;
  ids: IdGenerator;
};
export function requireHuman(actor: Actor): void {
  if (actor.kind !== "human")
    throw new ForbiddenError(
      "HUMAN_ONLY",
      "この操作は人間の利用者のみ実行できます。",
    );
}
export function requireVersion(current: number, expected: number): void {
  if (current !== expected)
    throw new ConflictError(
      "OPTIMISTIC_LOCK_FAILURE",
      "編集中に内容が更新されました。最新の内容を確認してください。",
    );
}
export function found<T>(
  value: T | null,
  kind: "MEMO" | "TOPIC" | "DOCUMENT" | "REVISION",
): T {
  if (value === null)
    throw new NotFoundError(
      `${kind}_NOT_FOUND`,
      "対象のデータが見つかりません。",
    );
  return value;
}
export async function memoView(
  context: FogUnitOfWork,
  memo: Memo,
  actor: Actor,
): Promise<MemoView> {
  const { ownerId, ...view } = memo;
  return {
    ...view,
    sourceDocuments: (
      await context.memos(ownerId).sourceDocuments(memo.id)
    ).filter((source) => actor.kind === "human" || !source.deleted),
  };
}
export async function documentView(
  context: FogUnitOfWork,
  document: Document,
  actor: Actor,
): Promise<DocumentView> {
  const { ownerId, ...view } = document;
  return {
    ...view,
    sourceMemos: (
      await context.documents(ownerId).sourceMemos(document.id)
    ).filter((source) => actor.kind === "human" || !source.deleted),
  };
}
