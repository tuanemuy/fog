import type { CredentialId, UserId } from "../valueObject";

/** What consuming a token yields: whose credential, and the one-shot bearer of the change it authorises. */
export type ConsumedResetToken = Readonly<{
  userId: UserId;
  credentialId: CredentialId;
  /** `password_reset_tokens.change_auth_token`, minted at consumption; the change that follows must present it. */
  changeAuthToken: string;
}>;

/**
 * Reset tokens live in the Identity Directory bucket (`spec/domains/identity.md`
 * PasswordResetTokenPort). Opaque to the domain; the raw token is derived
 * inside the bucket from `tokenId` and never stored. Synchronous: issued and
 * consumed inside `transactionSync`.
 *
 * `verifyAndConsume` returns more than the spec's `UserId`: the credential
 * and the change-authorisation bearer the following `beginCredentialChange`
 * binds to (superset; `userId` is still there).
 */
export interface PasswordResetTokenPort {
  /** Replaces every unused token of the credential; the raw token has no reader here. */
  issue(
    credentialId: CredentialId,
    now: Date,
  ): { token: string; tokenId: string };
  /** A `tokenId` no row answers to, from the same generator as `issue` (the not-sending side's payload). */
  mintDecoyTokenId(): string;
  /** Invalid, expired and used are all `null`. */
  verifyAndConsume(token: string, now: Date): ConsumedResetToken | null;
}
