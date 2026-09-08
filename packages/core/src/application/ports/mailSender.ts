/**
 * Mail delivery (`spec/domains/identity.md` MailSender). Called only by the
 * mail consumer in the request Worker's `queue()` handler, never by a
 * usecase. The adapter builds the URL and renders the body; the base URL
 * comes from configuration alone, never from a request. Asynchronous by
 * exception: every mail API is.
 */
export interface MailSender {
  sendPasswordResetMail(
    to: string,
    resetToken: string,
    providerIdempotencyKey: string,
  ): Promise<void>;
}
