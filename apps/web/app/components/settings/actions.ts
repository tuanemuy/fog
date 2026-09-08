import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  type ConnectionRevokedResult,
  type ConnectionsRevokedResult,
  type CredentialUnlinkedResult,
  changePasswordSchema,
  changeTrashRetentionDaysSchema,
  type PasswordChangedResult,
  type RetentionSavedResult,
  revokeAiClientConnectionSchema,
  unlinkSsoCredentialSchema,
} from "./schema";

/** S-ST-01. */
export const changeTrashRetentionDaysFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(changeTrashRetentionDaysSchema))
  .handler(async ({ data }): Promise<RetentionSavedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/changeTrashRetentionDays"),
    );
    await module.changeTrashRetentionDays({
      container,
      input: { userId, retentionDays: data.retentionDays },
    });
    return { retentionDays: data.retentionDays };
  });

/** S-AC-07 (logged in). The epoch advanced, so the session is re-issued before the answer. */
export const changePasswordFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(changePasswordSchema))
  .handler(async ({ data }): Promise<PasswordChangedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/changePassword"),
    );
    await module.changePassword({ container, input: { userId, ...data } });
    const { startSession } = await import("@/presentation/session");
    await startSession(userId);
    return { ok: true };
  });

/** P-13 / P-03 unlink. The epoch advanced, so the session is re-issued before the answer. */
export const unlinkSsoCredentialFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(unlinkSsoCredentialSchema))
  .handler(async ({ data }): Promise<CredentialUnlinkedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/unlinkSsoCredential"),
    );
    await module.unlinkSsoCredential({
      container,
      input: { userId, credentialId: data.credentialId },
    });
    const { startSession } = await import("@/presentation/session");
    await startSession(userId);
    return { credentialId: data.credentialId };
  });

/** S-AC-06: one connection, from P-13 or P-03. */
export const revokeAiClientConnectionFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(revokeAiClientConnectionSchema))
  .handler(async ({ data }): Promise<ConnectionRevokedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/revokeAiClientConnection"),
    );
    await module.revokeAiClientConnection({
      container,
      input: { userId, connectionId: data.connectionId },
    });
    return { connectionId: data.connectionId };
  });

/** P-03's second action. */
export const revokeAllAiClientConnectionsFn = createServerFn({
  method: "POST",
})
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async (): Promise<ConnectionsRevokedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () =>
        import("@repo/core/application/identity/revokeAllAiClientConnections"),
    );
    return module.revokeAllAiClientConnections({
      container,
      input: { userId },
    });
  });
