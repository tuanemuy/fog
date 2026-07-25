import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  PasswordHash,
  type PlainPassword,
} from "@repo/core/domain/identity/valueObject";

/**
 * `PasswordHasher` that "hashes" by prefixing, so integration suites do
 * not pay a real key-derivation cost per registration or login. The real
 * algorithm is covered by the WebCrypto adapter's own unit tests; tests
 * that genuinely need a round trip through PBKDF2 inject
 * `createPbkdf2PasswordHasher({ iterations })` at a low cost instead.
 */
export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: PlainPassword): Promise<PasswordHash> {
    return PasswordHash.create(`fake$${plain}`);
  }

  async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
    return hash === `fake$${plain}`;
  }
}
