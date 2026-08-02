import { env } from "cloudflare:test";
import { FakePasswordHasher } from "@repo/core/application/__tests__/fakes";
import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { createHmacSessionCodec } from "../../webcrypto/hmacSessionCodec";
import { type Database, getDatabase } from "../client";
import { D1UnitOfWorkProvider } from "../unitOfWork";

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
 * Builds a fresh container around the test-isolate's `env.DB` D1 binding.
 *
 * The binding is a singleton per Workers isolate but row cleanup is
 * driven by the file-level `setup.ts` (TRUNCATE in `beforeEach`), so
 * each test sees a clean database.
 *
 * `passwordHasher` defaults to the fake so the cost of key derivation
 * does not multiply across the suite; pass a real one for the few tests
 * where the round trip itself is the subject.
 */
export function createTestContainer(
  overrides: TestContainerOverrides = {},
): TestContainer {
  const db = getDatabase(env.DB);
  return {
    config: {
      ...content,
      appUrl: "http://localhost:3000",
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
