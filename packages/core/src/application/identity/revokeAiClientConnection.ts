import { AiClientConnection } from "@repo/core/domain/identity/entity";
import { AiClientConnectionId } from "@repo/core/domain/identity/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";

export type RevokeAiClientConnectionInput = Readonly<{
  userId: string;
  connectionId: string;
}>;

/**
 * S-AC-06. The `status` column is the authority: the next request of that
 * client reads it and is refused. Irreversible; a revoked one is a no-op.
 */
export async function revokeAiClientConnection({
  container,
  input,
}: ServiceArgs<RevokeAiClientConnectionInput>): Promise<void> {
  await container.identityGateway.revokeAiClientConnection(
    input.userId,
    input.connectionId,
  );
}

export function revokeAiClientConnectionProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawConnectionId: string,
  now: Date,
): void {
  const id = AiClientConnectionId.create(rawConnectionId);
  const found = ctx.aiClientConnectionRepository.findById(id);
  if (found === null) {
    throw new NotFoundError(
      "CONNECTION_NOT_FOUND",
      "The AI client connection was not found",
    );
  }
  if (found.entity.status === "revoked") return;
  ctx.aiClientConnectionRepository.save(
    AiClientConnection.revoke(found.entity, now),
    found.expectedVersion,
  );
}
