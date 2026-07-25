import { UserId } from "@repo/core/domain/identity/valueObject";
import { NotFoundError } from "../errors";
import type { ServiceArgs } from "../types";
import { type CurrentUserView, toCurrentUserView } from "./view";

export type GetCurrentUserInput = {
  userId: string;
};

export type GetCurrentUserOutput = {
  user: CurrentUserView;
};

/**
 * Reads the signed-in user for the settings screen (UC-identity-013).
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

  const found = await container.unitOfWorkProvider.run(({ userRepository }) =>
    userRepository.findById(userId),
  );
  if (!found) {
    throw new NotFoundError("USER_NOT_FOUND", `User not found: ${userId}`);
  }

  return { user: toCurrentUserView(found.entity) };
}
