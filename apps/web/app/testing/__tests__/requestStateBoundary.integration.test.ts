import { SELF } from "cloudflare:test";
import { reset } from "cloudflare:test";
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
      body: JSON.stringify({ version: 1, action, ...body }),
    });

  it("uses request-only secrets and calls User Data through script_name", async () => {
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
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      value: {
        userId: "acceptance-session-user",
        trashRetentionDays: 30,
      },
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

  it("rejects version mismatches and public routing overrides before RPC", async () => {
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

    const override = await SELF.fetch(
      "https://fog.test/acceptance/user-data/profile",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, userId: "another-user" }),
      },
    );
    expect(override.status).toBe(400);
    expect(await override.json()).toMatchObject({
      ok: false,
      error: { code: "ROUTING_OVERRIDE_FORBIDDEN", retryable: false },
    });
  });
});
