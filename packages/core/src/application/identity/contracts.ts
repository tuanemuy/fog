import type { PasswordHash } from "@repo/core/domain/identity/valueObject";

export const IDENTITY_RPC_VERSION = 1 as const;

export type RpcError = Readonly<{
  kind: "validation" | "conflict" | "not-found" | "infrastructure";
  code: string;
  message: string;
  retryable?: boolean;
}>;

export type RpcResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: RpcError }>;

export type CredentialKind = "password" | "sso";
export type CredentialState =
  | "reserved"
  | "initialized"
  | "active"
  | "tombstoned";

export type CredentialLocator = Readonly<{
  generation: string;
  bucket: number;
  opaqueKey: string;
}>;

export type IdentityRegistration = Readonly<{
  operationId: string;
  userId: string;
  email: string;
  passwordHash: PasswordHash;
  now: number;
}>;

export type PasswordCredential = Readonly<{
  userId: string;
  passwordHash: PasswordHash;
}>;

export type CurrentAccount = Readonly<{
  userId: string;
  email: string;
  authMethod: CredentialKind;
  trashRetentionDays: number;
  sessionEpoch: number;
}>;

export interface IdentityApplicationPort {
  registerWithPassword(input: IdentityRegistration): Promise<void>;
  findPasswordCredential(email: string): Promise<PasswordCredential | null>;
  getCurrentAccount(userId: string): Promise<CurrentAccount | null>;
}

export type SsoCredentialInput = Readonly<{
  operationId: string;
  provider: string;
  subject: string;
  email: string;
  proposedUserId: string;
  now: number;
}>;

export type ResetPrimitive = Readonly<{
  operationId: string;
  tokenHash: string;
  expiresAt: number;
}>;

export interface IdentityPrimitivePort {
  reserveSsoCredential(input: SsoCredentialInput): Promise<{ userId: string }>;
  storePasswordReset(input: ResetPrimitive & { userId: string }): Promise<void>;
  consumePasswordReset(
    tokenHash: string,
    now: number,
  ): Promise<{ userId: string } | null>;
}

export type IdentityOperationKind =
  | "signup"
  | "password-change"
  | "password-reset"
  | "sso-link"
  | "sso-unlink"
  | "delete-account"
  | "export";

export type IdentityOperationState =
  | "pending"
  | "credential-reserved"
  | "user-data-initialized"
  | "active"
  | "compensating"
  | "completed"
  | "failed";

export interface AuthenticatedUserDataRouter {
  forAuthenticatedUser(userId: string): {
    readonly userId: string;
  };
}
