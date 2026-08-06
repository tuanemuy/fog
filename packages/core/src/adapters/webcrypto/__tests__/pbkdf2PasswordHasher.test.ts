import { isSystemError } from "@repo/core/application/errors";
import {
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALGORITHM_ID,
  createPbkdf2PasswordHasher,
  DEFAULT_PBKDF2_ITERATIONS,
  hashFor,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
} from "../pbkdf2PasswordHasher";

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the hasher to reject");
}

// Production strength is PBKDF2-HMAC-SHA512 at 210k iterations; the tests
// run at a cost the runner can afford, which is exactly what the factory
// argument exists for. The parameters, not the cost, are what these
// assertions pin.
const ITERATIONS = 1_000;
const hasher = createPbkdf2PasswordHasher({ iterations: ITERATIONS });

const PASSWORD = PlainPassword.create("password123");

describe("createPbkdf2PasswordHasher", () => {
  it("verifies a password it hashed", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, hash)).resolves.toBe(true);
  });

  it("reports a wrong password as false rather than throwing", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(
      hasher.verify(PlainPassword.create("password124"), hash),
    ).resolves.toBe(false);
  });

  it("treats a password differing only in whitespace as wrong", async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(
      hasher.verify(PlainPassword.create(" password123"), hash),
    ).resolves.toBe(false);
  });

  it("encodes algorithm, iterations, salt and derived key", async () => {
    const hash = await hasher.hash(PASSWORD);
    const [algorithm, iterations, salt, derived] = hash.split("$");

    expect(algorithm).toBe("pbkdf2-sha512");
    expect(iterations).toBe(String(ITERATIONS));
    // 16-byte salt and a 256-bit derived key, base64-encoded.
    expect(atob(salt ?? "")).toHaveLength(16);
    expect(atob(derived ?? "")).toHaveLength(32);
  });

  it("draws a fresh salt per call, so the same password hashes differently", async () => {
    const [first, second] = await Promise.all([
      hasher.hash(PASSWORD),
      hasher.hash(PASSWORD),
    ]);

    expect(first).not.toBe(second);
    expect(first.split("$")[2]).not.toBe(second.split("$")[2]);
    await expect(hasher.verify(PASSWORD, first)).resolves.toBe(true);
    await expect(hasher.verify(PASSWORD, second)).resolves.toBe(true);
  });

  it("reads the iteration count back from the stored hash rather than its own setting", async () => {
    const weak = createPbkdf2PasswordHasher({ iterations: 1_000 });
    const strong = createPbkdf2PasswordHasher({ iterations: 2_000 });

    const weakHash = await weak.hash(PASSWORD);
    const strongHash = await strong.hash(PASSWORD);

    expect(weakHash.split("$")[1]).toBe("1000");
    expect(strongHash.split("$")[1]).toBe("2000");
    // Raising the cost must not invalidate hashes made at the old one.
    await expect(strong.verify(PASSWORD, weakHash)).resolves.toBe(true);
    await expect(weak.verify(PASSWORD, strongHash)).resolves.toBe(true);
  });

  it("defaults to the OWASP count for the algorithm it ships", async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(hash.split("$")[0]).toBe("pbkdf2-sha512");
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000);
  });

  // Written out as literals rather than assembled from `ALGORITHM_ID` and
  // the shipped digest name: building both sides from the constants under
  // test would pass even if the two drifted to a third algorithm together.
  it("writes one identifier and derives with the digest it names", () => {
    expect(ALGORITHM_ID).toBe("pbkdf2-sha512");
    expect(hashFor("pbkdf2-sha512")).toBe("SHA-512");
  });

  // Verifying a hash written before #20 is what keeps the read-only
  // `pbkdf2-sha256` branch honest: nothing writes that form any more, so
  // this hardcoded fixture — captured from the old encoder, for the plain
  // text `password123` — is its only remaining exercise.
  it("still verifies a hash written in the pre-#20 SHA-256 encoding", async () => {
    const legacy = PasswordHash.create(
      "pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=",
    );

    await expect(hasher.verify(PASSWORD, legacy)).resolves.toBe(true);
    await expect(
      hasher.verify(PlainPassword.create("password124"), legacy),
    ).resolves.toBe(false);
  });

  it.each([
    ["wrong field count", "pbkdf2-sha512$1000$c2FsdA=="],
    ["unknown algorithm", "argon2id$1000$c2FsdA==$aGFzaA=="],
    // `hashFor` is a total function rather than a lookup, so this can no
    // longer slip through — the case stays as the regression net for any
    // future rewrite that reaches for a table again.
    ["prototype key as algorithm", "constructor$1000$c2FsdA==$aGFzaA=="],
    ["non-numeric iterations", "pbkdf2-sha512$many$c2FsdA==$aGFzaA=="],
    ["zero iterations", "pbkdf2-sha512$0$c2FsdA==$aGFzaA=="],
    ["malformed base64", "pbkdf2-sha512$1000$!!!$aGFzaA=="],
    // A row claiming an absurd cost turns one login into an unbounded
    // CPU burn, so the ceiling is a refusal to compute rather than a
    // slow success. `Number` would also accept the three spellings
    // below, each of which the encoder can never produce.
    [
      "iterations above the ceiling",
      `pbkdf2-sha512$${MAX_PBKDF2_ITERATIONS + 1}$c2FsdA==$aGFzaA==`,
    ],
    [
      "iterations with surrounding whitespace",
      "pbkdf2-sha512$ 1000 $c2FsdA==$aGFzaA==",
    ],
    ["iterations in exponent notation", "pbkdf2-sha512$1e5$c2FsdA==$aGFzaA=="],
    ["iterations in hexadecimal", "pbkdf2-sha512$0x10$c2FsdA==$aGFzaA=="],
  ])(
    "raises SystemError(DATA_INTEGRITY_ERROR) for a stored hash it cannot read: %s",
    async (_label, stored) => {
      let caught: unknown;
      try {
        await hasher.verify(PASSWORD, PasswordHash.create(stored));
      } catch (error) {
        caught = error;
      }

      expect(isSystemError(caught)).toBe(true);
      expect(isSystemError(caught) && caught.code).toBe("DATA_INTEGRITY_ERROR");
    },
  );
});

