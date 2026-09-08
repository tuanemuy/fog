import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  type AuthorizationOutcome,
  type AuthorizationRequestView,
  authorizationRequestSchema,
} from "./schema";

/** The screen's read: the request is verified again, and the address it is for. */
export const readAuthorizationRequestFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(authorizationRequestSchema))
  .handler(async ({ data }): Promise<AuthorizationRequestView> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { getAiRuntime } = await import("@/presentation/ai/runtime");
    const { tokenCodec } = await getAiRuntime();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/getCurrentUser"),
    );
    const request = await tokenCodec.verifyAuthorizeRequest(
      data.request,
      container.clock.now(),
    );
    if (request === null) return { ok: false };
    const user = await module.getCurrentUser({ container, input: { userId } });
    return { ok: true, clientName: request.name, email: user.email };
  });

/**
 * 「許可する」 (S-AC-05): the fact is recorded, then a signed one-time
 * code is minted for that connection and handed back on the client's own
 * redirect URI — the one the request was validated against.
 */
export const approveAiClientAuthorizationFn = createServerFn({
  method: "POST",
})
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(authorizationRequestSchema))
  .handler(async ({ data }): Promise<AuthorizationOutcome> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { getAiRuntime } = await import("@/presentation/ai/runtime");
    const { tokenCodec } = await getAiRuntime();
    const { container, module } = await loadServerDeps(
      () =>
        import("@repo/core/application/identity/approveAiClientAuthorization"),
    );
    const now = container.clock.now();
    const request = await tokenCodec.verifyAuthorizeRequest(data.request, now);
    if (request === null) {
      const { ValidationError } = await import("@repo/core/application/errors");
      throw new ValidationError(
        "AUTHORIZATION_REQUEST_INVALID",
        "The authorization request is invalid or has expired",
      );
    }
    const { connectionId } = await module.approveAiClientAuthorization({
      container,
      input: { userId, clientName: request.name },
    });
    const code = await tokenCodec.issueCode(
      {
        jti: container.tokenGenerator.next(),
        uid: userId,
        cid: connectionId,
        client: request.client,
        redirect: request.redirect,
        challenge: request.challenge,
      },
      now,
    );
    const target = new URL(request.redirect);
    target.searchParams.set("code", code);
    if (request.state !== null) target.searchParams.set("state", request.state);
    return { redirectTo: target.toString() };
  });

/** 「拒否する」: nothing is recorded; the client learns `access_denied`. */
export const denyAiClientAuthorizationFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(authorizationRequestSchema))
  .handler(async ({ data }): Promise<AuthorizationOutcome> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    await requireUserId();
    const { getAiRuntime } = await import("@/presentation/ai/runtime");
    const { tokenCodec } = await getAiRuntime();
    const { getContainer } = await import(
      "@repo/core/application/di/containerStore"
    );
    const container = await getContainer();
    const request = await tokenCodec.verifyAuthorizeRequest(
      data.request,
      container.clock.now(),
    );
    if (request === null) {
      const { ValidationError } = await import("@repo/core/application/errors");
      throw new ValidationError(
        "AUTHORIZATION_REQUEST_INVALID",
        "The authorization request is invalid or has expired",
      );
    }
    const target = new URL(request.redirect);
    target.searchParams.set("error", "access_denied");
    if (request.state !== null) target.searchParams.set("state", request.state);
    return { redirectTo: target.toString() };
  });
