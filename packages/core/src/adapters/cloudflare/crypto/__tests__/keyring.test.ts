import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  activeKey,
  createMappingKeyring,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
  type MappingKeyEntry,
  MIN_KEYRING_SECRET_LENGTH,
  requireEmailEncryptionKeyring,
} from "../keyring";
import { bucketIndexOf } from "../locatorDerivation";

const SECRET = "test-directory-routing-secret-0123456789";

function mappingEntry(
  overrides: Partial<MappingKeyEntry> = {},
): MappingKeyEntry {
  return {
    role: "active",
    generation: INITIAL_KEY_GENERATION,
    key: SECRET,
    bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
    ...overrides,
  };
}

// `bucketIndexOf` takes its modulo over `2^32`, so any count that is not a
// power of two hands the leading buckets a larger share — and the bucket a
// credential landed in is an attribute of the generation, which no later
// deploy can correct. The factory is the only gate on it: neither the type
// system nor the linter sees the rule.
describe("createMappingKeyring bucket count", () => {
  it.each([
    ["three", 3],
    ["six", 6],
    ["ten", 10],
    ["twelve", 12],
    ["one hundred", 100],
    ["one thousand", 1000],
    ["one below a power of two", INITIAL_DIRECTORY_BUCKET_COUNT - 1],
    ["one above a power of two", INITIAL_DIRECTORY_BUCKET_COUNT + 1],
  ])(
    "refuses a count that is not a power of two: %s",
    (_label, bucketCount) => {
      expect(() =>
        createMappingKeyring([mappingEntry({ bucketCount })]),
      ).toThrow(/power of two/);
    },
  );

  it.each([1, 2, 4, 8, 16, 32, 1024])("accepts %i", (bucketCount) => {
    const keyring = createMappingKeyring([mappingEntry({ bucketCount })]);

    expect(activeKey(keyring).bucketCount).toBe(bucketCount);
  });

  it("holds the shipped count to the same rule", () => {
    expect(INITIAL_DIRECTORY_BUCKET_COUNT).toBe(16);
    expect(
      INITIAL_DIRECTORY_BUCKET_COUNT & (INITIAL_DIRECTORY_BUCKET_COUNT - 1),
    ).toBe(0);
    expect(() =>
      createMappingKeyring([
        mappingEntry({ bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT }),
      ]),
    ).not.toThrow();
  });

  // What the rule buys: over the whole `2^32` range every bucket takes the
  // same share under a power of two, and the leading ones take more under
  // anything else.
  it("is what keeps the leading buckets from taking a larger share", () => {
    // The domain `bucketIndexOf` reads from is the whole of `2^32` — too
    // large to walk, so how many of those values each bucket receives is
    // counted instead. The endpoints below anchor that count to the
    // function: the last partial cycle stops at bucket 5 under ten, and
    // the four above it never see it.
    expect(bucketIndexOf("00000000", 10)).toBe(0);
    expect(bucketIndexOf("ffffffff", 10)).toBe(5);

    const valuesPerBucket = (bucketCount: number) =>
      Array.from(
        { length: bucketCount },
        (_, index) => Math.floor((2 ** 32 - 1 - index) / bucketCount) + 1,
      );

    const balanced = valuesPerBucket(16);
    expect(Math.min(...balanced)).toBe(Math.max(...balanced));

    const biased = valuesPerBucket(10);
    expect(biased[0]).toBeGreaterThan(biased[9]);
  });

  it.each([
    ["zero", 0],
    ["negative", -16],
    ["fractional", 1.5],
  ])(
    "still refuses a count that is not an integer >= 1: %s",
    (_label, bucketCount) => {
      expect(() =>
        createMappingKeyring([mappingEntry({ bucketCount })]),
      ).toThrow(/integer/);
    },
  );
});

// The failure leaves the Durable Object through the RPC value envelope,
// which files anything that is not a `CodedError` under
// `UNCLASSIFIED_ERROR` with the constructor name for a message — so the
// name of the variable only reaches an operator if it is thrown as one.
describe("requireEmailEncryptionKeyring", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    [
      "one character below the floor",
      "a".repeat(MIN_KEYRING_SECRET_LENGTH - 1),
    ],
  ])(
    "raises SystemError(CONFIGURATION_ERROR) when the secret is %s",
    (_label, secret) => {
      let caught: unknown;
      try {
        requireEmailEncryptionKeyring(secret);
      } catch (error) {
        caught = error;
      }

      expect(isSystemError(caught)).toBe(true);
      expect(isSystemError(caught) && caught.code).toBe("CONFIGURATION_ERROR");
      expect(isSystemError(caught) && caught.toSerialized().kind).toBe(
        "system",
      );
      expect(isSystemError(caught) && caught.retryable).toBe(false);
    },
  );

  it("names the variable and never the value", () => {
    const secret = "short-but-secret";
    let caught: unknown;
    try {
      requireEmailEncryptionKeyring(secret);
    } catch (error) {
      caught = error;
    }

    expect(isSystemError(caught) && caught.message).toContain(
      "IDENTITY_MAIL_ENCRYPTION_KEY",
    );
    expect(isSystemError(caught) && caught.message).not.toContain(secret);
  });

  it("builds a single active entry at the initial generation", () => {
    const keyring = requireEmailEncryptionKeyring(SECRET);

    expect(keyring.entries).toHaveLength(1);
    expect(activeKey(keyring).generation).toBe(INITIAL_KEY_GENERATION);
    expect(activeKey(keyring).key).toBe(SECRET);
  });
});
