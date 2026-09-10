import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  activeKey,
  createKeyCommitment,
  createMappingKeyring,
  encryptionKeyringFromEnv,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
  type KeyCommitment,
  keyCommitmentFromEnv,
  keyDigestOf,
  type MappingKeyEntry,
  MIN_KEYRING_SECRET_LENGTH,
  mappingKeyringFromEnv,
  previousKey,
  requireEmailEncryptionKeyring,
  verifyKeyEntryAgainstCommitment,
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

// The JSON variables of `spec/rotation/index.md` (鍵材料の配布形) and the
// commitment's four-point check (TC-keyRotation-001, the unit half): a
// forged key, a forged generation, a forged bucket count, and the two
// correct keys with their labels swapped are each refused, and the
// refusal names none of the four.
describe("the keyring variables and the commitment", () => {
  const ACTIVE = "active-directory-routing-secret-0123456789";
  const PREVIOUS = "previous-directory-routing-secret-0123456789";
  const keyringJson = JSON.stringify([
    { role: "active", generation: 2, key: ACTIVE, bucketCount: 16 },
    { role: "previous", generation: 1, key: PREVIOUS, bucketCount: 16 },
  ]);

  async function commitment(
    overrides: Partial<{
      activeDigest: string;
      previousDigest: string;
      activeGeneration: number;
      activeBucketCount: number;
    }> = {},
  ): Promise<KeyCommitment> {
    return createKeyCommitment([
      {
        role: "active",
        generation: overrides.activeGeneration ?? 2,
        keyDigest: overrides.activeDigest ?? (await keyDigestOf(ACTIVE)),
        bucketCount: overrides.activeBucketCount ?? 16,
      },
      {
        role: "previous",
        generation: 1,
        keyDigest: overrides.previousDigest ?? (await keyDigestOf(PREVIOUS)),
        bucketCount: 16,
      },
    ]);
  }

  it("reads the JSON keyring, in probe order, and ignores the single variable while it is set", () => {
    const keyring = mappingKeyringFromEnv(keyringJson, "x".repeat(40));
    expect(keyring.entries.map((e) => [e.role, e.generation])).toEqual([
      ["active", 2],
      ["previous", 1],
    ]);
    expect(activeKey(keyring).key).toBe(ACTIVE);
    expect(previousKey(keyring)?.key).toBe(PREVIOUS);
  });

  it("falls back to a single generation 1 from the single variable, with no previous", () => {
    const keyring = mappingKeyringFromEnv(undefined, SECRET);
    expect(keyring.entries).toHaveLength(1);
    expect(activeKey(keyring)).toEqual({
      role: "active",
      generation: INITIAL_KEY_GENERATION,
      key: SECRET,
      bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
    });
    expect(previousKey(keyring)).toBeNull();
    expect(mappingKeyringFromEnv("", SECRET).entries).toHaveLength(1);
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an array", '{"role":"active"}'],
    [
      "two actives",
      JSON.stringify([
        { role: "active", generation: 1, key: ACTIVE, bucketCount: 16 },
        { role: "active", generation: 2, key: PREVIOUS, bucketCount: 16 },
      ]),
    ],
    [
      "a short key",
      JSON.stringify([
        { role: "active", generation: 1, key: "short", bucketCount: 16 },
      ]),
    ],
    [
      "a bucket count that is not a power of two",
      JSON.stringify([
        { role: "active", generation: 1, key: ACTIVE, bucketCount: 12 },
      ]),
    ],
  ])(
    "refuses a keyring variable that is %s, without echoing it",
    (_l, json) => {
      let caught: unknown;
      try {
        mappingKeyringFromEnv(json, undefined);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String((caught as Error).message)).toContain(
        "DIRECTORY_ROUTING_KEYRING",
      );
      expect(String((caught as Error).message)).not.toContain(ACTIVE);
    },
  );

  it("reads the encryption keyring the same way, as a SystemError on the state side", () => {
    const keyring = encryptionKeyringFromEnv(
      JSON.stringify([
        { role: "previous", generation: 1, key: PREVIOUS },
        { role: "active", generation: 2, key: ACTIVE },
      ]),
      undefined,
    );
    expect(activeKey(keyring).generation).toBe(2);
    expect(previousKey(keyring)?.generation).toBe(1);
    let caught: unknown;
    try {
      encryptionKeyringFromEnv("[]", undefined);
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught) && caught.code).toBe("CONFIGURATION_ERROR");
  });

  it("reads the commitment, and null while it is unset", async () => {
    expect(keyCommitmentFromEnv(undefined)).toBeNull();
    expect(keyCommitmentFromEnv("")).toBeNull();
    const parsed = keyCommitmentFromEnv(
      JSON.stringify([
        {
          role: "active",
          generation: 2,
          keyDigest: await keyDigestOf(ACTIVE),
          bucketCount: 16,
        },
      ]),
    );
    expect(parsed?.entries).toHaveLength(1);
    let caught: unknown;
    try {
      keyCommitmentFromEnv(
        '[{"role":"active","generation":2,"keyDigest":"nope","bucketCount":16}]',
      );
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught) && caught.code).toBe("CONFIGURATION_ERROR");
  });

  it("accepts the entries the commitment was built from", async () => {
    const c = await commitment();
    await expect(
      verifyKeyEntryAgainstCommitment(
        { role: "active", generation: 2, key: ACTIVE, bucketCount: 16 },
        c,
        "active",
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyKeyEntryAgainstCommitment(
        { role: "previous", generation: 1, key: PREVIOUS, bucketCount: 16 },
        c,
        "previous",
      ),
    ).resolves.toBeUndefined();
  });

  const active: MappingKeyEntry = {
    role: "active",
    generation: 2,
    key: ACTIVE,
    bucketCount: 16,
  };

  it.each([
    [
      "a forged key",
      { ...active, key: "forged-directory-routing-secret-0123456789" },
      "active",
    ],
    ["a forged generation", { ...active, generation: 3 }, "active"],
    ["a forged bucket count", { ...active, bucketCount: 32 }, "active"],
    [
      "the previous key labelled active",
      { ...active, role: "active", generation: 1, key: PREVIOUS },
      "active",
    ],
    [
      "the active key labelled previous",
      { ...active, role: "previous" },
      "previous",
    ],
    ["the right key presented under the other role", active, "previous"],
  ] as const)(
    "refuses %s with one CONFIGURATION_ERROR that names none of the four points",
    async (_label, entry, role) => {
      let caught: unknown;
      try {
        await verifyKeyEntryAgainstCommitment(entry, await commitment(), role);
      } catch (error) {
        caught = error;
      }
      expect(isSystemError(caught) && caught.code).toBe("CONFIGURATION_ERROR");
      const message = isSystemError(caught) ? caught.message : "";
      expect(message).not.toMatch(/digest|generation|bucket|role/i);
      expect(message).not.toContain(ACTIVE);
    },
  );
});