// The construction boundary is the only place "this hasher offers a real
// work factor" can be decided — every caller downstream just holds a
// `PasswordHasher`. A guard that only ever runs on values it accepts is
// not a guard, so both directions are walked here.
describe("createPbkdf2PasswordHasher argument validation", () => {
  it.each([
    ["one below the floor", MIN_PBKDF2_ITERATIONS - 1],
    ["no work factor at all", 1],
    ["zero", 0],
    ["negative", -1],
    ["fractional", MIN_PBKDF2_ITERATIONS + 0.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses to build a hasher with %s iterations", (_label, iterations) => {
    expect(() => createPbkdf2PasswordHasher({ iterations })).toThrow(
      /at least/,
    );
  });

  it("accepts exactly the floor, so the check is `<` and not `<=`", async () => {
    const floor = createPbkdf2PasswordHasher({
      iterations: MIN_PBKDF2_ITERATIONS,
    });
    const hash = await floor.hash(PASSWORD);

    expect(hash.split("$")[1]).toBe(String(MIN_PBKDF2_ITERATIONS));
    await expect(floor.verify(PASSWORD, hash)).resolves.toBe(true);
  });

  it("takes the OWASP default for its algorithm when given no argument", async () => {
    const hash = await createPbkdf2PasswordHasher().hash(PASSWORD);
    expect(hash.split("$")[0]).toBe("pbkdf2-sha512");
    expect(hash.split("$")[1]).toBe(String(DEFAULT_PBKDF2_ITERATIONS));
  });
});

// The ceiling's accepting side, kept apart because reaching `derive` at
// ten million iterations is the very cost the ceiling exists to bound:
// stubbing the derivation leaves `parse` as the only thing under test.
describe("createPbkdf2PasswordHasher at the iteration ceiling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a stored hash declaring exactly the ceiling", async () => {
    vi.spyOn(crypto.subtle, "deriveBits").mockResolvedValue(
      new ArrayBuffer(32),
    );

    await expect(
      hasher.verify(
        PASSWORD,
        PasswordHash.create(
          `pbkdf2-sha512$${MAX_PBKDF2_ITERATIONS}$c2FsdA==$aGFzaA==`,
        ),
      ),
    ).resolves.toBe(false);
  });
});

// The other half of the split: a corrupted stored value is
// `DataIntegrityError` (above), a failing computation is `CryptoError`.
// Usecases pass `SystemError` through untouched, so if this translation
// were missing the raw WebCrypto rejection would reach the client as
// `kind: "unknown"` and nothing else in the suite would notice.
describe("createPbkdf2PasswordHasher under a failing WebCrypto", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("translates a deriveBits failure during hash into SystemError(CRYPTO_ERROR)", async () => {
    const cause = new Error("boom");
    vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(cause);

    const caught = await capture(() => hasher.hash(PASSWORD));

    expect(isSystemError(caught)).toBe(true);
    expect(isSystemError(caught) && caught.code).toBe("CRYPTO_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });

  it("translates an importKey failure during hash into SystemError(CRYPTO_ERROR)", async () => {
    const cause = new Error("no key material");
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(cause);

    const caught = await capture(() => hasher.hash(PASSWORD));

    expect(isSystemError(caught)).toBe(true);
    expect(isSystemError(caught) && caught.code).toBe("CRYPTO_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });

  it("translates a deriveBits failure during verify into SystemError(CRYPTO_ERROR)", async () => {
    const stored = await hasher.hash(PASSWORD);
    const cause = new Error("boom");
    vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(cause);

    const caught = await capture(() => hasher.verify(PASSWORD, stored));

    expect(isSystemError(caught)).toBe(true);
    // Deliberately not the `false` that means "wrong password": a
    // computation that never ran says nothing about the password.
    expect(isSystemError(caught) && caught.code).toBe("CRYPTO_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });
});

describe("DEFAULT_PBKDF2_ITERATIONS", () => {
  // The pin holds only while `DUMMY_PASSWORD_HASH_ITERATIONS` infers a
  // literal type. Annotating it `: number` — a plausible readability edit —
  // widens `typeof` and silently drops the pin, letting the two work
  // factors drift apart and reviving the timing oracle. The directive below
  // is the whole assertion: it goes unused the moment the pin is gone, and
  // `@ts-expect-error` with nothing to suppress fails the type check.
  it("is pinned to the literal the login path declares", () => {
    // @ts-expect-error the adapter default is the literal
    // `DUMMY_PASSWORD_HASH_ITERATIONS`, not `number`
    const drifted: typeof DEFAULT_PBKDF2_ITERATIONS = 600_000;
    void drifted;
  });
});

describe("ALGORITHM_ID", () => {
  // The same assertion as above, for the second half of the pin: an
  // algorithm swap moves neither work factor, so the iteration pin cannot
  // see it. Checked against the adapter's declaration rather than the
  // login path's constant, because what has to stay pinned is the
  // identifier this adapter writes — widening the application-side
  // constant to `string` would still be caught here.
  it("is pinned to the literal the login path declares", () => {
    // @ts-expect-error the adapter identifier is the literal
    // `DUMMY_PASSWORD_HASH_ALGORITHM_ID`, not `string`
    const drifted: typeof ALGORITHM_ID = "pbkdf2-sha256";
    void drifted;
  });
});
