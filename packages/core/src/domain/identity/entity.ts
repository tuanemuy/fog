import { Version } from "@repo/core/domain/common/version";
import { BusinessRuleError, RehydrationError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";
import { CredentialId, TrashRetentionDays, UserId } from "./valueObject";

/**
 * Non-PII summary of one held credential.
 *
 * Neither the original address nor the SSO subject is here: those live on the
 * Identity Directory side. What the settings screen may render as an identity
 * is `credentialId` / `kind` / `label`; `usableForLogin` is a capability flag,
 * not an identifier.
 */
export type CredentialRef = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** Provider name for `kind: "sso"`, the empty string for `kind: "email"`. */
  label: string;
  /**
   * Whether this credential alone is a way in. Always true for `kind: "sso"`;
   * true for `kind: "email"` only while the mapping holds a password verifier.
   * The authority is the Identity Directory — this field mirrors its verdict.
   */
  usableForLogin: boolean;
}>;

/**
 * The account, as the user's own Durable Object holds it.
 *
 * **Not a discriminated union over auth method.** One account can hold an
 * email credential and an SSO credential at the same time, so the ways in are
 * a set. Consequently `email` / `passwordHash` / `provider` / `providerSubject`
 * are absent: the original address and the verification material belong to the
 * Identity Directory, and this side keeps only the non-PII summary.
 */
export type User = Readonly<{
  id: UserId;
  credentials: readonly CredentialRef[];
  trashRetentionDays: TrashRetentionDays;
  version: Version;
  createdAt: Date;
  updatedAt: Date;
}>;

/**
 * The number of ways in.
 *
 * Distinct `credentialId`s among the entries that are usable for login — not
 * the entry count. Counting entries would let an account reach zero ways in
 * (the same credential can be represented more than once during a key
 * rotation), and ignoring `usableForLogin` would count an SSO-only account's
 * email entry, which exists purely to reserve the address.
 */
function loginCredentialCount(user: User): number {
  const ids = new Set<string>();
  for (const credential of user.credentials) {
    if (credential.usableForLogin) ids.add(credential.credentialId);
  }
  return ids.size;
}

function initialize(
  params: { id: string; credentials: readonly CredentialRef[] },
  now: Date,
): User {
  return {
    id: UserId.create(params.id),
    credentials: params.credentials,
    trashRetentionDays: TrashRetentionDays.default(),
    version: Version.initial(),
    createdAt: now,
    updatedAt: now,
  };
}

/** Adds a credential, replacing any entry with the same `credentialId`. */
function addCredential(user: User, credential: CredentialRef, now: Date): User {
  const kept = user.credentials.filter(
    (existing) => existing.credentialId !== credential.credentialId,
  );
  return {
    ...user,
    credentials: [...kept, credential],
    version: Version.next(user.version),
    updatedAt: now,
  };
}

/**
 * Removes a credential.
 *
 * Refuses when it is the last way in. The check runs on the *resulting* set
 * rather than on the current one, so removing a credential that was never
 * usable for login (an SSO-only account's email entry) stays allowed.
 */
function removeCredential(
  user: User,
  credentialId: CredentialId,
  now: Date,
): User {
  const credentials = user.credentials.filter(
    (existing) => existing.credentialId !== credentialId,
  );
  if (credentials.length === user.credentials.length) {
    return user;
  }
  if (loginCredentialCount({ ...user, credentials }) === 0) {
    throw new BusinessRuleError(
      IdentityErrorCode.LastLoginCredential,
      "Cannot remove the last credential that can be used to sign in",
    );
  }
  return {
    ...user,
    credentials,
    version: Version.next(user.version),
    updatedAt: now,
  };
}

function changeTrashRetentionDays(
  user: User,
  retentionDays: TrashRetentionDays,
  now: Date,
): User {
  // Re-submitting the current value is not an error (the spec's test cases
  // require it to succeed), but it is not a change either: bumping the
  // version would make a settings screen that re-posts its form fight
  // concurrent writers over OCC. The caller detects the no-op by identity
  // (`next === user`) before deciding whether to `save`.
  if (retentionDays === user.trashRetentionDays) {
    return user;
  }
  return {
    ...user,
    trashRetentionDays: retentionDays,
    version: Version.next(user.version),
    updatedAt: now,
  };
}

// Loose-typed because adapters feed untrusted persistence rows; each field
// is re-validated through its value object inside `reconstruct`.
type ReconstructInput = Readonly<{
  id: string;
  credentials: readonly {
    credentialId: string;
    kind: string;
    label: string;
    usableForLogin: boolean;
  }[];
  trashRetentionDays: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

function reconstructCredential(input: {
  credentialId: string;
  kind: string;
  label: string;
  usableForLogin: boolean;
}): CredentialRef {
  if (input.kind !== "email" && input.kind !== "sso") {
    throw new Error(`Unknown credential kind: ${input.kind}`);
  }
  return {
    credentialId: CredentialId.create(input.credentialId),
    kind: input.kind,
    label: input.label,
    usableForLogin: input.usableForLogin,
  };
}

export const User = {
  /**
   * First persistence of an account. The credential set is supplied by the
   * caller because which credentials exist is decided on the Identity
   * Directory side — password signup contributes one `kind: "email"` entry,
   * SSO signup contributes an `sso` entry plus the email entry that reserves
   * the address.
   */
  initialize,

  addCredential,

  removeCredential,

  changeTrashRetentionDays,

  loginCredentialCount,

  // Value objects throw `BusinessRuleError` to mean "fresh input is
  // invalid". The same failure on a stored row means something else —
  // persisted data has drifted from the schema — so wrap everything here
  // in `RehydrationError`, which adapters translate to
  // `SystemError(DataIntegrityError)`.
  reconstruct: (input: ReconstructInput): User => {
    try {
      return {
        id: UserId.create(input.id),
        credentials: input.credentials.map(reconstructCredential),
        trashRetentionDays: TrashRetentionDays.create(input.trashRetentionDays),
        version: Version.create(input.version),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
    } catch (error) {
      throw new RehydrationError(
        `Failed to rehydrate User (id=${input.id})`,
        error,
      );
    }
  },
};
