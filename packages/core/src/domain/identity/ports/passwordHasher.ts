import type { PasswordHash, PlainPassword } from "../valueObject";

/**
 * Password hashing and verification. The algorithm, its parameters and the
 * encoding of the resulting string are entirely the adapter's business —
 * the domain only knows that a `PasswordHash` came out of `hash` and that
 * `verify` is the sole way to compare one against a `PlainPassword`.
 *
 * `verify` must be timing-safe and reports a mismatch as `false`, not as a
 * thrown error: "wrong password" is an expected outcome, and turning it
 * into an error would tempt callers to reveal which half of the credential
 * pair was wrong. Only a failure of the computation itself (resource
 * exhaustion, unusable stored encoding) raises `SystemError`.
 */
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
}
