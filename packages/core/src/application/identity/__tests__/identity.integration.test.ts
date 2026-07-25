import * as schema from "@repo/core/adapters/d1/schema";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import {
  isConflictError,
  isNotFoundError,
  isSystemError,
  isValidationError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { User } from "@repo/core/domain/identity/entity";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  Email,
  SsoProvider,
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakePasswordHasher } from "../../__tests__/fakes";
import {
  createTestContainer,
  type TestContainer,
} from "../../__tests__/helpers";
import { getCurrentUser } from "../getCurrentUser";
import { loginWithPassword } from "../loginWithPassword";
import { registerWithPassword } from "../registerWithPassword";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const PASSWORD = "password123";

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the usecase to reject");
}

async function seedSsoUser(
  container: TestContainer,
  email: string,
): Promise<string> {
  const { entity } = User.registerWithSso(
    {
      id: container.idGenerator.next(),
      email,
      provider: SsoProvider.create("google"),
      providerSubject: `sub-${email}`,
    },
    NOW,
  );
  await container.unitOfWorkProvider.run(async ({ userRepository }) => {
    await userRepository.insert(entity);
  });
  return entity.id;
}

const throwingHasher = (method: "hash" | "verify"): PasswordHasher => {
  const delegate = new FakePasswordHasher();
  const boom = () => {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      `WebCrypto refused to ${method}`,
    );
  };
  return {
    hash: async (plain) => (method === "hash" ? boom() : delegate.hash(plain)),
    verify: async (plain, hash) =>
      method === "verify" ? boom() : delegate.verify(plain, hash),
  };
};

// Renaming `users` away is the only way to make a non-constraint DB
// fault (ADR-019), and a rename that outlives its test takes the pool's
// global `DELETE FROM users` with it — and every later test in the file.
// So the rename and its undo are never written apart: both fault
// injectors below own a `finally`, and the table name lives in one
// place.
const HIDDEN_USERS_TABLE = "users_hidden";

const hideUsersTable = (container: TestContainer) =>
  container.db.run(
    sql.raw(`ALTER TABLE users RENAME TO ${HIDDEN_USERS_TABLE}`),
  );

const revealUsersTable = (container: TestContainer) =>
  container.db.run(
    sql.raw(`ALTER TABLE ${HIDDEN_USERS_TABLE} RENAME TO users`),
  );

/** Makes every `users` statement fail with a non-constraint DB error. */
async function withUsersTableHidden<T>(
  container: TestContainer,
  fn: () => Promise<T>,
): Promise<T> {
  await hideUsersTable(container);
  try {
    return await fn();
  } finally {
    await revealUsersTable(container);
  }
}

/**
 * Runs `fn` against a container whose unit of work hides the `users`
 * table *after* the usecase has registered its insert, so the batch
 * fails at flush time on the write rather than on the pre-check read.
 *
 * That ordering is what makes the injection honest, and `hidden` records
 * it: if the usecase never reached `insert`, the test asserted nothing
 * about writes and must fail rather than pass quietly.
 */
async function withInsertBreakingProvider<T>(
  base: TestContainer,
  fn: (container: TestContainer) => Promise<T>,
): Promise<T> {
  let hidden = false;
  const unitOfWorkProvider: UnitOfWorkProvider = {
    run: (callback) =>
      base.unitOfWorkProvider.run((ctx) => {
        const wrapped: UnitOfWorkContext = {
          collectEvents: (drafts) => ctx.collectEvents(drafts),
          userRepository: {
            findById: (id) => ctx.userRepository.findById(id),
            findByEmail: (email) => ctx.userRepository.findByEmail(email),
            save: (user, expectedVersion) =>
              ctx.userRepository.save(user, expectedVersion),
            insert: async (user) => {
              await ctx.userRepository.insert(user);
              await hideUsersTable(base);
              hidden = true;
            },
          },
        };
        return callback(wrapped);
      }),
  };

  try {
    const result = await fn({ ...base, unitOfWorkProvider });
    expect(hidden).toBe(true);
    return result;
  } finally {
    if (hidden) await revealUsersTable(base);
  }
}

