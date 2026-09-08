import type { UserActor } from "@repo/core/domain/identity/valueObject";
import { Document } from "@repo/core/domain/knowledge/entity";
import { DocumentId } from "@repo/core/domain/knowledge/valueObject";
import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { EditDocumentDto } from "./gateway";
import {
  blankToNull,
  documentNotFound,
  reasonOrDefault,
  rebuildActor,
} from "./shared";
import { type EditDocumentView, toDocumentRevisionMetaView } from "./view";

export const MANUAL_EDIT_CHANGE_REASON = "手動編集";

export type EditDocumentInput = Readonly<{
  userId: string;
  /** Only a human edits through this face; the AI side is `editDocumentByAi`. */
  actor: UserActor;
  documentId: string;
  title: string;
  body: string;
  changeReason?: string | null;
  /** The `version` the editor opened; the transport bounds it to a non-negative integer. */
  expectedVersion: number;
}>;

/** S-DT-05, request side. */
export async function editDocument({
  container,
  input,
}: ServiceArgs<EditDocumentInput>): Promise<EditDocumentView> {
  return container.knowledgeGateway.editDocument(input.userId, {
    actor: { kind: "user", userId: input.actor.userId },
    documentId: input.documentId,
    title: input.title,
    body: input.body,
    changeReason: blankToNull(input.changeReason),
    expectedVersion: input.expectedVersion,
  });
}

/**
 * Inside the DO. A `version` other than the one the editor opened is
 * answered as `conflict` without a write; "save anyway" re-submits with
 * `conflict.currentVersion`. The OCC check in `save` stays as the last line.
 */
export function editDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: EditDocumentDto,
  revisionId: string,
  now: Date,
): EditDocumentView {
  const documentId = DocumentId.create(input.documentId);
  const found = ctx.documentRepository.findById(documentId);
  if (found === null) throw documentNotFound();
  const current = found.entity;

  if (current.version !== input.expectedVersion) {
    const latest = ctx.documentRepository.findRevision(
      documentId,
      current.latestRevision,
    );
    if (latest === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "The document's latest revision is missing",
      );
    }
    return {
      result: "conflict",
      latestRevision: current.latestRevision,
      version: current.version,
      updatedAt: current.updatedAt,
      conflict: {
        currentTitle: current.title,
        currentBody: current.body,
        currentVersion: current.version,
        latestRevision: toDocumentRevisionMetaView(latest),
      },
    };
  }

  const outcome = Document.edit(
    current,
    {
      revisionId,
      title: input.title,
      body: input.body,
      actor: rebuildActor(input.actor),
      changeReason: reasonOrDefault(
        input.changeReason,
        MANUAL_EDIT_CHANGE_REASON,
      ),
    },
    now,
  );
  if (outcome.kind === "unchanged") {
    return {
      result: "unchanged",
      latestRevision: current.latestRevision,
      version: current.version,
      updatedAt: current.updatedAt,
      conflict: null,
    };
  }
  ctx.documentRepository.save(outcome.document, found.expectedVersion);
  ctx.documentRepository.insertRevision(outcome.revision);
  return {
    result: "saved",
    latestRevision: outcome.document.latestRevision,
    version: outcome.document.version,
    updatedAt: outcome.document.updatedAt,
    conflict: null,
  };
}
