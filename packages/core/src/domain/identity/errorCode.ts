export const IdentityErrorCode = {
  InvalidUserId: "IDENTITY_INVALID_USER_ID",
  InvalidCredentialId: "IDENTITY_INVALID_CREDENTIAL_ID",
  InvalidEmail: "IDENTITY_INVALID_EMAIL",
  // No thrower yet, deliberately. The credential set is a projection, so the
  // "last way in" refusal belongs to `unlinkSsoCredential` (#12); what #37
  // supplies is the predicate (`User.loginCredentialCount`) and this code.
  LastLoginCredential: "IDENTITY_LAST_LOGIN_CREDENTIAL",
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
