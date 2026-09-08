import { BusinessRuleError } from "@repo/core/domain/error";
import {
  type ActiveDocument,
  Document,
  type LiveTopic,
  Topic,
  type TrashedDocument,
  type TrashedTopic,
} from "./entity";
import { KnowledgeErrorCode } from "./errorCode";

/**
 * Set deletion and set restore of a topic with its documents (invariant 7).
 * Pure: fetching and saving the entities is the usecase's, inside one unit
 * of work.
 */
export const TopicTrashService = {
  /**
   * `documents` are the topic's active documents in full; each is trashed
   * with `trashedWith = topic.id` and the same `purgeAfter` as the topic.
   * Documents already in the trash on their own are not passed in.
   */
  trashTopicSet: (
    topic: LiveTopic,
    documents: readonly ActiveDocument[],
    purgeAfter: Date,
    now: Date,
  ): Readonly<{
    topic: TrashedTopic;
    documents: readonly TrashedDocument[];
  }> => ({
    topic: Topic.softDelete(topic, purgeAfter, now),
    documents: documents.map((document) =>
      Document.softDelete(document, topic.id, purgeAfter, now),
    ),
  }),

  /**
   * `documents` are the trashed documents under the topic. Only the ones
   * trashed with it come back; individually deleted ones stay and are
   * answered as `skippedDocuments`.
   */
  restoreTopicSet: (
    topic: TrashedTopic,
    documents: readonly TrashedDocument[],
    now: Date,
  ): Readonly<{
    topic: LiveTopic;
    restoredDocuments: readonly ActiveDocument[];
    skippedDocuments: readonly TrashedDocument[];
  }> => {
    const restoredDocuments: ActiveDocument[] = [];
    const skippedDocuments: TrashedDocument[] = [];
    for (const document of documents) {
      if (document.topicId !== topic.id) {
        throw new BusinessRuleError(
          KnowledgeErrorCode.TrashedWithMismatch,
          "The document does not belong to the topic being restored",
        );
      }
      if (document.trashedWith === topic.id) {
        restoredDocuments.push(Document.restore(document, now));
      } else {
        skippedDocuments.push(document);
      }
    }
    return {
      topic: Topic.restore(topic, now),
      restoredDocuments,
      skippedDocuments,
    };
  },
};
