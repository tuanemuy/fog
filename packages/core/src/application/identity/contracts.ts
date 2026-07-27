import type {
  Email,
  PasswordHash,
  SsoProvider,
  SsoSubject,
  UserId,
} from "@repo/core/domain/identity/valueObject";

export const IDENTITY_RPC_VERSION = 1 as const;
export const IDENTITY_OPERATION_ID_MAX_BYTES = 128;

declare const operationIdBrand: unique symbol;
declare const directoryReferenceBrand: unique symbol;

export type OperationId = string & { readonly [operationIdBrand]: true };
export type DirectoryReference = string & {
  readonly [directoryReferenceBrand]: true;
};

export function operationId(raw: string): OperationId {
  const value = raw.trim();
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > IDENTITY_OPERATION_ID_MAX_BYTES) {
    throw new TypeError("operationId is malformed");
  }
  return value as OperationId;
}

export function directoryReference(raw: string): DirectoryReference {
  if (raw.length === 0 || raw.length > 1024) {
    throw new TypeError("directory reference is malformed");
  }
  return raw as DirectoryReference;
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

export type LogicalCredential =
  | Readonly<{
      credentialId: string;
      kind: "password";
      email: Email;
      passwordHash: PasswordHash;
    }>
  | Readonly<{
      credentialId: string;
      kind: "sso";
      provider: SsoProvider;
      subject: SsoSubject;
      verifiedEmail: Email;
    }>;

export type LogicalCredentialAuthority = LogicalCredential &
  Readonly<{ directoryReferences: readonly DirectoryReference[] }>;

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
  directoryReference: DirectoryReference;
  state: CredentialState;
  accountEpoch: number;
  credential: LogicalCredential;
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
  credentialId: string;
  email: Email;
  passwordHash: PasswordHash;
  directoryReference: DirectoryReference;
  accountEpoch: number;
}>;

export type DirectoryAuthorityRow = Readonly<{
  userId: UserId;
  operationId: OperationId;
  directoryReference: DirectoryReference;
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
  references(
    canonicalCredential: string,
  ): Promise<readonly DirectoryReference[]>;
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
  preparePasswordResetRequest(input: {
    operationId: OperationId;
    userId: UserId;
    email: Email;
    proposedResetSecret: string;
    expiresAt: number;
    now: number;
  }): Promise<{
    resetSecret: string;
    tokenHash: string;
    expiresAt: number;
    replayed: boolean;
  }>;
  reserve(input: {
    operationId: OperationId;
    userId: UserId;
    directoryReference: DirectoryReference;
    credentialId: string;
    credential: CredentialRef;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  markInitialized(input: {
    operationId: OperationId;
    userId: UserId;
    directoryReference: DirectoryReference;
    now: number;
  }): Promise<void>;
  activate(input: {
    operationId: OperationId;
    userId: UserId;
    directoryReference: DirectoryReference;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  replacePassword(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    userId: UserId;
    passwordHash: PasswordHash;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  tombstone(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    userId: UserId;
    accountEpoch: number;
    now: number;
  }): Promise<void>;
  purge(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    userId: UserId;
    accountEpoch: number;
  }): Promise<void>;
  storePasswordReset(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    userId: UserId;
    tokenHash: string;
    expiresAt: number;
  }): Promise<void>;
  enqueuePasswordResetMail(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    userId: UserId;
    email: Email;
    resetSecret: string;
    expiresAt: number;
    providerIdempotencyKey: string;
    now: number;
  }): Promise<void>;
  lookupPasswordReset(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
    tokenHash: string;
    now: number;
  }): Promise<{ userId: UserId } | null>;
  consumePasswordReset(input: {
    operationId: OperationId;
    directoryReference: DirectoryReference;
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
    directoryReference?: DirectoryReference;
    credential?: LogicalCredential;
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
    directoryReference: DirectoryReference;
    credential: LogicalCredential;
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
    previous: DirectoryReference;
    active: DirectoryReference;
    kind: CredentialKind;
    now: number;
  }): Promise<void>;
  countActiveGeneration(userId: UserId, generation: string): Promise<number>;
  beginDeletion(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): Promise<{
    epoch: number;
    state: IdentityOperationState;
    directoryReferences: readonly DirectoryReference[];
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
  requestPasswordReset(input: {
    operationId: OperationId;
    email: Email;
    expiresAt: number;
    now: number;
  }): Promise<PasswordResetRequestResult>;
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
    credentialId: string;
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