const userRows = (container: TestContainer) =>
  container.db.select().from(schema.users);
const outboxRows = (container: TestContainer) =>
  container.db.select().from(schema.outboxEvents);

describe("registerWithPassword (integration)", () => {
  // TC-registerWithPassword-001
  it("creates a version-0 PasswordUser and its userRegistered event in one commit (TC-registerWithPassword-001)", async () => {
    const container = createTestContainer();

    const { userId } = await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    const users = await userRows(container);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: userId,
      email: "user@example.com",
      authMethod: "password",
      ssoProvider: null,
      ssoProviderSubject: null,
      trashRetentionDays: 30,
      version: 0,
    });
    expect(users[0]?.passwordHash).not.toContain(PASSWORD);

    const outbox = await outboxRows(container);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "identity.userRegistered",
      aggregateId: userId,
      processedAt: null,
    });
    expect(outbox[0]?.payload).toEqual({ userId, authMethod: "password" });
  });

  // TC-registerWithPassword-002
  it("stores the trimmed, lowercased address (TC-registerWithPassword-002)", async () => {
    const container = createTestContainer();

    await registerWithPassword({
      container,
      input: { email: "  User@Example.COM  ", password: PASSWORD },
    });

    const users = await userRows(container);
    expect(users[0]?.email).toBe("user@example.com");
  });

  // TC-registerWithPassword-003
  it("rejects a malformed address with BusinessRuleError and writes nothing (TC-registerWithPassword-003)", async () => {
    const container = createTestContainer();

    const error = await capture(() =>
      registerWithPassword({
        container,
        input: { email: "not-an-email", password: PASSWORD },
      }),
    );

    expect(isBusinessRuleError(error)).toBe(true);
    expect(isBusinessRuleError(error) && error.code).toBe(
      "IDENTITY_INVALID_EMAIL",
    );
    expect(await userRows(container)).toHaveLength(0);
    expect(await outboxRows(container)).toHaveLength(0);
  });

  // TC-registerWithPassword-005 — the VO's own boundary tests stop at
  // `Email.create`; spec's expectation is that the *registration*
  // succeeds, which is the only way the transport ceiling in
  // `components/auth/schema.ts` and the domain limit are checked against
  // each other.
  it("registers an address that is exactly 320 characters (TC-registerWithPassword-005)", async () => {
    const container = createTestContainer();
    const email = `${"a".repeat(308)}@example.com`;
    expect(email).toHaveLength(320);

    const { userId } = await registerWithPassword({
      container,
      input: { email, password: PASSWORD },
    });

    const users = await userRows(container);
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(userId);
    expect(users[0]?.email).toBe(email);
    expect(users[0]?.email).toHaveLength(320);
  });

  // TC-registerWithPassword-007 / TC-registerWithPassword-008
  it.each([
    ["shortest accepted", 8],
    ["longest accepted", 128],
  ])(
    "registers with a %s password of exactly %i characters (TC-registerWithPassword-007 / TC-registerWithPassword-008)",
    async (_label, length) => {
      const container = createTestContainer();
      const password = "p".repeat(length);
      expect(password).toHaveLength(length);

      const { userId } = await registerWithPassword({
        container,
        input: { email: `user${length}@example.com`, password },
      });

      const users = await userRows(container);
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(userId);
      expect(users[0]?.passwordHash).not.toContain(password);
      expect(await outboxRows(container)).toHaveLength(1);
    },
  );

  // TC-registerWithPassword-011
  it("rejects a duplicate address at the pre-check (TC-registerWithPassword-011)", async () => {
    const container = createTestContainer();
    await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    const error = await capture(() =>
      registerWithPassword({
        container,
        input: { email: "user@example.com", password: "another-password" },
      }),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );
    expect(await userRows(container)).toHaveLength(1);
  });

  // TC-registerWithPassword-012
  it("refuses to link a password account onto an existing SSO address (TC-registerWithPassword-012)", async () => {
    const container = createTestContainer();
    const ssoId = await seedSsoUser(container, "user@example.com");

    const error = await capture(() =>
      registerWithPassword({
        container,
        input: { email: "user@example.com", password: PASSWORD },
      }),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );
    const users = await userRows(container);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: ssoId,
      authMethod: "sso",
      passwordHash: null,
    });
  });

  // TC-registerWithPassword-013
  it("detects a duplicate that only matches after normalisation (TC-registerWithPassword-013)", async () => {
    const container = createTestContainer();
    await registerWithPassword({
      container,
      input: { email: "USER@Example.com", password: PASSWORD },
    });

    const error = await capture(() =>
      registerWithPassword({
        container,
        input: { email: "  user@example.com ", password: PASSWORD },
      }),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );
    expect(await userRows(container)).toHaveLength(1);
  });

  // TC-registerWithPassword-014 — both callers pass the `findByEmail`
  // pre-check, so the loser only learns of the collision when
  // `users_email_uq` fires at flush time. The assertions stay loose
  // enough to hold under either failure shape (D1 aborts the losing
  // batch; libSQL fails the transaction).
  it("collapses a concurrent registration race onto EMAIL_ALREADY_REGISTERED (TC-registerWithPassword-014)", async () => {
    const container = createTestContainer();
    const input = { email: "race@example.com", password: PASSWORD };

    const results = await Promise.allSettled([
      registerWithPassword({ container, input }),
      registerWithPassword({ container, input }),
    ]);

    // Exactly one winner: "nobody registered" would satisfy every
    // assertion below on its own, and that is the regression this test
    // exists to catch.
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);

    const failure = results.find((r) => r.status === "rejected");
    expect(isConflictError(failure?.reason)).toBe(true);
    expect(isConflictError(failure?.reason) && failure?.reason.code).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );
    // The pre-check path (`findByEmail` saw the row) raises without a
    // `cause`; only ADR-008's UNIQUE_VIOLATION reading carries one. This
    // is the sole test that walks that catch, so it pins the path too —
    // otherwise the reading could die and nothing would notice.
    expect(
      isConflictError(failure?.reason) && failure?.reason.cause,
    ).toBeDefined();

    expect(await userRows(container)).toHaveLength(1);
    expect(await outboxRows(container)).toHaveLength(1);
  });

  // TC-registerWithPassword-015
  it("surfaces a hashing failure as SystemError without creating a user (TC-registerWithPassword-015)", async () => {
    const container = createTestContainer({
      passwordHasher: throwingHasher("hash"),
    });

    const error = await capture(() =>
      registerWithPassword({
        container,
        input: { email: "user@example.com", password: PASSWORD },
      }),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CRYPTO_ERROR");
    expect(await userRows(container)).toHaveLength(0);
    expect(await outboxRows(container)).toHaveLength(0);
  });

  // TC-registerWithPassword-016 — a non-constraint failure on purpose: a
  // constraint violation would be classified as `ConflictError`, and a
  // UNIQUE / PK one would be read as EMAIL_ALREADY_REGISTERED (ADR-008),
  // so neither would ever reach `SystemError`.
  it("rolls back and reports SystemError when the insert hits a DB fault (TC-registerWithPassword-016)", async () => {
    const base = createTestContainer();

    const error = await withInsertBreakingProvider(base, (container) =>
      capture(() =>
        registerWithPassword({
          container,
          input: { email: "user@example.com", password: PASSWORD },
        }),
      ),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("DATABASE_ERROR");
    expect(await userRows(base)).toHaveLength(0);
    expect(await outboxRows(base)).toHaveLength(0);
  });
});

