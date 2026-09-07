/**
 * Codes a `BusinessRuleError<IdentityErrorCode>` may carry. The value-object
 * factories are the producers; `spec/domains/identity.md` names each code at
 * the invariant it guards.
 */
export const IdentityErrorCode = {
  InvalidUserId: "INVALID_USER_ID",
  InvalidCredentialId: "INVALID_CREDENTIAL_ID",
  InvalidAiClientConnectionId: "INVALID_AI_CLIENT_CONNECTION_ID",
  InvalidEmail: "INVALID_EMAIL",
  PasswordTooWeak: "PASSWORD_TOO_WEAK",
  InvalidPasswordHash: "INVALID_PASSWORD_HASH",
  UnsupportedSsoProvider: "UNSUPPORTED_SSO_PROVIDER",
  InvalidClientName: "INVALID_CLIENT_NAME",
  InvalidTrashRetentionDays: "INVALID_TRASH_RETENTION_DAYS",
  LoginMethodRequired: "LOGIN_METHOD_REQUIRED",
  LastCredentialRemoval: "LAST_CREDENTIAL_REMOVAL",
  PasswordNotSupported: "PASSWORD_NOT_SUPPORTED",
} as const;

export type IdentityErrorCode =
  (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];
