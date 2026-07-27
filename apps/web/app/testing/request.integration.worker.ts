import {
  createRequestContainer,
  readRequestServerConfig,
  routeAuthenticatedUserData,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import { getCurrentUser } from "@repo/core/application/identity/getCurrentUser";
import { loginWithPassword } from "@repo/core/application/identity/loginWithPassword";
import { logout } from "@repo/core/application/identity/logout";
import { registerWithPassword } from "@repo/core/application/identity/registerWithPassword";
import type { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";

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
const forbiddenRoutingKeys = new Set([
  "userId",
  "durableObjectId",
  "partition",
  "routingKey",
]);

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
  const payload = input as Record<string, unknown>;
  if (Object.keys(payload).some((key) => forbiddenRoutingKeys.has(key))) {
    throw new TypeError("ROUTING_OVERRIDE_FORBIDDEN");
  }
  return payload;
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("fog_session="));
  return value?.slice("fog_session=".length) || null;
}

function withSession(value: unknown, token: string | null): Response {
  const response = json(value);
  response.headers.set(
    "set-cookie",
    token === null
      ? "fog_session=; Path=/; HttpOnly; Max-Age=0"
      : `fog_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return response;
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
    if (
      typeof payload.email !== "string" ||
      typeof payload.password !== "string"
    ) {
      throw new TypeError("INVALID_REQUEST_PAYLOAD");
    }
    const result =
      payload.action === "signup"
        ? await registerWithPassword({
            container,
            input: {
              operationId: crypto.randomUUID(),
              email: payload.email,
              password: payload.password,
            },
          })
        : await loginWithPassword({
            container,
            input: { email: payload.email, password: payload.password },
          });
    const token = await container.sessionCodec.issue(
      result.userId,
      result.sessionEpoch,
      container.clock.now(),
    );
    return withSession({ ok: true, value: { userId: result.userId } }, token);
  }
  const token = sessionToken(request);
  const session =
    token === null
      ? null
      : await container.sessionCodec.verify(token, container.clock.now());
  if (session === null) {
    return json(
      { ok: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  }
  if (payload.action === "logout") {
    await logout({ container, input: { userId: session.userId } });
    return withSession({ ok: true, value: null }, null);
  }
  if (payload.action === "current") {
    return json({
      ok: true,
      value: await getCurrentUser({
        container,
        input: { userId: session.userId },
      }),
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
        return json(
          {
            ok: false,
            error: {
              code:
                error instanceof Error
                  ? "code" in error && typeof error.code === "string"
                    ? error.code
                    : error.message
                  : "IDENTITY_REQUEST_FAILED",
            },
          },
          { status: 400 },
        );
      }
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
        const session =
          token === null
            ? null
            : await container.sessionCodec.verify(token, container.clock.now());
        if (session === null) {
          return json(
            { ok: false, error: { code: "UNAUTHENTICATED" } },
            { status: 401 },
          );
        }
        const object = routeAuthenticatedUserData(
          env.USER_DATA,
          session.userId,
        );
        const profile = await object.getProfile();
        return json(profile, { status: profile.ok ? 200 : 503 });
      } catch (error) {
        return json(
          {
            ok: false,
            error: {
              code:
                error instanceof Error
                  ? error.message
                  : "INVALID_REQUEST_PAYLOAD",
              retryable: false,
            },
          },
          { status: 400 },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
