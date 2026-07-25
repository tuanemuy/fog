import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { DUMMY_PASSWORD_HASH_ITERATIONS } from "@repo/core/application/identity/loginWithPassword";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  PasswordHash,
  type PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { fromBase64, timingSafeEqual, toBase64 } from "./encoding";

const ALGORITHM_ID = "pbkdf2-sha256";
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

/**
 * OWASP's recommendation for PBKDF2-HMAC-SHA256 (2023 cheat sheet).
 *
 * Typed as the login path's {@link DUMMY_PASSWORD_HASH_ITERATIONS} rather
 * than as `number`: `loginWithPassword` levels its response time by
 * verifying a dummy hash that declares that cost, so the two numbers have
 * to move together or the timing oracle comes back — inverted if only the
 * dummy moves, in its original direction if only this one does. Raising
 * the work factor therefore means editing both constants; nothing else in
 * the dummy needs regenerating, since `verify` derives at whatever cost
 * the stored value declares.
 *
 * Equalisation stays imperfect for hashes written at an earlier cost:
 * until those rows are rewritten (rehash-on-login, Issue #18) a wrong
 * password on such an account is cheaper than an unknown address.
 */
export const DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS = 210_000;

/**
 * Floor for the factory's `iterations` argument. Well below any usable
 * production cost — the argument exists so test runs stay affordable —
 * but high enough that a typo or an uninitialised config value cannot
 * quietly stand up a hasher that offers no work factor at all.
 */
export const MIN_PBKDF2_ITERATIONS = 1_000;

/**
 * Ceiling accepted when reading an iteration count back out of a stored
 * hash. A row carrying an absurd count would otherwise turn one login
 * into an unbounded CPU burn (a Worker killed by its CPU limit, a Node
 * worker thread pinned indefinitely). Reaching it requires database
 * write access, so this guards data corruption rather than an attacker.
 */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;

export type Pbkdf2PasswordHasherOptions = Readonly<{
  iterations?: number;
}>;

type StoredHash = Readonly<{
  iterations: number;
  salt: Uint8Array;
  derived: Uint8Array;
}>;

async function derive(
  plain: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(plain),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: salt as BufferSource,
        iterations,
      },
      key,
      DERIVED_BITS,
    );
    return new Uint8Array(bits);
  } catch (cause) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      "Failed to derive password hash",
      cause,
    );
  }
}

function parse(stored: string): StoredHash {
  const parts = stored.split("$");
  const [algorithm, iterationsRaw, saltRaw, derivedRaw] = parts;
  if (
    parts.length !== 4 ||
    algorithm !== ALGORITHM_ID ||
    iterationsRaw === undefined ||
    saltRaw === undefined ||
    derivedRaw === undefined
  ) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored password hash is not in a recognised encoding",
    );
  }
  // `Number` would accept `" 12 "` / `"1e5"` / `"0x10"`; the encoder only
  // ever writes plain digits, so anything else is a corrupted row.
  const iterations = /^\d+$/.test(iterationsRaw)
    ? Number(iterationsRaw)
    : Number.NaN;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored password hash declares an invalid iteration count",
    );
  }
  try {
    return {
      iterations,
      salt: fromBase64(saltRaw),
      derived: fromBase64(derivedRaw),
    };
  } catch (cause) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored password hash carries malformed base64",
      cause,
    );
  }
}

/**
 * `PasswordHasher` backed by WebCrypto PBKDF2-HMAC-SHA256 — available
 * unchanged on Node 20+, Workers, Lambda and Cloud Run, so all four
 * reference runtimes share one implementation and `packages/core` gains
 * no crypto dependency (ADR-003).
 *
 * The stored form is self-describing:
 *
 * ```
 * pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64>
 * ```
 *
 * `verify` reads the algorithm and parameters back out of the stored
 * value rather than assuming the current settings, so raising
 * `iterations` — or later adding an Argon2id branch and re-hashing on
 * login — leaves existing hashes verifiable.
 *
 * `iterations` is a factory argument and deliberately *not* an
 * environment variable: strength would otherwise drift per deployment
 * with no way to tell which hash was made at which cost. Production
 * wiring takes the default; the argument exists so tests can run at a
 * cost their runner can afford.
 *
 * A mismatch is `false`, never an error — see the port's contract. Only
 * the computation failing raises (`SystemError`).
 *
 * @throws if `iterations` is not an integer of at least
 * {@link MIN_PBKDF2_ITERATIONS}.
 */
export function createPbkdf2PasswordHasher(
  options: Pbkdf2PasswordHasherOptions = {},
): PasswordHasher {
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(
      `PBKDF2 iterations must be an integer of at least ${MIN_PBKDF2_ITERATIONS}`,
    );
  }

  return {
    async hash(plain: PlainPassword): Promise<PasswordHash> {
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const derived = await derive(plain, salt, iterations);
      return PasswordHash.create(
        `${ALGORITHM_ID}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`,
      );
    },

    async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
      const stored = parse(hash);
      const candidate = await derive(plain, stored.salt, stored.iterations);
      return timingSafeEqual(candidate, stored.derived);
    },
  };
}
