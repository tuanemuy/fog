import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  credentialsSchema,
  executePasswordResetSchema,
  requestPasswordResetSchema,
} from "./schema";

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

/** S-AC-07, the request: the answer is the same for every address. */
export const requestPasswordResetFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(requestPasswordResetSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/requestPasswordReset"),
    );
    await module.requestPasswordReset({ container, input: data });
    return { ok: true as const };
  });

/** S-AC-07, the completion: the new session is the only one left alive. */
export const executePasswordResetFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(executePasswordResetSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/executePasswordReset"),
    );
    const { userId } = await module.executePasswordReset({
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
