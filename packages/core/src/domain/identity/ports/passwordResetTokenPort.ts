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
 * Everything a token row is written from — derived by the caller, never here.
 *
 * All three are plain strings and numbers so they survive the RPC hop and so
 * this port stays synchronous; see the port's own note for why the derivation
 * cannot live inside the transaction.
 */
export type ResetTokenIssueMaterial = Readonly<{
  /** Row identity, and the pre-image the send job re-derives the link from. */
  tokenId: string;
  /** `SHA-256` of the link's secret half. The only value `verifyAndConsume` matches. */
  tokenHash: string;
  /** Which reset-token key generation signed the link. */
  tokenKeyGeneration: number;
}>;

/**
 * Issue / verify / consume for password reset tokens.
 *
 * **Lives on the Identity Directory side**, because the token rows do. That
 * `issue` takes a credential rather than a user is not what decides the
 * placement — the placement is decided by needing to resolve an unauthenticated
 * request that carries nothing but the token.
 *
 * ## Neither method derives anything, and that is the contract
 *
 * Both take a value that has **already been hashed** by the caller. The port is
 * synchronous because it sits on a unit-of-work context, WebCrypto is not, so
 * hashing happens one level out in the Durable Object's RPC entry point — the
 * same shape `reserveCredential` uses for the sealed canonical (ADR-036 /
 * ADR-042). `adapters/cloudflare/identityDirectory/resetTokenCrypto.ts` is the
 * single place the derivation chain is written, and issuing, sending and
 * verifying all read it, so the three cannot drift into disagreement again.
 *
 * ## What the row guarantees, precisely
 *
 * The row holds `token_id` and `SHA-256(secret)`, where `secret =
 * HMAC(IDENTITY_RESET_TOKEN_KEY[generation], token_id)` is the bearer half of
 * the mailed link. A database leak therefore yields no usable link: deriving
 * `secret` from `token_id` needs the keyring, which is a state-Worker secret
 * and is not in the database, and deriving it from the hash needs a SHA-256
 * pre-image. **`token_id` is an identifier and is never accepted as proof** —
 * submitting it matches no row, because rows are keyed by the hash of the
 * derived secret.
 *
 * Issuing is per credential: a new token **deletes every unused token for that
 * credential in the same transaction**, so older links stop working. Unlinking
 * a credential and changing its password do the same, which is what keeps a
 * live reset link from outliving the credential it points at.
 *
 * Invalid, expired and already-used tokens are not errors — they are `null`.
 */
export interface PasswordResetTokenPort {
  issue(
    credentialId: CredentialId,
    material: ResetTokenIssueMaterial,
    now: Date,
  ): void;
  /**
   * `tokenHash` is `SHA-256` of the secret parsed out of the link the user
   * followed — not the link, and not `token_id`. #12 owns the consumption
   * entry point and computes it there, asynchronously, before opening its unit
   * of work.
   */
  verifyAndConsume(
    tokenHash: string,
    now: Date,
    operationId: string,
  ): ConsumedResetToken | null;
}
