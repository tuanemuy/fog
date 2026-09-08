import type { AiClientConnection } from "@repo/core/domain/identity/entity";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { AiClientConnectionView } from "./view";

export type ListAiClientConnectionsInput = Readonly<{ userId: string }>;
export type ListAiClientConnectionsOutput = Readonly<{
  connections: readonly AiClientConnectionView[];
}>;

/** S-AC-06: every connection as a fact, revoked ones included; the screens choose. */
export async function listAiClientConnections({
  container,
  input,
}: ServiceArgs<ListAiClientConnectionsInput>): Promise<ListAiClientConnectionsOutput> {
  return container.identityGateway.listAiClientConnections(input.userId);
}

export function toAiClientConnectionView(
  connection: AiClientConnection,
): AiClientConnectionView {
  return {
    connectionId: connection.id,
    clientName: connection.clientName,
    status: connection.status,
    connectedAt: connection.connectedAt,
    lastUsedAt: connection.lastUsedAt,
    revokedAt: connection.status === "revoked" ? connection.revokedAt : null,
  };
}

export function listAiClientConnectionsProcedure(
  ctx: UserDataUnitOfWorkContext,
): ListAiClientConnectionsOutput {
  return {
    connections: ctx.aiClientConnectionRepository
      .listByUserId()
      .map(toAiClientConnectionView),
  };
}
