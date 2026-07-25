import { isConflictError } from "@repo/core/application/errors";
import { User } from "@repo/core/domain/identity/entity";
import { IdentityEvents } from "@repo/core/domain/identity/events";
import {
  PasswordHash,
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

describe("LibsqlUnitOfWorkProvider (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  const HASH = PasswordHash.create("pbkdf2-sha256$1$c2FsdA==$aGFzaA==");
  let counter = 0;
  const nextUser = (label: string) => {
    counter += 1;
    const suffix = counter.toString(16).padStart(4, "0");
    return User.registerWithPassword(
      {
        id: `0193e7d0-${suffix}-7000-8000-100000000000`,
        email: `${label}-${suffix}@example.com`,
        passwordHash: HASH,
      },
      NOW,
    );
  };

  let container: TestContainer | null = null;
  const openContainer = async () => {
    container = await createTestContainer();
    return container;
  };
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("defers all writes until run() resolves (no row visible mid-callback)", async () => {
    const c = await openContainer();
    const { entity: user } = nextUser("deferred");

    let midRunRows: unknown[] = [];
    await c.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.insert(user);
      // Side-channel read against the outer handle: the transaction has
      // not been opened yet, so the row must not be visible.
      midRunRows = await c.db.select().from(schema.users);
    });

    expect(midRunRows).toHaveLength(0);

    const afterRows = await c.db.select().from(schema.users);
    expect(afterRows).toHaveLength(1);
  });

  it("persists collected outbox events atomically with the aggregate write", async () => {
    const c = await openContainer();
    const { entity: user, eventDrafts } = nextUser("with-events");

    await c.unitOfWorkProvider.run(
      async ({ userRepository, collectEvents }) => {
        await userRepository.insert(user);
        collectEvents(eventDrafts);
      },
    );

    const userRows = await c.db.select().from(schema.users);
    const outboxRows = await c.db.select().from(schema.outboxEvents);
    expect(userRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventType).toBe("identity.userRegistered");
    expect(outboxRows[0]?.aggregateId).toBe(user.id);
  });

  it("rolls back outbox events when the aggregate write hits an OCC failure", async () => {
    const c = await openContainer();
    const { entity: created } = nextUser("occ-rollback");
    await c.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.insert(created);
    });

    const found = await c.unitOfWorkProvider.run(async ({ userRepository }) =>
      userRepository.findById(created.id),
    );
    if (!found) throw new Error("seeded user disappeared");
    const { entity: bumped } = User.changeTrashRetentionDays(
      found.entity,
      TrashRetentionDays.create(7),
      NOW,
    );
    await c.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.save(bumped, found.expectedVersion);
    });

    let caught: unknown;
    try {
      await c.unitOfWorkProvider.run(
        async ({ userRepository, collectEvents }) => {
          await userRepository.save(bumped, found.expectedVersion);
          collectEvents([IdentityEvents.passwordChanged(created.id, NOW)]);
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    // Not merely "some conflict": the same UoW can also raise
    // UNIQUE_VIOLATION, and a stale-version write reported as one would
    // mean the OCC guard never fired.
    expect(isConflictError(caught) && caught.code).toBe(
      "OPTIMISTIC_LOCK_FAILURE",
    );

    // Prior UoWs did not collect events; the failing UoW's `collectEvents`
    // must have rolled back along with its UPDATE.
    const outboxRows = await c.db.select().from(schema.outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });

  it("returns the callback's value on successful commit", async () => {
    const c = await openContainer();
    const { entity: user } = nextUser("return-value");

    const id = await c.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.insert(user);
      return user.id;
    });
    expect(id).toBe(user.id);
  });

  it("supports a read-only UoW (no writes / no transaction)", async () => {
    const c = await openContainer();
    const result = await c.unitOfWorkProvider.run(async ({ userRepository }) =>
      userRepository.findById(UserId.create("nonexistent-id")),
    );
    expect(result).toBeNull();
  });
});
