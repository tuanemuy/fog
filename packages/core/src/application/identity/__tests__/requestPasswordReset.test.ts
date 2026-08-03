import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import type { DirectoryLocator } from "@repo/core/lib/directoryLocator";
import { describe, expect, it } from "vitest";
import { content } from "../../../config";
import { FakeLogger } from "../../__tests__/fakes";
import { requestPasswordReset } from "../requestPasswordReset";

/**
 * Which buckets a reset request reaches.
 *
 * The request has to walk every generation the keyring carries, as
 * `loginWithPassword` does. Asking the active one only leaves a user whose
 * mapping a routing-key rotation has not remapped yet able to sign in but
 * unable to reset — the request lands in an empty new-generation bucket, the
 * send finds no mapping and settles `done`, and because the four cases answer
 * identically neither the user nor an operator can see it. A recovery path
 * disappearing silently for the length of a rotation is a security problem, not
 * an availability one.
 */

const LOCATORS: readonly [DirectoryLocator, ...DirectoryLocator[]] = [
  { generation: 2, bucketIndex: 7, hmac: "a".repeat(64), doName: "dir:g2:b7" },
  { generation: 1, bucketIndex: 3, hmac: "b".repeat(64), doName: "dir:g1:b3" },
];

function container(
  asked: DirectoryLocator[],
  locators: readonly [DirectoryLocator, ...DirectoryLocator[]] = LOCATORS,
): RequestContainer {
  return {
    config: { ...content, appUrl: "http://localhost:3000" },
    directoryLocator: { forCanonical: async () => locators },
    directoryStubFactory: (locator: DirectoryLocator) =>
      ({
        requestPasswordReset: async () => {
          asked.push(locator);
          return { v: 1 as const, ok: true as const, value: null };
        },
      }) as unknown as ReturnType<RequestContainer["directoryStubFactory"]>,
    userDataStubFactory: () => {
      throw new Error("a reset request must not reach a User Data DO");
    },
    passwordHasher: {
      hash: async () => {
        throw new Error("a reset request must not hash");
      },
      verify: async () => false,
    },
    sessionCodec: {
      issue: async () => {
        throw new Error("a reset request must not issue a session");
      },
      verify: async () => null,
    },
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: new FakeLogger(),
  };
}

describe("requestPasswordReset", () => {
  it("asks every generation the keyring carries", async () => {
    const asked: DirectoryLocator[] = [];
    await requestPasswordReset({
      container: container(asked),
      input: { email: "user@example.com" },
    });
    expect(asked.map((locator) => locator.doName)).toEqual([
      "dir:g2:b7",
      "dir:g1:b3",
    ]);
  });

  it("asks each of them with that generation's own hmac", async () => {
    const asked: DirectoryLocator[] = [];
    await requestPasswordReset({
      container: container(asked),
      input: { email: "user@example.com" },
    });
    // A bucket is keyed on the hmac of *its* generation; reusing the active
    // one would address the previous bucket and find nothing there either.
    expect(asked.map((locator) => locator.hmac)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
  });

  it("makes the same calls whether or not the address is on file", async () => {
    // The stub answers identically in both runs, which is the production
    // behaviour: a bucket writes its job row unconditionally. So the number of
    // RPCs cannot vary with whether a mapping exists — no probe first, no
    // early exit on the first hit.
    const first: DirectoryLocator[] = [];
    const second: DirectoryLocator[] = [];
    await requestPasswordReset({
      container: container(first),
      input: { email: "registered@example.com" },
    });
    await requestPasswordReset({
      container: container(second),
      input: { email: "unknown@example.com" },
    });
    expect(first).toHaveLength(second.length);
  });

  it("reaches no bucket at all for a malformed address", async () => {
    const asked: DirectoryLocator[] = [];
    await requestPasswordReset({
      container: container(asked),
      input: { email: "not an address" },
    });
    // It never reaches storage and reveals only what the caller already typed.
    expect(asked).toHaveLength(0);
  });
});
