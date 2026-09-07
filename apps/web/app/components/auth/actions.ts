import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { credentialsSchema } from "./schema";

export const registerFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(credentialsSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/registerWithPassword"),
    );
    const { userId } = await module.registerWithPassword({
      container,
      input: data,
    });
    const { startSession } = await import("@/presentation/session");
    await startSession(userId);
    return { userId };
  });

export const loginFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(credentialsSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/loginWithPassword"),
    );
    const { userId } = await module.loginWithPassword({
      container,
      input: data,
    });
    const { startSession } = await import("@/presentation/session");
    await startSession(userId);
    return { userId };
  });

export const logoutFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("@/presentation/currentUser");
    const userId = await getCurrentUserId();
    if (userId !== null) {
      const { container, module } = await loadServerDeps(
        () => import("@repo/core/application/identity/logout"),
      );
      await module.logout({ container, input: { userId } });
    }
    const { endSession } = await import("@/presentation/session");
    endSession();
    return { ok: true as const };
  });
