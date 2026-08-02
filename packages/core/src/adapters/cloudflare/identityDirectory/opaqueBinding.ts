import { timingSafeEqual } from "../../webcrypto/encoding";

/**
 * The comparison rule for the two opaque bindings — the caller token
 * (`credential_mappings.caller_token`, mirrored as `account.caller_token` on
 * the User Data side) and `password_reset_tokens.change_auth_token`. Those two,
 * and nothing else.
 *
 * The User Data DO's `AccountStore` imports it from here because the value
 * compared is literally the same token; there is one rule, not two.
 *
 * Three clauses, and the first two are the reason this is a function rather
 * than an inline comparison:
 *
 * 1. **A `NULL` on the row never matches.** Both columns legitimately become
 *    `NULL` — `change_auth_token` on consumption and on the phase-1 sweep,
 *    `account.caller_token` on a completed withdrawal — so the obvious
 *    "byte-compare both sides" implementation lets `NULL == NULL` through and
 *    a caller holding no binding at all passes the check.
 * 2. **A missing or empty argument is refused before the comparison**, for the
 *    same reason from the other side.
 * 3. Otherwise the comparison is constant-time.
 *
 * This matches the fail-closed stance taken elsewhere for a missing `ep` or
 * `typ` on a session token: these columns *are* the binding, so they get the
 * same strength of refusal.
 */
export function matchOpaque(
  rowValue: string | null,
  argument: string | null | undefined,
): boolean {
  if (rowValue === null || rowValue.length === 0) return false;
  if (argument === null || argument === undefined || argument.length === 0) {
    return false;
  }
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(rowValue), encoder.encode(argument));
}
