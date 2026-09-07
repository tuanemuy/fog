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
  };
}
