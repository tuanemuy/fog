import { isConflictError } from "@repo/core/application/errors";
import { postMemo } from "@repo/core/application/memo/postMemo";
import type { ExpectedVersion } from "@repo/core/domain/common/transactionalRepository";
import type { User } from "@repo/core/domain/identity/entity";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { type ActiveMemo, Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { describe, expect, it } from "vitest";
import { createMemoRepository } from "../stores/memoRepository";
import { createUserSettingsRepository } from "../stores/userSettingsRepository";
import { inUserDataStorage } from "./helpers";
import { createTestContainer, registerTestUser } from "./testContainer";

function expectOccConflict(error: unknown): void {
  expect(isConflictError(error)).toBe(true);
  if (!isConflictError(error)) throw error;
  expect(error.code).toBe("OPTIMISTIC_LOCK_FAILURE");
}

describe("OCC: a stale expectedVersion is a caller-visible conflict", () => {
  it("user_settings: save with a token an earlier save already consumed throws", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    await inUserDataStorage(userId, (sql, _instance, state) => {
      const repository = createUserSettingsRepository(sql);
      const found = repository.find();
      expect(found).not.toBeNull();
      if (found === null) throw new Error("unreachable");
      const { entity, expectedVersion: staleToken } = found;
      expect(entity.version).toBe(0);

      const first: User = {
        ...entity,
        version: entity.version + 1,
        updatedAt: new Date(),
      };
      state.storage.transactionSync(() => {
        repository.save(first, staleToken);
      });
      expect(repository.find()?.entity.version).toBe(1);

      const second: User = {
        ...first,
        version: first.version + 1,
        updatedAt: new Date(),
      };
      let caught: unknown = null;
      try {
        state.storage.transactionSync(() => {
          repository.save(second, staleToken);
        });
      } catch (error) {
        caught = error;
      }
      expectOccConflict(caught);

      // The conflicting write left the row untouched.
      const after = repository.find();
      expect(after?.entity.version).toBe(1);
      expect(after?.expectedVersion).toBe(1 as ExpectedVersion<User>);
    });
  });

  it("memos: save with the token from before another save throws", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { memo: posted } = await postMemo({
      container,
      input: {
        userId,
        body: "first body",
        actor: Actor.user(UserId.create(userId)),
      },
    });
    expect(posted.version).toBe(0);

    await inUserDataStorage(userId, (sql, _instance, state) => {
      const repository = createMemoRepository(sql, userId);
      const found = repository.findById(MemoId.create(posted.id));
      expect(found).not.toBeNull();
      if (found === null) throw new Error("unreachable");
      const { entity, expectedVersion: staleToken } = found;
      const actor = Actor.user(UserId.create(userId));

      const edited = Memo.edit(
        entity,
        { body: "second body", actor },
        new Date(),
      );
      state.storage.transactionSync(() => {
        repository.save(edited.memo, staleToken);
        if (edited.newRevision) repository.insertRevision(edited.newRevision);
      });
      expect(
        repository.findById(MemoId.create(posted.id))?.entity.version,
      ).toBe(1);

      const editedAgain = Memo.edit(
        edited.memo,
        { body: "third body", actor },
        new Date(),
      );
      let caught: unknown = null;
      try {
        state.storage.transactionSync(() => {
          repository.save(editedAgain.memo, staleToken);
        });
      } catch (error) {
        caught = error;
      }
      expectOccConflict(caught);

      const after = repository.findById(MemoId.create(posted.id));
      expect(after?.entity.version).toBe(1);
      expect(after?.entity.body).toBe("second body");
      expect(after?.expectedVersion).toBe(1 as ExpectedVersion<ActiveMemo>);
    });
  });
});
