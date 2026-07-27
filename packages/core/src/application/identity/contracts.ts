import type {
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "@repo/core/domain/identity/valueObject";

export const IDENTITY_RPC_VERSION = 1 as const;
export const IDENTITY_OPERATION_ID_MAX_BYTES = 128;

declare const operationIdBrand: unique symbol;
declare const opaqueCredentialKeyBrand: unique symbol;

export type OperationId = string & { readonly [operationIdBrand]: true };
export type OpaqueCredentialKey = string & {
  readonly [opaqueCredentialKeyBrand]: true;
};

export function operationId(raw: string): OperationId {
  const value = raw.trim();
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > IDENTITY_OPERATION_ID_MAX_BYTES) {
    throw new TypeError("operationId is malformed");
  }
  return value as OperationId;
}

export function opaqueCredentialKey(raw: string): OpaqueCredentialKey {
  if (raw.length === 0) {
    throw new TypeError("opaque credential key is malformed");
  }
  return raw as OpaqueCredentialKey;
}

export type RpcError = Readonly<{
  kind: "validation" | "conflict" | "not-found" | "infrastructure";
  code: string;
  message: string;
  retryable: boolean;
}>;

export type RpcResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: RpcError }>;

export type IdentityRpcQuery<T> = Readonly<{
  version: typeof IDENTITY_RPC_VERSION;
  payload: T;
}>;

export type IdentityRpcMutation<T> = Readonly<{
  version: typeof IDENTITY_RPC_VERSION;
  operationId: string;
  payload: T;
}>;

export type CredentialKind = "password" | "sso";
export type CredentialState =
  | "reserved"
  | "initialized"
  | "active"
  | "tombstoned";

export type CredentialLocator = Readonly<{
  generation: string;
  bucket: number;
  opaqueKey: OpaqueCredentialKey;
}>;

export type LogicalCredentialAuthority = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  locators: readonly CredentialLocator[];
}>;

export type CredentialRef =
  | Readonly<{
      kind: "password";
      canonicalValue: string;
      passwordHash: PasswordHash;
    }>
  | Readonly<{
      kind: "sso";
      canonicalValue: string;
      provider: SsoProvider;
      verifiedEmail: Email;
    }>;

export type DirectoryCredential = Readonly<{
  userId: UserId;
  operationId: OperationId;
  locator: CredentialLocator;
  state: CredentialState;
  accountEpoch: number;
  credential: CredentialRef;
}>;

export type IdentityRegistration = Readonly<{
  operationId: OperationId;
  userId: UserId;
  email: Email;
  passwordHash: PasswordHash;
  now: number;
}>;

export type PasswordCredential = Readonly<{
  userId: UserId;
  passwordHash: PasswordHash;
  locator: CredentialLocator;
  accountEpoch: number;
}>;

export type DirectoryAuthorityRow = Readonly<{
  userId: UserId;
  operationId: OperationId;
  locator: CredentialLocator;
  state: CredentialState;
  accountEpoch: number;
}>;

export type AccountStatus = "pending" | "active" | "deleting" | "deleted";

export type AccountAuthSummary = Readonly<{
  userId: UserId;
  status: AccountStatus;
  primaryEmail: Email | null;
  authMethods: readonly CredentialKind[];
  credentials: readonly LogicalCredentialAuthority[];
  sessionEpoch: number;
  operationEpoch: number;
}>;

export type UserDataIdentityProfile = Readonly<{
  userId: UserId;
  displayName: string | null;
  trashRetentionDays: number;
}>;

export type UserDataIdentityStatus = Readonly<{
  initialized: boolean;
  deleted: boolean;
}>;

export type UserDataIdentityInitializeRpc = IdentityRpcMutation<{
  userId: string;
  now: number;
}>;
export type UserDataIdentityProfileRpc = IdentityRpcQuery<{ userId: string }>;
export type UserDataIdentityStatusRpc = IdentityRpcQuery<{ userId: string }>;
export type UserDataIdentityDeleteRpc = IdentityRpcMutation<{ userId: string }>;

export type CurrentAccount = Readonly<{
  auth: AccountAuthSummary;
  profile: UserDataIdentityProfile;
}>;

