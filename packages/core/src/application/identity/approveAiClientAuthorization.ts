import { AiClientConnection } from "@repo/core/domain/identity/entity";
import { UserId } from "@repo/core/domain/identity/valueObject";
import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";

export type ApproveAiClientAuthorizationInput = Readonly<{
  userId: string;
  clientName: string;
}>;

export type ApproveAiClientAuthorizationOutput = Readonly<{
  connectionId: string;
}>;

/**
 * S-AC-05, 「許可する」: the fact of the authorization, and only that. The
 * request's validity, the code and the tokens are the adapter's; a denial
 * never reaches the application (no usecase for it, by the spec's leave).
 */
export async function approveAiClientAuthorization({
  container,
  input,
}: ServiceArgs<ApproveAiClientAuthorizationInput>): Promise<ApproveAiClientAuthorizationOutput> {
  return container.identityGateway.approveAiClientAuthorization(input.userId, {
    clientName: input.clientName,
  });
}

/** Inside the User Data DO: the connection carries the reset version it was born under. */
export function approveAiClientAuthorizationProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: { userId: string; clientName: string },
  id: string,
  now: Date,
): ApproveAiClientAuthorizationOutput {
  const account = ctx.accountStore.find();
  if (account === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account row is missing",
    );
  }
  const connection = AiClientConnection.create(
    {
      id,
      userId: UserId.create(input.userId),
      clientName: input.clientName,
      createdAtResetVersion: account.resetVersion,
    },
    now,
  );
  ctx.aiClientConnectionRepository.insert(connection);
  return { connectionId: connection.id };
}
