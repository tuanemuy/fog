export type AccountStatus = "active" | "deleting" | "deleted";

export type AccountState = Readonly<{
  status: AccountStatus;
  /** The sole authority on session revocation. Monotonically increasing. */
  sessionEpoch: number;
  /** Advanced by a completed password reset and by nothing else. */
  resetVersion: number;
}>;

/**
 * Account state and the two revocation counters.
 *
 * **Not part of the `User` aggregate**: revoking sessions is not a settings
 * change. It is also not one of the "non-aggregate stores" — the `account`
 * table carries the OCC `version` column and belongs to the aggregate side.
 * Not folding into `User` and being non-aggregate are different things.
 *
 * `sessionEpoch` advances on exactly four operations — password change, reset
 * completion, SSO unlink, and withdrawal. **Linking an SSO credential does not
 * advance it**: gaining a way in does not make existing sessions less
 * trustworthy, and advancing would sign the user out of the very screen they
 * linked from.
 *
 * `resetVersion` advances only on reset completion, never on an ordinary
 * password change. It scopes the automatic revocation of AI client
 * connections, and `sessionEpoch` cannot stand in for it: one intervening
 * password change would move the epoch past the connections meant to die.
 *
 * Both advances are single statements with no OCC predicate and do not bump
 * `version` — they advance a monotonic counter rather than updating settings.
 *
 * `advanceResetVersion` **returns the value after the advance**; the scope of
 * revocation is derived from that return value rather than from a second
 * `find()`, because splitting the read from the advance lets concurrent
 * execution shift the scope.
 */
export interface AccountStore {
  find(): AccountState | null;
  advanceSessionEpoch(): void;
  advanceResetVersion(): number;

  /**
   * Creates the account row. Signup phase 2 is the only caller.
   *
   * `spec/domains/identity.md` leaves the writer of `status` / `deleted_at` /
   * `caller_token` open; this is it. `account` carries the OCC `version` and is
   * on the aggregate side, so adding a method here does not disturb the
   * non-aggregate-store roster.
   */
  initialize(callerToken: string, now: Date): void;

  /**
   * Constant-time comparison against `account.caller_token`.
   *
   * Exposed as a predicate rather than as a getter on {@link AccountState} so
   * the token has no way out of the store: it must not appear in a DTO, a log
   * line or a job's `terminal_reason`, and a value that is never returned
   * cannot be put in one by accident.
   *
   * A `NULL` column never matches, and neither does an empty argument.
   */
  matchCallerToken(token: string | null | undefined): boolean;
}
