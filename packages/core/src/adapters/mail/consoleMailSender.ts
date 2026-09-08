import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { MailSender } from "@repo/core/application/ports/mailSender";
import { passwordResetUrl } from "./resetMailContent";

export const MAIL_DEV_SINK_CONSOLE = "console";

/**
 * The development sink: one line on the request Worker's log with the
 * recipient and the reset URL (raw token included). This is the declared
 * exception to the hygiene rule in `spec/async/index.md` — it exists for
 * the browser check of S-AC-07 only, is enabled by `MAIL_DEV_SINK="console"`
 * in `.dev.vars`, and no deployed config carries that variable.
 */
export function createConsoleMailSender(input: {
  appUrl: string;
  sink: string | undefined;
  log?: (line: string) => void;
}): MailSender {
  if (input.sink !== MAIL_DEV_SINK_CONSOLE) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      `MAIL_DEV_SINK must be "${MAIL_DEV_SINK_CONSOLE}" for the console sink`,
    );
  }
  const log = input.log ?? ((line: string) => console.log(line));
  return {
    async sendPasswordResetMail(to, resetToken) {
      log(
        `[dev-mail] to=${to} url=${passwordResetUrl(input.appUrl, resetToken)}`,
      );
    },
  };
}
