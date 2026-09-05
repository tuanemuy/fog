import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { ResetMailer } from "./accountPorts";
import type { FogUnitOfWorkProvider } from "./ports";

/** Delivers the durable reset queue at least once; the message ID stays stable across retries. */
export async function dispatchResetEmails({
  unitOfWork,
  clock,
  ids,
  mailer,
  limit = 20,
}: {
  unitOfWork: FogUnitOfWorkProvider;
  clock: Clock;
  ids: IdGenerator;
  mailer?: ResetMailer;
  limit?: number;
}): Promise<{ sentCount: number; failedCount: number }> {
  let sentCount = 0;
  let failedCount = 0;
  await unitOfWork.run(({ account }) =>
    account.deleteExpiredResetMail(clock.now().toISOString()),
  );
  if (!mailer) return { sentCount, failedCount };
  for (let index = 0; index < Math.max(1, Math.min(100, limit)); index++) {
    const now = clock.now();
    const mail = await unitOfWork.run(({ account }) =>
      account.claimResetMail({
        now: now.toISOString(),
        leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
        leaseToken: ids.next(),
      }),
    );
    if (!mail) break;
    try {
      await mailer.sendPasswordReset({
        id: mail.id,
        to: mail.to,
        resetUrl: mail.resetUrl,
        expiresAt: mail.expiresAt,
      });
      await unitOfWork.run(({ account }) =>
        account.deliveredResetMail(mail.id, mail.leaseToken),
      );
      sentCount++;
    } catch {
      const delay = Math.min(
        3_600_000,
        30_000 * 2 ** Math.min(mail.attempts - 1, 7),
      );
      await unitOfWork.run(({ account }) =>
        account.retryResetMail({
          id: mail.id,
          leaseToken: mail.leaseToken,
          availableAt: new Date(clock.now().getTime() + delay).toISOString(),
        }),
      );
      failedCount++;
    }
  }
  return { sentCount, failedCount };
}
