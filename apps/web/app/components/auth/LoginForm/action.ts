import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { loginSchema } from "../schema";

export const loginFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(loginSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@/presentation/identityActionHandlers"),
    );
    const { userId, sessionEpoch } = await module.loginPasswordAction(
      container,
      data,
    );
    const { startSession } = await import("@/presentation/session");
    await startSession(userId, sessionEpoch);
    return { ok: true } as const;
  });