describe("loginWithPassword (integration)", () => {
  async function seedPasswordUser(
    container: TestContainer,
    email: string,
    password: string = PASSWORD,
  ): Promise<string> {
    const { userId } = await registerWithPassword({
      container,
      input: { email, password },
    });
    return userId;
  }

  // TC-loginWithPassword-001
  it("returns the userId for correct credentials (TC-loginWithPassword-001)", async () => {
    const container = createTestContainer();
    const userId = await seedPasswordUser(container, "user@example.com");

    await expect(
      loginWithPassword({
        container,
        input: { email: "user@example.com", password: PASSWORD },
      }),
    ).resolves.toEqual({ userId });
  });

  // TC-loginWithPassword-002
  it("matches on the normalised address (TC-loginWithPassword-002)", async () => {
    const container = createTestContainer();
    const userId = await seedPasswordUser(container, "user@example.com");

    await expect(
      loginWithPassword({
        container,
        input: { email: "  User@EXAMPLE.com  ", password: PASSWORD },
      }),
    ).resolves.toEqual({ userId });
  });

  // TC-loginWithPassword-003
  it("rejects an unknown address as INVALID_CREDENTIALS (TC-loginWithPassword-003)", async () => {
    const container = createTestContainer();

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "nobody@example.com", password: PASSWORD },
      }),
    );

    expect(isValidationError(error)).toBe(true);
    expect(isValidationError(error) && error.code).toBe("INVALID_CREDENTIALS");
  });

  // TC-loginWithPassword-004
  it("rejects a wrong password as INVALID_CREDENTIALS (TC-loginWithPassword-004)", async () => {
    const container = createTestContainer();
    await seedPasswordUser(container, "user@example.com");

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "user@example.com", password: "wrong-password" },
      }),
    );

    expect(isValidationError(error)).toBe(true);
    expect(isValidationError(error) && error.code).toBe("INVALID_CREDENTIALS");
  });

  // TC-loginWithPassword-005
  it("does not reveal that an address belongs to an SSO account (TC-loginWithPassword-005)", async () => {
    const container = createTestContainer();
    await seedSsoUser(container, "sso@example.com");

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "sso@example.com", password: PASSWORD },
      }),
    );

    expect(isValidationError(error)).toBe(true);
    expect(isValidationError(error) && error.code).toBe("INVALID_CREDENTIALS");
  });

  // TC-loginWithPassword-006
  it("converts a malformed address into INVALID_CREDENTIALS, not BusinessRuleError (TC-loginWithPassword-006)", async () => {
    const container = createTestContainer();

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "not-an-email", password: PASSWORD },
      }),
    );

    expect(isBusinessRuleError(error)).toBe(false);
    expect(isValidationError(error)).toBe(true);
    expect(isValidationError(error) && error.code).toBe("INVALID_CREDENTIALS");
  });

  // TC-loginWithPassword-007
  it("converts a too-short password into INVALID_CREDENTIALS, not PasswordTooWeak (TC-loginWithPassword-007)", async () => {
    const container = createTestContainer();

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "user@example.com", password: "short" },
      }),
    );

    expect(isBusinessRuleError(error)).toBe(false);
    expect(isValidationError(error)).toBe(true);
    expect(isValidationError(error) && error.code).toBe("INVALID_CREDENTIALS");
  });

  // TC-loginWithPassword-008 — the uniformity is the feature: any
  // difference between these would let an attacker probe which addresses
  // are registered and how.
  it("answers every failure mode identically (TC-loginWithPassword-008)", async () => {
    const container = createTestContainer();
    await seedPasswordUser(container, "user@example.com");
    await seedSsoUser(container, "sso@example.com");

    const inputs = [
      { email: "nobody@example.com", password: PASSWORD },
      { email: "user@example.com", password: "wrong-password" },
      { email: "sso@example.com", password: PASSWORD },
      { email: "not-an-email", password: PASSWORD },
      { email: "user@example.com", password: "short" },
    ];

    const serialized = [];
    for (const input of inputs) {
      const error = await capture(() =>
        loginWithPassword({ container, input }),
      );
      expect(isValidationError(error)).toBe(true);
      if (isValidationError(error)) serialized.push(error.toSerialized());
    }

    expect(serialized).toHaveLength(inputs.length);
    for (const entry of serialized) {
      expect(entry).toEqual(serialized[0]);
    }
    expect(serialized[0]).toEqual({
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
      retryable: false,
    });
  });

  // The serialized answers above are identical; response time has to be
  // too, or the wall clock reports what the message refuses to. Counting
  // verifications is the observable stand-in for that cost — a timing
  // assertion would be flaky, this one is not.
  it("pays for one verification on every credential path, matched or not", async () => {
    const counted: string[] = [];
    const delegate = new FakePasswordHasher();
    const container = createTestContainer({
      passwordHasher: {
        hash: (plain) => delegate.hash(plain),
        verify: async (plain, hash) => {
          counted.push(hash);
          return delegate.verify(plain, hash);
        },
      },
    });
    await seedPasswordUser(container, "user@example.com");
    await seedSsoUser(container, "sso@example.com");

    for (const email of [
      "nobody@example.com",
      "sso@example.com",
      "user@example.com",
    ]) {
      await capture(() =>
        loginWithPassword({
          container,
          input: { email, password: "wrong-password" },
        }),
      );
    }

    expect(counted).toHaveLength(3);
  });

  // TC-loginWithPassword-009 — the one case that pays for a real key
  // derivation, since the boundary being checked is the round trip.
  it("verifies an 8-character password through the real hasher (TC-loginWithPassword-009)", async () => {
    const container = createTestContainer({
      passwordHasher: createPbkdf2PasswordHasher({ iterations: 1_000 }),
    });
    const userId = await seedPasswordUser(
      container,
      "user@example.com",
      "pass1234",
    );

    await expect(
      loginWithPassword({
        container,
        input: { email: "user@example.com", password: "pass1234" },
      }),
    ).resolves.toEqual({ userId });

    // The only place a real derivation reaches storage, so it is also the
    // only place "the column holds the hasher's output, not what the user
    // typed" can be observed for real rather than through a fake.
    const users = await userRows(container);
    expect(users[0]?.passwordHash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(users[0]?.passwordHash).not.toContain("pass1234");
  });

  // TC-loginWithPassword-010
  it("surfaces a findByEmail DB fault as SystemError (TC-loginWithPassword-010)", async () => {
    const container = createTestContainer();

    const error = await withUsersTableHidden(container, () =>
      capture(() =>
        loginWithPassword({
          container,
          input: { email: "user@example.com", password: PASSWORD },
        }),
      ),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("DATABASE_ERROR");
  });

  // TC-loginWithPassword-011 — a failed computation is a SystemError,
  // deliberately distinct from the `false` that means "wrong password".
  it("distinguishes a failing verify computation from a mismatch (TC-loginWithPassword-011)", async () => {
    const seeding = createTestContainer();
    await seedPasswordUser(seeding, "user@example.com");
    const container = createTestContainer({
      passwordHasher: throwingHasher("verify"),
    });

    const error = await capture(() =>
      loginWithPassword({
        container,
        input: { email: "user@example.com", password: PASSWORD },
      }),
    );

    expect(isValidationError(error)).toBe(false);
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("CRYPTO_ERROR");
  });
});

