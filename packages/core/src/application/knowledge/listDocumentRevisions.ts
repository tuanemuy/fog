import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { documentNotFound } from "./shared";
import { type DocumentRevisionsView, toDocumentRevisionMetaView } from "./view";

export type ListDocumentRevisionsInput = Readonly<{
  userId: string;
  documentId: string;
}>;

/** S-DT-06, request side. Who, when and why only; bodies come with the diff. */
export async function listDocumentRevisions({
  container,
  input,
}: ServiceArgs<ListDocumentRevisionsInput>): Promise<DocumentRevisionsView> {
  return container.knowledgeGateway.listDocumentRevisions(
    input.userId,
    input.documentId,
  );
}

/** Inside the DO. A trashed document still shows its history (human UI only). */
export function listDocumentRevisionsProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawDocumentId: string,
): DocumentRevisionsView {
  const documentId = DocumentId.create(rawDocumentId);
  const found = ctx.documentRepository.findByIdIncludingTrashed(documentId);
  if (found === null) throw documentNotFound();
  return {
    documentId,
    latestRevision: found.entity.latestRevision,
    revisions: ctx.documentRepository
      .listRevisionSummaries(documentId)
      .map(toDocumentRevisionMetaView),
  };
}
