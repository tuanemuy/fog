import { describe, expect, it } from "vitest";
import {
  fromBase64,
  fromBase64Url,
  timingSafeEqual,
  toBase64,
  toBase64Url,
} from "../encoding";

const bytes = (...values: number[]) => new Uint8Array(values);

// Padding is decided by `length % 3`, so 0-3 bytes plus one length past
// the first wrap covers every arm of the encoder.
const ROUND_TRIP: ReadonlyArray<readonly [string, Uint8Array]> = [
  ["empty", bytes()],
  ["one byte (two pad characters)", bytes(0x61)],
  ["two bytes (one pad character)", bytes(0x61, 0x62)],
  ["three bytes (no padding)", bytes(0x61, 0x62, 0x63)],
  ["four bytes (wraps into a second group)", bytes(0x61, 0x62, 0x63, 0x64)],
  ["33 bytes, the length of a signature plus one", new Uint8Array(33).fill(7)],
  ["every byte value", new Uint8Array(256).map((_, i) => i)],
];

describe("toBase64 / fromBase64", () => {
  it.each(ROUND_TRIP)("round-trips %s", (_label, value) => {
    expect(fromBase64(toBase64(value))).toEqual(value);
  });

  it("emits the standard alphabet, padded to a multiple of four", () => {
    for (const [, value] of ROUND_TRIP) {
      const encoded = toBase64(value);
      expect(encoded.length % 4).toBe(0);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    }
  });

  // The stored password hash carries salt and derived key in this
  // encoding, so a change here invalidates every persisted hash. Pinning
  // one known vector makes that a failing test rather than a silent
  // logout of the entire user base.
  it("encodes a known vector", () => {
    expect(toBase64(bytes(0x61, 0x62, 0x63))).toBe("YWJj");
    expect(toBase64(bytes(0xfb, 0xff, 0xbf))).toBe("+/+/");
  });
});

describe("toBase64Url / fromBase64Url", () => {
  it.each(ROUND_TRIP)("round-trips %s", (_label, value) => {
    expect(fromBase64Url(toBase64Url(value))).toEqual(value);
  });

  // The token rides in a cookie value, where `+` `/` `=` are all either
  // reserved or a quoting hazard.
  it("emits only cookie-safe characters", () => {
    for (const [, value] of ROUND_TRIP) {
      expect(toBase64Url(value)).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("substitutes the two alphabet characters and strips padding", () => {
    expect(toBase64Url(bytes(0xfb, 0xff, 0xbf))).toBe("-_-_");
    expect(toBase64Url(bytes(0x61))).toBe("YQ");
    expect(toBase64(bytes(0x61))).toBe("YQ==");
  });

  // The decoding is not canonical: a standard-base64 spelling of the same
  // bytes decodes identically, so several distinct strings map onto one
  // value. Harmless for signature verification (bytes are what get
  // compared) but the reason a token string must never be used as an
  // identity to compare, index or deduplicate on.
  it("decodes the standard alphabet to the same bytes as the url one", () => {
    expect(fromBase64Url("-_-_")).toEqual(fromBase64Url("+/+/"));
  });

  // The narrower half of that: padding is computed from the length of the
  // input, so anything that lands off a multiple of four is refused even
  // though `atob` alone would have tolerated it.
  it.each([
    ["trailing whitespace", "YWJj "],
    ["embedded whitespace", "YW Jj"],
    ["redundant padding", "YWJjZA==="],
    ["outside the alphabet", "!!!!"],
  ])("refuses %s", (_label, value) => {
    expect(() => fromBase64Url(value)).toThrow();
  });

  // The other side of that boundary, pinned so the JSDoc is not read as
  // "whitespace is rejected": the length check is the only filter, and
  // whitespace that keeps the length a multiple of four rides through on
  // `atob`'s own leniency.
  it.each([
    [
      "trailing whitespace that keeps a multiple of four",
      "YWJj    ",
      bytes(0x61, 0x62, 0x63),
    ],
    ["whitespace standing in for stripped padding", "YQ  ", bytes(0x61)],
  ])("accepts %s", (_label, value, expected) => {
    expect(fromBase64Url(value)).toEqual(expected);
  });
});

describe("timingSafeEqual", () => {
  it("reports equal byte sequences as equal", () => {
    expect(timingSafeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
    expect(timingSafeEqual(bytes(), bytes())).toBe(true);
  });

  it("reports differing lengths as unequal", () => {
    expect(timingSafeEqual(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(bytes(), bytes(0))).toBe(false);
  });

  // Every position has to be compared, not just the first mismatch: a
  // short-circuit would let the running time report how much of a
  // candidate secret was right. Walking the difference across the whole
  // sequence is the observable stand-in for that.
  it.each([0, 1, 2, 15, 31])(
    "reports a difference at position %i as unequal",
    (index) => {
      const a = new Uint8Array(32).fill(9);
      const b = new Uint8Array(32).fill(9);
      b[index] = 8;

      expect(timingSafeEqual(a, b)).toBe(false);
    },
  );

  it("reports a difference in any single bit as unequal", () => {
    expect(timingSafeEqual(bytes(0b0000_0000), bytes(0b0000_0001))).toBe(false);
    expect(timingSafeEqual(bytes(0b1000_0000), bytes(0b0000_0000))).toBe(false);
  });
});
