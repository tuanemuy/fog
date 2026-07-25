import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { describe, expect, it } from "vitest";
import { requireSessionSecret } from "../secrets";

// This is the one gate between "the deployment set no `SESSION_SECRET`"
// and "every session token is forgeable", and the only reason the
// `SessionSecret` brand means anything. Its accepting side is exercised
// by `requestContainerConfig.test.ts`; what has to be pinned here is that
// it actually refuses.
//
// The length comes from the adapter's exported constant because that is
// where the floor is defined — `createHmacSessionCodec` asserts the same
// one at construction. Reading it here rather than restating 32 keeps
// this suite honest if the floor is raised, and keeps the two checks
// from splitting: a DI layer that branded a secret the codec then
// rejects would throw a bare `Error` outside the error middleware, i.e.
// a plain 500 on every request.
describe("requireSessionSecret", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["a placeholder short of the floor", "change-me"],
    [
      "one character below the floor",
      "a".repeat(MIN_SESSION_SECRET_LENGTH - 1),
    ],
  ])("refuses a secret that is %s", (_label, secret) => {
    expect(() => requireSessionSecret(secret)).toThrow(/SESSION_SECRET/);
  });

  it("names only the variable, never the value it was given", () => {
    const secret = `leaked-${"a".repeat(MIN_SESSION_SECRET_LENGTH - 8)}`;

    let caught: unknown;
    try {
      requireSessionSecret(secret.slice(0, -1));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("leaked");
  });

  it("accepts a secret of exactly the floor, so the check is `<` and not `<=`", () => {
    const shortest = "a".repeat(MIN_SESSION_SECRET_LENGTH);

    expect(requireSessionSecret(shortest)).toBe(shortest);
  });
});
