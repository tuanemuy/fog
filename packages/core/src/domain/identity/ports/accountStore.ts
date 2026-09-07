export type AccountState = Readonly<{
  status: "active" | "deleting" | "deleted";
  /** The sole authority for session revocation; monotonically increasing. */
  sessionEpoch: number;
  /** Advances only when a password reset completes. */
  resetVersion: number;
}>;

/**
 * Account status and the revocation authority, inside the User Data DO.
 *
 * Not part of the `User` aggregate: revoking sessions is not a settings
 * change. Only four operations advance `sessionEpoch` (password change, reset
 * completion, SSO unlink, withdrawal); linking an SSO credential does not.
 * None of the writers take an OCC token or advance `version`.
 */
export interface AccountStore {
  find(): AccountState | null;
  advanceSessionEpoch(): void;
  /** Returns the value after the increment; do not re-read with `find()`. */
  advanceResetVersion(): number;
  /**
   * Written once, by account initialisation (registration saga phase 2), and
   * cleared only when withdrawal completes. Every cross-DO operation that
   * targets this account is bound to it.
   */
  initializeCallerBinding(callerToken: string): void;
  /**
   * Conditional on `status = 'active'`; matching zero rows is idempotent
   * success. Flips to `deleting` and advances `sessionEpoch`.
   */
  beginDeletion(): void;
}
