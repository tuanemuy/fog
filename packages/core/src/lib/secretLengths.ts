/**
 * Floors for the secrets a deployment supplies.
 *
 * Held here rather than on the codec that enforces them so that
 * `application/di/secrets.ts` can read the same number without importing an
 * adapter (a reversed dependency). Both readers must keep reading it: restating
 * `32` in either place lets the two checks split, and a DI layer that brands a
 * secret the codec then rejects throws a bare `Error` outside the error
 * middleware — a plain 500 on every request.
 *
 * A shorter HMAC key than the hash's block-equivalent output buys nothing:
 * HMAC-SHA256 forgeries cost the key's entropy, not the payload's.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;
