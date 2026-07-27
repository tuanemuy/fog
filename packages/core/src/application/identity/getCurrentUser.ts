import { UserId } from "@repo/core/domain/identity/valueObject";
import { NotFoundError } from "../errors";
import type { ServiceArgs } from "../types";
import type { CurrentUserView } from "./view";

export type GetCurrentUserInput = {
  userId: string;
};

export type GetCurrentUserOutput = CurrentUserView;

/**
 * Reads the signed-in user for the settings screen.
 *
 * `userId` comes from the verified session, never from the request body,
 * so a miss means the account was deleted while a session outlived it —
 * hence `NotFoundError` rather than an authorization failure.
 */
export async function getCurrentUser({
  container,
  input,
}: ServiceArgs<GetCurrentUserInput>): Promise<GetCurrentUserOutput> {
  const userId = UserId.create(input.userId);

  if (!container.identity)
    throw new Error("Identity gateway is not configured");
  const account = await container.identity.getCurrentAccount(userId);
  if (!account) {
    throw new NotFoundError("USER_NOT_FOUND", `User not found: ${userId}`);
  }

  return {
    userId: account.auth.userId,
    email: account.auth.primaryEmail ?? "",
    authMethods: account.auth.authMethods,
    displayName: account.profile.displayName,
    trashRetentionDays: account.profile.trashRetentionDays,
  };
}
