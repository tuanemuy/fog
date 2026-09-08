import type { KnowledgeGateway } from "@repo/core/application/knowledge/gateway";
import {
  callDurableObject,
  type DurableObjectBindings,
  userDataStub,
} from "./doStubs";
import type { UserDataDurableObject } from "./userDataDurableObject";

/** The request Worker's knowledge gateway: one stub call per usecase, envelope unfolded. */
export function createKnowledgeGateway(
  bindings: DurableObjectBindings,
): KnowledgeGateway {
  const userData = (userId: string) =>
    userDataStub(
      bindings.USER_DATA,
      userId,
    ) as unknown as UserDataDurableObject;
  return {
    createTopic(userId, input) {
      return callDurableObject(() => userData(userId).createTopic(input));
    },
    updateTopic(userId, input) {
      return callDurableObject(() => userData(userId).updateTopic(input));
    },
    listTopics(userId, input) {
      return callDurableObject(() => userData(userId).listTopics(input));
    },
    getTopic(userId, topicId) {
      return callDurableObject(() => userData(userId).getTopic(topicId));
    },
    getTopicName(userId, topicId) {
      return callDurableObject(() => userData(userId).getTopicName(topicId));
    },
    trashTopic(userId, topicId) {
      return callDurableObject(() => userData(userId).trashTopic(topicId));
    },
    createDocument(userId, input) {
      return callDurableObject(() => userData(userId).createDocument(input));
    },
    editDocument(userId, input) {
      return callDurableObject(() => userData(userId).editDocument(input));
    },
    rollbackDocument(userId, input) {
      return callDurableObject(() => userData(userId).rollbackDocument(input));
    },
    trashDocument(userId, documentId) {
      return callDurableObject(() =>
        userData(userId).trashDocument(documentId),
      );
    },
    getDocument(userId, documentId) {
      return callDurableObject(() => userData(userId).getDocument(documentId));
    },
    listDocumentRevisions(userId, documentId) {
      return callDurableObject(() =>
        userData(userId).listDocumentRevisions(documentId),
      );
    },
    diffDocumentRevisions(userId, input) {
      return callDurableObject(() =>
        userData(userId).diffDocumentRevisions(input),
      );
    },
    listDocumentSourceMemos(userId, documentId) {
      return callDurableObject(() =>
        userData(userId).listDocumentSourceMemos(documentId),
      );
    },
    listDocumentsReferencingMemo(userId, memoId) {
      return callDurableObject(() =>
        userData(userId).listDocumentsReferencingMemo(memoId),
      );
    },
  };
}
