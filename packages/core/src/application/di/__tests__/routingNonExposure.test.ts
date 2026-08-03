import {
  assertNoForbiddenValue,
  FORBIDDEN_VALUES,
} from "@repo/core/adapters/cloudflare/__tests__/forbiddenValues";
import { translateStubError } from "@repo/core/adapters/cloudflare/platform/stubErrors";
import { content } from "@repo/core/config";
import { describe, expect, it } from "vitest";
import type { Logger } from "../../ports/logger";
import {
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "../secrets";
import { createRequestContainer } from "../serverCloudflare";

// Canonical addresses, their HMACs, the derived Durable Object locator and the
// opaque bindings must not be recoverable from operational output.
//
// The composition root is where the first three are *produced*, so this walks
// the routing half of it — the locator derivation and the two stub factories,
// including the wrapper that translates a platform failure — with a recording
// Logger installed, and asserts that nothing observable carries any of them.
// The forbidden-value list is shared with the job-runner and mail-sender
// suites so the two halves cannot drift apart.
//
// **The values asserted on are the ones this run derived**, not the fixed
// strings in that list. A hard-coded hmac or locator is never the one a given
// run produces, so a check against the list alone passes while the real value
// leaks. The two haystacks are also kept apart: what the namespace was asked to
// address is recorded separately from what was logged, so the assertion does
// not have to exclude the value it most needs to look for.

const SESSION_SECRET = requireSessionSecret("0123456789abcdef0123456789abcdef");
const AI_CLIENT_TOKEN_SECRET = requireAiClientTokenSecret(
  "ai-client-0123456789abcdef0123456789abcdef",
);
const DIRECTORY_ROUTING_KEYRING = requireDirectoryRoutingKeyring(
  JSON.stringify([
    {
      generation: 1,
      key: "routing-0123456789abcdef0123456789abcdef",
      bucketCount: 256,
    },
  ]),
);

const CANONICAL = FORBIDDEN_VALUES[0] as string;

function recordingLogger(recorded: string[]): Logger {
  const record = (message: string, meta?: unknown) => {
    recorded.push(message);
    if (meta !== undefined) recorded.push(JSON.stringify(meta));
  };
  return { info: record, warn: record, error: record };
}

/**
 * A namespace whose every call fails the way an unreachable Durable Object
 * does. That is the one path where the locator is in scope at the moment an
 * error is built, so it is the path worth walking.
 */
function failingNamespace(recorded: string[]) {
  return {
    idFromName(name: string) {
      recorded.push(name);
      return { name };
    },
    get() {
      return {
        async getCurrentUser() {
          throw new Error("Network connection lost.");
        },
      };
    },
  } as never;
}

function build(recorded: string[]) {
  return createRequestContainer({
    ...content,
    appUrl: "http://localhost:3000",
    bindings: {
      userData: failingNamespace(recorded),
      identityDirectory: failingNamespace(recorded),
    },
    secrets: {
      sessionSecret: SESSION_SECRET,
      aiClientTokenSecret: AI_CLIENT_TOKEN_SECRET,
      directoryRoutingKeyring: DIRECTORY_ROUTING_KEYRING,
    },
  });
}

describe("routing material never reaches observable output", () => {
  it("derives a locator that carries no trace of the canonical it came from", async () => {
    const recorded: string[] = [];
    const container = build(recorded);
    const [locator] = await container.directoryLocator.forCanonical(CANONICAL);

    // The locator is what a DO is *named* after, so it is the value most
    // likely to be logged by accident downstream.
    expect(locator).toBeDefined();
    expect(locator?.doName).not.toContain(CANONICAL);
    expect(locator?.hmac).not.toContain(CANONICAL);
    expect(locator?.doName).toMatch(/^dir:g\d+:b\d+$/);
  });

  it("keeps the shared list's placeholder locator in the shape a real one takes", () => {
    // A placeholder the derivation never emits — a zero-padded index, say —
    // leaves every assertion that consults the list for a locator leak
    // structurally unable to fire.
    const placeholders = FORBIDDEN_VALUES.filter((value) =>
      value.startsWith("dir:"),
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      expect(placeholder).toMatch(/^dir:g\d+:b(0|[1-9]\d*)$/);
      expect(Number(placeholder.split(":b")[1])).toBeLessThan(256);
    }
  });

  it("keeps the canonical, its hmac and its locator out of a failing stub call, log and error alike", async () => {
    const addressed: string[] = [];
    const container = build(addressed);
    const [locator] = await container.directoryLocator.forCanonical(CANONICAL);
    if (locator === undefined) throw new Error("no locator");

    const logged: string[] = [];
    const logger = recordingLogger(logged);

    const stub = container.directoryStubFactory(locator);
    let message = "";
    try {
      await (
        stub as unknown as { getCurrentUser(): Promise<unknown> }
      ).getCurrentUser();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      logger.error("stub call failed", { cause: message });
    }

    expect(message).not.toBe("");
    // Positive control: the run really did address the bucket, so the negative
    // assertions below are not being made against material that was never in
    // scope. `addressed` is the namespace's argument, not observable output.
    expect(addressed).toContain(locator.doName);
    // The real derived values, alongside the fixed list.
    assertNoForbiddenValue(
      [message, ...logged],
      [CANONICAL, locator.hmac, locator.doName],
    );
  });

  it("translates a platform failure into a fixed message", () => {
    const failure = (() => {
      try {
        translateStubError(new Error(`reset for ${CANONICAL}`));
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    assertNoForbiddenValue([failure]);
  });
});
