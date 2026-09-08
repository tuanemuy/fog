import { MemoId } from "@repo/core/domain/memo/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { ReferencingDocumentsView, ReferencingDocumentView } from "./view";

export type ListDocumentsReferencingMemoInput = Readonly<{
  userId: string;
  memoId: string;
}>;

/**
 * S-TL-07 for one memo, request side (human UI only). The timeline's trail
 * reads a whole page at once through `attachSourceDocuments`; no screen
 * calls this today (decision △-7).
 */
export async function listDocumentsReferencingMemo({
  container,
  input,
}: ServiceArgs<ListDocumentsReferencingMemoInput>): Promise<ReferencingDocumentsView> {
  return container.knowledgeGateway.listDocumentsReferencingMemo(
    input.userId,
    input.memoId,
  );
}

export function listDocumentsReferencingMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawMemoId: string,
): ReferencingDocumentsView {
  const memoId = MemoId.create(rawMemoId);
  if (ctx.memoRepository.findByIdIncludingTrashed(memoId) === null) {
    throw new NotFoundError("MEMO_NOT_FOUND", "The memo was not found");
  }
  const links = ctx.documentRepository.listSourceLinksByMemo(memoId);
  const documents = new Map(
    ctx.documentRepository
      .listSummariesByIdsIncludingTrashed(links.map((link) => link.documentId))
      .map((summary) => [summary.id as string, summary] as const),
  );
  const result: ReferencingDocumentView[] = [];
  for (const link of links) {
    const document = documents.get(link.documentId);
    if (!document) continue;
    result.push({
      documentId: document.id,
      title: document.title,
      topicId: document.topicId,
      deleted: document.status === "trashed",
      linkedAt: link.createdAt,
    });
  }
  return { documents: result };
}
