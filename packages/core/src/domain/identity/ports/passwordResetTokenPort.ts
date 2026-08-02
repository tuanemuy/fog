import type { CredentialId } from "../valueObject";

export type ConsumedResetToken = Readonly<{
  userId: string;
  credentialId: CredentialId;
  credentialVersion: number;
  /**
   * A single-use 128-bit random value minted at consumption time. It is the
   * *only* binding a reset-initiated credential change can present, so it is
   * returned to the caller and cleared from the row on success.
   */
  changeAuthToken: string;
}>;

/**
 * Issue / verify / consume for password reset tokens.
 *
 * **Lives on the Identity Directory side**, because the token rows do. That
 * `issue` takes a credential rather than a user is not what decides the
 * placement — the placement is decided by needing to resolve an unauthenticated
 * request that carries nothing but the token.
 *
 * The raw token is never stored: the row keeps a hash derived from `token_id`,
 * so a database leak yields no usable link.
 *
 * Issuing is per credential: a new token **deletes every unused token for that
 * credential in the same transaction**, so older links stop working. Unlinking
 * a credential and changing its password do the same, which is what keeps a
 * live reset link from outliving the credential it points at.
 *
 * Invalid, expired and already-used tokens are not errors — they are `null`.
 */
export interface PasswordResetTokenPort {
  issue(credentialId: CredentialId, now: Date): string;
  verifyAndConsume(
    token: string,
    now: Date,
    operationId: string,
  ): ConsumedResetToken | null;
}
