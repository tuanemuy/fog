import type { TrashGateway } from "@repo/core/application/trash/gateway";
import {
  callDurableObject,
  type DurableObjectBindings,
  userDataStub,
} from "./doStubs";
import type { UserDataDurableObject } from "./userDataDurableObject";

/** The request Worker's trash gateway: one stub call per usecase, envelope unfolded. */
export function createTrashGateway(
  bindings: DurableObjectBindings,
): TrashGateway {
  const userData = (userId: string) =>
    userDataStub(
      bindings.USER_DATA,
      userId,
    ) as unknown as UserDataDurableObject;
  return {
    listTrash(userId, input) {
      return callDurableObject(() => userData(userId).listTrash(input));
    },
    restoreMemo(userId, memoId) {
      return callDurableObject(() => userData(userId).restoreMemo(memoId));
    },
    restoreDocument(userId, input) {
      return callDurableObject(() => userData(userId).restoreDocument(input));
    },
    restoreTopic(userId, topicId) {
      return callDurableObject(() => userData(userId).restoreTopic(topicId));
    },
    hardDeleteTrashItem(userId, ref) {
      return callDurableObject(() => userData(userId).hardDeleteTrashItem(ref));
    },
    emptyTrash(userId) {
      return callDurableObject(() => userData(userId).emptyTrash());
    },
  };
}
