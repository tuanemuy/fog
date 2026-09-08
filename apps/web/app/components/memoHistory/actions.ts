import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { diffMemoRevisionsSchema, rollbackMemoSchema } from "./schema";

/** S-TL-05: the two snapshots; the diff itself is computed on the client. */
export const diffMemoRevisionsFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(diffMemoRevisionsSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/diffMemoRevisions"),
    );
    return module.diffMemoRevisions({ container, input: { userId, ...data } });
  });

/** S-TL-05 "restore this content". */
export const rollbackMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(rollbackMemoSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/memo/rollbackMemo"),
    );
    const { Actor, UserId } = await import(
      "@repo/core/domain/identity/valueObject"
    );
    return module.rollbackMemo({
      container,
      input: { userId, ...data, actor: Actor.user(UserId.create(userId)) },
    });
  });
