import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type {
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { fromBase64, toBase64 } from "./encoding";

export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const ALGORITHM = "pbkdf2-sha256";

export type Pbkdf2PasswordHasherOptions = Readonly<{ iterations?: number }>;

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function derive(
  plain: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * `PasswordHasher` over WebCrypto PBKDF2-SHA256, the derivation both Workers
 * and Node ship. The stored form is
 * `pbkdf2-sha256$<iterations>$<salt>$<hash>`, so the cost parameter travels
 * with the verifier and can be raised without invalidating stored ones.
 * A derivation the crypto subsystem refuses is `SystemError(CryptoError)`.
 */
export function createPbkdf2PasswordHasher(
  options: Pbkdf2PasswordHasherOptions = {},
): PasswordHasher {
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  return {
    async hash(plain: PlainPassword): Promise<PasswordHash> {
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      let derived: Uint8Array;
      try {
        derived = await derive(plain, salt, iterations);
      } catch (error) {
        throw new SystemError(
          SystemErrorCode.CryptoError,
          "Password hashing failed",
          error,
        );
      }
      return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(derived)}` as PasswordHash;
    },

    async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
      const [algorithm, rawIterations, rawSalt, rawHash] = hash.split("$");
      const storedIterations = Number(rawIterations);
      if (
        algorithm !== ALGORITHM ||
        !Number.isInteger(storedIterations) ||
        storedIterations < 1 ||
        !rawSalt ||
        !rawHash
      ) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "The stored password verifier is not in a known format",
        );
      }
      let expected: Uint8Array;
      let derived: Uint8Array;
      try {
        expected = fromBase64(rawHash);
        derived = await derive(plain, fromBase64(rawSalt), storedIterations);
      } catch (error) {
        throw new SystemError(
          SystemErrorCode.CryptoError,
          "Password verification failed",
          error,
        );
      }
      return constantTimeEqual(derived, expected);
    },
  };
}
