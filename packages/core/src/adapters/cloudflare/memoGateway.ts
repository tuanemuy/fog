import type { MemoGateway } from "@repo/core/application/memo/gateway";
import {
  callDurableObject,
  type DurableObjectBindings,
  userDataStub,
} from "./doStubs";
import type { UserDataDurableObject } from "./userDataDurableObject";

export function createMemoGateway(
  bindings: DurableObjectBindings,
): MemoGateway {
  const userData = (userId: string) =>
    userDataStub(
      bindings.USER_DATA,
      userId,
    ) as unknown as UserDataDurableObject;
  return {
    postMemo(userId, input) {
      return callDurableObject(() => userData(userId).postMemo(input));
    },
    getTimeline(userId, query) {
      return callDurableObject(() => userData(userId).getTimeline(query));
    },
    jumpToDate(userId, input) {
      return callDurableObject(() => userData(userId).jumpToDate(input));
    },
    showMemoInTimeline(userId, input) {
      return callDurableObject(() =>
        userData(userId).showMemoInTimeline(input),
      );
    },
    editMemo(userId, input) {
      return callDurableObject(() => userData(userId).editMemo(input));
    },
    updateMemoByAi(userId, input) {
      return callDurableObject(() => userData(userId).updateMemoByAi(input));
    },
    recentMemos(userId, input) {
      return callDurableObject(() => userData(userId).recentMemos(input));
    },
    getMemo(userId, memoId) {
      return callDurableObject(() => userData(userId).getMemo(memoId));
    },
    listMemoRevisions(userId, memoId) {
      return callDurableObject(() =>
        userData(userId).listMemoRevisions(memoId),
      );
    },
    diffMemoRevisions(userId, input) {
      return callDurableObject(() => userData(userId).diffMemoRevisions(input));
    },
    rollbackMemo(userId, input) {
      return callDurableObject(() => userData(userId).rollbackMemo(input));
    },
    softDeleteMemo(userId, memoId) {
      return callDurableObject(() => userData(userId).softDeleteMemo(memoId));
    },
  };
}
