import { requireDirectoryRoutingKeyring } from "@repo/core/application/di/secrets";
import { describe, expect, it } from "vitest";
import { createDirectoryLocator } from "../directoryLocator";

/**
 * The bucket-index derivation, as a unit.
 *
 * The routing non-exposure suite only checks the *shape* of `doName`, which a
 * derivation reading the wrong two bytes, applying the wrong modulus or
 * returning the generations in the wrong order would satisfy just as well.
 *
 * The two generations deliberately declare **different** bucket counts, since
 * that is the property `secrets.ts` says cannot be defaulted — a Durable Object
 * name carries the index, never the count, so a previous generation's modulus
 * is unrecoverable if it is not taken from that generation's own entry.
 */

const KEYRING = requireDirectoryRoutingKeyring(
  JSON.stringify([
    {
      generation: 7,
      key: "routing-active-0123456789abcdef0123456789",
      bucketCount: 256,
    },
    {
      generation: 6,
      key: "routing-previous-0123456789abcdef0123456",
      bucketCount: 5,
      role: "previous",
    },
  ]),
);

const locator = createDirectoryLocator(KEYRING);

const CANONICAL = "user@example.com";

/**
 * The index re-derived from the published hmac rather than copied from the
 * implementation: the first two bytes, big-endian, modulo the generation's own
 * bucket count.
 */
function expectedIndex(hmac: string, bucketCount: number): number {
  return Number.parseInt(hmac.slice(0, 4), 16) % bucketCount;
}

describe("directoryLocator.forCanonical", () => {
  it("answers active generation first, then the previous one", async () => {
    const locators = await locator.forCanonical(CANONICAL);
    // The order is a contract, not an accident: `loginWithPassword` walks it
    // expecting the active generation first, and the signup saga takes
    // `locators[0]` as the only bucket it writes to.
    expect(locators.map((entry) => entry.generation)).toEqual([7, 6]);
  });

  it("takes the modulus from each generation's own bucket count", async () => {
    const [active, previous] = await locator.forCanonical(CANONICAL);
    if (previous === undefined) throw new Error("no previous generation");

    expect(active.bucketIndex).toBe(expectedIndex(active.hmac, 256));
    expect(previous.bucketIndex).toBe(expectedIndex(previous.hmac, 5));
    // The previous generation was split into five buckets, so an index taken
    // with the *active* generation's modulus would be out of range almost
    // always — and this canonical is one of the cases where it is.
    expect(previous.bucketIndex).toBeLessThan(5);
    expect(expectedIndex(previous.hmac, 256)).toBeGreaterThanOrEqual(5);
  });

  it("reads the first two bytes big-endian, not little-endian", async () => {
    const [active] = await locator.forCanonical(CANONICAL);
    const swapped =
      ((Number.parseInt(active.hmac.slice(2, 4), 16) << 8) |
        Number.parseInt(active.hmac.slice(0, 2), 16)) %
      256;
    // With `bucketCount = 256` the modulus keeps only the low byte, so the two
    // endiannesses disagree whenever the first two bytes differ — which is what
    // makes this canonical usable as the witness.
    expect(active.hmac.slice(0, 2)).not.toBe(active.hmac.slice(2, 4));
    expect(active.bucketIndex).not.toBe(swapped);
  });

  it("names the Durable Object from the generation and the index alone", async () => {
    const locators = await locator.forCanonical(CANONICAL);
    for (const entry of locators) {
      expect(entry.doName).toBe(
        `dir:g${entry.generation}:b${entry.bucketIndex}`,
      );
      // Identity is the full 256-bit hmac; the index is only a routing
      // decision, and truncating the hmac to it would collapse the two.
      expect(entry.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.doName).not.toContain(CANONICAL);
    }
  });

  it("is deterministic, and separates two canonicals", async () => {
    const first = await locator.forCanonical(CANONICAL);
    const again = await locator.forCanonical(CANONICAL);
    expect(again).toEqual(first);

    const other = await locator.forCanonical("someone.else@example.com");
    expect(other[0].hmac).not.toBe(first[0].hmac);
  });
});
