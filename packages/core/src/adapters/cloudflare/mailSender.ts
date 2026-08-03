import type { Fetcher } from "@cloudflare/workers-types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { Logger } from "@repo/core/application/ports/logger";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import type { Email } from "@repo/core/domain/identity/valueObject";

/**
 * The two `MailSender` implementations.
 *
 * No mail provider has been chosen yet, so the binding-backed adapter stays
 * deliberately thin: it POSTs to whatever Worker is bound as
 * `MAIL_SENDER` and lets that Worker own the provider. Building the reset link
 * is the adapter's job, per `spec/domains/identity.md`.
 */

/** Assembling the reset URL belongs here, not to the usecase. */
function resetUrl(appUrl: string, resetToken: string): string {
  const url = new URL("/reset-password", appUrl);
  url.searchParams.set("token", resetToken);
  return url.toString();
}

export function createBindingMailSender(
  fetcher: Fetcher,
  appUrl: string,
  logger: Logger,
): MailSender {
  return {
    async sendPasswordResetMail(
      to: Email,
      resetToken: string,
      providerIdempotencyKey: string,
    ): Promise<void> {
      // Job execution is at-least-once, so the provider needs a deterministic
      // key to collapse a redelivery onto the same send. It comes from the
      // caller because only the job row knows the `operationKey` it is derived
      // from — hashing the message here would change on every retry.
      const response = await fetcher.fetch("https://mail-sender/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": providerIdempotencyKey,
        },
        body: JSON.stringify({
          to,
          template: "password-reset",
          resetUrl: resetUrl(appUrl, resetToken),
        }),
      });
      if (!response.ok) {
        // The status is safe to log; the body is not — it can echo the address
        // back. The reset request usecase must not let this reach the user
        // either, since a delivery failure would reveal that the address exists.
        logger.error("mail send failed", { status: response.status });
        throw new SystemError(
          SystemErrorCode.ExternalApiError,
          `Mail provider rejected the send (status ${response.status})`,
        );
      }
    },
  };
}

/**
 * Used when `MAIL_SENDER` is unbound — local development and the integration
 * suite. It warns on **every** call rather than once: silently dropping mail in
 * production is the failure this is meant to make impossible to miss.
 */
export function createNoopMailSender(logger: Logger): MailSender {
  return {
    sendPasswordResetMail(): Promise<void> {
      // No address, no token: the point is that a mail was dropped, and
      // naming the recipient would put PII into logs to say so.
      logger.warn("MAIL_SENDER is not bound; password reset mail was dropped");
      return Promise.resolve();
    },
  };
}
