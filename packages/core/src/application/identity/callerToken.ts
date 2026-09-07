import type { TokenGenerator } from "../ports/tokenGenerator";

/**
 * The opaque value that binds every cross-DO operation on an account to the
 * saga that created it. Below this length a stored or presented token is
 * treated as a mismatch before any comparison.
 */
export const CALLER_TOKEN_MIN_LENGTH = 32;

/** One fresh binding value from the port; never derived from time or an id. */
export function newCallerToken(tokens: TokenGenerator): string {
  return tokens.next();
}

export function isWellFormedCallerToken(value: string | null): boolean {
  return value !== null && value.length >= CALLER_TOKEN_MIN_LENGTH;
}
