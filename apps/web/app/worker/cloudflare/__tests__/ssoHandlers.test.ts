import {
  createDevStubSsoProvider,
  encodeDevCode,
} from "@repo/core/adapters/sso/devStubSsoProvider";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createSsoStateCodec } from "@repo/core/adapters/webcrypto/ssoStateCodec";
import type { ServerEnv } from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import { ConflictError } from "@repo/core/application/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "@/presentation/sessionCookie";

const SECRET = "s".repeat(48);
const APP_URL = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  registerOrLoginWithSso:
    vi.fn<(args: unknown) => Promise<{ userId: string; isNewUser: boolean }>>(),
  linkSsoCredential:
    vi.fn<(args: unknown) => Promise<{ credentialId: string }>>(),
  devStubEnabled: { value: true },
  readAccountState:
    vi.fn<
      (userId: string) => Promise<{
        status: string;
        sessionEpoch: number;
        resetVersion: number;
      } | null>
    >(),
}));

vi.mock("@repo/core/application/identity/registerOrLoginWithSso", () => ({
  registerOrLoginWithSso: mocks.registerOrLoginWithSso,
}));
vi.mock("@repo/core/application/identity/linkSsoCredential", () => ({
  linkSsoCredential: mocks.linkSsoCredential,
}));

const sessionCodec = createHmacSessionCodec({ secret: SECRET });

vi.mock("@repo/core/application/di/serverCloudflare", () => ({
  readRequestServerConfig: () => ({
    appUrl: APP_URL,
    secrets: { sessionSecret: SECRET },
    bindings: {},
  }),
  createRequestContainer: (): Partial<RequestContainer> => ({
    clock: { now: () => new Date() },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionCodec,
    identityGateway: {
      readAccountState: mocks.readAccountState,
    } as unknown as RequestContainer["identityGateway"],
  }),
  createSsoRuntime: () => ({
    provider: createDevStubSsoProvider(APP_URL),
    providers: ["google"],
    stateCodec: createSsoStateCodec({ sessionSecret: SECRET }),
    devStubEnabled: mocks.devStubEnabled.value,
  }),
}));

const { handleSso, isSsoRoute, SSO_STATE_COOKIE_NAME } = await import(
  "../ssoHandlers"
);

const env = {} as ServerEnv;

function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(setCookie: string): string {
  return decodeURIComponent(
    setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "",
  );
}

