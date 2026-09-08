import type { UserActor } from "@repo/core/domain/identity/valueObject";
import { Document } from "@repo/core/domain/knowledge/entity";
import {
  DocumentId,
  RevisionNumber,
} from "@repo/core/domain/knowledge/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { RollbackDocumentDto } from "./gateway";
import {
  blankToNull,
  documentNotFound,
  reasonOrDefault,
  rebuildActor,
  revisionNotFound,
} from "./shared";
import type { RollbackDocumentView } from "./view";

export function rollbackChangeReason(revisionNumber: number): string {
  return `リビジョン${revisionNumber}の内容に戻す`;
}

export type RollbackDocumentInput = Readonly<{
  userId: string;
  /** Rollback exists for humans only; no AI scope carries it. */
  actor: UserActor;
  documentId: string;
  revisionNumber: number;
  changeReason?: string | null;
}>;

/** S-DT-06 "restore this content", request side. */
export async function rollbackDocument({
  container,
  input,
}: ServiceArgs<RollbackDocumentInput>): Promise<RollbackDocumentView> {
  return container.knowledgeGateway.rollbackDocument(input.userId, {
    actor: { kind: "user", userId: input.actor.userId },
    documentId: input.documentId,
    revisionNumber: input.revisionNumber,
    changeReason: blankToNull(input.changeReason),
  });
}

export function rollbackDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: RollbackDocumentDto,
  revisionId: string,
  now: Date,
): RollbackDocumentView {
  const documentId = DocumentId.create(input.documentId);
  const revisionNumber = RevisionNumber.create(input.revisionNumber);
  const found = ctx.documentRepository.findById(documentId);
  if (found === null) throw documentNotFound();
  const target = ctx.documentRepository.findRevision(
    documentId,
    revisionNumber,
  );
  if (target === null) throw revisionNotFound();
  const outcome = Document.rollback(
    found.entity,
    target,
    {
      revisionId,
      actor: rebuildActor(input.actor),
      changeReason: reasonOrDefault(
        input.changeReason,
        rollbackChangeReason(revisionNumber),
      ),
    },
    now,
  );
  if (outcome.kind === "unchanged") {
    return {
      changed: false,
      latestRevision: found.entity.latestRevision,
      version: found.entity.version,
      updatedAt: found.entity.updatedAt,
    };
  }
  ctx.documentRepository.save(outcome.document, found.expectedVersion);
  ctx.documentRepository.insertRevision(outcome.revision);
  return {
    changed: true,
    latestRevision: outcome.document.latestRevision,
    version: outcome.document.version,
    updatedAt: outcome.document.updatedAt,
  };
}
