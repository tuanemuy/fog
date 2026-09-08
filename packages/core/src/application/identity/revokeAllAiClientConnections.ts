import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";

export type RevokeAllAiClientConnectionsInput = Readonly<{ userId: string }>;
export type RevokeAllAiClientConnectionsOutput = Readonly<{
  revokedCount: number;
}>;

/** P-03's second mandatory action. The listing beside it arrives with the AI slice. */
export async function revokeAllAiClientConnections({
  container,
  input,
}: ServiceArgs<RevokeAllAiClientConnectionsInput>): Promise<RevokeAllAiClientConnectionsOutput> {
  const revokedCount =
    await container.identityGateway.revokeAllAiClientConnections(input.userId);
  return { revokedCount };
}

export function revokeAllAiClientConnectionsProcedure(
  ctx: UserDataUnitOfWorkContext,
): number {
  return ctx.aiClientConnectionRevoker.revokeAll();
}
