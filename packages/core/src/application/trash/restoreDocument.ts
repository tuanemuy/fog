import { UserId } from "@repo/core/domain/identity/valueObject";
import { Document, Topic } from "@repo/core/domain/knowledge/entity";
import { TopicTrashService } from "@repo/core/domain/knowledge/service";
import { DocumentId, TopicId } from "@repo/core/domain/knowledge/valueObject";
import { RestorePolicy } from "@repo/core/domain/trash/service";
import type { TrashedDocumentItem } from "@repo/core/domain/trash/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { RestoreDestinationDto, RestoreDocumentDto } from "./gateway";
import { trashItemNotFound } from "./shared";
import type { RestoreDocumentView } from "./view";

export type RestoreDocumentInput = Readonly<{
  userId: string;
  documentId: string;
  confirmSetRestore?: boolean | undefined;
  destination?: RestoreDestinationDto | null | undefined;
}>;

/** S-TR-02 (document) with the three branches of ADR-001, request side. */
export async function restoreDocument({
  container,
  input,
}: ServiceArgs<RestoreDocumentInput>): Promise<RestoreDocumentView> {
  return container.trashGateway.restoreDocument(input.userId, {
    documentId: input.documentId,
    confirmSetRestore: input.confirmSetRestore === true,
    destination: input.destination ?? null,
  });
}

function documentNotInTrash(): NotFoundError {
  return new NotFoundError(
    "DOCUMENT_NOT_FOUND",
    "The document is not in the trash",
  );
}

/**
 * Inside the DO, one transaction. The plan is judged from the topic's
 * present state and judged again before any write, so a confirmation or a
 * destination given for a branch the state has since left is not applied
 * (`spec/usecases/trash.md` restoreDocument).
 */
export function restoreDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: RestoreDocumentDto,
  ids: { userId: string; newTopicId: string },
  now: Date,
): RestoreDocumentView {
  const documentId = DocumentId.create(dto.documentId);
  const item = ctx.trashQueryPort.findTrashItem({
    kind: "document",
    id: documentId,
  });
  if (item === null || item.kind !== "document") throw trashItemNotFound();

  const topic = ctx.topicRepository.findByIdIncludingTrashed(item.topicId);
  const plan = RestorePolicy.decideDocumentRestore(
    item,
    topic === null
      ? { kind: "hardDeleted" }
      : topic.entity.status === "trashed"
        ? { kind: "trashed" }
        : { kind: "active" },
  );

  switch (plan.kind) {
    case "restoreAlone":
      return restoreAlone(ctx, item, now);
    case "restoreWithTopic":
      if (!dto.confirmSetRestore) {
        return {
          result: "setRestoreConfirmationRequired",
          documentId,
          topicId: plan.topicId,
          topicName: topic?.entity.name ?? "",
        };
      }
      return restoreWithTopic(ctx, item, now);
    case "selectDestination":
      if (dto.destination === null) {
        return { result: "destinationSelectionRequired", documentId };
      }
      return restoreTo(ctx, item, dto.destination, ids, now);
  }
}

/** The document's own row, re-read with its OCC token; gone or live is not-in-trash. */
function takeTrashed(ctx: UserDataUnitOfWorkContext, documentId: DocumentId) {
  const found = ctx.documentRepository.findByIdIncludingTrashed(documentId);
  if (found === null || found.entity.status !== "trashed") {
    throw documentNotInTrash();
  }
  return { document: found.entity, expectedVersion: found.expectedVersion };
}

function restoreAlone(
  ctx: UserDataUnitOfWorkContext,
  item: TrashedDocumentItem,
  now: Date,
): RestoreDocumentView {
  const live = ctx.topicRepository.findById(item.topicId);
  if (live === null) {
    // The state moved while the user looked: judge again, write nothing.
    const again = ctx.topicRepository.findByIdIncludingTrashed(item.topicId);
    if (again !== null && again.entity.status === "trashed") {
      return {
        result: "setRestoreConfirmationRequired",
        documentId: item.id,
        topicId: item.topicId,
        topicName: again.entity.name,
      };
    }
    return { result: "destinationSelectionRequired", documentId: item.id };
  }
  // Touch: serialises with a concurrent trashTopic (the same device as createDocument).
  ctx.topicRepository.save(
    { ...live.entity, version: live.entity.version + 1 },
    live.expectedVersion,
  );
  const { document, expectedVersion } = takeTrashed(ctx, item.id);
  ctx.documentRepository.save(Document.restore(document, now), expectedVersion);
  return { result: "restored", documentId: item.id, restoredTopicId: null };
}

function restoreWithTopic(
  ctx: UserDataUnitOfWorkContext,
  item: TrashedDocumentItem,
  now: Date,
): RestoreDocumentView {
  const topic = ctx.topicRepository.findByIdIncludingTrashed(item.topicId);
  if (topic === null) {
    return { result: "destinationSelectionRequired", documentId: item.id };
  }
  if (topic.entity.status !== "trashed") return restoreAlone(ctx, item, now);
  const trashed = ctx.documentRepository.listTrashedByTopic(item.topicId);
  const outcome = TopicTrashService.restoreTopicSet(
    topic.entity,
    trashed.map((d) => d.entity),
    now,
  );
  ctx.topicRepository.save(outcome.topic, topic.expectedVersion);
  const versions = new Map(
    trashed.map((d) => [d.entity.id, d.expectedVersion]),
  );
  const version = (id: DocumentId) =>
    versions.get(id) as (typeof trashed)[number]["expectedVersion"];
  for (const document of outcome.restoredDocuments) {
    ctx.documentRepository.save(document, version(document.id));
  }
  // The document the user asked for always comes back, even when it was
  // deleted on its own before the set was (S-TR-02).
  const skipped = outcome.skippedDocuments.find((d) => d.id === item.id);
  if (skipped !== undefined) {
    ctx.documentRepository.save(
      Document.restore(skipped, now),
      version(skipped.id),
    );
  }
  return {
    result: "restored",
    documentId: item.id,
    restoredTopicId: item.topicId,
  };
}

function restoreTo(
  ctx: UserDataUnitOfWorkContext,
  item: TrashedDocumentItem,
  destination: RestoreDestinationDto,
  ids: { userId: string; newTopicId: string },
  now: Date,
): RestoreDocumentView {
  let destinationTopicId: TopicId;
  if (destination.kind === "existing") {
    const topicId = TopicId.create(destination.topicId);
    const live = ctx.topicRepository.findById(topicId);
    if (live === null) {
      throw new NotFoundError(
        "TOPIC_NOT_FOUND",
        "The destination topic is not available",
      );
    }
    ctx.topicRepository.save(
      { ...live.entity, version: live.entity.version + 1 },
      live.expectedVersion,
    );
    destinationTopicId = topicId;
  } else {
    const created = Topic.create(
      {
        id: ids.newTopicId,
        userId: UserId.create(ids.userId),
        name: destination.name,
        description: destination.description,
      },
      now,
    );
    ctx.topicRepository.insert(created);
    destinationTopicId = created.id;
  }
  const { document, expectedVersion } = takeTrashed(ctx, item.id);
  ctx.documentRepository.save(
    Document.restore(
      Document.moveToTopic(document, destinationTopicId, now),
      now,
    ),
    expectedVersion,
  );
  return {
    result: "restored",
    documentId: item.id,
    restoredTopicId: destinationTopicId,
  };
}
