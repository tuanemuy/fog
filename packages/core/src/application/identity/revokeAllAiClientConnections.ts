import { AiClientConnection } from "@repo/core/domain/identity/entity";
import type { AiClientConnectionId } from "@repo/core/domain/identity/valueObject";
import { isConflictError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Logger } from "../ports/logger";
import type { ServiceArgs } from "../types";

export type RevokeAllAiClientConnectionsInput = Readonly<{ userId: string }>;
export type RevokeAllAiClientConnectionsOutput = Readonly<{
  revokedCount: number;
  failedCount: number;
}>;

/**
 * P-03's mandatory action (and nowhere else's): every active connection,
 * whatever its reset version, is revoked one transaction at a time; a
 * conflict is counted and skipped, and the rest go on (`emptyTrash`'s
 * shape). A re-run finishes what was left.
 */
export async function revokeAllAiClientConnections({
  container,
  input,
}: ServiceArgs<RevokeAllAiClientConnectionsInput>): Promise<RevokeAllAiClientConnectionsOutput> {
  return container.identityGateway.revokeAllAiClientConnections(input.userId);
}

/** One connection, one transaction. `true` when it was revoked here. */
export function revokeOneAiClientConnectionProcedure(
  ctx: UserDataUnitOfWorkContext,
  id: AiClientConnectionId,
  now: Date,
): boolean {
  const found = ctx.aiClientConnectionRepository.findById(id);
  if (found === null || found.entity.status !== "active") return false;
  ctx.aiClientConnectionRepository.save(
    AiClientConnection.revoke(found.entity, now),
    found.expectedVersion,
  );
  return true;
}

/**
 * The facade's loop: `run` per connection, never nested. Each `run` is
 * given by the caller so the DO's own unit-of-work entry (gate + re-arm)
 * stays the only one.
 */
export async function revokeAllAiClientConnectionsSteps(
  run: (fn: (ctx: UserDataUnitOfWorkContext) => boolean) => Promise<boolean>,
  ids: readonly AiClientConnectionId[],
  now: Date,
  logger: Logger,
): Promise<RevokeAllAiClientConnectionsOutput> {
  let revokedCount = 0;
  let failedCount = 0;
  for (const id of ids) {
    try {
      if (
        await run((ctx) => revokeOneAiClientConnectionProcedure(ctx, id, now))
      ) {
        revokedCount += 1;
      }
    } catch (error) {
      if (!isConflictError(error)) throw error;
      failedCount += 1;
      logger.warn(
        "revokeAllAiClientConnections: connection left for a re-run",
        {
          connectionId: id,
        },
      );
    }
  }
  return { revokedCount, failedCount };
}
