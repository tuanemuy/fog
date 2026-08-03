import { describe, expect, it } from "vitest";
import { payloadDigest } from "../table";

/**
 * The digest decides whether a re-enqueue under an existing `operation_key` is
 * a duplicate request or a `ConflictError`, and the failure mode is silent: a
 * collision drops the second request and keeps only its pull-forward, with no
 * error anywhere. So both properties below are load-bearing rather than tidy.
 */
describe("payloadDigest", () => {
  it("is a function of the value, not of key insertion order", () => {
    // `JSON.stringify` follows insertion order, so without a stable
    // serialisation these two differ — meaning the same logical payload would be
    // rejected as a conflicting one purely because a caller wrote the object
    // literal the other way round.
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(payloadDigest({ outer: { x: "1", y: "2" }, list: [1, 2] })).toBe(
      payloadDigest({ list: [1, 2], outer: { y: "2", x: "1" } }),
    );
  });

  it("keeps array order significant", () => {
    expect(payloadDigest([1, 2])).not.toBe(payloadDigest([2, 1]));
  });

  it("is 128 bits wide", () => {
    expect(payloadDigest({ kind: "email" })).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates payloads that differ only by a transposition", () => {
    expect(payloadDigest({ hmac: "ab" })).not.toBe(
      payloadDigest({ hmac: "ba" }),
    );
    expect(payloadDigest({ a: "xy" })).not.toBe(payloadDigest({ a: "yx" }));
  });

  it("separates the empty payload from a null one only when they differ", () => {
    expect(payloadDigest(null)).toBe(payloadDigest(undefined));
    expect(payloadDigest({})).not.toBe(payloadDigest(null));
  });
});
