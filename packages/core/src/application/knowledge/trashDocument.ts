import { Document } from "@repo/core/domain/knowledge/entity";
import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import { RetentionPolicy } from "@repo/core/domain/trash/retentionPolicy";
import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { armPurgeTrash } from "../trash/armPurgeTrash";
import type { Needs, ServiceArgs } from "../types";
import { documentNotFound } from "./shared";

export type TrashDocumentInput = Readonly<{
  userId: string;
  documentId: string;
}>;

/** S-DT-08 / S-AI-05, request side. */
export async function trashDocument({
  container,
  input,
}: ServiceArgs<TrashDocumentInput, Needs<"knowledgeGateway">>): Promise<void> {
  await container.knowledgeGateway.trashDocument(
    input.userId,
    input.documentId,
  );
}

/** Inside the DO. An individual delete: `trashedWith` stays `null`. */
export function trashDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawDocumentId: string,
  now: Date,
): void {
  const found = ctx.documentRepository.findById(
    DocumentId.create(rawDocumentId),
  );
  if (found === null) throw documentNotFound();
  const settings = ctx.userSettingsRepository.find();
  if (settings === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account holds no settings row",
    );
  }
  const purgeAfter = RetentionPolicy.expiresAt(
    now,
    settings.entity.trashRetentionDays,
  );
  ctx.documentRepository.save(
    Document.softDelete(found.entity, null, purgeAfter, now),
    found.expectedVersion,
  );
  armPurgeTrash(ctx);
}
