// Test harness for application-layer integration tests.
//
// Runs inside a Workers isolate via `vitest-pool-workers`; the
// `cloudflare:test` `env.DB` binding is a real D1 SQLite database
// (in-memory under Miniflare). Per-test row cleanup is owned by
// `packages/core/src/adapters/d1/__tests__/setup.ts` (TRUNCATE in `beforeEach`),
// so the harness here is intentionally thin: each call to
// `createTestContainer()` just builds a fresh DI container around the
// shared binding.
import { env } from "cloudflare:test";
import { type Database, getDatabase } from "@repo/core/adapters/d1/client";
import { D1UnitOfWorkProvider } from "@repo/core/adapters/d1/unitOfWork";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { beforeEach } from "vitest";
import { FakePasswordHasher } from "./fakes";

// The raw `db` handle rides along so tests can read back through a side
// channel and prove that a write really landed.
export type TestContainer = RequestContainer & {
  db: Database;
};

export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export type TestContainerOverrides = Partial<
  Pick<RequestContainer, "passwordHasher" | "sessionCodec">
>;

/**
 * `passwordHasher` defaults to the fake: usecase suites register and log
 * in dozens of times, and paying a real key derivation for each buys
 * nothing the WebCrypto adapter's own unit tests do not already cover.
 * Tests where the round trip is the point pass a real hasher.
 */
export function createTestContainer(
  overrides: TestContainerOverrides = {},
): TestContainer {
  const db = getDatabase(env.DB);
  return {
    config: {
      ...content,
      appUrl: "http://localhost:8787",
    },
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    passwordHasher: overrides.passwordHasher ?? new FakePasswordHasher(),
    sessionCodec:
      overrides.sessionCodec ??
      createHmacSessionCodec({ secret: TEST_SESSION_SECRET }),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    db,
  };
}

/**
 * Suite hook that yields a fresh `TestContainer` per test. Row
 * cleanup happens globally in the D1 pool's `setup.ts`, so this is
 * just a constructor + getter — no `afterEach` work is needed.
 */
export function setupTestContainer(
  overrides: TestContainerOverrides = {},
): () => TestContainer {
  let container: TestContainer;
  beforeEach(() => {
    container = createTestContainer(overrides);
  });
  return () => container;
}
