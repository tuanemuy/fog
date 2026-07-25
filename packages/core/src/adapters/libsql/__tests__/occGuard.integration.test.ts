import { User } from "@repo/core/domain/identity/entity";
import { IdentityEvents } from "@repo/core/domain/identity/events";
import {
  PasswordHash,
  TrashRetentionDays,
} from "@repo/core/domain/identity/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import { occGuard, outboxEvents } from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

/**
 * End-to-end check that the `_occ_guard` CHECK-constraint trick aborts an
 * entire libSQL interactive transaction when an OCC-guarded UPDATE matches
 * zero rows. Mirrors the D1 adapter's `occGuard.integration.test.ts`
 * because the guarantee is identical: any path through the UoW that fires
 * the guard must leave `_occ_guard` empty and roll back co-batched writes.
 */
describe("OCC guard via _occ_guard CHECK constraint (libSQL)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  const HASH = PasswordHash.create("pbkdf2-sha256$1$c2FsdA==$aGFzaA==");
  let counter = 0;
  const nextUser = (label: string) => {
    counter += 1;
    const suffix = counter.toString(16).padStart(4, "0");
    return User.registerWithPassword(
      {
        id: `0193e7d0-${suffix}-7000-8000-400000000000`,
        email: `${label}-${suffix}@example.com`,
        passwordHash: HASH,
      },
      NOW,
    );
  };

  let container: TestContainer | null = null;
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("keeps _occ_guard empty across a successful commit", async () => {
    container = await createTestContainer();
    const { entity: user, eventDrafts } = nextUser("ok");
    await container.unitOfWorkProvider.run(
      async ({ userRepository, collectEvents }) => {
        await userRepository.insert(user);
        collectEvents(eventDrafts);
      },
    );

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(user.id),
    );
    if (!found) return;
    const { entity: updated } = User.changeTrashRetentionDays(
      found.entity,
      TrashRetentionDays.create(7),
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.save(updated, found.expectedVersion);
    });

    const guardRows = await container.db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("keeps _occ_guard empty after a failed OCC commit", async () => {
    container = await createTestContainer();
    const { entity: created } = nextUser("fail");
    await container.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.insert(created);
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ userRepository }) => userRepository.findById(created.id),
    );
    if (!found) return;
    const { entity: bumped } = User.changeTrashRetentionDays(
      found.entity,
      TrashRetentionDays.create(7),
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ userRepository }) => {
      await userRepository.save(bumped, found.expectedVersion);
    });

    let threw = false;
    try {
      await container.unitOfWorkProvider.run(
        async ({ userRepository, collectEvents }) => {
          await userRepository.save(bumped, found.expectedVersion);
          collectEvents([IdentityEvents.passwordChanged(created.id, NOW)]);
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Guard table must stay empty — the CHECK aborts the transaction before
    // any row can persist on either the success or conflict path.
    const guardRows = await container.db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
    // Co-batched outbox insert was rolled back along with the failing
    // UPDATE — this is the property that makes "writes ⇔ outbox" atomicity
    // hold under the libSQL adapter.
    const outboxRows = await container.db.select().from(outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });
});
