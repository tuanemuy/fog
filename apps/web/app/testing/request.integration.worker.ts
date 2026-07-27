import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import {
  createRequestContainer,
  readRequestServerConfig,
  routeAuthenticatedUserData,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import { operationId } from "@repo/core/application/identity/contracts";
import { Email, SsoProvider } from "@repo/core/domain/identity/valueObject";
import { loginSchema, signupSchema } from "../components/auth/schema";
import type { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";
import { resolveAuthenticatedUserId } from "../presentation/authenticatedSession";
import {
  httpStatusFor,
  isAppServerError,
  redactForClient,
  serializeError,
} from "../presentation/errorResponse";
import {
  currentUserAction,
  loginPasswordAction,
  logoutAction,
  registerPasswordAction,
} from "../presentation/identityActionHandlers";
import {
  buildSessionCookie,
  issueSessionCookie,
} from "../presentation/sessionCookie";
import { validateInput } from "../presentation/validator";

type IntegrationEnv = Omit<
  ServerEnv,
  "USER_DATA" | "SESSION_SECRET" | "DIRECTORY_ROUTING_SECRET_ACTIVE"
> &
  Readonly<{
    USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
    SESSION_SECRET: string;
    DIRECTORY_ROUTING_SECRET_ACTIVE: string;
  }>;

const contractVersion = 1;

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

async function readPublicPayload(
  request: Request,
): Promise<Record<string, unknown>> {
  const input: unknown = await request.json();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("INVALID_REQUEST_PAYLOAD");
  }
  return input as Record<string, unknown>;
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("fog_session="));
  return value?.slice("fog_session=".length) || null;
}

function withSession(value: unknown, cookie: string): Response {
  const response = json(value);
  response.headers.set("set-cookie", cookie);
  return response;
}

function publicError(error: unknown): Response {
  const serialized = isAppServerError(error)
    ? redactForClient(error.serialized)
    : redactForClient(serializeError(error));
  return json(
    { ok: false, error: serialized },
    { status: httpStatusFor(serialized) },
  );
}

async function identityFlow(
  request: Request,
  env: IntegrationEnv,
): Promise<Response> {
  const payload = await readPublicPayload(request);
  if (
    payload.version !== contractVersion ||
    typeof payload.action !== "string"
  ) {
    return json(
      {
        ok: false,
        error: { code: "RPC_VERSION_UNSUPPORTED", retryable: false },
      },
      { status: 409 },
    );
  }
  const container = createRequestContainer(
    readRequestServerConfig(env as unknown as ServerEnv),
  );
  if (payload.action === "signup" || payload.action === "login") {
    const result =
      payload.action === "signup"
        ? await registerPasswordAction(
            container,
            validateInput(signupSchema)(payload),
          )
        : await loginPasswordAction(
            container,
            validateInput(loginSchema)(payload),
          );
    const cookie = await issueSessionCookie(
      container,
      result.userId,
      result.sessionEpoch,
      { secure: true },
    );
    return withSession({ ok: true, value: { userId: result.userId } }, cookie);
  }
  const userId = await resolveAuthenticatedUserId(
    container,
    sessionToken(request),
  );
  if (userId === null) {
    return json(
      { ok: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  }
  if (payload.action === "logout") {
    await logoutAction(container, userId);
    return withSession(
      { ok: true, value: null },
      buildSessionCookie(null, { secure: true }),
    );
  }
  if (payload.action === "current") {
    return json({
      ok: true,
      value: await currentUserAction(container, userId),
    });
  }
  throw new TypeError("INVALID_REQUEST_PAYLOAD");
}

export default {
  async fetch(request: Request, env: IntegrationEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/acceptance/config" && request.method === "GET") {
      return json({
        contractVersion,
        requestSecretsPresent:
          env.SESSION_SECRET.length > 0 &&
          env.DIRECTORY_ROUTING_SECRET_ACTIVE.length > 0,
      });
    }
    if (url.pathname === "/acceptance/identity" && request.method === "POST") {
      try {
        return await identityFlow(request, env);
      } catch (error) {
        return publicError(error);
      }
    }
    if (
      url.pathname === "/acceptance/fixture/sso-only" &&
      request.method === "POST"
    ) {
      const payload = await readPublicPayload(request);
      const email = Email.create(String(payload.email));
      const config = readRequestServerConfig(env as unknown as ServerEnv);
      const identity = new CloudflareIdentityGateway(
        config.identityDirectory,
        config.accountHome,
        config.userData,
        config.directoryRouting,
      );
      const container = createRequestContainer(config);
      await identity.lookupOrCreateSso({
        operationId: operationId(crypto.randomUUID()),
        provider: SsoProvider.create("google"),
        subject: crypto.randomUUID(),
        email,
        now: container.clock.now().getTime(),
      });
      return json({ ok: true });
    }
    if (
      url.pathname === "/acceptance/user-data/profile" &&
      request.method === "POST"
    ) {
      try {
        const payload = await readPublicPayload(request);
        if (payload.version !== contractVersion) {
          return json(
            {
              ok: false,
              error: {
                code: "RPC_VERSION_UNSUPPORTED",
                retryable: false,
              },
            },
            { status: 409 },
          );
        }
        const token = sessionToken(request);
        const container = createRequestContainer(
          readRequestServerConfig(env as unknown as ServerEnv),
        );
        const userId = await resolveAuthenticatedUserId(container, token);
        if (userId === null) {
          return json(
            { ok: false, error: { code: "UNAUTHENTICATED" } },
            { status: 401 },
          );
        }
        const object = routeAuthenticatedUserData(env.USER_DATA, userId);
        const profile = await object.identityGetProfileV1({
          version: 1,
          payload: { userId },
        });
        return json(profile, { status: profile.ok ? 200 : 503 });
      } catch (error) {
        return publicError(error);
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
