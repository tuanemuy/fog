export const IdentityErrorCode = {
  InvalidUserId: "IDENTITY_INVALID_USER_ID",
  InvalidEmail: "IDENTITY_INVALID_EMAIL",
  PasswordTooWeak: "IDENTITY_PASSWORD_TOO_WEAK",
  InvalidPasswordHash: "IDENTITY_INVALID_PASSWORD_HASH",
  UnsupportedSsoProvider: "IDENTITY_UNSUPPORTED_SSO_PROVIDER",
  InvalidSsoProviderSubject: "IDENTITY_INVALID_SSO_PROVIDER_SUBJECT",
  InvalidAiClientConnectionId: "IDENTITY_INVALID_AI_CLIENT_CONNECTION_ID",
  InvalidClientName: "IDENTITY_INVALID_CLIENT_NAME",
  InvalidTrashRetentionDays: "IDENTITY_INVALID_TRASH_RETENTION_DAYS",
} as const;

export type IdentityErrorCode =
  (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];
