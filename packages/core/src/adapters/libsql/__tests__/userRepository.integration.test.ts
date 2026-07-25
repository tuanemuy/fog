import { isConflictError, isSystemError } from "@repo/core/application/errors";
import { User } from "@repo/core/domain/identity/entity";
import {
  Email,
  PasswordHash,
  SsoProvider,
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import { users } from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

// Mirrors `d1/__tests__/userRepository.integration.test.ts`: the two
// adapters implement the same port and must agree on rehydration, OCC and
// error classification, so the two suites assert the same guarantees.
const NOW = new Date("2026-01-01T00:00:00.000Z");
const HASH = PasswordHash.create("pbkdf2-sha256$1$c2FsdA==$aGFzaA==");

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-300000000000`;
};

const passwordUser = (email: string) =>
  User.registerWithPassword({ id: nextId(), email, passwordHash: HASH }, NOW)
    .entity;

const ssoUser = (email: string) =>
  User.registerWithSso(
    {
      id: nextId(),
      email,
      provider: SsoProvider.create("apple"),
      providerSubject: `sub-${email}`,
    },
    NOW,
  ).entity;

async function insert(container: TestContainer, user: User): Promise<void> {
  await container.unitOfWorkProvider.run(async ({ userRepository }) => {
    await userRepository.insert(user);
  });
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the repository to reject");
}

// Drizzle wraps the driver error in one that only names the statement,
// so the constraint name lives further down the chain.
function causeChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}

const rawRow = (overrides: Partial<typeof users.$inferInsert>) => ({
  id: nextId(),
  email: `raw-${counter}@example.com`,
  authMethod: "password",
  passwordHash: HASH as string,
  ssoProvider: null,
  ssoProviderSubject: null,
  trashRetentionDays: 30,
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("LibsqlUserRepository (integration)", () => {
  let container: TestContainer | null = null;
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("rehydrates a password account with its OCC token", async () => {
    container = await createTestContainer();
    const user = passwordUser("password@example.com");
    await insert(container, user);

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );

    expect(found?.entity).toEqual(user);
    expect(found?.expectedVersion).toBe(0);
  });

  it("rehydrates an SSO account", async () => {
    container = await createTestContainer();
    const user = ssoUser("sso@example.com");
    await insert(container, user);

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );

    expect(found?.entity).toEqual(user);
    expect(User.isSsoUser(found?.entity as User)).toBe(true);
  });

  it("finds a row through a differently-cased address", async () => {
    container = await createTestContainer();
    const user = passwordUser("Mixed.Case@Example.COM");
    await insert(container, user);

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) =>
        userRepository.findByEmail(Email.create("  MIXED.case@example.com ")),
    );

    expect(found?.entity.id).toBe(user.id);
  });

  it("reports a miss as null rather than an error", async () => {
    container = await createTestContainer();

    const [byId, byEmail] = await container.unitOfWorkProvider.run(
      async ({ userRepository }) =>
        Promise.all([
          userRepository.findById(UserId.create(nextId())),
          userRepository.findByEmail(Email.create("nobody@example.com")),
        ]),
    );

    expect(byId).toBeNull();
    expect(byEmail).toBeNull();
  });

  it("commits a save that carries the current version token", async () => {
    container = await createTestContainer();
    const user = passwordUser("occ-ok@example.com");
    await insert(container, user);

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );
    if (!found) throw new Error("seeded user disappeared");
    const { entity: updated } = User.changeTrashRetentionDays(
      found.entity,
      TrashRetentionDays.create(7),
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.save(updated, found.expectedVersion);
    });

    const reread = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );
    expect(reread?.entity.trashRetentionDays).toBe(7);
    expect(reread?.expectedVersion).toBe(1);
  });

  it("rejects a save carrying a stale version token", async () => {
    container = await createTestContainer();
    const seeded = container;
    const user = passwordUser("occ-stale@example.com");
    await insert(seeded, user);

    const found = await seeded.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );
    if (!found) throw new Error("seeded user disappeared");
    const { entity: updated } = User.changeTrashRetentionDays(
      found.entity,
      TrashRetentionDays.create(7),
      NOW,
    );
    await seeded.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.save(updated, found.expectedVersion);
    });

    const error = await capture(() =>
      seeded.unitOfWorkProvider.run(async ({ userRepository }) => {
        await userRepository.save(updated, found.expectedVersion);
      }),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe(
      "OPTIMISTIC_LOCK_FAILURE",
    );
  });

  it("raises ConflictError(UNIQUE_VIOLATION) when the email collides", async () => {
    container = await createTestContainer();
    const seeded = container;
    await insert(seeded, passwordUser("dup@example.com"));

    const error = await capture(() =>
      insert(seeded, passwordUser("dup@example.com")),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe("UNIQUE_VIOLATION");
  });

  // The partial index is what lets the usecase-side translation read any
  // UNIQUE_VIOLATION raised by a `PasswordUser` insert as
  // EMAIL_ALREADY_REGISTERED: with both SSO columns NULL the index cannot
  // match, so the email index is the only one left that could have fired.
  // Losing the `WHERE` clause would make that reading wrong, and nothing
  // else would notice.
  it("keeps password accounts out of the partial SSO identity index", async () => {
    container = await createTestContainer();
    const seeded = container;

    await insert(seeded, passwordUser("first@example.com"));
    await insert(seeded, passwordUser("second@example.com"));

    expect(await seeded.db.select().from(users)).toHaveLength(2);
  });

  it("rejects a second SSO identity with the same provider and subject", async () => {
    container = await createTestContainer();
    const seeded = container;
    const shared = (email: string) =>
      User.registerWithSso(
        {
          id: nextId(),
          email,
          provider: SsoProvider.create("apple"),
          providerSubject: "shared-subject",
        },
        NOW,
      ).entity;

    await insert(seeded, shared("one@example.com"));

    const error = await capture(() =>
      insert(seeded, shared("two@example.com")),
    );

    expect(isConflictError(error)).toBe(true);
    expect(isConflictError(error) && error.code).toBe("UNIQUE_VIOLATION");
  });

  // Raw inserts on purpose: these rows cannot be built through the
  // domain, and the point is that the database refuses them even when a
  // future writer bypasses it. `mapDbError` flattens every CHECK to the
  // same code, so the constraint *name* in the driver message is the only
  // evidence that the right invariant fired.
  it.each([
    [
      "a password row carrying an SSO identity",
      { ssoProvider: "apple", ssoProviderSubject: "sub" },
      /users_auth_method_sum/,
    ],
    [
      "an SSO row carrying a password hash",
      { authMethod: "sso", ssoProvider: "apple", ssoProviderSubject: "sub" },
      /users_auth_method_sum/,
    ],
    [
      "an unknown auth method",
      { authMethod: "ldap" },
      /users_auth_method_(sum|valid)/,
    ],
    [
      "an unsupported SSO provider",
      {
        authMethod: "sso",
        passwordHash: null,
        ssoProvider: "github",
        ssoProviderSubject: "sub",
      },
      /users_sso_provider_valid/,
    ],
    [
      "an empty SSO subject",
      {
        authMethod: "sso",
        passwordHash: null,
        ssoProvider: "apple",
        ssoProviderSubject: "",
      },
      /users_sso_subject_nonempty/,
    ],
    [
      "a retention window below one day",
      { trashRetentionDays: 0 },
      /users_trash_retention_positive/,
    ],
  ])("refuses %s", async (_label, overrides, constraint) => {
    container = await createTestContainer();
    const seeded = container;

    const error = await capture(() =>
      seeded.db.insert(users).values(rawRow(overrides)),
    );

    expect(causeChain(error)).toMatch(constraint);
    expect(await seeded.db.select().from(users)).toHaveLength(0);
  });

  it("raises SystemError(DATA_INTEGRITY_ERROR) for a stored id the generator disowns", async () => {
    container = await createTestContainer();
    const seeded = container;
    await seeded.db.insert(users).values(rawRow({ id: "not-a-uuid-v7" }));

    const error = await capture(() =>
      seeded.unitOfWorkProvider.run(async ({ userRepository }) =>
        userRepository.findById(UserId.create("not-a-uuid-v7")),
      ),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("DATA_INTEGRITY_ERROR");
  });

  it("raises SystemError(DATA_INTEGRITY_ERROR) for a row that violates a domain invariant", async () => {
    container = await createTestContainer();
    const seeded = container;
    const id = nextId();
    await seeded.db.insert(users).values(rawRow({ id, email: "not-an-email" }));

    const error = await capture(() =>
      seeded.unitOfWorkProvider.run(async ({ userRepository }) =>
        userRepository.findById(UserId.create(id)),
      ),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe("DATA_INTEGRITY_ERROR");
  });
});
