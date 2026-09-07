import { describe, expect, it } from "vitest";
import { canonicalPayloadDigest } from "../payloadDigest";

// The same rule governs `jobs.payload_digest` and
// `operations.payload_digest`; both writers sit inside a fully
// synchronous `transactionSync`, which is why the derivation cannot use
// `crypto.subtle.digest` and stores the canonical form itself.
describe("canonicalPayloadDigest", () => {
  it("does not depend on the order the keys were written in", () => {
    expect(canonicalPayloadDigest({ b: 1, a: 2 })).toBe(
      canonicalPayloadDigest({ a: 2, b: 1 }),
    );
  });

  it("normalises nested objects too", () => {
    expect(canonicalPayloadDigest({ outer: { z: 1, a: 2 }, first: 3 })).toBe(
      canonicalPayloadDigest({ first: 3, outer: { a: 2, z: 1 } }),
    );
  });

  // Array order is meaning, not incidental ordering, so it is preserved.
  it("preserves array order", () => {
    expect(canonicalPayloadDigest({ xs: [1, 2] })).not.toBe(
      canonicalPayloadDigest({ xs: [2, 1] }),
    );
  });

  it("drops keys whose value is undefined", () => {
    expect(canonicalPayloadDigest({ a: 1, b: undefined })).toBe(
      canonicalPayloadDigest({ a: 1 }),
    );
  });

  it("separates payloads that actually differ", () => {
    expect(canonicalPayloadDigest({ target: "a" })).not.toBe(
      canonicalPayloadDigest({ target: "b" }),
    );
  });

  // The column holds the canonical form itself rather than a hash of it,
  // so the failure mode of a non-cryptographic digest — a difference that
  // goes unnoticed, hence no `ConflictError` — cannot arise.
  it("is reversible into the value it normalised", () => {
    const digest = canonicalPayloadDigest({ b: [1, { d: 4, c: 3 }], a: "x" });
    expect(JSON.parse(digest)).toEqual({ a: "x", b: [1, { c: 3, d: 4 }] });
  });
});
