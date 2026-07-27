import { BusinessRuleError } from "../error";
import type {
  Email,
  PasswordHash,
  SsoProvider,
  SsoSubject,
  UserId,
} from "./valueObject";

export type PasswordCredential = Readonly<{
  credentialId: string;
  kind: "password";
  email: Email;
  passwordHash: PasswordHash;
}>;

export type SsoCredential = Readonly<{
  credentialId: string;
  kind: "sso";
  provider: SsoProvider;
  subject: SsoSubject;
  verifiedEmail: Email;
}>;

export type LoginCredential = PasswordCredential | SsoCredential;

type AccountIdentityBase = Readonly<{
  id: UserId;
  sessionEpoch: number;
}>;

export type AccountIdentity =
  | (AccountIdentityBase &
      Readonly<{
        status: "pending" | "deleting";
        primaryEmail: Email | null;
        credentials: readonly LoginCredential[];
      }>)
  | (AccountIdentityBase &
      Readonly<{
        status: "active";
        primaryEmail: Email;
        credentials: readonly [LoginCredential, ...LoginCredential[]];
      }>)
  | (AccountIdentityBase &
      Readonly<{
        status: "deleted";
        primaryEmail: null;
        credentials: readonly [];
      }>);

type AccountIdentityInput = AccountIdentityBase &
  Readonly<{
    status: AccountIdentity["status"];
    primaryEmail: Email | null;
    credentials: readonly LoginCredential[];
  }>;

function fail(code: string, message: string): never {
  throw new BusinessRuleError(code, message);
}

function emailOf(credential: LoginCredential): Email {
  return credential.kind === "password"
    ? credential.email
    : credential.verifiedEmail;
}

function create(input: AccountIdentityInput): AccountIdentity {
  if (!Number.isSafeInteger(input.sessionEpoch) || input.sessionEpoch < 0) {
    fail(
      "IDENTITY_SESSION_EPOCH_INVALID",
      "Session epoch must be non-negative",
    );
  }
  if (input.status === "active" && input.credentials.length === 0) {
    fail(
      "IDENTITY_LAST_CREDENTIAL_REQUIRED",
      "An active account must have a login credential",
    );
  }
  if (input.status === "active" && input.primaryEmail === null) {
    fail(
      "IDENTITY_PRIMARY_EMAIL_REQUIRED",
      "An active account must have a primary email",
    );
  }
  if (input.status === "deleted") {
    if (input.primaryEmail !== null || input.credentials.length !== 0) {
      fail(
        "IDENTITY_DELETED_ACCOUNT_NOT_MINIMAL",
        "A deleted account cannot retain credentials or primary email",
      );
    }
    return input as AccountIdentity;
  }
  if (
    new Set(input.credentials.map((credential) => credential.credentialId))
      .size !== input.credentials.length
  ) {
    fail(
      "IDENTITY_CREDENTIAL_DUPLICATED",
      "Logical credential identifiers must be unique",
    );
  }
  const canonicalCredentials = input.credentials.map((credential) =>
    credential.kind === "password"
      ? `password:${credential.email}`
      : `sso:${credential.provider}:${credential.subject}`,
  );
  if (new Set(canonicalCredentials).size !== canonicalCredentials.length) {
    fail(
      "IDENTITY_CREDENTIAL_DUPLICATED",
      "Canonical login credentials must be unique",
    );
  }
  if (
    input.status === "active" &&
    input.primaryEmail !== null &&
    !input.credentials.some(
      (credential) => emailOf(credential) === input.primaryEmail,
    )
  ) {
    fail(
      "IDENTITY_PRIMARY_EMAIL_NOT_VERIFIED",
      "Primary email must belong to an active credential",
    );
  }
  return input as AccountIdentity;
}

function addCredential(
  account: AccountIdentity,
  credential: LoginCredential,
): AccountIdentity {
  if (account.status !== "active") {
    fail(
      "IDENTITY_ACCOUNT_NOT_ACTIVE",
      "Credentials require an active account",
    );
  }
  const existing = account.credentials.find(
    (candidate) => candidate.credentialId === credential.credentialId,
  );
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(credential)) return account;
    fail(
      "IDENTITY_CREDENTIAL_DUPLICATED",
      "Logical credential identifier already has another value",
    );
  }
  return create({
    ...account,
    credentials: [...account.credentials, credential],
    primaryEmail: account.primaryEmail ?? emailOf(credential),
    sessionEpoch: account.sessionEpoch + 1,
  });
}

function canUnlink(
  account: Readonly<{
    status: AccountIdentity["status"];
    credentials: readonly Readonly<{
      credentialId: string;
      kind: LoginCredential["kind"];
    }>[];
  }>,
  credentialId: string,
): boolean {
  return (
    account.status === "active" &&
    account.credentials.some(
      (credential) => credential.credentialId === credentialId,
    ) &&
    account.credentials.length > 1
  );
}

function unlink(
  account: AccountIdentity,
  credentialId: string,
): AccountIdentity {
  if (!canUnlink(account, credentialId)) {
    fail(
      "IDENTITY_LAST_CREDENTIAL_REQUIRED",
      "The final login credential cannot be removed",
    );
  }
  const credentials = account.credentials.filter(
    (credential) => credential.credentialId !== credentialId,
  );
  const primaryEmail =
    account.primaryEmail !== null &&
    credentials.some(
      (credential) => emailOf(credential) === account.primaryEmail,
    )
      ? account.primaryEmail
      : credentials[0]
        ? emailOf(credentials[0])
        : null;
  return create({
    ...account,
    credentials,
    primaryEmail,
    sessionEpoch: account.sessionEpoch + 1,
  });
}

function replacePassword(
  account: AccountIdentity,
  credentialId: string,
  passwordHash: PasswordHash,
): AccountIdentity {
  if (account.status !== "active") {
    fail(
      "IDENTITY_ACCOUNT_NOT_ACTIVE",
      "Password changes require an active account",
    );
  }
  const target = account.credentials.find(
    (credential) =>
      credential.credentialId === credentialId &&
      credential.kind === "password",
  );
  if (!target) {
    fail(
      "IDENTITY_PASSWORD_CREDENTIAL_NOT_FOUND",
      "Password credential does not exist",
    );
  }
  return create({
    ...account,
    credentials: account.credentials.map((credential) =>
      credential.credentialId === credentialId && credential.kind === "password"
        ? { ...credential, passwordHash }
        : credential,
    ),
    sessionEpoch: account.sessionEpoch + 1,
  });
}

function markDeleting(account: AccountIdentity): AccountIdentity {
  if (account.status === "deleted") return account;
  if (account.status === "deleting") return account;
  if (account.status !== "active") {
    fail(
      "IDENTITY_ACCOUNT_NOT_ACTIVE",
      "Only an active account can begin deletion",
    );
  }
  return create({
    ...account,
    status: "deleting",
    sessionEpoch: account.sessionEpoch + 1,
  });
}

function markDeleted(account: AccountIdentity): AccountIdentity {
  if (account.status === "deleted") return account;
  if (account.status !== "deleting") {
    fail(
      "IDENTITY_ACCOUNT_NOT_DELETING",
      "Account deletion must be in progress",
    );
  }
  return create({
    ...account,
    status: "deleted",
    primaryEmail: null,
    credentials: [],
  });
}

/**
 * Authentication authority. Credentials are logical domain values; routing
 * generations, buckets, Durable Object names and checkpoints belong to the
 * Cloudflare adapter.
 */
export const AccountIdentity = {
  create,
  addCredential,
  canUnlink,
  unlink,
  replacePassword,
  markDeleting,
  markDeleted,
};
