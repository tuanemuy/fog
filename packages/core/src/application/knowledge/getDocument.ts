import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { documentNotFound } from "./shared";
import { type DocumentView, toDocumentView } from "./view";

export type GetDocumentInput = Readonly<{ userId: string; documentId: string }>;

/** S-DT-05 / S-AI-02 `get`, request side. Active only: the trash reads as absent. */
export async function getDocument({
  container,
  input,
}: ServiceArgs<GetDocumentInput>): Promise<DocumentView> {
  return container.knowledgeGateway.getDocument(input.userId, input.documentId);
}

export function getDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawDocumentId: string,
): DocumentView {
  const found = ctx.documentRepository.findById(
    DocumentId.create(rawDocumentId),
  );
  if (found === null) throw documentNotFound();
  return toDocumentView(found.entity);
}
