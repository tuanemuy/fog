import type { WithEventDrafts } from "@repo/core/domain/common/event";
import { Version } from "@repo/core/domain/common/version";
import { BusinessRuleError, RehydrationError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";
import { type IdentityEvent, IdentityEvents } from "./events";
import {
  Email,
  PasswordHash,
  SsoProvider,
  TrashRetentionDays,
  UserId,
} from "./valueObject";

type UserBase = Readonly<{
  id: UserId;
  email: Email;
  trashRetentionDays: TrashRetentionDays;
  version: Version;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PasswordUser = UserBase &
  Readonly<{
    authMethod: "password";
    passwordHash: PasswordHash;
  }>;

export type SsoUser = UserBase &
  Readonly<{
    authMethod: "sso";
    provider: SsoProvider;
    providerSubject: string;
  }>;

export type User = PasswordUser | SsoUser;

function createProviderSubject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new BusinessRuleError(
      IdentityErrorCode.InvalidSsoProviderSubject,
      "SSO provider subject cannot be empty",
    );
  }
  return trimmed;
}

function registerWithPassword(
  params: { id: string; email: string; passwordHash: PasswordHash },
  now: Date,
): WithEventDrafts<PasswordUser, IdentityEvent> {
  const user: PasswordUser = {
    authMethod: "password",
    id: UserId.create(params.id),
    email: Email.create(params.email),
    passwordHash: params.passwordHash,
    trashRetentionDays: TrashRetentionDays.default(),
    version: Version.initial(),
    createdAt: now,
    updatedAt: now,
  };
  return {
    entity: user,
    eventDrafts: [IdentityEvents.userRegistered(user.id, "password", now)],
  };
}

function registerWithSso(
  params: {
    id: string;
    email: string;
    provider: SsoProvider;
    providerSubject: string;
  },
  now: Date,
): WithEventDrafts<SsoUser, IdentityEvent> {
  const user: SsoUser = {
    authMethod: "sso",
    id: UserId.create(params.id),
    email: Email.create(params.email),
    provider: params.provider,
    providerSubject: createProviderSubject(params.providerSubject),
    trashRetentionDays: TrashRetentionDays.default(),
    version: Version.initial(),
    createdAt: now,
    updatedAt: now,
  };
  return {
    entity: user,
    eventDrafts: [IdentityEvents.userRegistered(user.id, "sso", now)],
  };
}

// Takes `PasswordUser`, not `User`: an SSO account has no password to
// change, and the discriminated union makes that a compile error rather
// than a runtime guard. Verifying the current password (or a reset token)
// happens in the usecase via `PasswordHasher`.
function changePassword(
  user: PasswordUser,
  newPasswordHash: PasswordHash,
  now: Date,
): WithEventDrafts<PasswordUser, IdentityEvent> {
  const next: PasswordUser = {
    ...user,
    passwordHash: newPasswordHash,
    version: Version.next(user.version),
    updatedAt: now,
  };
  return {
    entity: next,
    eventDrafts: [IdentityEvents.passwordChanged(next.id, now)],
  };
}

function changeTrashRetentionDays(
  user: User,
  retentionDays: TrashRetentionDays,
  now: Date,
): WithEventDrafts<User, IdentityEvent> {
  // Re-submitting the current value is not an error (the spec's test cases
  // require it to succeed), but it is not a change either: bumping the
  // version would make a settings screen that re-posts its form fight
  // concurrent writers over OCC, and `identity.trashRetentionChanged`
  // subscribers would recompute retention windows that did not move. The
  // caller can detect the no-op by identity (`entity === user`) or by the
  // empty draft list before deciding whether to `save`.
  if (retentionDays === user.trashRetentionDays) {
    return { entity: user, eventDrafts: [] };
  }
  const next: User = {
    ...user,
    trashRetentionDays: retentionDays,
    version: Version.next(user.version),
    updatedAt: now,
  };
  return {
    entity: next,
    eventDrafts: [
      IdentityEvents.trashRetentionChanged(next.id, retentionDays, now),
    ],
  };
}

function assertUnset(value: string | null, column: string): void {
  if (value !== null) {
    throw new Error(`Column ${column} must be null for this auth method`);
  }
}

// Loose-typed because adapters feed untrusted persistence rows; each field
// is re-validated through its value object inside `reconstruct`.
type ReconstructInput = Readonly<{
  id: string;
  email: string;
  authMethod: string;
  passwordHash: string | null;
  ssoProvider: string | null;
  ssoProviderSubject: string | null;
  trashRetentionDays: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export const User = {
  isPasswordUser: (user: User): user is PasswordUser =>
    user.authMethod === "password",
  isSsoUser: (user: User): user is SsoUser => user.authMethod === "sso",

  registerWithPassword,

  registerWithSso,

  changePassword,

  changeTrashRetentionDays,

  // Value objects throw `BusinessRuleError` to mean "fresh input is
  // invalid". The same failure on a stored row means something else —
  // persisted data has drifted from the schema — so wrap everything here
  // in `RehydrationError`, which adapters translate to
  // `SystemError(DataIntegrityError)`. Rows violating the `users` sum-type
  // CHECK are unreachable in practice; both directions of that drift land
  // on the same path — a missing column because its value object rejects
  // the empty string, a column belonging to the *other* variant because
  // `assertUnset` rejects it. Without the latter check such a row would
  // rehydrate silently with the foreign columns dropped.
  reconstruct: (input: ReconstructInput): User => {
    try {
      const base = {
        id: UserId.create(input.id),
        email: Email.create(input.email),
        trashRetentionDays: TrashRetentionDays.create(input.trashRetentionDays),
        version: Version.create(input.version),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      if (input.authMethod === "password") {
        assertUnset(input.ssoProvider, "ssoProvider");
        assertUnset(input.ssoProviderSubject, "ssoProviderSubject");
        return {
          ...base,
          authMethod: "password",
          passwordHash: PasswordHash.create(input.passwordHash ?? ""),
        } satisfies PasswordUser;
      }
      if (input.authMethod === "sso") {
        assertUnset(input.passwordHash, "passwordHash");
        return {
          ...base,
          authMethod: "sso",
          provider: SsoProvider.create(input.ssoProvider ?? ""),
          providerSubject: createProviderSubject(
            input.ssoProviderSubject ?? "",
          ),
        } satisfies SsoUser;
      }
      throw new Error(`Unknown auth method: ${input.authMethod}`);
    } catch (error) {
      throw new RehydrationError(
        `Failed to rehydrate User (id=${input.id})`,
        error,
      );
    }
  },
};
