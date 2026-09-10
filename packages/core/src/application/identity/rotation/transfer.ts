import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";

/**
 * A `credential_mappings` row as it crosses the bucket boundary during a
 * mapping-key transfer — every column, primitives only, the three
 * ciphertext columns verbatim (`spec/rotation/index.md`, premise 5). The
 * transfer moves rows, it does not re-encrypt them.
 */
export type MappingRowDto = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  hmac: string;
  generation: number;
  userId: string | null;
  status: "reserved" | "active";
  passwordVerifier: string | null;
  pendingVerifier: string | null;
  changeState: "pending" | "advanced" | null;
  changeOrigin: "password-change" | "reset" | null;
  credentialVersion: number;
  encryptedCanonical: string;
  encryptionGeneration: number;
  encryptionNonce: string;
  failedAttempts: number;
  nextAttemptAllowedAt: number | null;
  operationId: string | null;
  candidateUserId: string | null;
  reservedUntil: number;
  sagaCommitted: number | null;
  locators: string | null;
  coordinatorLocator: string | null;
  callerToken: string;
  createdAt: number;
  updatedAt: number;
}>;

/**
 * The authentication-state columns s4 re-reads before issuing the import:
 * a row whose value changed since the s1 snapshot is passed over rather
 * than copied, so a credential change that landed in between is never
 * fixed as a copy of its *previous* state (`spec/rotation/index.md`, s4).
 */
export type AuthenticationState = Readonly<{
  status: "reserved" | "active";
  changeState: "pending" | "advanced" | null;
  credentialVersion: number;
  passwordVerifier: string | null;
}>;

export function authenticationStateUnchanged(
  snapshot: AuthenticationState,
  reread: AuthenticationState | null,
): boolean {
  return (
    reread !== null &&
    reread.status === snapshot.status &&
    reread.changeState === snapshot.changeState &&
    reread.credentialVersion === snapshot.credentialVersion &&
    reread.passwordVerifier === snapshot.passwordVerifier
  );
}

/**
 * The five branches of the canonical-row judgement at s4, and that is all
 * of them (`spec/rotation/index.md`, 正本判定): (a) no row at the
 * destination, (b) the destination is newer, (c) the source is newer,
 * (d) equal — an idempotent re-run, (e) another account's row. "Write
 * nothing if a row exists" is not one of them: it is the path by which
 * an old verifier comes back after a reset completes in the old bucket.
 */
export type CanonicalVerdict = "a" | "b" | "c" | "d" | "e";

export function judgeCanonicalRow(
  existing: Readonly<{
    userId: string | null;
    credentialVersion: number;
  }> | null,
  incoming: Readonly<{ userId: string | null; credentialVersion: number }>,
): CanonicalVerdict {
  if (existing === null) return "a";
  if (existing.userId !== incoming.userId) return "e";
  if (existing.credentialVersion > incoming.credentialVersion) return "b";
  if (existing.credentialVersion < incoming.credentialVersion) return "c";
  return "d";
}

/** Per-row answer of `import-remapped-mappings`: a verdict, or `rejected` for a row that failed the self-check or the encryption-generation guard. */
export type ImportOutcome = CanonicalVerdict | "rejected";

/** The answer of one `remap-chunk` — counts and a cursor, never a row. */
export type RemapChunkResult = Readonly<{
  /** Rows whose source row was deleted at s5 in this chunk. */
  processed: number;
  /** Rows scanned and left in place: s1 / s3 / s4 pass-overs, rejected imports and RPC failures. */
  skipped: number;
  /** Rows of every status still in the source bucket after the chunk — the `previousCount` it recorded. */
  remaining: number;
  /** Rows the destination refused with verdict (e) in this chunk. */
  conflicts: number;
  /** The last `credentialId` scanned, to hand back as the next call's `afterCredentialId`; `null` once the scan reached the end. */
  lastCredentialId: string | null;
}>;
