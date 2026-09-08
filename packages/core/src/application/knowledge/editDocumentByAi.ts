import { Document } from "@repo/core/domain/knowledge/entity";
import {
  DocumentBody,
  DocumentId,
  DocumentPatch,
} from "@repo/core/domain/knowledge/valueObject";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { type AiClientActorDto, rebuildActor } from "../identity/actorDto";
import type { Needs, ServiceArgs } from "../types";
import type { EditDocumentByAiDto } from "./gateway";
import { documentNotFound } from "./shared";
import type { EditDocumentByAiView } from "./view";

export type EditDocumentByAiInput = Readonly<{
  userId: string;
  actor: AiClientActorDto;
  documentId: string;
  edit: EditDocumentByAiDto["edit"];
  /** Required: no default is supplied on this face (requirements 4.5). */
  changeReason: string | null | undefined;
}>;

export function changeReasonRequired(): ValidationError {
  return new ValidationError(
    "CHANGE_REASON_REQUIRED",
    "changeReason is required for an AI edit",
    { changeReason: ["変更理由を入力してください"] },
  );
}

/**
 * MCP `edit_document` (S-AI-04): patches applied in order against the
 * body as it stands, or the whole body when the user asked for a rewrite;
 * both reach the same `Document.edit` with the current title. The reason
 * is required here and not defaulted — the human face's 「手動編集」 is
 * exactly what an AI edit may not hide behind.
 */
export async function editDocumentByAi({
  container,
  input,
}: ServiceArgs<
  EditDocumentByAiInput,
  Needs<"knowledgeGateway">
>): Promise<EditDocumentByAiView> {
  const changeReason = input.changeReason?.trim() ?? "";
  if (changeReason.length === 0) throw changeReasonRequired();
  return container.knowledgeGateway.editDocumentByAi(input.userId, {
    actor: input.actor,
    documentId: DocumentId.create(input.documentId),
    edit: input.edit,
    changeReason,
  });
}

export function editDocumentByAiProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: EditDocumentByAiDto,
  revisionId: string,
  now: Date,
): EditDocumentByAiView {
  if (input.changeReason.trim().length === 0) throw changeReasonRequired();
  const found = ctx.documentRepository.findById(
    DocumentId.create(input.documentId),
  );
  if (found === null) throw documentNotFound();
  const current = found.entity;
  const body =
    input.edit.mode === "replaceAll"
      ? input.edit.body
      : DocumentPatch.apply(
          DocumentBody.create(current.body),
          DocumentPatch.create(input.edit.patches),
        );
  const outcome = Document.edit(
    current,
    {
      revisionId,
      title: current.title,
      body,
      actor: rebuildActor(input.actor),
      changeReason: input.changeReason.trim(),
    },
    now,
  );
  if (outcome.kind === "unchanged") {
    return {
      changed: false,
      latestRevision: current.latestRevision,
      updatedAt: current.updatedAt,
    };
  }
  ctx.documentRepository.save(outcome.document, found.expectedVersion);
  ctx.documentRepository.insertRevision(outcome.revision);
  return {
    changed: true,
    latestRevision: outcome.document.latestRevision,
    updatedAt: outcome.document.updatedAt,
  };
}
