import type { SearchGateway } from "@repo/core/application/search/gateway";
import {
  callDurableObject,
  type DurableObjectBindings,
  userDataStub,
} from "./doStubs";
import type { UserDataDurableObject } from "./userDataDurableObject";

/** The request Worker's search gateway: one stub call, envelope unfolded. */
export function createSearchGateway(
  bindings: DurableObjectBindings,
): SearchGateway {
  return {
    search(userId, input) {
      const stub = userDataStub(
        bindings.USER_DATA,
        userId,
      ) as unknown as UserDataDurableObject;
      return callDurableObject(() => stub.search(input));
    },
  };
}
