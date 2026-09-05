import { emailAddress, passwordValue } from "@repo/core/domain/fog/content";
import { ForbiddenError, UnauthorizedError } from "../errors";
import type { AccountDependencies } from "./accountSupport";
import type { AccountServices } from "./accountTypes";
import { requireHuman } from "./contentSupport";
import { createHumanSession } from "./sessionSupport";

export const RESET_REQUEST_MESSAGE =
  "登録されている場合は、パスワード再設定の案内を送信します。";
const invalidReset = () =>
  new UnauthorizedError(
    "INVALID_RESET_TOKEN",
    "再設定リンクが無効または期限切れです。もう一度再設定を依頼してください。",
  );
export function createRecoveryServices(
  deps: AccountDependencies,
): Pick<
  AccountServices,
  "changePassword" | "requestPasswordReset" | "completePasswordReset"
> {
  const { unitOfWork, crypto, clock, ids } = deps;
  return {
    async changePassword(actor, input) {
      requireHuman(actor);
      const password = passwordValue(input.newPassword);
      const hash = await crypto.hashPassword(password);
      return unitOfWork.run(async (context) => {
        const credential = await context.auth.passwordCredential(actor.userId);
        if (!credential)
          throw new ForbiddenError(
            "PASSWORD_LOGIN_UNAVAILABLE",
            "このアカウントにはパスワードのログイン手段がありません。",
          );
        if (
          !(await crypto.verifyPassword(
            input.currentPassword,
            credential.passwordHash,
          ))
        )
          throw new UnauthorizedError(
            "INVALID_CURRENT_PASSWORD",
            "現在のパスワードが正しくありません。",
          );
        const user = await context.auth.findUser(actor.userId);
        if (!user)
          throw new UnauthorizedError(
            "INVALID_CREDENTIALS",
            "ログインし直してください。",
          );
        await context.account.replacePassword(actor.userId, hash);
        await context.account.deleteSessions(actor.userId);
        await context.account.invalidatePendingAuthorizations(actor.userId);
        await context.account.deleteResetTokens(actor.userId);
        await context.account.deleteResetMail(actor.userId);
        await context.auth.deleteAttempt(
          crypto.digestToken(`login:${user.email}`),
        );
        return createHumanSession(context, user, deps);
      });
    },
    async requestPasswordReset(input) {
      const email = emailAddress(input.email);
      await unitOfWork.run(async (context) => {
        const now = clock.now();
        const key = crypto.digestToken(`reset:${email}`);
        const previous = await context.auth.getAttempt(key);
        const active =
          previous && previous.expiresAt > now.toISOString() ? previous : null;
        await context.auth.saveAttempt({
          key,
          count: Math.min((active?.count ?? 0) + 1, 3),
          expiresAt:
            active?.expiresAt ??
            new Date(now.getTime() + 900_000).toISOString(),
        });
        if ((active?.count ?? 0) >= 3) return;
        const user = await context.auth.findUserByEmail(email);
        if (!user || !(await context.auth.passwordCredential(user.id))) return;
        const token = crypto.newToken();
        const expiresAt = new Date(now.getTime() + 1_800_000).toISOString();
        const url = new URL(
          "/password/reset",
          deps.appUrl ?? "http://localhost:3000",
        );
        url.searchParams.set("token", token);
        await context.account.createResetToken({
          tokenHash: crypto.digestToken(token),
          ownerId: user.id,
          createdAt: now.toISOString(),
          expiresAt,
        });
        await context.account.enqueueResetMail({
          id: ids.next(),
          ownerId: user.id,
          to: user.email,
          resetUrl: url.toString(),
          expiresAt,
          createdAt: now.toISOString(),
        });
      });
      return { message: RESET_REQUEST_MESSAGE };
    },
    async completePasswordReset(input) {
      const password = passwordValue(input.newPassword);
      const hash = await crypto.hashPassword(password);
      return unitOfWork.run(async (context) => {
        const reset = await context.account.findResetToken(
          crypto.digestToken(input.token),
        );
        const now = clock.now().toISOString();
        if (!reset || reset.expiresAt <= now) throw invalidReset();
        const user = await context.auth.findUser(reset.ownerId);
        if (!user || !(await context.auth.passwordCredential(user.id)))
          throw invalidReset();
        const cutoff =
          (await context.account.lastResetAt(user.id)) ?? user.createdAt;
        await context.account.replacePassword(user.id, hash);
        await context.account.deleteSessions(user.id);
        await context.account.invalidatePendingAuthorizations(user.id);
        await context.account.revokeAiSince(user.id, cutoff, now);
        await context.account.saveLastResetAt(user.id, now);
        await context.account.deleteResetTokens(user.id);
        await context.account.deleteResetMail(user.id);
        await context.auth.deleteAttempt(
          crypto.digestToken(`login:${user.email}`),
        );
        return createHumanSession(context, user, deps);
      });
    },
  };
}
