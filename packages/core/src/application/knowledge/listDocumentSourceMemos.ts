import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import { snippetOf } from "@repo/core/lib/text";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { documentNotFound } from "./shared";
import type { SourceMemosView, SourceMemoView } from "./view";

export type ListDocumentSourceMemosInput = Readonly<{
  userId: string;
  documentId: string;
}>;

/** S-DT-05 / S-DT-07, request side (human UI only: reads the trash for 「削除済み」). */
export async function listDocumentSourceMemos({
  container,
  input,
}: ServiceArgs<ListDocumentSourceMemosInput>): Promise<SourceMemosView> {
  return container.knowledgeGateway.listDocumentSourceMemos(
    input.userId,
    input.documentId,
  );
}

/**
 * Inside the DO. Links in the order they were made; a memo whose link is
 * gone (hard-deleted, ADR-003) does not appear.
 */
export function listDocumentSourceMemosProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawDocumentId: string,
): SourceMemosView {
  const documentId = DocumentId.create(rawDocumentId);
  const found = ctx.documentRepository.findByIdIncludingTrashed(documentId);
  if (found === null) throw documentNotFound();
  const links = ctx.documentRepository.listSourceLinksByDocument(documentId);
  const memos = new Map(
    ctx.memoRepository
      .listByIdsIncludingTrashed(links.map((link) => link.memoId))
      .map((memo) => [memo.id as string, memo] as const),
  );
  const sourceMemos: SourceMemoView[] = [];
  for (const link of links) {
    const memo = memos.get(link.memoId);
    if (!memo) continue;
    sourceMemos.push({
      memoId: memo.id,
      snippet: snippetOf(memo.body),
      postedAt: memo.postedAt,
      deleted: memo.status === "trashed",
      linkedAt: link.createdAt,
    });
  }
  return { sourceMemos };
}
