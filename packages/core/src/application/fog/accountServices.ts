import { BusinessRuleError } from "@repo/core/domain/error";
import { NotFoundError } from "../errors";
import type { AccountDependencies } from "./accountSupport";
import type { AccountServices } from "./accountTypes";
import { requireHuman } from "./contentSupport";
import { createGoogleServices } from "./googleServices";
import { createRecoveryServices } from "./recoveryServices";

export function createAccountServices(
  deps: AccountDependencies,
): AccountServices {
  const { unitOfWork, clock } = deps;
  return {
    ...createGoogleServices(deps),
    ...createRecoveryServices(deps),
    async credentials(actor) {
      requireHuman(actor);
      return unitOfWork.run(async ({ auth, account }) => {
        const hasPassword =
          (await auth.passwordCredential(actor.userId)) !== null;
        const credentials = await account.googleCredentials(actor.userId);
        const removable = hasPassword || credentials.length > 1;
        return {
          hasPassword,
          google: credentials.map(({ id, email }) => ({
            id,
            label: "Google",
            email,
            removable,
          })),
        };
      });
    },
    async unlinkGoogleCredential(actor, input) {
      requireHuman(actor);
      await unitOfWork.run(async ({ auth, account }) => {
        const credentials = await account.googleCredentials(actor.userId);
        if (!credentials.some((credential) => credential.id === input.id))
          throw new NotFoundError(
            "GOOGLE_CREDENTIAL_NOT_FOUND",
            "連携が見つかりません。",
          );
        if (
          credentials.length <= 1 &&
          !(await auth.passwordCredential(actor.userId))
        )
          throw new BusinessRuleError(
            "LAST_LOGIN_METHOD",
            "最後のログイン手段は解除できません。",
          );
        await account.deleteGoogleCredential(actor.userId, input.id);
      });
    },
    async revokeAllAiConnections(actor) {
      requireHuman(actor);
      await unitOfWork.run(async ({ account }) => {
        await account.revokeAllAi(actor.userId, clock.now().toISOString());
      });
    },
  };
}
