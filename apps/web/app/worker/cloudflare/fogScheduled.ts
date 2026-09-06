import type { ResetMailer } from "@repo/core/application/fog/accountPorts";
import type { FogUnitOfWorkProvider } from "@repo/core/application/fog/ports";
import { dispatchResetEmails } from "@repo/core/application/fog/resetEmailDispatcher";
import { purgeExpiredTrash } from "@repo/core/application/fog/trashServices";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";

export const RESET_MAIL_CRON = "* * * * *";
export const RETENTION_CRON = "0 3 * * *";

export async function runFogScheduled(
  cron: string,
  deps: {
    unitOfWork: FogUnitOfWorkProvider;
    clock: Clock;
    ids: IdGenerator;
    logger: Logger;
    mailer?: ResetMailer;
  },
): Promise<void> {
  if (cron === RESET_MAIL_CRON) {
    const result = await dispatchResetEmails({
      unitOfWork: deps.unitOfWork,
      clock: deps.clock,
      ids: deps.ids,
      ...(deps.mailer ? { mailer: deps.mailer } : {}),
    });
    if (result.sentCount || result.failedCount)
      deps.logger.info("[fog.reset-mail] delivery cycle", result);
    return;
  }
  if (cron === RETENTION_CRON) {
    const result = await purgeExpiredTrash({
      unitOfWork: deps.unitOfWork,
      clock: deps.clock,
    });
    if (result.deletedCount)
      deps.logger.info("[fog.retention] expired trash deleted", result);
    return;
  }
  deps.logger.warn("[fog.scheduled] ignored unknown cron", { cron });
}
