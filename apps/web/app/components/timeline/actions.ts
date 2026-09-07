import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { postMemoSchema, timelinePageSchema } from "./schema";

export const postMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(postMemoSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/postMemo"),
    );
    const { Actor, UserId } = await import(
      "@repo/core/domain/identity/valueObject"
    );
    return module.postMemo({
      container,
      input: {
        userId,
        body: data.body,
        actor: Actor.user(UserId.create(userId)),
      },
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
