import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import { WebCryptoTokenGenerator } from "@repo/core/adapters/webcrypto/webCryptoTokenGenerator";
import type { RequestContainer } from "@repo/core/application/di/types";
import { registerWithPassword } from "@repo/core/application/identity/registerWithPassword";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type { SessionCodec } from "@repo/core/application/ports/sessionCodec";
import { content } from "@repo/core/config";
import { activeKey } from "../crypto/keyring";
import { deriveLocator } from "../crypto/locatorDerivation";
import { createTestGateways, testKeyring, uniqueEmail } from "./helpers";

/** Usecases never touch the codec; a call is a wiring error, so it throws. */
const throwingSessionCodec: SessionCodec = {
  issue() {
    throw new Error("sessionCodec must not be reached from a usecase");
  },
  verify() {
    throw new Error("sessionCodec must not be reached from a usecase");
  },
};

/** The lowest cost the suites pay per registration / login. */
export const TEST_PBKDF2_ITERATIONS = 1000;

/**
 * A production-equivalent request container wired to the two Durable Object
 * bindings, with a cheap PBKDF2 so each derivation stays in the millisecond
 * range.
 */
export function createTestContainer(): RequestContainer {
  return {
    config: { ...content, appUrl: "http://localhost" },
    ...createTestGateways(),
    passwordHasher: createPbkdf2PasswordHasher({
      iterations: TEST_PBKDF2_ITERATIONS,
    }),
    sessionCodec: throwingSessionCodec,
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    tokenGenerator: WebCryptoTokenGenerator,
    logger: ConsoleLogger,
  };
}

export const TEST_PASSWORD = "correct horse battery";

export type RegisteredUser = Readonly<{
  userId: string;
  email: string;
  password: string;
}>;

/** Registers a fresh address and hands back what the suites need to address it. */
export async function registerTestUser(
  container: RequestContainer,
  overrides: Partial<{ email: string; password: string }> = {},
): Promise<RegisteredUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? TEST_PASSWORD;
  const { userId } = await registerWithPassword({
    container,
    input: { email, password },
  });
  return { userId, email, password };
}

/** The bucket the canonical email lives in under the active test key. */
export async function bucketOfEmail(canonicalEmail: string) {
  const locator = await deriveLocator(
    activeKey(testKeyring),
    "email",
    canonicalEmail,
  );
  return {
    generation: locator.generation,
    bucketIndex: locator.bucketIndex,
    hmac: locator.hmac,
  };
}