export interface IdentityApplicationPort {
  preparePasswordSignup(input: {
    operationId: OperationId;
    proposedUserId: UserId;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): Promise<{
    userId: UserId;
    passwordHash: PasswordHash;
    preparedAt: number;
    replayed: boolean;
  }>;
  registerWithPassword(input: IdentityRegistration): Promise<{
    sessionEpoch: number;
  }>;
  findPasswordCredential(email: Email): Promise<PasswordCredential | null>;
  getAccountAuthority(userId: UserId): Promise<AccountAuthSummary | null>;
  getCurrentAccount(userId: UserId): Promise<CurrentAccount | null>;
}

export type IdentityOperationKind =
  | "signup"
  | "password-change"
  | "password-reset"
  | "sso-create"
  | "sso-link"
  | "sso-unlink"
  | "delete-account"
  | "credential-rotation"
  | "export";

export type IdentityOperationState =
  | "pending"
  | "credential-reserved"
  | "user-data-initialized"
  | "directory-active"
  | "active"
  | "tombstoning"
  | "user-data-deleted"
  | "purging"
  | "compensating"
  | "completed"
  | "failed";

export type IdentityOperation = Readonly<{
  operationId: OperationId;
  kind: IdentityOperationKind;
  state: IdentityOperationState;
  payloadDigest: string;
  epoch: number;
}>;

export interface CredentialDirectoryPort {
  locators(canonicalCredential: string): Promise<readonly CredentialLocator[]>;
  lookupPassword(email: Email): Promise<readonly (PasswordCredential | null)[]>;
  lookupCredential(
    canonicalCredential: string,
  ): Promise<readonly (DirectoryCredential | null)[]>;
  preparePasswordSignup(input: {
    operationId: OperationId;
    proposedUserId: UserId;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): Promise<{
    userId: UserId;
    passwordHash: PasswordHash;
    preparedAt: number;
    replayed: boolean;
  }>;
  prepareSsoCreate(input: {
    operationId: OperationId;
    proposedUserId: UserId;
    provider: SsoProvider;
    subject: string;
    email: Email;
    now: number;
  }): Promise<{ userId: UserId; replayed: boolean }>;
  reserve(input: {
    operationId: OperationId;
    userId: UserId;
    locator: CredentialLocator;
    credential: CredentialRef;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  markInitialized(input: {
    operationId: OperationId;
    userId: UserId;
    locator: CredentialLocator;
    now: number;
  }): Promise<void>;
  activate(input: {
    operationId: OperationId;
    userId: UserId;
    locator: CredentialLocator;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  replacePassword(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    passwordHash: PasswordHash;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  tombstone(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  purge(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    accountEpoch: number;
  }): Promise<void>;
  storePasswordReset(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    tokenHash: string;
    expiresAt: number;
  }): Promise<void>;
  enqueuePasswordResetMail(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    email: Email;
    tokenHash: string;
    providerIdempotencyKey: string;
    now: number;
  }): Promise<void>;
  lookupPasswordReset(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    tokenHash: string;
    now: number;
  }): Promise<{ userId: UserId } | null>;
  consumePasswordReset(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    tokenHash: string;
    now: number;
  }): Promise<{ userId: UserId } | null>;
}

export interface AccountHomePort {
  beginOperation(input: {
    operationId: OperationId;
    userId: UserId;
    kind: IdentityOperationKind;
    payloadDigest: string;
    primaryEmail?: Email;
    now: number;
  }): Promise<IdentityOperation>;
  advanceOperation(input: {
    operationId: OperationId;
    userId: UserId;
    expectedState: IdentityOperationState;
    nextState: IdentityOperationState;
    locator?: CredentialLocator;
    credentialId?: string;
    credentialKind?: CredentialKind;
    primaryEmail?: Email;
    bumpSessionEpoch?: boolean;
    now: number;
  }): Promise<IdentityOperation>;
  getOperation(
    userId: UserId,
    operationId: OperationId,
  ): Promise<IdentityOperation | null>;
  getAuthSummary(userId: UserId): Promise<AccountAuthSummary | null>;
  compensateCreate(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): Promise<void>;
  addCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    locator: CredentialLocator;
    credentialId: string;
    kind: CredentialKind;
    primaryEmail?: Email;
    bumpSessionEpoch: boolean;
    now: number;
  }): Promise<AccountAuthSummary>;
  removeCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    credentialId: string;
    bumpSessionEpoch: boolean;
    now: number;
  }): Promise<AccountAuthSummary>;
  replaceCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    previous: CredentialLocator;
    active: CredentialLocator;
    kind: CredentialKind;
    now: number;
  }): Promise<void>;
  beginDeletion(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): Promise<{
    epoch: number;
    state: IdentityOperationState;
    locators: readonly CredentialLocator[];
  }>;
  finishDeletion(input: {
    operationId: OperationId;
    userId: UserId;
    epoch: number;
    now: number;
  }): Promise<boolean>;
}

export interface UserDataIdentityPort {
  initialize(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): Promise<void>;
  getProfile(userId: UserId): Promise<UserDataIdentityProfile | null>;
  getStatus(userId: UserId): Promise<UserDataIdentityStatus>;
  deleteAll(input: { operationId: OperationId; userId: UserId }): Promise<void>;
}

export type SsoCredentialInput = Readonly<{
  operationId: OperationId;
  provider: SsoProvider;
  subject: string;
  email: Email;
  now: number;
}>;

export type ResetPrimitive = Readonly<{
  operationId: OperationId;
  tokenHash: string;
  expiresAt: number;
}>;

export type PasswordResetRequestResult = Readonly<{ accepted: true }>;

export interface IdentityPrimitivePort {
  lookupOrCreateSso(input: SsoCredentialInput): Promise<{
    userId: UserId;
    sessionEpoch: number;
  }>;
  storePasswordReset(
    input: ResetPrimitive & { email: Email; userId: UserId },
  ): Promise<void>;
  requestPasswordReset(
    input: ResetPrimitive & { email: Email; now: number },
  ): Promise<PasswordResetRequestResult>;
  changePassword(input: {
    operationId: OperationId;
    userId: UserId;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): Promise<{ sessionEpoch: number }>;
  consumePasswordReset(input: {
    operationId: OperationId;
    tokenHash: string;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): Promise<{ userId: UserId; sessionEpoch: number } | null>;
  linkSso(input: SsoCredentialInput & { userId: UserId }): Promise<void>;
  unlinkCredential(input: {
    operationId: OperationId;
    userId: UserId;
    locator: CredentialLocator;
    now: number;
  }): Promise<void>;
  deleteAccount(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): Promise<void>;
}

export interface AuthenticatedUserDataRouter {
  forAuthenticatedUser(userId: UserId): {
    readonly userId: UserId;
    readonly objectName: string;
  };
}