describe("getCurrentUser (integration)", () => {
  // TC-getCurrentUser-001 / TC-getCurrentUser-005
  it("returns the password account's projection with the default retention (TC-getCurrentUser-001 / TC-getCurrentUser-005)", async () => {
    const container = createTestContainer();
    const { userId } = await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    await expect(
      getCurrentUser({ container, input: { userId } }),
    ).resolves.toEqual({
      userId,
      email: "user@example.com",
      authMethod: "password",
      trashRetentionDays: 30,
    });
  });

  // TC-getCurrentUser-002
  it("reports authMethod sso for an SSO account (TC-getCurrentUser-002)", async () => {
    const container = createTestContainer();
    const userId = await seedSsoUser(container, "sso@example.com");

    const user = await getCurrentUser({ container, input: { userId } });
    expect(user.authMethod).toBe("sso");
    expect(user.email).toBe("sso@example.com");
  });

  // TC-getCurrentUser-003
  it("exposes no credential material for a password account (TC-getCurrentUser-003)", async () => {
    const container = createTestContainer();
    const { userId } = await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    const user = await getCurrentUser({ container, input: { userId } });

    expect(Object.keys(user).sort()).toEqual([
      "authMethod",
      "email",
      "trashRetentionDays",
      "userId",
    ]);
    const stored = (await userRows(container))[0];
    expect(JSON.stringify(user)).not.toContain(stored?.passwordHash ?? "?");
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
  });

  // TC-getCurrentUser-004
  it("exposes no SSO subject for an SSO account (TC-getCurrentUser-004)", async () => {
    const container = createTestContainer();
    const userId = await seedSsoUser(container, "sso@example.com");

    const user = await getCurrentUser({ container, input: { userId } });

    expect(Object.keys(user).sort()).toEqual([
      "authMethod",
      "email",
      "trashRetentionDays",
      "userId",
    ]);
    expect(JSON.stringify(user)).not.toContain("google");
    expect(JSON.stringify(user)).not.toContain("sub-sso@example.com");
  });

  // TC-getCurrentUser-006
  it("reflects a changed retention window (TC-getCurrentUser-006)", async () => {
    const container = createTestContainer();
    const { userId } = await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    await container.unitOfWorkProvider.run(
      async ({ userRepository, collectEvents }) => {
        const found = await userRepository.findById(UserId.create(userId));
        if (!found) throw new Error("seeded user disappeared");
        const { entity, eventDrafts } = User.changeTrashRetentionDays(
          found.entity,
          TrashRetentionDays.create(1),
          NOW,
        );
        await userRepository.save(entity, found.expectedVersion);
        collectEvents(eventDrafts);
      },
    );

    const user = await getCurrentUser({ container, input: { userId } });
    expect(user.trashRetentionDays).toBe(1);
  });

  // TC-getCurrentUser-007
  it("reports NotFoundError when the session outlived the account (TC-getCurrentUser-007)", async () => {
    const container = createTestContainer();

    const error = await capture(() =>
      getCurrentUser({
        container,
        input: { userId: container.idGenerator.next() },
      }),
    );

    expect(isNotFoundError(error)).toBe(true);
    expect(isNotFoundError(error) && error.code).toBe("USER_NOT_FOUND");
  });

  // TC-getCurrentUser-008 — spec states this at the usecase, not at
  // `UserId.create`: a session that decodes to a blank subject must be
  // refused before any lookup happens, and nothing must be written or
  // read on the way out.
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])(
    "refuses a %s userId with BusinessRuleError (TC-getCurrentUser-008)",
    async (_label, userId) => {
      const container = createTestContainer();

      const error = await capture(() =>
        getCurrentUser({ container, input: { userId } }),
      );

      expect(isBusinessRuleError(error)).toBe(true);
      expect(isBusinessRuleError(error) && error.code).toBe(
        "IDENTITY_INVALID_USER_ID",
      );
    },
  );

  // TC-getCurrentUser-009
  it("surfaces a findById DB fault as SystemError (TC-getCurrentUser-009)", async () => {
    const container = createTestContainer();
    const { userId } = await registerWithPassword({
      container,
      input: { email: "user@example.com", password: PASSWORD },
    });

    const error = await withUsersTableHidden(container, () =>
      capture(() => getCurrentUser({ container, input: { userId } })),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("DATABASE_ERROR");
  });
});

describe("email lookup after normalisation (integration)", () => {
  it("finds the stored row through a differently-cased address", async () => {
    const container = createTestContainer();
    const { userId } = await registerWithPassword({
      container,
      input: { email: "  Mixed.Case@Example.COM ", password: PASSWORD },
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) =>
        userRepository.findByEmail(Email.create("MIXED.CASE@example.com")),
    );

    expect(found?.entity.id).toBe(userId);
  });
});
