import { UserId } from "@repo/core/domain/identity/valueObject";
import { unwrap } from "../rpc/restoreError";
import type { ServiceArgs } from "../types";
import type { CurrentUserView } from "./view";

export type GetCurrentUserInput = {
  userId: string;
  epoch: number;
};

export type GetCurrentUserOutput = CurrentUserView;

/**
 * Reads the signed-in user for the settings screen.
 *
 * `userId` and `epoch` both come from the verified session, never from the
 * request body. The epoch is compared against the account's current one inside
 * the Durable Object — this side's cookie check proves only that the token was
 * signed by us, not that it is still current.
 */
export async function getCurrentUser({
  container,
  input,
}: ServiceArgs<GetCurrentUserInput>): Promise<GetCurrentUserOutput> {
  const userId = UserId.create(input.userId);
  return unwrap(
    await container
      .userDataStubFactory(userId)
      .getCurrentUser(userId, input.epoch),
  );
}
