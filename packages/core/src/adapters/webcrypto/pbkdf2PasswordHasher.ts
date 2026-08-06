import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  DUMMY_PASSWORD_HASH_ALGORITHM_ID,
  DUMMY_PASSWORD_HASH_ITERATIONS,
} from "@repo/core/application/identity/loginWithPassword";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  PasswordHash,
  type PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { fromBase64, timingSafeEqual, toBase64 } from "./encoding";

/** WebCrypto digest names this adapter can drive PBKDF2 with. */
type Digest = "SHA-256" | "SHA-512";

/**
 * Maps a stored algorithm identifier onto the WebCrypto digest name;
 * `null` means "an identifier this adapter cannot read".
 *
 * Total on purpose, and deliberately not a lookup table: a bare object
 * indexed by the stored string would let prototype keys (`constructor`)
 * answer truthy. A table keyed by a literal type would be total as well,
 * but with only two algorithms the cost of keeping the table outweighs
 * what it buys.
 *
 * `pbkdf2-sha256` is a read-only branch kept for rows written before #20;
 * nothing writes it any more. No production row is expected to carry that
 * format, so the branch may be deleted once no row is left in it — in the
 * development D1, once its remaining rows are gone. #18's rehash-on-login
 * landing is not that moment: it rewrites those rows by verifying them
 * through this branch, so the branch has to outlive it and may only go
 * once it has finished sweeping. `.thread/20/adr.md` ADR-002 carries how
 * far that premise was verified and the one thing to check before
 * deleting.
 */
export const hashFor = (algorithm: string): Digest | null =>
  algorithm === "pbkdf2-sha512"
    ? "SHA-512"
    : algorithm === "pbkdf2-sha256"
      ? "SHA-256"
      : null;

/**
 * The one identifier this adapter writes. Pinned to the login path's
 * {@link DUMMY_PASSWORD_HASH_ALGORITHM_ID} for the reason spelled out on
 * {@link DEFAULT_PBKDF2_ITERATIONS}.
 */
export const ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID =
  "pbkdf2-sha512";

/**
 * The digest `hash()` hands WebCrypto. Held directly rather than looked up
 * through {@link hashFor}, so no `null` ever reaches the write path.
 */
const SHIPPED_HASH = "SHA-512" as const;

const SALT_BYTES = 16;
const DERIVED_BITS = 256;

/**
 * OWASP's recommendation for PBKDF2-HMAC-SHA512 — the row this adapter
 * ships. SHA-512's resistance to GPU/ASIC parallelism is why *we* pick
 * it, not why OWASP set that row's count. `.thread/1/adr.md` ADR-003
 * carries the table, its source and the date it was read.
 *
 * Typed as the login path's {@link DUMMY_PASSWORD_HASH_ITERATIONS} rather
 * than as `number`: `loginWithPassword` levels its response time by
 * verifying a dummy hash that declares that cost, so the two numbers have
 * to move together or the timing oracle comes back — inverted if only the
 * dummy moves, in its original direction if only this one does. The
 * algorithm identifier is covered by a second pin of the same shape
 * ({@link ALGORITHM_ID}), since `verify` derives with whatever algorithm
 * *and* cost the stored value declares — moving either one alone leaves
 * the dummy burning the wrong amount of work. Only the dummy's salt and
 * digest stay arbitrary; nothing regenerates them.
 *
 * Equalisation stays imperfect for hashes written at an earlier cost or
 * algorithm: until those rows are rewritten by rehash-on-login, a wrong
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
 * into an unbounded CPU burn (a Worker killed by its CPU limit). Reaching
 * it requires database write access, so this guards data corruption
 * rather than an attacker.
 */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;

export type Pbkdf2PasswordHasherOptions = Readonly<{
  iterations?: number;
}>;

type StoredHash = Readonly<{
  digest: Digest;
  iterations: number;
  salt: Uint8Array;
  derived: Uint8Array;
}>;

async function derive(
  plain: string,
  salt: Uint8Array,
  iterations: number,
  digest: Digest,
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
        hash: digest,
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
  const digest = algorithm === undefined ? null : hashFor(algorithm);
  if (
    parts.length !== 4 ||
    digest === null ||
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
      digest,
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
 * `PasswordHasher` backed by WebCrypto PBKDF2-HMAC-SHA512 — available on
 * Workers, so `packages/core` gains no crypto dependency.
 *
 * The stored form is self-describing:
 *
 * ```
 * pbkdf2-sha512$<iterations>$<saltBase64>$<hashBase64>
 * ```
 *
 * `verify` reads the algorithm and parameters back out of the stored
 * value rather than assuming the current settings, so raising
 * `iterations` — or later adding an Argon2id branch and re-hashing on
 * login — leaves existing hashes verifiable. What it reads is
 * deliberately wider than what it writes: `pbkdf2-sha256` still verifies
 * (rows written before #20) while `pbkdf2-sha512` is the only identifier
 * this adapter emits.
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
      const derived = await derive(plain, salt, iterations, SHIPPED_HASH);
      return PasswordHash.create(
        `${ALGORITHM_ID}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`,
      );
    },

    async verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean> {
      const stored = parse(hash);
      const candidate = await derive(
        plain,
        stored.salt,
        stored.iterations,
        stored.digest,
      );
      return timingSafeEqual(candidate, stored.derived);
    },
  };
}
