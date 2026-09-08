import type { ExportGateway } from "@repo/core/application/export/gateway";
import {
  callDurableObject,
  type DurableObjectBindings,
  userDataStub,
} from "./doStubs";
import type { UserDataDurableObject } from "./userDataDurableObject";

/** The request Worker's export gateway: one stub call, envelope unfolded. */
export function createExportGateway(
  bindings: DurableObjectBindings,
): ExportGateway {
  return {
    readExportSource(userId) {
      const userData = userDataStub(
        bindings.USER_DATA,
        userId,
      ) as unknown as UserDataDurableObject;
      return callDurableObject(() => userData.readExportSource());
    },
  };
}
