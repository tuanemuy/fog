// Test harness for application-layer integration tests.
//
// Runs inside a Workers isolate via `vitest-pool-workers`, where the
// `cloudflare:test` bindings are the two real Durable Object namespaces. Data
// cleanup between tests is owned by
// `packages/core/src/adapters/cloudflare/__tests__/setup.ts`, so the harness
// here just assembles a container per test.
//
// It goes through `createRequestContainer` rather than reaching for
// `idFromName` itself. That keeps the Durable-Object selection point where the
// architecture claims it is — one module, checkable by `grep` — and means the
// suites exercise the same wiring production does, stub-error translation
// included.
//
// Importing a concrete adapter here is deliberate and is why
// `application/**/__tests__/` is excluded from the reversed-import check: a
// harness plays the composition root's role, which is to hand the code under
// test the real thing.
import { env } from "cloudflare:test";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import type { RequestContainer } from "@repo/core/application/di/types";
import { content } from "@repo/core/config";
import { beforeEach } from "vitest";
import {
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "../di/secrets";
import { createRequestContainer } from "../di/serverCloudflare";
import { FakePasswordHasher } from "./fakes";

export type TestContainer = RequestContainer;

export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";
export const TEST_AI_CLIENT_TOKEN_SECRET =
  "test-ai-client-secret-0123456789abcdef";

export const TEST_DIRECTORY_ROUTING_SECRET = JSON.stringify([
  {
    generation: 1,
    key: "test-directory-routing-secret-0123456789",
    bucketCount: 256,
  },
]);

export type TestContainerOverrides = Partial<
  Pick<RequestContainer, "passwordHasher" | "sessionCodec">
>;

/**
 * `passwordHasher` defaults to the fake: usecase suites register and log in
 * dozens of times, and paying a real key derivation for each buys nothing the
 * WebCrypto adapter's own unit tests do not already cover. Tests where the
 * round trip is the point pass a real hasher.
 */
export function createTestContainer(
  overrides: TestContainerOverrides = {},
): TestContainer {
  const container = createRequestContainer({
    ...content,
    appUrl: "http://localhost:8787",
    bindings: {
      userData: env.USER_DATA,
      identityDirectory: env.IDENTITY_DIRECTORY,
    },
    secrets: {
      sessionSecret: requireSessionSecret(TEST_SESSION_SECRET),
      aiClientTokenSecret: requireAiClientTokenSecret(
        TEST_AI_CLIENT_TOKEN_SECRET,
      ),
      directoryRoutingKeyring: requireDirectoryRoutingKeyring(
        TEST_DIRECTORY_ROUTING_SECRET,
      ),
    },
  });

  return {
    ...container,
    passwordHasher: overrides.passwordHasher ?? new FakePasswordHasher(),
    sessionCodec:
      overrides.sessionCodec ??
      createHmacSessionCodec({ secret: TEST_SESSION_SECRET }),
  };
}

/** Suite hook yielding a fresh `TestContainer` per test. */
export function setupTestContainer(
  overrides: TestContainerOverrides = {},
): () => TestContainer {
  let container: TestContainer;
  beforeEach(() => {
    container = createTestContainer(overrides);
  });
  return () => container;
}
