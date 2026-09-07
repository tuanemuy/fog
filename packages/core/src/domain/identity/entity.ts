import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";
import { CredentialId, TrashRetentionDays, UserId } from "./valueObject";

/**
 * Non-PII summary of one credential the account holds. The settings screen may
 * show `credentialId` / `kind` / `label`; `usableForLogin` is a capability
 * flag, not an identifier. Neither the address nor the SSO subject appears.
 */
export type CredentialRef = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** Provider name for `sso`, the empty string for `email`. */
  label: string;
  /** `sso` is always true; `email` only while a verifier exists. */
  usableForLogin: boolean;
}>;

/**
 * The account as the User Data DO sees it. No auth-method discriminator: the
 * credential set is what varies. The address and the verifier live on the
 * Identity Directory side and never appear here.
 */
export type User = Readonly<{
  id: UserId;
  credentials: readonly CredentialRef[];
  trashRetentionDays: TrashRetentionDays;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CredentialRefInput = Readonly<{
  credentialId: string;
  kind: "email" | "sso";
  label: string;
  usableForLogin: boolean;
}>;

function toCredentialRef(input: CredentialRefInput): CredentialRef {
  return {
    credentialId: CredentialId.create(input.credentialId),
    kind: input.kind,
    label: input.label,
    usableForLogin: input.usableForLogin,
  };
}

/** Distinct `credentialId`s among the usable elements — the count the invariant uses. */
function loginMethodCount(credentials: readonly CredentialRef[]): number {
  return new Set(
    credentials
      .filter((credential) => credential.usableForLogin)
      .map((credential) => credential.credentialId),
  ).size;
}

function requireLoginMethod(credentials: readonly CredentialRef[]): void {
  if (loginMethodCount(credentials) === 0) {
    throw new BusinessRuleError(
      IdentityErrorCode.LoginMethodRequired,
      "An account needs at least one login method",
    );
  }
}

function build(
  id: string,
  credentials: readonly CredentialRef[],
  now: Date,
): User {
  requireLoginMethod(credentials);
  return {
    id: UserId.create(id),
    credentials,
    trashRetentionDays: TrashRetentionDays.default(),
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export const User = {
  /** Password registration: the first credential is one `email` element. */
  registerWithPassword: (
    params: { id: string; credential: CredentialRefInput },
    now: Date,
  ): User => build(params.id, [toCredentialRef(params.credential)], now),

  /** First SSO sign-in: one `sso` element plus the `email` reservation element. */
  registerWithSso: (
    params: { id: string; credentials: readonly CredentialRefInput[] },
    now: Date,
  ): User => build(params.id, params.credentials.map(toCredentialRef), now),

  /** Replaces the element with the same `credentialId` when one exists. */
  addCredential: (user: User, credential: CredentialRef, now: Date): User => ({
    ...user,
    credentials: [
      ...user.credentials.filter(
        (existing) => existing.credentialId !== credential.credentialId,
      ),
      credential,
    ],
    version: user.version + 1,
    updatedAt: now,
  }),

  /**
   * Only `sso` elements can be removed; there is no unlink path for `email`.
   * Removing the last usable login method is refused.
   */
  removeCredential: (
    user: User,
    credentialId: CredentialId,
    now: Date,
  ): User => {
    const target = user.credentials.find(
      (credential) => credential.credentialId === credentialId,
    );
    if (target !== undefined && target.kind !== "sso") {
      throw new BusinessRuleError(
        IdentityErrorCode.LastCredentialRemoval,
        "An email credential cannot be unlinked",
      );
    }
    const remaining = user.credentials.filter(
      (credential) => credential.credentialId !== credentialId,
    );
    if (loginMethodCount(remaining) === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.LastCredentialRemoval,
        "The last login method cannot be unlinked",
      );
    }
    return {
      ...user,
      credentials: remaining,
      version: user.version + 1,
      updatedAt: now,
    };
  },

  changeTrashRetentionDays: (
    user: User,
    retentionDays: TrashRetentionDays,
    now: Date,
  ): User => ({
    ...user,
    trashRetentionDays: retentionDays,
    version: user.version + 1,
    updatedAt: now,
  }),

  /**
   * Rebuilds a persisted account. Deliberately does not check the login-method
   * invariant: `credentials` is a projection of `CredentialLocatorStore`, and
   * an empty set is the legitimate state between phase 2 and phase 4 of the
   * registration saga (`spec/domains/identity.md`).
   */
  reconstruct: (
    params: Readonly<{
      id: string;
      credentials: readonly CredentialRefInput[];
      trashRetentionDays: number;
      version: number;
      createdAt: Date;
      updatedAt: Date;
    }>,
  ): User => ({
    id: UserId.create(params.id),
    credentials: params.credentials.map(toCredentialRef),
    trashRetentionDays: TrashRetentionDays.create(params.trashRetentionDays),
    version: params.version,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  }),
};
