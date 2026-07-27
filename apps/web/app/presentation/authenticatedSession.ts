import type { RequestContainer } from "@repo/core/application/di/types";
import { UserId } from "@repo/core/domain/identity/valueObject";

export async function resolveAuthenticatedUserId(
  container: RequestContainer,
  token: string | null,
): Promise<string | null> {
  if (token === null) return null;
  const verified = await container.sessionCodec.verify(
    token,
    container.clock.now(),
  );
  if (!verified || !container.identity) return null;
  const authority = await container.identity.getAccountAuthority(
    UserId.create(verified.userId),
  );
  if (
    authority?.status !== "active" ||
    authority.sessionEpoch !== verified.sessionEpoch
  ) {
    return null;
  }
  return authority.userId;
}
