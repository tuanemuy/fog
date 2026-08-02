import type { Email } from "@repo/core/domain/identity/valueObject";

/**
 * Outbound mail. One of exactly **two** asynchronous ports in the codebase
 * (the other is `PasswordHasher`), and that pair is an enumeration, not a
 * derived rule: they are asynchronous because the only APIs that can implement
 * them are, not because of where they run.
 *
 * Consequently a `MailSender` must never be placed on a `UnitOfWorkContext` —
 * the callback there is fully synchronous. It reaches its caller through the
 * **job** context instead, where the handler runs outside the transaction.
 *
 * Building the reset link URL is the adapter's job, not the usecase's.
 */
export interface MailSender {
  /**
   * `providerIdempotencyKey` is derived from the job's `operationKey`, so it is
   * the *same* value on every redelivery of the same row. Deriving one from the
   * message inside the adapter would mint a fresh key per retry and defeat the
   * collapse it exists for; that is why it is a parameter rather than a detail
   * of the implementation.
   */
  sendPasswordResetMail(
    to: Email,
    resetToken: string,
    providerIdempotencyKey: string,
  ): Promise<void>;
}
