import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/lib/secretLengths";
import { describe, expect, it } from "vitest";
import {
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "../secrets";

// These are the gates between "the deployment set nothing" and "every token is
// forgeable", and the only reason the brands mean anything. Their accepting
// side is exercised by `requestContainerConfig.test.ts`; what has to be pinned
// here is that they actually refuse.
//
// The length comes from `lib/secretLengths.ts` because that is where the floor
// is defined — `createHmacTokenCodec` asserts the same one at construction.
// Reading it here rather than restating 32 keeps this suite honest if the floor
// is raised, and keeps the two checks from splitting: a DI layer that branded a
// secret the codec then rejects would throw a bare `Error` outside the error
// middleware, i.e. a plain 500 on every request.
const KEY = "a".repeat(MIN_SESSION_SECRET_LENGTH);

const singleKeySecrets = [
  ["SESSION_SECRET", requireSessionSecret],
  ["AI_CLIENT_TOKEN_SECRET", requireAiClientTokenSecret],
] as const;

describe.each(singleKeySecrets)("%s", (name, require_) => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["a placeholder short of the floor", "change-me"],
    [
      "one character below the floor",
      "a".repeat(MIN_SESSION_SECRET_LENGTH - 1),
    ],
  ])("refuses a secret that is %s", (_label, secret) => {
    expect(() => require_(secret)).toThrow(new RegExp(name));
  });

  it("names only the variable, never the value it was given", () => {
    const secret = `leaked-${"a".repeat(MIN_SESSION_SECRET_LENGTH - 8)}`;

    let caught: unknown;
    try {
      require_(secret.slice(0, -1));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("leaked");
  });

  it("accepts a secret of exactly the floor, so the check is `<` and not `<=`", () => {
    expect(require_(KEY)).toBe(KEY);
  });
});

describe("requireDirectoryRoutingKeyring", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    generation: 1,
    key: KEY,
    bucketCount: 256,
    ...overrides,
  });

  it("accepts one active generation", () => {
    const keyring = requireDirectoryRoutingKeyring(JSON.stringify([entry()]));
    expect(keyring.entries).toHaveLength(1);
  });

  // Lookups walk active first, then previous, so the order has to be
  // normalised rather than taken from however the env var happened to be
  // written.
  it("orders the active generation before the previous one", () => {
    const keyring = requireDirectoryRoutingKeyring(
      JSON.stringify([
        entry({ generation: 1, role: "previous", bucketCount: 128 }),
        entry({ generation: 2 }),
      ]),
    );
    expect(keyring.entries.map((e) => e.generation)).toEqual([2, 1]);
  });

  it.each([
    ["unset", undefined],
    ["not JSON", "not-json"],
    ["an empty array", "[]"],
  ])("refuses a keyring that is %s", (_label, raw) => {
    expect(() => requireDirectoryRoutingKeyring(raw)).toThrow(
      /DIRECTORY_ROUTING_SECRET/,
    );
  });

  it("refuses a repeated generation", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(
        JSON.stringify([entry(), entry({ role: "previous" })]),
      ),
    ).toThrow(/repeats generation/);
  });

  it("refuses more than one active generation", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(
        JSON.stringify([entry(), entry({ generation: 2 })]),
      ),
    ).toThrow(/exactly one active/);
  });

  it("refuses more than one previous generation", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(
        JSON.stringify([
          entry({ generation: 3 }),
          entry({ generation: 2, role: "previous" }),
          entry({ generation: 1, role: "previous" }),
        ]),
      ),
    ).toThrow(/at most one previous/);
  });

  // The DO name carries the bucket *index*, not the count, so a previous
  // generation whose modulus was never written down is unrecoverable.
  it("refuses an entry with no bucketCount", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(
        JSON.stringify([{ generation: 1, key: KEY }]),
      ),
    ).toThrow(/bucketCount/);
  });

  it("refuses a bucketCount below 1", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(
        JSON.stringify([entry({ bucketCount: 0 })]),
      ),
    ).toThrow(/bucketCount/);
  });

  it("refuses a key below the floor", () => {
    expect(() =>
      requireDirectoryRoutingKeyring(JSON.stringify([entry({ key: "short" })])),
    ).toThrow(/at least/);
  });

  it("never echoes the key material it refused", () => {
    let caught: unknown;
    try {
      requireDirectoryRoutingKeyring(
        JSON.stringify([entry({ key: "leaked-but-far-too-short" })]),
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain("leaked");
  });
});
