import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import type { TrashedDocumentItem, TrashItem } from "./valueObject";

/** The topic's present state, read by the usecase and handed in. */
export type TopicStatusForRestore =
  | Readonly<{ kind: "active" }>
  | Readonly<{ kind: "trashed" }>
  | Readonly<{ kind: "hardDeleted" }>;

export type DocumentRestorePlan =
  | Readonly<{ kind: "restoreAlone" }>
  | Readonly<{ kind: "restoreWithTopic"; topicId: TopicId }>
  | Readonly<{ kind: "selectDestination" }>;

/** ADR-001: which of the three restore branches a document takes. */
export const RestorePolicy = {
  decideDocumentRestore: (
    item: TrashedDocumentItem,
    topicStatus: TopicStatusForRestore,
  ): DocumentRestorePlan => {
    switch (topicStatus.kind) {
      case "active":
        return { kind: "restoreAlone" };
      case "trashed":
        return { kind: "restoreWithTopic", topicId: item.topicId };
      case "hardDeleted":
        return { kind: "selectDestination" };
    }
  },
};

export type HardDeletePlan = Readonly<{
  memoIds: readonly MemoId[];
  documentIds: readonly DocumentId[];
  topicIds: readonly TopicId[];
}>;

/**
 * What a hard delete of one trash item erases. A topic takes the documents
 * trashed with it (`setDocumentIds`) and nothing else: a document deleted
 * on its own is never swept away by someone else's delete (ADR-001).
 */
export const HardDeletePolicy = {
  expandTargets: (item: TrashItem): HardDeletePlan => {
    switch (item.kind) {
      case "memo":
        return { memoIds: [item.id], documentIds: [], topicIds: [] };
      case "document":
        return { memoIds: [], documentIds: [item.id], topicIds: [] };
      case "topic":
        return {
          memoIds: [],
          documentIds: item.setDocumentIds,
          topicIds: [item.id],
        };
    }
  },
};
