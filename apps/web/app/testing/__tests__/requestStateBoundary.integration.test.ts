import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => reset());

describe("request Worker to state auxiliary Worker boundary", () => {
  const identity = (
    action: string,
    body: Record<string, unknown> = {},
    cookie?: string,
  ) =>
    SELF.fetch("https://fog.test/acceptance/identity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({
        version: 1,
        action,
        ...(action === "signup" ? { operationId: crypto.randomUUID() } : {}),
        ...body,
      }),
    });

  it("keeps request-only secrets on request and requires authentication for User Data", async () => {
    const config = await SELF.fetch("https://fog.test/acceptance/config");
    expect(await config.json()).toEqual({
      contractVersion: 1,
      requestSecretsPresent: true,
    });

    const response = await SELF.fetch(
      "https://fog.test/acceptance/user-data/profile",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("runs signup, current-user, logout, and login across the two Workers", async () => {
    const credentials = {
      email: `acceptance-${crypto.randomUUID()}@example.com`,
      password: "correct horse battery staple",
    };
    const signup = await identity("signup", credentials);
    expect(signup.status).toBe(200);
    const signupCookie = signup.headers.get("set-cookie");
    expect(signupCookie).toContain("HttpOnly");
    expect(await signup.json()).toMatchObject({ ok: true });

    const current = await identity("current", {}, signupCookie ?? undefined);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      ok: true,
      value: { email: credentials.email, authMethods: ["password"] },
    });

    const loggedOut = await identity("logout", {}, signupCookie ?? undefined);
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");

    const login = await identity("login", credentials);
    expect(login.status).toBe(200);
    const loginCookie = login.headers.get("set-cookie");
    expect(loginCookie).toContain("HttpOnly");
    const afterLogin = await identity("current", {}, loginCookie ?? undefined);
    expect(afterLogin.status).toBe(200);
    expect(await afterLogin.json()).toMatchObject({
      ok: true,
      value: { email: credentials.email },
    });
  });

  it("rejects version mismatches and ignores public routing overrides", async () => {
    const mismatch = await SELF.fetch(
      "https://fog.test/acceptance/user-data/profile",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 0 }),
      },
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      ok: false,
      error: { code: "RPC_VERSION_UNSUPPORTED", retryable: false },
    });

    const signup = await identity("signup", {
      email: `routing-${crypto.randomUUID()}@example.com`,
      password: "correct horse battery staple",
    });
    const cookie = signup.headers.get("set-cookie") ?? "";
    const expectedUserId = (
      (await signup.json()) as { value: { userId: string } }
    ).value.userId;
    const override = await SELF.fetch(
      "https://fog.test/acceptance/user-data/profile",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ version: 1, userId: "another-user" }),
      },
    );
    expect(override.status).toBe(200);
    expect(await override.json()).toMatchObject({
      ok: true,
      value: { userId: expectedUserId },
    });
  });

  it("routes two authenticated accounts only to their canonical User Data objects", async () => {
    const signups = await Promise.all(
      ["first", "second"].map((label) =>
        identity("signup", {
          email: `${label}-${crypto.randomUUID()}@example.com`,
          password: "correct horse battery staple",
        }),
      ),
    );
    const sessions = await Promise.all(
      signups.map(async (response) => ({
        cookie: response.headers.get("set-cookie") ?? "",
        userId: ((await response.json()) as { value: { userId: string } }).value
          .userId,
      })),
    );
    const profiles = await Promise.all(
      sessions.map(({ cookie }) =>
        SELF.fetch("https://fog.test/acceptance/user-data/profile", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
          },
          body: JSON.stringify({ version: 1 }),
        }).then((response) => response.json()),
      ),
    );
    expect(
      profiles.map(
        (profile) => (profile as { value: { userId: string } }).value.userId,
      ),
    ).toEqual(sessions.map(({ userId }) => userId));
    expect(new Set(sessions.map(({ userId }) => userId)).size).toBe(2);
  });

  it("uses the production login handler and public error projection for enumeration-resistant failures", async () => {
    const credentials = {
      email: `login-${crypto.randomUUID()}@example.com`,
      password: "correct horse battery staple",
    };
    const ssoOnlyEmail = `sso-only-${crypto.randomUUID()}@example.com`;
    await identity("signup", credentials);
    const fixture = await SELF.fetch(
      "https://fog.test/acceptance/fixture/sso-only",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ssoOnlyEmail }),
      },
    );
    expect(fixture.status).toBe(200);
    const attempts = [
      {
        email: `unknown-${crypto.randomUUID()}@example.com`,
        password: credentials.password,
      },
      { email: credentials.email, password: "definitely-the-wrong-password" },
      { email: ssoOnlyEmail, password: credentials.password },
      { email: "not-an-email", password: credentials.password },
    ];
    const responses = await Promise.all(
      attempts.map((input) => identity("login", input)),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(responses.map(({ status }) => status)).toEqual([422, 422, 422, 422]);
    expect(
      bodies.map((body) => {
        const error = (body as { error: unknown }).error;
        return error;
      }),
    ).toEqual([
      {
        kind: "validation",
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
        retryable: false,
      },
      {
        kind: "validation",
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
        retryable: false,
      },
      {
        kind: "validation",
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
        retryable: false,
      },
      {
        kind: "validation",
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
        retryable: false,
      },
    ]);
  });
});
