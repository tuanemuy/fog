import { User } from "@repo/core/domain/identity/entity";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";

export type InitializeAccountInput = Readonly<{
  userId: string;
  operationId: string;
  callerToken: string;
  credentials: readonly Readonly<{
    credentialId: string;
    kind: "email" | "sso";
    label: string;
    usableForLogin: boolean;
  }>[];
  locators: readonly MappingLocator[];
}>;

/**
 * Registration saga phase 2 (`initialize-account`), inside the User Data DO.
 *
 * Writes the settings row, the caller binding and the `signup` procedure
 * record in one transaction; the DO entry places the schema in that same
 * transaction. The procedure record is the sole authority that "this object
 * was created by this operation", and its digest covers exactly `userId` /
 * `credentialId` / `locators` — never the caller token.
 *
 * Idempotent on re-drive: an already-initialised object only re-asserts the
 * procedure record, which converges on a matching payload and raises
 * `ConflictError` on a different one.
 */
export function initializeAccountProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: InitializeAccountInput,
  now: Date,
): void {
  const credentialIds = input.credentials.map((c) => c.credentialId);
  const record = () =>
    ctx.recordOperation({
      operationId: input.operationId,
      kind: "signup",
      payload: {
        userId: input.userId,
        credentialId:
          credentialIds.length === 1 ? credentialIds[0] : credentialIds,
        locators: input.locators,
      },
      phase: "initialized",
      targetLocators: input.locators,
    });

  if (ctx.accountStore.find() !== null) {
    record();
    return;
  }

  const user =
    input.credentials.length === 1 && input.credentials[0]
      ? User.registerWithPassword(
          { id: input.userId, credential: input.credentials[0] },
          now,
        )
      : User.registerWithSso(
          { id: input.userId, credentials: input.credentials },
          now,
        );
  ctx.userSettingsRepository.insert(user);
  ctx.accountStore.initializeCallerBinding(input.callerToken);
  record();
}
