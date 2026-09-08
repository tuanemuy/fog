import type { CredentialId } from "../valueObject";

export type CredentialLocator = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** Opaque routing material to the Identity Directory row; the adapter alone reads into it. */
  mapping: string;
  credentialVersion: number;
  usableForLogin: boolean;
  label: string;
}>;

/**
 * Reverse index of the credentials this account holds — the authority for the
 * login reachability check and the only way back to the Identity Directory
 * rows on unlink and withdrawal. Holds neither the address nor a verifier.
 *
 * Every write acts on all rows of a `credentialId` at once; matching looks at
 * `credentialId` only, never at the mapping generation.
 */
export interface CredentialLocatorStore {
  list(): readonly CredentialLocator[];
  /** The newest-generation row for that credential, or `null`. */
  findByCredentialId(credentialId: CredentialId): CredentialLocator | null;
  /** Every generation's row of the credential, newest first — the material an unlink stashes before deleting. */
  listByCredentialId(credentialId: CredentialId): readonly CredentialLocator[];
  /**
   * Upsert. `credentialVersion` is written as the maximum of the argument and
   * the existing maximum over every row of that `credentialId`, on inserts as
   * well, so generations never diverge. Never a no-op when a row exists.
   */
  record(locator: CredentialLocator): void;
  /** Not idempotent: never re-issued on a saga resume. Returns the value after the increment. */
  advanceCredentialVersion(credentialId: CredentialId): number;
  deleteByCredentialId(credentialId: CredentialId): void;
}
