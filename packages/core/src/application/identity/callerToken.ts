/**
 * The opaque value that binds every cross-DO operation on an account to the
 * saga that created it. Below this length a stored or presented token is
 * treated as a mismatch before any comparison.
 */
export const CALLER_TOKEN_MIN_LENGTH = 32;

/** 128 bits from the CSPRNG, hex-encoded. Never derived from time or an id. */
export function newCallerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isWellFormedCallerToken(value: string | null): boolean {
  return value !== null && value.length >= CALLER_TOKEN_MIN_LENGTH;
}
