export const IdentityErrorCode = {
  InvalidUserId: "IDENTITY_INVALID_USER_ID",
  InvalidCredentialId: "IDENTITY_INVALID_CREDENTIAL_ID",
  InvalidEmail: "IDENTITY_INVALID_EMAIL",
  // No thrower yet, deliberately. The credential set is a projection, so the
  // "last way in" refusal belongs to `unlinkSsoCredential` (#12); what #37
  // supplies is the predicate (`User.loginCredentialCount`) and this code.
  // Named after `spec/usecases/identity.md`'s `LastCredentialRemoval` rather
  // than after the predicate: #12 reads the spec to build the thrower, and two
  // names for one refusal is a decision it would have to re-make.
  LastCredentialRemoval: "IDENTITY_LAST_CREDENTIAL_REMOVAL",
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
