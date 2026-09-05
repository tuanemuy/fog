import { ConflictError } from "@repo/core/application/errors";
import type { FogServices } from "@repo/core/application/fog/types";
import { describe, expect, it, vi } from "vitest";
import { handleFogGoogleCallback } from "./fogGoogleHttp";

const actor = { kind: "human" as const, userId: "u", email: "u@example.test" };
function setup(result: unknown, authenticated = false) {
  const completeGoogleAuth = vi.fn().mockResolvedValue(result);
  const authenticate = vi.fn().mockResolvedValue(authenticated ? actor : null);
  const services = {
    authenticate,
    completeGoogleAuth,
  } as unknown as FogServices;
  return { services, completeGoogleAuth, authenticate };
}
const invoke = (
  services: FogServices,
  query = "state=s&code=c",
  headers: Record<string, string> = {},
) =>
  handleFogGoogleCallback(
    new Request(`https://fog.example/auth/google/callback?${query}`, {
      headers: {
        cookie: "fog_oidc_browser=browser; fog_session=existing",
        ...headers,
      },
    }),
    { services, appUrl: "https://fog.example" },
  );
describe("Google HTTP callback", () => {
  it("accepts extra provider parameters and sets a secure human session", async () => {
    const stub = setup({
      kind: "signedIn",
      auth: { token: "test-token", actor },
      returnTo: "/timeline",
    });
    const response = await invoke(
      stub.services,
      "state=s&code=c&scope=openid&authuser=0&prompt=none",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://fog.example/timeline",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Lax; Max-Age=2592000; Secure",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(stub.completeGoogleAuth).toHaveBeenCalledWith(null, {
      state: "s",
      code: "c",
      browserToken: "browser",
    });
  });
  it("preserves existing session on explicit linking", async () => {
    const stub = setup({ kind: "linked", returnTo: "/settings" }, true);
    const response = await invoke(stub.services);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBe(
      "https://fog.example/settings?auth=linked",
    );
  });
  it("returns cancelled login to a safe saved path", async () => {
    const stub = setup({ kind: "cancelled", returnTo: "/topics" });
    const response = await invoke(stub.services, "state=s&error=access_denied");
    expect(response.headers.get("location")).toContain("returnTo=%2Ftopics");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects bearer before authenticating or consuming state", async () => {
    const stub = setup({});
    const response = await invoke(stub.services, undefined, {
      authorization: "Bearer test-token",
    });
    expect(response.status).toBe(403);
    expect(stub.authenticate).not.toHaveBeenCalled();
    expect(stub.completeGoogleAuth).not.toHaveBeenCalled();
  });
  it.each([
    "state=s&state=t&code=c",
    "state=s&code=c&error=denied",
    "code=c",
  ])("rejects malformed callback %s without consuming a request", async (query) => {
    const stub = setup({});
    const response = await invoke(stub.services, query);
    expect(response.headers.get("location")).toBe(
      "https://fog.example/login?auth=failed",
    );
    expect(stub.completeGoogleAuth).not.toHaveBeenCalled();
  });
  it("never redirects to an external return URL", async () => {
    const stub = setup({
      kind: "signedIn",
      auth: { token: "test-token", actor },
      returnTo: "https://attacker.example",
    });
    const response = await invoke(stub.services);
    expect(response.headers.get("location")).toBe(
      "https://fog.example/timeline",
    );
  });
  it("explains an already linked Google identity", async () => {
    const stub = setup({}, true);
    stub.completeGoogleAuth.mockRejectedValue(
      new ConflictError("GOOGLE_CREDENTIAL_EXISTS", "Already linked"),
    );
    const response = await invoke(stub.services);
    expect(response.headers.get("location")).toBe(
      "https://fog.example/settings?auth=already-linked",
    );
  });
});
