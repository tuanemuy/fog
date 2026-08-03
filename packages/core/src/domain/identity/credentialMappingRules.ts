import type { CredentialMapping } from "./ports/credentialMappingRepository";

/**
 * "Is this mapping a way in, and may it be used right now?" — as pure
 * predicates over {@link CredentialMapping}.
 *
 * These used to be three slightly different inline conditions in the adapter
 * layer (login's lookup, the reset request's eligibility, the send job's
 * recipient test). They implement one domain rule —
 * `spec/domains/identity.md`'s "the test is whether password verification
 * material exists, not whether a credential exists" — and a rule written three
 * times is a rule that gets amended twice. Living here, they are what #12 and
 * #18 amend when they add a condition.
 *
 * The throttle windows stay out: their size, ceiling and decay are #18 / #38's
 * to decide, so they arrive as arguments rather than as constants here.
 */

/**
 * The minimum a mapping needs before any credential-bearing decision is made
 * of it: activated, and with no credential change in flight.
 *
 * `status` is not optional — a signup's phase-1a reservation row already
 * carries its `passwordVerifier`, so skipping it would hand an unactivated
 * signup's verification material out. `changeState` covers `'pending'` and
 * `'advanced'` alike: mid-change, neither the old nor the new password may
 * sign in (fail closed).
 */
export function isSettled(mapping: CredentialMapping): boolean {
  return mapping.status === "active" && mapping.changeState === null;
}

/**
 * Whether the row holds password verification material.
 *
 * Structurally typed rather than taking a whole {@link CredentialMapping}, so
 * a caller reading a narrow projection of the row can still express the rule
 * by name instead of restating it. An SSO-only account's address reservation
 * *has* a stored original and *has* a credential, and still answers false —
 * which is the whole content of the rule.
 *
 * A type predicate, so that "the rule said yes" and "the field is non-null"
 * are the same fact to the compiler and a caller has nothing left to re-test.
 */
export function holdsPasswordVerifier<
  T extends Readonly<{ passwordVerifier: string | null }>,
>(mapping: T): mapping is T & Readonly<{ passwordVerifier: string }> {
  return mapping.passwordVerifier !== null;
}

/**
 * Whether a login attempt may be verified against this mapping now.
 *
 * The verifier's *presence* is not part of it: an SSO row is legitimately
 * usable and holds none, and login's own caller tests
 * {@link holdsPasswordVerifier} separately.
 */
export function isUsableForLogin(
  mapping: CredentialMapping,
  now: number,
): boolean {
  return (
    isSettled(mapping) &&
    (mapping.nextAttemptAllowedAt === null ||
      mapping.nextAttemptAllowedAt <= now)
  );
}

/**
 * Whether a reset request may issue a token against this mapping now.
 *
 * Deliberately **not** {@link isUsableForLogin} plus a window: the failed-login
 * backoff must not gate recovery, or an attacker could lock a user out of the
 * one path back in by failing logins against them.
 */
export function isResetRequestAllowed(
  mapping: CredentialMapping,
  now: number,
  windowMs: number,
): boolean {
  return (
    isSettled(mapping) &&
    holdsPasswordVerifier(mapping) &&
    (mapping.lastResetRequestedAt === null ||
      mapping.lastResetRequestedAt + windowMs <= now)
  );
}
