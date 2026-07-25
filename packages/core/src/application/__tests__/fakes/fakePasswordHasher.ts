import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  PasswordHash,
  type PlainPassword,
} from "@repo/core/domain/identity/valueObject";

/** FNV-1a — fast, deterministic, and irreversible enough for a fake. */
function digest(plain: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < plain.length; index += 1) {
    hash ^= plain.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * `PasswordHasher` that digests cheaply, so integration suites do not pay
 * a real key derivation per registration or login. The real algorithm is
 * covered by the WebCrypto adapter's own unit tests; tests that genuinely
 * need a round trip through PBKDF2 inject
 * `createPbkdf2PasswordHasher({ iterations })` at a low cost instead.
 *
 * The output must not embed the plaintext, cheap as the fake is: every
 * suite that uses it asserts "no plaintext reached `users.password_hash`"
 * against this value, and a fake that simply prefixed the password would
 * make that assertion hold by accident (ADR-011).
 */
export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: PlainPassword): Promise<PasswordHash> {
    return PasswordHash.create(`fake$${digest(plain)}`);
  }

  async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
    return hash === `fake$${digest(plain)}`;
  }
}
