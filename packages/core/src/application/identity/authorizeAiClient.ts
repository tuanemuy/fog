import { AiClientConnectionId } from "@repo/core/domain/identity/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Needs, ServiceArgs } from "../types";

export type AuthorizeAiClientInput = Readonly<{
  userId: string;
  connectionId: string;
}>;

/** What the authorization middleware needs beyond the token: the name the revision will carry. */
export type AuthorizedAiClient = Readonly<{ clientName: string }>;

/**
 * The per-call guard of the AI API (PH-07 △-4): the connection is read by
 * `findActiveById` on every request — revoked or unknown is `null`, which
 * the transport turns into 401 — and its usage is recorded best-effort in
 * the same round trip. Not a usecase in the spec's sense; the presentation
 * entry that keeps the guard on the application side of the boundary.
 */
export async function authorizeAiClient({
  container,
  input,
}: ServiceArgs<
  AuthorizeAiClientInput,
  Needs<"identityGateway">
>): Promise<AuthorizedAiClient | null> {
  return container.identityGateway.authorizeAiClient(
    input.userId,
    input.connectionId,
  );
}

/** The read half, inside the unit of work; `recordUsage` follows outside it (the facade). */
export function findActiveAiClientProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawConnectionId: string,
): AuthorizedAiClient | null {
  // An account on its way out (or gone) mints and exchanges nothing, even
  // while its connections are still `active` ahead of `finalize-withdrawal`.
  const account = ctx.accountStore.find();
  if (account === null || account.status !== "active") return null;
  const found = ctx.aiClientConnectionRepository.findActiveById(
    AiClientConnectionId.create(rawConnectionId),
  );
  return found === null ? null : { clientName: found.entity.clientName };
}
