import type { CredentialId } from "../valueObject";

export type CredentialLocator = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** Full-length (64 hex) HMAC of the canonical value. */
  hmac: string;
  /** Routing-key generation this locator was derived under. */
  generation: number;
  bucketIndex: number;
  credentialVersion: number;
  usableForLogin: boolean;
  /** Non-PII display name: the provider for `sso`, empty for `email`. */
  label: string;
}>;

/**
 * Reverse lookup of the credentials an account holds.
 *
 * **The authority for login's reachability check**, and the only reverse
 * information available when an unlink or a withdrawal has to delete the
 * Identity Directory rows. It holds neither the original address nor any
 * verification material.
 *
 * Reachability compares `credentialId` alone and never the generation: during
 * a routing-key rotation the same credential legitimately has rows in two
 * generations. For the same reason `record` / `advanceCredentialVersion` /
 * `deleteByCredentialId` all address **every** row of that credential at once
 * — updating one generation would leave a disagreement with the Directory.
 *
 * `record` is an upsert keyed by `(credentialId, generation)` and
 * `credentialVersion` is monotonically non-decreasing per `credentialId`: it
 * writes the larger of the argument and the stored value. **It must never be a
 * no-op when a row already exists** — a skipped record locks the user out at
 * the next reachability check. `usableForLogin` and `label` are overwritten
 * verbatim, because the Directory decides them.
 */
export interface CredentialLocatorStore {
  list(): readonly CredentialLocator[];
  findByCredentialId(credentialId: CredentialId): CredentialLocator | null;
  record(locator: CredentialLocator): void;
  advanceCredentialVersion(credentialId: CredentialId): void;
  /** "Absent is success" — an idempotent delete. */
  deleteByCredentialId(credentialId: CredentialId): void;
}
