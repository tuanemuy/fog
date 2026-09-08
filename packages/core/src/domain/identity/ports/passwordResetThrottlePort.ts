/**
 * The reset-request throttle window (`spec/domains/identity.md`). One call
 * judges and counts: the window's first request creates its row and
 * answers `true`; a later one updates `last_requested_at` and answers
 * `false`. The row is written whether or not the address is registered.
 */
export interface PasswordResetThrottlePort {
  claimWindow(windowKey: string, now: Date): boolean;
}