async function start(query = ""): Promise<{ state: string; cookie: string }> {
  const response = await handleSso(
    new Request(`${APP_URL}/auth/sso/google/start${query}`),
    env,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const cookie =
    cookiesOf(response).find((c) => c.startsWith(SSO_STATE_COOKIE_NAME)) ?? "";
  return {
    state,
    cookie: `${SSO_STATE_COOKIE_NAME}=${encodeURIComponent(cookieValue(cookie))}`,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.devStubEnabled.value = true;
});

describe("isSsoRoute", () => {
  it("claims the start / callback and the dev page, nothing else", () => {
    expect(isSsoRoute("/auth/sso/google/start")).toBe(true);
    expect(isSsoRoute("/auth/sso/google/callback")).toBe(true);
    expect(isSsoRoute("/__dev/sso/google/authorize")).toBe(true);
    expect(isSsoRoute("/auth/sso")).toBe(false);
    expect(isSsoRoute("/login")).toBe(false);
  });
});

describe("start", () => {
  it("pins a signed state in an HttpOnly cookie scoped to the handlers and bounces to the provider", async () => {
    const response = await handleSso(
      new Request(`${APP_URL}/auth/sso/google/start?redirect=%2Fsettings`),
      env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/__dev/sso/google/authorize");
    const state = location.searchParams.get("state") ?? "";
    const [cookie] = cookiesOf(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/auth/sso");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookieValue(cookie ?? "")).toBe(state);
    const payload = await createSsoStateCodec({ sessionSecret: SECRET }).verify(
      state,
      new Date(),
    );
    expect(payload).toMatchObject({
      provider: "google",
      intent: "login",
      redirect: "/settings",
      origin: "/login",
      userId: null,
    });
  });

  it("drops an off-origin redirect and remembers the signup origin", async () => {
    const { state } = await start(
      "?from=signup&redirect=https%3A%2F%2Fevil.example",
    );
    const payload = await createSsoStateCodec({ sessionSecret: SECRET }).verify(
      state,
      new Date(),
    );
    expect(payload).toMatchObject({ redirect: null, origin: "/signup" });
  });

  it("answers 404 for a provider outside the configured list", async () => {
    const response = await handleSso(
      new Request(`${APP_URL}/auth/sso/apple/start`),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("refuses a link intent without a session", async () => {
    const response = await handleSso(
      new Request(`${APP_URL}/auth/sso/google/start?intent=link`),
      env,
    );
    expect(response.headers.get("location")).toBe(
      "/login?redirect=%2Fsettings",
    );
  });
});

describe("callback", () => {
  it("refuses a state that does not match the cookie", async () => {
    const { state } = await start();
    const response = await handleSso(
      new Request(`${APP_URL}/auth/sso/google/callback?code=x&state=${state}`),
      env,
    );
    expect(response.headers.get("location")).toBe("/login?sso_error=failed");
    expect(mocks.registerOrLoginWithSso).not.toHaveBeenCalled();
  });

  // P-01: a cancel is not an error — the origin page comes back as it was,
  // with its carried redirect and no `sso_error`.
  it("returns a provider cancel to the origin page with no message", async () => {
    const { state, cookie } = await start("?from=signup");
    const response = await handleSso(
      new Request(
        `${APP_URL}/auth/sso/google/callback?error=access_denied&state=${state}`,
        { headers: { cookie } },
      ),
      env,
    );
    expect(response.headers.get("location")).toBe("/signup");
    expect(cookiesOf(response)[0]).toContain("Max-Age=0");

    const carried = await start("?redirect=%2Ftopics");
    const back = await handleSso(
      new Request(
        `${APP_URL}/auth/sso/google/callback?error=access_denied&state=${carried.state}`,
        { headers: { cookie: carried.cookie } },
      ),
      env,
    );
    expect(back.headers.get("location")).toBe("/login?redirect=%2Ftopics");
  });

  it("runs the usecase, starts the session and returns to the carried target", async () => {
    mocks.registerOrLoginWithSso.mockResolvedValue({
      userId: "user-1",
      isNewUser: true,
    });
    mocks.readAccountState.mockResolvedValue({
      status: "active",
      sessionEpoch: 4,
      resetVersion: 0,
    });
    const { state, cookie } = await start("?redirect=%2Ftopics");
    const code = encodeDevCode({
      providerSubject: "sub-1",
      email: "a@example.com",
    });
    const response = await handleSso(
      new Request(
        `${APP_URL}/auth/sso/google/callback?code=${code}&state=${state}`,
        {
          headers: { cookie },
        },
      ),
      env,
    );
    expect(response.headers.get("location")).toBe("/topics");
    expect(mocks.registerOrLoginWithSso).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          provider: "google",
          providerSubject: "sub-1",
          email: "a@example.com",
        },
      }),
    );
    const session =
      cookiesOf(response).find((c) => c.startsWith(SESSION_COOKIE_NAME)) ?? "";
    const verified = await sessionCodec.verify(
      cookieValue(session),
      new Date(),
    );
    expect(verified).toEqual({ userId: "user-1", sessionEpoch: 4 });
  });

  it("sends a held address back to the origin as email_registered", async () => {
    mocks.registerOrLoginWithSso.mockRejectedValue(
      new ConflictError("EMAIL_ALREADY_REGISTERED", "held"),
    );
    const { state, cookie } = await start("?from=signup");
    const code = encodeDevCode({
      providerSubject: "sub-1",
      email: "a@example.com",
    });
    const response = await handleSso(
      new Request(
        `${APP_URL}/auth/sso/google/callback?code=${code}&state=${state}`,
        {
          headers: { cookie },
        },
      ),
      env,
    );
    expect(response.headers.get("location")).toBe(
      "/signup?sso_error=email_registered",
    );
    expect(
      cookiesOf(response).some((c) => c.startsWith(SESSION_COOKIE_NAME)),
    ).toBe(false);
  });

  it("links for the session the state was issued to and lands on P-13", async () => {
    mocks.readAccountState.mockResolvedValue({
      status: "active",
      sessionEpoch: 1,
      resetVersion: 0,
    });
    mocks.linkSsoCredential.mockResolvedValue({ credentialId: "c" });
    const session = await sessionCodec.issue("user-9", 1, new Date());
    const sessionCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`;
    const startResponse = await handleSso(
      new Request(`${APP_URL}/auth/sso/google/start?intent=link`, {
        headers: { cookie: sessionCookie },
      }),
      env,
    );
    const location = new URL(startResponse.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const stateCookie = `${SSO_STATE_COOKIE_NAME}=${encodeURIComponent(state)}`;
    const code = encodeDevCode({
      providerSubject: "sub-2",
      email: "b@example.com",
    });
    const response = await handleSso(
      new Request(
        `${APP_URL}/auth/sso/google/callback?code=${code}&state=${state}`,
        {
          headers: { cookie: `${sessionCookie}; ${stateCookie}` },
        },
      ),
      env,
    );
    expect(response.headers.get("location")).toBe("/settings?sso=linked");
    expect(mocks.linkSsoCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          userId: "user-9",
          provider: "google",
          providerSubject: "sub-2",
        },
      }),
    );
  });
});

describe("the dev consent page", () => {
  it("answers 404 when the stub is not enabled", async () => {
    mocks.devStubEnabled.value = false;
    const response = await handleSso(
      new Request(`${APP_URL}/__dev/sso/google/authorize?state=x`),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("bounces 許可 to the callback with a code that carries the form, and キャンセル with access_denied", async () => {
    const form = new URLSearchParams({
      decision: "allow",
      subject: "sub-1",
      email: "a@example.com",
      state: "st",
    });
    const allowed = await handleSso(
      new Request(`${APP_URL}/__dev/sso/google/authorize?state=st`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      env,
    );
    const location = new URL(allowed.headers.get("location") ?? "");
    expect(location.pathname).toBe("/auth/sso/google/callback");
    expect(location.searchParams.get("state")).toBe("st");
    expect(location.searchParams.get("code")).toBe(
      encodeDevCode({ providerSubject: "sub-1", email: "a@example.com" }),
    );

    const denied = await handleSso(
      new Request(`${APP_URL}/__dev/sso/google/authorize?state=st`, {
        method: "POST",
        body: new URLSearchParams({ decision: "deny" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      env,
    );
    expect(
      new URL(denied.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("access_denied");
  });
});
