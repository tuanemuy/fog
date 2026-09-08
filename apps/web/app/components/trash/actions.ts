import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  type HardDeleteResult,
  hardDeleteTrashItemSchema,
  listTrashSchema,
  restoreDocumentSchema,
  restoreMemoSchema,
  restoreTopicSchema,
} from "./schema";

async function currentUserId() {
  const { requireUserId } = await import("@/presentation/currentUser");
  return requireUserId();
}

/** 「もっと読む」 of P-12. */
export const listTrashFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(listTrashSchema))
  .handler(async ({ data }) => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/listTrash"),
    );
    return module.listTrash({ container, input: { userId, ...data } });
  });

/** The live topics a document may be restored into (ADR-001, decision △-5). */
export const loadRestoreDestinationsFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/listTopics"),
    );
    return module.listTopics({
      container,
      input: { userId, includeArchived: true },
    });
  });

export const restoreMemoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(restoreMemoSchema))
  .handler(async ({ data }) => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/restoreMemo"),
    );
    return module.restoreMemo({ container, input: { userId, ...data } });
  });

export const restoreDocumentFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(restoreDocumentSchema))
  .handler(async ({ data }) => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/restoreDocument"),
    );
    return module.restoreDocument({
      container,
      input: {
        userId,
        documentId: data.documentId,
        confirmSetRestore: data.confirmSetRestore,
        destination: data.destination ?? null,
      },
    });
  });

export const restoreTopicFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(restoreTopicSchema))
  .handler(async ({ data }) => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/restoreTopic"),
    );
    return module.restoreTopic({ container, input: { userId, ...data } });
  });

export const hardDeleteTrashItemFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(hardDeleteTrashItemSchema))
  .handler(async ({ data }): Promise<HardDeleteResult> => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/hardDeleteTrashItem"),
    );
    await module.hardDeleteTrashItem({ container, input: { userId, ...data } });
    return { deleted: true };
  });

export const emptyTrashFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const userId = await currentUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/trash/emptyTrash"),
    );
    return module.emptyTrash({ container, input: { userId } });
  });
