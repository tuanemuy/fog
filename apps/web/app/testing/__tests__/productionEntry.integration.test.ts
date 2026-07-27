import { reset, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

type ProductionTestBindings = {
  PRODUCTION_SIGNUP_FN_ID: string;
  PRODUCTION_LOGIN_FN_ID: string;
  PRODUCTION_LOGOUT_FN_ID: string;
};

const bindings = env as unknown as ProductionTestBindings;

afterEach(() => reset());

function serverFunction(
  id: string,
  data: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  let reference = 0;
  const encode = (value: unknown): unknown => {
    if (typeof value === "string") return { t: 1, s: value };
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const id = reference;
      reference += 1;
      const entries = Object.entries(value);
      return {
        t: 10,
        i: id,
        p: {
          k: entries.map(([key]) => key),
          v: entries.map(([, item]) => encode(item)),
        },
        o: 0,
      };
    }
    throw new TypeError(
      "Production server function fixture must be plain data",
    );
  };
  return SELF.fetch(`https://fog.test/_serverFn/${id}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ t: encode({ data }), f: 63, m: [] }),
  });
}

describe("production Cloudflare request entry", () => {
  it("runs defaultEntry and the built signup/login/logout server functions over HTTP", async () => {
    const loginPage = await SELF.fetch("https://fog.test/login");
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("ログイン");

    const credentials = {
      email: `production-${crypto.randomUUID()}@example.com`,
      password: "correct horse battery staple",
    };
    const signup = await serverFunction(bindings.PRODUCTION_SIGNUP_FN_ID, {
      operationId: crypto.randomUUID(),
      ...credentials,
    });
    expect(signup.status).toBe(200);
    expect(signup.headers.get("set-cookie")).toContain("fog_session=");
    expect(signup.headers.get("set-cookie")).toContain("HttpOnly");

    const login = await serverFunction(
      bindings.PRODUCTION_LOGIN_FN_ID,
      credentials,
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("fog_session=");

    const settings = await SELF.fetch("https://fog.test/settings", {
      headers: { cookie },
    });
    expect(settings.status).toBe(200);
    expect(await settings.text()).toContain("設定");

    const logout = await serverFunction(
      bindings.PRODUCTION_LOGOUT_FN_ID,
      {},
      cookie,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
