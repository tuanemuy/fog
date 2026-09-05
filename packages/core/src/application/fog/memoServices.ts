import {
  type Memo,
  memoBody,
  timelineCursor,
  timelineDate,
} from "@repo/core/domain/fog/content";
import {
  type ContentDependencies,
  found,
  memoView,
  requireHuman,
  requireVersion,
} from "./contentSupport";
import type { MemoServices } from "./types";
export function createMemoServices({
  unitOfWork,
  clock,
  ids,
}: ContentDependencies): MemoServices {
  return {
    listMemos(actor) {
      return unitOfWork.run(async (context) =>
        Promise.all(
          (await context.memos(actor.userId).list()).map((memo) =>
            memoView(context, memo, actor),
          ),
        ),
      );
    },
    async createMemo(actor, input) {
      const body = memoBody(input.body);
      const now = clock.now().toISOString();
      const memo: Memo = {
        id: ids.next(),
        ownerId: actor.userId,
        body,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      return unitOfWork.run(async (context) => {
        await context.memos(actor.userId).create(memo, actor);
        return memoView(context, memo, actor);
      });
    },
    async getMemo(actor, id) {
      return unitOfWork.run(async (context) =>
        memoView(
          context,
          found(await context.memos(actor.userId).find(id), "MEMO"),
          actor,
        ),
      );
    },
    async listTimeline(actor, input) {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 30)));
      const before = input.cursor ? timelineCursor(input.cursor) : undefined;
      const date = input.date ? timelineDate(input.date) : undefined;
      const keyword = input.memoId ? "" : (input.keyword?.trim() ?? "");
      return unitOfWork.run(async (context) => {
        const repo = context.memos(actor.userId);
        const focus = !before
          ? input.memoId
            ? found(await repo.find(input.memoId), "MEMO")
            : date
              ? await repo.nearest(date, keyword)
              : null
          : null;
        const memos = await repo.page({
          limit: limit + 1,
          keyword,
          ...(before ? { before } : {}),
          ...(focus ? { at: focus } : {}),
        });
        const page = memos.slice(0, limit);
        const last = page.at(-1);
        return {
          memos: await Promise.all(
            page.map((memo) => memoView(context, memo, actor)),
          ),
          nextCursor:
            memos.length > limit && last
              ? `${last.createdAt}|${last.id}`
              : null,
          focusId: focus?.id ?? null,
        };
      });
    },
    async editMemo(actor, input) {
      const body = memoBody(input.body);
      return unitOfWork.run(async (context) => {
        const repo = context.memos(actor.userId);
        const current = found(await repo.find(input.id), "MEMO");
        requireVersion(current.version, input.expectedVersion);
        if (current.body === body) return memoView(context, current, actor);
        const updated = {
          ...current,
          body,
          updatedAt: clock.now().toISOString(),
          version: current.version + 1,
        };
        await repo.update(updated, input.expectedVersion, actor);
        return memoView(context, updated, actor);
      });
    },
    async memoHistory(actor, id) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const repo = context.memos(actor.userId);
        found(await repo.find(id), "MEMO");
        return repo.history(id);
      });
    },
    async rollbackMemo(actor, input) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const repo = context.memos(actor.userId);
        const current = found(await repo.find(input.id), "MEMO");
        requireVersion(current.version, input.expectedVersion);
        const revision = found(
          (await repo.history(input.id)).find(
            (rev) => rev.version === input.version,
          ) ?? null,
          "REVISION",
        );
        const updated = {
          ...current,
          body: revision.body,
          updatedAt: clock.now().toISOString(),
          version: current.version + 1,
        };
        await repo.update(updated, input.expectedVersion, actor);
        return memoView(context, updated, actor);
      });
    },
  };
}
