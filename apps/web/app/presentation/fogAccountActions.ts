import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { validateInput } from "./validator";

export const loadFogAccountOptions = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({}).strict()))
  .handler(async () => {
    const { getFogAccountRuntime } = await import("./fogAccountRuntime");
    return { googleEnabled: getFogAccountRuntime().googleEnabled };
  });
export const beginFogGoogle = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(z.object({ returnTo: z.string().max(2048) }).strict()),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, getFogSession } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await getFogSession();
    const { getCookie, setCookie } = await import(
      "@tanstack/react-start/server"
    );
    const { getContainer } = await import(
      "@repo/core/application/di/containerStore"
    );
    const { getFogAccountRuntime } = await import("./fogAccountRuntime");
    const { safeReturnTo } = await import("./fogSecurity");
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    const browserToken =
      getCookie("fog_oidc_browser") ??
      getFogAccountRuntime().createBrowserToken();
    const result = await getFogServices().beginGoogleAuth(actor, {
      browserToken,
      returnTo: actor ? "/settings" : safeReturnTo(data.returnTo),
    });
    const { config } = await getContainer();
    setCookie("fog_oidc_browser", browserToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(config.appUrl).protocol === "https:",
      path: "/",
      maxAge: 600,
    });
    return result;
  });
export const unlinkFogGoogle = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(z.object({ id: z.string().min(1).max(128) }).strict()),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().unlinkGoogleCredential(actor, data);
  });
export const changeFogPassword = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z
        .object({
          currentPassword: z.string().max(128),
          newPassword: z.string().max(128),
        })
        .strict(),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor, setFogSession } = await import(
      "./fogAuth"
    );
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    const result = await getFogServices().changePassword(actor, data);
    await setFogSession(result.token);
  });
export const requestFogPasswordReset = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(z.object({ email: z.string().max(254) }).strict()),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().requestPasswordReset(data);
  });
export const completeFogPasswordReset = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z
        .object({
          token: z.string().min(1).max(256),
          newPassword: z.string().max(128),
        })
        .strict(),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, setFogSession } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    const result = await getFogServices().completePasswordReset(data);
    await setFogSession(result.token);
  });
export const revokeAllFogAiConnections = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({}).strict()))
  .handler(async () => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().revokeAllAiConnections(actor);
  });
