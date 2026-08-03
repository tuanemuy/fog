import type { CredentialId } from "../valueObject";

export type CredentialMappingKind = "email" | "sso";

export type CredentialMappingStatus = "reserved" | "active";

/** `null` = no change in flight. See `spec/database/index.md`. */
export type CredentialChangeState = "pending" | "advanced" | null;

export type CredentialMapping = Readonly<{
  credentialId: CredentialId;
  userId: string | null;
  candidateUserId: string | null;
  kind: CredentialMappingKind;
  status: CredentialMappingStatus;
  passwordVerifier: string | null;
  credentialVersion: number;
  changeState: CredentialChangeState;
  changeOrigin: "password-change" | "reset" | null;
  failedAttempts: number;
  nextAttemptAllowedAt: number | null;
  lastResetRequestedAt: number | null;
  operationId: string | null;
  callerToken: string | null;
  reservedUntil: number;
  sagaCommitted: boolean;
  generation: number;
  hmac: string;
}>;

/**
 * Reads against the credential → `userId` mapping.
 *
 * ## The domain contract and this signature differ on purpose
 *
 * `spec/domains/identity.md` states the contract as
 * `findByEmail(email: Email)` / `findBySsoIdentity(provider, providerSubject)`.
 * That is **the contract as seen from the request Worker**, and it cannot be
 * implemented inside the Durable Object: mapping rows are keyed by
 * `(kind, full-length hmac)`, and `DIRECTORY_ROUTING_SECRET` — the material the
 * HMAC needs — is distributed to the request Worker only. Handing it to the
 * state Worker as well would break the non-duplicated-distribution rule that
 * keeps the raw address out of the Directory.
 *
 * So the split is: **canonicalisation (`Email.create` / `ssoCanonical`) and
 * HMAC derivation (`directoryLocator.forCanonical`) belong to the request
 * Worker; looking a row up by `(kind, hmac)` belongs to the Durable Object.**
 * The `email` / `sso` distinction survives as the `kind` argument — it is the
 * caller that knows which canonical it built.
 */
export interface CredentialMappingRepository {
  findByLocatorKey(
    kind: CredentialMappingKind,
    hmac: string,
  ): CredentialMapping | null;

  findByCredentialId(credentialId: CredentialId): CredentialMapping | null;

  /**
   * Whether a row exists for that locator key. Used by signup phase 1 to check
   * the previous generation while a rotation is in flight; returns one bit and
   * has no side effect.
   */
  checkPreviousGeneration(kind: CredentialMappingKind, hmac: string): boolean;
}
