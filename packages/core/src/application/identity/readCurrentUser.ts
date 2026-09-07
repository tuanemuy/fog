import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { CurrentUserDto } from "./gateway";
import { fromCredentialLocator } from "./rebuild";

/** The User Data DO half of `getCurrentUser`: settings summary plus the reverse index. */
export function readCurrentUserProcedure(
  ctx: UserDataUnitOfWorkContext,
): CurrentUserDto | null {
  const found = ctx.userSettingsRepository.find();
  if (found === null) return null;
  const { entity } = found;
  return {
    userId: entity.id,
    trashRetentionDays: entity.trashRetentionDays,
    credentials: entity.credentials.map((c) => ({
      credentialId: c.credentialId,
      kind: c.kind,
      label: c.label,
      usableForLogin: c.usableForLogin,
    })),
    locators: ctx.credentialLocatorStore.list().map(fromCredentialLocator),
  };
}
