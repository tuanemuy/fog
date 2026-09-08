import {
  DocumentId,
  RevisionNumber,
} from "@repo/core/domain/knowledge/valueObject";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { DiffDocumentRevisionsDto } from "./gateway";
import { revisionNotFound } from "./shared";
import { type DocumentDiffView, toDocumentRevisionView } from "./view";

export type DiffDocumentRevisionsInput = Readonly<{
  userId: string;
  documentId: string;
  baseRevisionNumber: number;
  targetRevisionNumber: number;
}>;

function distinctRevisions(
  input: DiffDocumentRevisionsDto,
): DiffDocumentRevisionsDto {
  if (input.baseRevisionNumber === input.targetRevisionNumber) {
    throw new ValidationError(
      "SAME_REVISION",
      "base and target must be different revisions",
    );
  }
  return input;
}

/** S-DT-06, request side: the two full snapshots; the diff is the presentation's. */
export async function diffDocumentRevisions({
  container,
  input,
}: ServiceArgs<DiffDocumentRevisionsInput>): Promise<DocumentDiffView> {
  return container.knowledgeGateway.diffDocumentRevisions(
    input.userId,
    distinctRevisions({
      documentId: input.documentId,
      baseRevisionNumber: input.baseRevisionNumber,
      targetRevisionNumber: input.targetRevisionNumber,
    }),
  );
}

export function diffDocumentRevisionsProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: DiffDocumentRevisionsDto,
): DocumentDiffView {
  distinctRevisions(input);
  const documentId = DocumentId.create(input.documentId);
  const base = ctx.documentRepository.findRevision(
    documentId,
    RevisionNumber.create(input.baseRevisionNumber),
  );
  const target = ctx.documentRepository.findRevision(
    documentId,
    RevisionNumber.create(input.targetRevisionNumber),
  );
  if (base === null || target === null) throw revisionNotFound();
  return {
    base: toDocumentRevisionView(base),
    target: toDocumentRevisionView(target),
  };
}
