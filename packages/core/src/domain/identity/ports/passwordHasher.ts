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
 *
 * **An error thrown by either method must not carry a `PlainPassword` in
 * its message, its `cause` or any nested field.** Callers log these
 * failures, and a `PlainPassword` is a branded `string` with no `toJSON` to
 * intercept, so an implementation that echoes its input — a debugging
 * wrapper, a third-party hasher — puts the plaintext straight into the log
 * sink. Nothing in the type system stops that; this clause is what a
 * reviewer holds an adapter to.
 */
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
}
