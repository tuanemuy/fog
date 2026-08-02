import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";

export const logoutFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const { userId } = await requireUserId();

    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/logout"),
    );
    await module.logout({ container, input: { userId } });

    const { endSession } = await import("@/presentation/session");
    endSession();
    return { ok: true } as const;
  });
