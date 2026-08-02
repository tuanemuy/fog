import { Email } from "@repo/core/domain/identity/valueObject";
import { unwrap } from "../rpc/restoreError";
import type { ServiceArgs } from "../types";

export type RequestPasswordResetInput = {
  email: string;
};

/**
 * Asks for a password reset link.
 *
 * Returns nothing, and returns it identically in every case — registered,
 * unregistered, SSO-only, or throttled. The bucket writes a job row every time,
 * arms the same alarm and answers the same way, so none of the four is
 * distinguishable from the others.
 *
 * A malformed address is the one exception: it never reaches storage and
 * reveals only what the caller already typed.
 */
export async function requestPasswordReset({
  container,
  input,
}: ServiceArgs<RequestPasswordResetInput>): Promise<void> {
  let email: Email;
  try {
    email = Email.create(input.email);
  } catch {
    return;
  }

  const locators = await container.directoryLocator.forCanonical(email);
  const locator = locators[0];
  if (locator === undefined) return;

  unwrap(
    await container
      .directoryStubFactory(locator)
      .requestPasswordReset("email", locator.hmac),
  );
}
