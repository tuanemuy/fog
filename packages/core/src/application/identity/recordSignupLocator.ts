import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { RecordSignupLocatorDto } from "./gateway";
import { toCredentialLocator } from "./rebuild";

/**
 * Registration saga phase 4: the reverse-index row and the procedure's
 * completion, in one transaction. Splitting them would leave "can log in but
 * the procedure is unfinished" as a stable state that a later cleanup could
 * abandon (`spec/recovery/index.md`, S2).
 */
export function recordSignupLocatorProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: RecordSignupLocatorDto,
): void {
  ctx.credentialLocatorStore.record(toCredentialLocator(input.locator));
  ctx.updateOperation({ operationId: input.operationId, phase: "done" });
}
