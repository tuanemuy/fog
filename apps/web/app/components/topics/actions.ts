import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  createTopicSchema,
  trashTopicSchema,
  updateTopicSchema,
} from "./schema";

/** S-DT-01. Dispatched from the list's form; the list owner shows the optimistic row. */
export const createTopicFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(createTopicSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/createTopic"),
    );
    return module.createTopic({ container, input: { userId, ...data } });
  });

/** S-DT-03: rename, re-describe, 完了にする / 完了を解除. */
export const updateTopicFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(updateTopicSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/updateTopic"),
    );
    return module.updateTopic({ container, input: { userId, ...data } });
  });

/** S-DT-09: the topic and its documents to the trash as a set. */
export const trashTopicFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(trashTopicSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/trashTopic"),
    );
    return module.trashTopic({ container, input: { userId, ...data } });
  });
