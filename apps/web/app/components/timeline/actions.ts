import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { userActorOf } from "@/presentation/userActor";
import { validateInput } from "@/presentation/validator";
import {
  editMemoSchema,
  postMemoSchema,
  type SoftDeleteMemoResult,
  softDeleteMemoSchema,
  timelinePageSchema,
} from "./schema";

export const postMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(postMemoSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/postMemo"),
    );
    return module.postMemo({
      container,
      input: { userId, body: data.body, actor: await userActorOf(userId) },
    });
  });

export const loadTimelinePageFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(timelinePageSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/getTimeline"),
    );
    return module.getTimeline({ container, input: { userId, ...data } });
  });

/** S-TL-04. The leaf owns this call; `expectedVersion` is the OCC token it started from. */
export const editMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(editMemoSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/editMemo"),
    );
    return module.editMemo({
      container,
      input: { userId, ...data, actor: await userActorOf(userId) },
    });
  });

/** S-TL-06. The list owner runs this; the leaf only asks for it. */
export const softDeleteMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(softDeleteMemoSchema))
  .handler(async ({ data }): Promise<SoftDeleteMemoResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/softDeleteMemo"),
    );
    await module.softDeleteMemo({
      container,
      input: { userId, memoId: data.memoId },
    });
    return { deleted: true };
  });
