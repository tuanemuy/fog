import type { UserId } from "@repo/core/domain/identity/valueObject";
import type { AuthenticatedUserDataRouter } from "./contracts";

/**
 * Derives the only User Data object an authenticated account may address.
 * The object name is never accepted from a request or operator payload.
 */
export const CanonicalAuthenticatedUserDataRouter: AuthenticatedUserDataRouter =
  {
    forAuthenticatedUser(userId: UserId) {
      return { userId, objectName: userId };
    },
  };
