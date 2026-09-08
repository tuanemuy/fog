import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  createDocumentSchema,
  diffDocumentRevisionsSchema,
  editDocumentSchema,
  rollbackDocumentSchema,
  type TrashDocumentResult,
  trashDocumentSchema,
} from "./schema";

async function userActorOf(userId: string) {
  const { Actor, UserId } = await import(
    "@repo/core/domain/identity/valueObject"
  );
  return Actor.user(UserId.create(userId));
}

/** S-DT-04. The change reason is not posted: the application writes 「作成」 (△-3). */
export const createDocumentFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(createDocumentSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/createDocument"),
    );
    return module.createDocument({
      container,
      input: { userId, actor: await userActorOf(userId), ...data },
    });
  });

/** S-DT-05. `expectedVersion` is the OCC token the editor opened with. */
export const editDocumentFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(editDocumentSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/editDocument"),
    );
    return module.editDocument({
      container,
      input: { userId, actor: await userActorOf(userId), ...data },
    });
  });

/** S-DT-08. */
export const trashDocumentFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(trashDocumentSchema))
  .handler(async ({ data }): Promise<TrashDocumentResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/trashDocument"),
    );
    await module.trashDocument({ container, input: { userId, ...data } });
    return { deleted: true };
  });

/** S-DT-06 "restore this content". The reason is the application's default. */
export const rollbackDocumentFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(rollbackDocumentSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/rollbackDocument"),
    );
    return module.rollbackDocument({
      container,
      input: { userId, actor: await userActorOf(userId), ...data },
    });
  });

/** S-DT-06: the two snapshots; the diff itself is computed on the client. */
export const diffDocumentRevisionsFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(diffDocumentRevisionsSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/knowledge/diffDocumentRevisions"),
    );
    return module.diffDocumentRevisions({
      container,
      input: { userId, ...data },
    });
  });
