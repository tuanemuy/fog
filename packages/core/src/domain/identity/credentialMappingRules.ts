import type { CredentialMapping } from "./ports/credentialMappingRepository";

/**
 * "Is this mapping a way in, and may it be used right now?" — as pure
 * predicates over {@link CredentialMapping}.
 *
 * They implement one domain rule — `spec/domains/identity.md`'s "the test is
 * whether password verification material exists, not whether a credential
 * exists". Login's lookup, the reset request's eligibility and the send job's
 * recipient test all consult it; a rule written three times inline is a rule
 * that gets amended twice.
 *
 * The throttle windows stay out: their size, ceiling and decay are an
 * operational concern, so they arrive as arguments rather than as constants
 * here.
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
 *
 * ## Fixed windows, not a sliding one
 *
 * The comparison is between **window numbers** — `floor(t / windowMs)` — and
 * not `last + windowMs <= now`. The two throttle identically for a single
 * well-behaved caller, and differ in exactly one case that matters: the stamp
 * is advanced by every request, eligible or not (that unconditional advance is
 * what makes the window number of an eligible request unused, which the
 * `send-mail` `operationKey` relies on). Under a sliding test, an
 * unauthenticated third party asking slightly faster than the window keeps
 * `last` moving and the victim never becomes eligible again — password
 * recovery, the one path back in, closes permanently and the uniform response
 * means neither the user nor an operator can see it. With window numbers the
 * first request of any window is always eligible, because the stamp it compares
 * against was necessarily written in an earlier window; a link therefore
 * reaches the registered address at least once per window regardless of who
 * asked for it.
 *
 * The cost is that two requests straddling a boundary both issue, so the second
 * replaces the first one's still-live link. That is the same trade-off the
 * window already accepts for the mail itself.
 *
 * A `null` stamp is unconditionally eligible, which is why a new mapping is
 * created with `last_reset_requested_at = created_at` rather than NULL: a
 * freshly created mapping must *not* be eligible in the window it was born in,
 * because a request made against the same address while it was unregistered may
 * already have spent that window's `send-mail` key.
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
      Math.floor(mapping.lastResetRequestedAt / windowMs) <
        Math.floor(now / windowMs))
  );
}
