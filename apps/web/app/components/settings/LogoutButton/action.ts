import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";

export const logoutFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();

    const { container, module } = await loadServerDeps(
      () => import("@/presentation/identityActionHandlers"),
    );
    await module.logoutAction(container, userId);

    const { endSession } = await import("@/presentation/session");
    endSession();
    return { ok: true } as const;
  });
