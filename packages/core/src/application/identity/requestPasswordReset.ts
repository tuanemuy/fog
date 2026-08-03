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
 *
 * ## Every generation, not just the active one
 *
 * `forCanonical` yields the active generation first and the previous one while
 * the keyring still carries it, and `loginWithPassword` walks both. Asking only
 * the active bucket leaves a user whose mapping a rotation has not remapped yet
 * able to sign in but unable to reset — the request reaches an empty bucket,
 * the send finds no mapping and settles `done`, and the uniform answer means
 * neither the user nor an operator can see it. Recovery quietly disappearing
 * for the length of a rotation is a security problem, not merely an
 * availability one.
 *
 * The request goes to **every** locator rather than to the first one holding a
 * row: each bucket writes exactly one job row whatever it finds, so an
 * unconditional fan-out keeps the request count independent of where — or
 * whether — the mapping exists. Probing first would reintroduce the very
 * distinction the uniform path removes.
 *
 * **Known overlap.** While a rotation has the same credential mapped in two
 * generations at once, both buckets find a row, both judge themselves eligible
 * and both issue — so one request produces two mails carrying two independently
 * live links. Issuing deletes the credential's earlier unused tokens, but that
 * delete is scoped to the bucket it runs in and cannot reach across
 * generations, and consuming one link leaves the other redeemable until its TTL
 * expires. Narrowing the fan-out is not the answer (it is what restores the
 * oracle); folding the overlap belongs to the transfer procedure. There is no
 * transfer procedure today, so the state is unreachable here.
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

  for (const locator of await container.directoryLocator.forCanonical(email)) {
    unwrap(
      await container
        .directoryStubFactory(locator)
        .requestPasswordReset("email", locator.hmac),
    );
  }
}
