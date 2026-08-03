import { Version } from "@repo/core/domain/common/version";
import { RehydrationError } from "@repo/core/domain/error";
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
  /**
   * **A read projection of `CredentialLocatorStore`, never a written field.**
   * `UserSettingsRepository.save` writes `user_settings` alone, so there is no
   * aggregate transition that could change this set; the transitions are
   * `CredentialLocatorStore.record` / `deleteByCredentialId`, driven from the
   * Identity Directory's verdict. That is why no `addCredential` /
   * `removeCredential` exists here — a method that bumped `version` and left
   * the set untouched would make the spec's own procedure a silent no-op.
   */
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
 *
 * This is the **predicate form** of the "at least one way in" invariant. Since
 * the credential set is a projection, the invariant cannot be enforced by a
 * transition on this aggregate: an unlink checks it here and then removes the
 * locator rows.
 */
function loginCredentialCount(user: User): number {
  const ids = new Set<string>();
  for (const credential of user.credentials) {
    if (credential.usableForLogin) ids.add(credential.credentialId);
  }
  return ids.size;
}

function initialize(params: { id: string }, now: Date): User {
  return {
    id: UserId.create(params.id),
    credentials: [],
    trashRetentionDays: TrashRetentionDays.default(),
    version: Version.initial(),
    createdAt: now,
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
   * First persistence of an account. **Takes no credential set**, and the
   * absence is the point: this runs at signup phase 2, when the reservations
   * exist on the Identity Directory side but no `credential_locators` row does
   * yet — phase 4 writes those. Since `credentials` is that table's projection,
   * an empty set here is not a violated invariant but the only truthful value,
   * and a parameter would let a caller assert a set the row does not hold.
   *
   * "At least one credential, at least one of them usable for login" therefore
   * holds over the *account*, from the moment phase 4 completes, and is
   * enforced where the set is written: reservations on the way in, and
   * {@link loginCredentialCount} as the unlink predicate on the way out.
   */
  initialize,

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
