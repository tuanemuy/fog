import { describe, expect, it } from "vitest";
import {
  activeKey,
  createMappingKeyring,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
  type MappingKeyEntry,
} from "../keyring";
import {
  bucketIndexOf,
  bucketLocatorOf,
  decodeMapping,
  deriveLocator,
  directoryBucketLocator,
  encodeMapping,
  LOCATOR_HMAC_HEX_LENGTH,
  ssoCanonical,
} from "../locatorDerivation";

const SECRET = "test-directory-routing-secret-0123456789";
const OTHER_SECRET = "another-directory-routing-secret-01234567";

function entry(overrides: Partial<MappingKeyEntry> = {}): MappingKeyEntry {
  return activeKey(
    createMappingKeyring([
      {
        role: "active",
        generation: INITIAL_KEY_GENERATION,
        key: SECRET,
        bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
        ...overrides,
      },
    ]),
  );
}

// Nothing in the type system or the linter notices the derivation rule
// changing, and a change to it re-buckets every credential that was ever
// stored — it is a change of generation, not of code. These are the only
// gate on it.
describe("deriveLocator", () => {
  it("renders the whole SHA-256 as lowercase hex and never truncates it", async () => {
    const derived = await deriveLocator(entry(), "email", "user@example.com");

    expect(derived.hmac).toHaveLength(LOCATOR_HMAC_HEX_LENGTH);
    expect(derived.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers the same value for the same canonical value and generation", async () => {
    const first = await deriveLocator(entry(), "email", "user@example.com");
    const second = await deriveLocator(entry(), "email", "user@example.com");

    expect(second).toEqual(first);
  });

  it("separates two canonical values, and two keys for one canonical value", async () => {
    const derived = await deriveLocator(entry(), "email", "user@example.com");
    const otherCanonical = await deriveLocator(
      entry(),
      "email",
      "other@example.com",
    );
    const otherKey = await deriveLocator(
      entry({ key: OTHER_SECRET }),
      "email",
      "user@example.com",
    );

    expect(otherCanonical.hmac).not.toBe(derived.hmac);
    expect(otherKey.hmac).not.toBe(derived.hmac);
  });

  // Carried on the entry rather than fixed globally, because the count is
  // an attribute of the generation: a rotation that changes it is what
  // opens a new set of buckets. A power of two, like every real count —
  // `bucketIndexOf` favours the leading buckets under any other value.
  it("keeps the bucket inside the generation's own count", async () => {
    const bucketCount = 8;
    const key = entry({ bucketCount });

    for (let index = 0; index < 64; index += 1) {
      const derived = await deriveLocator(key, "email", `u${index}@e.test`);
      expect(Number.isInteger(derived.bucketIndex)).toBe(true);
      expect(derived.bucketIndex).toBeGreaterThanOrEqual(0);
      expect(derived.bucketIndex).toBeLessThan(bucketCount);
    }
  });

  // Taken from the front of the derived value and never re-hashed, so the
  // writer and the reader cannot end up on different rules.
  it("reads the bucket off the first four bytes of the derived value", async () => {
    const derived = await deriveLocator(entry(), "email", "user@example.com");

    expect(derived.bucketIndex).toBe(
      bucketIndexOf(derived.hmac, INITIAL_DIRECTORY_BUCKET_COUNT),
    );
    expect(bucketIndexOf("00000010", 16)).toBe(0);
    expect(bucketIndexOf("0000001f", 16)).toBe(15);
  });

  it("carries the generation it was derived under into the bucket name", async () => {
    const derived = await deriveLocator(
      entry({ generation: 4 }),
      "email",
      "user@example.com",
    );

    expect(derived.generation).toBe(4);
    expect(bucketLocatorOf(derived)).toBe(
      directoryBucketLocator(4, derived.bucketIndex),
    );
    expect(bucketLocatorOf(derived)).toMatch(/^dir:g4:b\d+$/);
  });
});

// `U+0000` occurs in neither half, so no pair of (provider, subject) can
// be spelled two ways or collide with another pair.
describe("ssoCanonical", () => {
  it("separates the provider from the subject with a value neither can hold", () => {
    const separator = String.fromCharCode(0);

    expect(ssoCanonical("google", "sub-1")).toBe(`google${separator}sub-1`);
    // The pair a plain concatenation would collapse into one value.
    expect(ssoCanonical("google", "sub")).not.toBe(
      ssoCanonical("googles", "ub"),
    );
  });
});

describe("the mapping string", () => {
  it("round-trips through this module and nothing else reads into it", async () => {
    const derived = await deriveLocator(entry(), "email", "user@example.com");
    const encoded = encodeMapping(derived);

    expect(encoded).toBe(
      `g${derived.generation}:b${derived.bucketIndex}:${derived.hmac}`,
    );
    expect(decodeMapping("email", encoded)).toEqual(derived);
  });

  // The kind travels as its own field wherever the mapping does, so
  // putting it inside as well would let the two disagree.
  it("does not carry the kind, and takes it from the argument on the way back", async () => {
    const derived = await deriveLocator(entry(), "email", "user@example.com");
    const encoded = encodeMapping(derived);

    expect(encoded).not.toContain("email");
    expect(decodeMapping("sso", encoded)?.kind).toBe("sso");
  });

  // `null` rather than a throw: the callers that decode are reading stored
  // rows, and the store is what holds the context to call that drift.
  it.each([
    ["empty", ""],
    ["not a mapping at all", "user@example.com"],
    ["a truncated digest", "g1:b0:abcdef"],
    ["upper-case hex", `g1:b0:${"A".repeat(64)}`],
    ["a missing bucket", `g1:${"a".repeat(64)}`],
  ])("refuses %s by answering null", (_label, raw) => {
    expect(decodeMapping("email", raw)).toBeNull();
  });
});
