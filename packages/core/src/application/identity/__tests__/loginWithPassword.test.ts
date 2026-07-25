import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import type { UserRepository } from "@repo/core/domain/identity/ports/userRepository";
import { describe, expect, it, vi } from "vitest";
import { content } from "../../../config";
import { FakeLogger } from "../../__tests__/fakes";

type LoginWithPassword =
  typeof import("../loginWithPassword").loginWithPassword;

const WARNING =
  "Login timing equalisation is inactive: the password hasher could not verify the dummy hash";

const UNKNOWN_ADDRESS = {
  email: "nobody@example.com",
  password: "password123",
};

class UnreadableDummyError extends Error {
  constructor() {
    super("stored hash is not in this hasher's encoding");
    this.name = "UnreadableDummyError";
  }
}

// The latch lives in module scope, so the module — not the container — is
// what a test has to re-create to observe the first warning.
async function freshLogin(): Promise<LoginWithPassword> {
  vi.resetModules();
  return (await import("../loginWithPassword")).loginWithPassword;
}

const absentUser: UserRepository = {
  insert: async () => {
    throw new Error("an unknown address must not insert");
  },
  save: async () => {
    throw new Error("an unknown address must not save");
  },
  findById: async () => null,
  findByEmail: async () => null,
};

function container(
  logger: FakeLogger,
  burnFailure: () => Promise<never>,
): RequestContainer {
  return {
    config: { ...content, appUrl: "http://localhost:3000" },
    unitOfWorkProvider: {
      run: (fn) =>
        fn({
          userRepository: absentUser,
          collectEvents: () => {
            throw new Error("login must not enqueue events");
          },
        }),
    },
    passwordHasher: {
      hash: async () => {
        throw new Error("login must not hash");
      },
      verify: burnFailure,
    },
    sessionCodec: {
      issue: async () => {
        throw new Error("login must not issue a session");
      },
      verify: async () => null,
    },
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger,
  };
}

// The usecase always rejects here (an unknown address is
// `INVALID_CREDENTIALS` whether or not the burn threw); these tests are
// about what reached the logger on the way out.
async function attempt(
  login: LoginWithPassword,
  logger: FakeLogger,
  burnFailure: () => Promise<never> = async () => {
    throw new UnreadableDummyError();
  },
): Promise<void> {
  await login({
    container: container(logger, burnFailure),
    input: UNKNOWN_ADDRESS,
  }).catch(() => undefined);
}

// .issue/1/adr.md ADR-034 makes this warning the only signal that login's
// timing equalisation has stopped working, and ADR-047 then latched it.
// Both halves need pinning: a latch that never fires and a latch that
// never holds are equally silent failures of that signal.
describe("burnVerificationTime's unreadable-dummy warning", () => {
  it("reports an unreadable dummy hash, naming the failure's type only", async () => {
    const login = await freshLogin();
    const logger = new FakeLogger();

    await attempt(login, logger);

    // Exact, not `toContain`: the contract is that the failure's *type*
    // travels and its message, stack and cause chain do not, because a
    // swapped-in hasher could have put a `PlainPassword` in any of them.
    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: WARNING,
        meta: { cause: "UnreadableDummyError" },
      },
    ]);
  });

  it("names the type when the hasher rejects with a non-Error", async () => {
    const login = await freshLogin();
    const logger = new FakeLogger();

    await attempt(login, logger, () => Promise.reject("unreadable"));

    expect(logger.byLevel("warn")[0]?.meta).toEqual({ cause: "string" });
  });

  it("stays silent for every later attempt in the same isolate", async () => {
    const login = await freshLogin();
    const first = new FakeLogger();
    const later = new FakeLogger();

    await attempt(login, first);
    await attempt(login, later);
    await attempt(login, later);

    expect(first.entries).toHaveLength(1);
    // A fresh container does not re-arm the latch: the fact being reported
    // belongs to the process, so unauthenticated traffic cannot inflate the
    // signal by arriving on new containers.
    expect(later.entries).toEqual([]);
  });

  // Without this the suite above would still pass against a `warn` that
  // fires on every burn rather than only on a failed one.
  it("says nothing when the hasher can read the dummy hash", async () => {
    const login = await freshLogin();
    const logger = new FakeLogger();
    const readable = container(logger, async () => {
      throw new Error("unreachable");
    });

    await login({
      container: {
        ...readable,
        passwordHasher: {
          ...readable.passwordHasher,
          verify: async () => false,
        },
      },
      input: UNKNOWN_ADDRESS,
    }).catch(() => undefined);

    expect(logger.entries).toEqual([]);
  });
});
