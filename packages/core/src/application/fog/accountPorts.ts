export interface GoogleIdentityPort {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;
  exchange(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<{ subject: string; email: string; emailVerified: true }>;
}
export interface ResetMailer {
  sendPasswordReset(input: {
    id: string;
    to: string;
    resetUrl: string;
    expiresAt: string;
  }): Promise<void>;
}
export type GoogleCredential = Readonly<{
  id: string;
  ownerId: string;
  subject: string;
  email: string;
  createdAt: string;
}>;
export type GoogleRequest = Readonly<{
  stateHash: string;
  browserHash: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: string;
  consumed: boolean;
}> &
  (
    | Readonly<{ mode: "login"; ownerId: null }>
    | Readonly<{ mode: "link"; ownerId: string }>
  );
export type ResetToken = Readonly<{
  tokenHash: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
}>;
export type ResetMail = Readonly<{
  id: string;
  ownerId: string;
  to: string;
  resetUrl: string;
  expiresAt: string;
  attempts: number;
  leaseToken: string;
}>;
export interface AccountRepository {
  googleCredentials(ownerId: string): Promise<GoogleCredential[]>;
  findGoogleSubject(subject: string): Promise<GoogleCredential | null>;
  createGoogleCredential(credential: GoogleCredential): Promise<void>;
  deleteGoogleCredential(ownerId: string, id: string): Promise<void>;
  createGoogleRequest(request: GoogleRequest): Promise<void>;
  findGoogleRequest(stateHash: string): Promise<GoogleRequest | null>;
  consumeGoogleRequest(stateHash: string): Promise<void>;
  replacePassword(ownerId: string, passwordHash: string): Promise<void>;
  deleteSessions(ownerId: string): Promise<void>;
  invalidatePendingAuthorizations(ownerId: string): Promise<void>;
  createResetToken(token: ResetToken): Promise<void>;
  findResetToken(tokenHash: string): Promise<ResetToken | null>;
  deleteResetTokens(ownerId: string): Promise<void>;
  lastResetAt(ownerId: string): Promise<string | null>;
  saveLastResetAt(ownerId: string, at: string): Promise<void>;
  revokeAiSince(ownerId: string, since: string, now: string): Promise<void>;
  revokeAllAi(ownerId: string, now: string): Promise<void>;
  enqueueResetMail(mail: {
    id: string;
    ownerId: string;
    to: string;
    resetUrl: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<void>;
  deleteResetMail(ownerId: string): Promise<void>;
  claimResetMail(input: {
    now: string;
    leaseUntil: string;
    leaseToken: string;
  }): Promise<ResetMail | null>;
  deliveredResetMail(id: string, leaseToken: string): Promise<void>;
  retryResetMail(input: {
    id: string;
    leaseToken: string;
    availableAt: string;
  }): Promise<void>;
  deleteExpiredResetMail(now: string): Promise<void>;
}
