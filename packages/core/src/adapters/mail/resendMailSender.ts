import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { MailSender } from "@repo/core/application/ports/mailSender";
import {
  PASSWORD_RESET_MAIL_SUBJECT,
  passwordResetMailText,
  passwordResetUrl,
} from "./resetMailContent";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type ResendMailSenderOptions = Readonly<{
  apiKey: string;
  fromAddress: string;
  appUrl: string;
  /** Swappable for the contract test and the unit test; defaults to the global. */
  fetch?: typeof fetch;
}>;

/**
 * Resend adapter (PH-06 △-1): one REST call per mail, with the
 * `providerIdempotencyKey` the Durable Object derived handed over as
 * `Idempotency-Key`, so a redelivered event does not send twice. A
 * non-2xx answer is `SystemError(ExternalApiError)`; the consumer turns
 * it into a queue retry. The response body is never logged: it can echo
 * the recipient.
 */
export function createResendMailSender(
  options: ResendMailSenderOptions,
): MailSender {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async sendPasswordResetMail(to, resetToken, providerIdempotencyKey) {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": providerIdempotencyKey,
          },
          body: JSON.stringify({
            from: options.fromAddress,
            to: [to],
            subject: PASSWORD_RESET_MAIL_SUBJECT,
            text: passwordResetMailText(
              passwordResetUrl(options.appUrl, resetToken),
            ),
          }),
        });
      } catch (cause) {
        throw new SystemError(
          SystemErrorCode.NetworkError,
          "The mail provider could not be reached",
          cause,
        );
      }
      if (!response.ok) {
        throw new SystemError(
          SystemErrorCode.ExternalApiError,
          `The mail provider answered ${response.status}`,
        );
      }
    },
  };
}
