import type { User } from "@repo/core/domain/identity/entity";

/**
 * Outbound DTO for the settings screen. Primitives only — branded value
 * objects widen to their primitive for free, so projection needs no cast.
 *
 * The field list is a security boundary, not just a convenience: no
 * `passwordHash`, no SSO subject. `authMethod` is here because the UI has
 * to decide whether to offer password change at all, and that is the one
 * fact about the credential the client legitimately needs.
 */
export type CurrentUserView = Readonly<{
  userId: string;
  email: string;
  authMethod: "password" | "sso";
  trashRetentionDays: number;
}>;

export function toCurrentUserView(user: User): CurrentUserView {
  return {
    userId: user.id,
    email: user.email,
    authMethod: user.authMethod,
    trashRetentionDays: user.trashRetentionDays,
  };
}
