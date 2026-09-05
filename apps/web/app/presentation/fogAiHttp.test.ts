import { ForbiddenError } from "@repo/core/application/errors";
import type { AiServices } from "@repo/core/application/fog/aiTypes";
import { describe, expect, it, vi } from "vitest";
import { readFogAiClients } from "./fogAiConfig";
import { handleFogAiHttp } from "./fogAiHttp";
import { assertHumanTransport } from "./fogSecurity";

const bearer = `Bearer ${"a".repeat(64)}`;
function fixture() {
  const execute = vi.fn<AiServices["executeAi"]>().mockResolvedValue({
    kind: "read",
    operation: "guidance",
    data: { operations: [], guidance: [] },
  });
  const begin = vi.fn<AiServices["beginAiAuthorization"]>().mockResolvedValue({
    requestToken: "opaque",
    expiresAt: "2026-09-05T00:10:00Z",
  });
  const exchange = vi.fn<AiServices["exchangeAiCode"]>().mockResolvedValue({
    accessToken: "secret",
    tokenType: "Bearer",
    expiresIn: 30,
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = (request: Request) =>
    handleFogAiHttp(request, {
      services: {
        executeAi: execute,
        beginAiAuthorization: begin,
        exchangeAiCode: exchange,
      },
      appUrl: "http://localhost:3000",
      logger,
    });
  return { execute, begin, exchange, run, logger };
}
const call = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer,
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("AI HTTP boundary", () => {
  it("only accepts explicit operations and forbids actor/owner injection and human operations", async () => {
    const f = fixture();
    for (const body of [
      { operation: "hardDelete", input: { id: "x" } },
      { operation: "guidance", input: { ownerId: "other" } },
      { operation: "guidance", input: {}, actor: { kind: "human" } },
      { operation: "memos.create", input: { body: "memo" } },
    ])
      expect((await f.run(call(body))).status).toBe(422);
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      (await f.run(call({ operation: "guidance", input: {} }))).status,
    ).toBe(200);
    expect(f.execute).toHaveBeenCalledWith("a".repeat(64), {
      operation: "guidance",
      input: {},
    });
  });
  it("rejects cookie-only, mixed-cookie, and bearer on human credential transport", async () => {
    const f = fixture();
    expect(
      (
        await f.run(
          call({ operation: "guidance", input: {} }, { Authorization: "" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.run(
          call(
            { operation: "guidance", input: {} },
            { Cookie: "fog_session=human" },
          ),
        )
      ).status,
    ).toBe(403);
    for (const path of [
      "/login",
      "/signup",
      "/settings",
      "/trash",
      "/memos/id/history",
    ]) {
      expect(() =>
        assertHumanTransport(
          new Request(`http://localhost:3000${path}`, {
            headers: { Authorization: bearer, Cookie: "fog_session=human" },
          }),
        ),
      ).toThrow("人間用");
    }
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON, oversized bodies and unsupported media without invocation", async () => {
    const f = fixture();
    const invalid = new Request("http://localhost:3000/api/ai", {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: "{",
    });
    expect((await f.run(invalid)).status).toBe(400);
    expect(
      (
        await f.run(
          call({
            operation: "memos.create",
            input: { body: "a".repeat(512001) },
            idempotencyKey: "large",
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await f.run(call({}, { "Content-Type": "text/plain" }))).status,
    ).toBe(415);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("never redirects an invalid client or duplicate parameters", async () => {
    const f = fixture();
    f.begin.mockRejectedValue(
      new ForbiddenError(
        "INVALID_CLIENT",
        "登録されていないクライアントです。",
      ),
    );
    const url = new URL("http://localhost:3000/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "bad",
      redirect_uri: "https://external.example/callback",
      state: "s".repeat(32),
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    }).toString();
    const response = await f.run(new Request(url));
    expect(response.status).toBe(403);
    expect(response.headers.has("location")).toBe(false);
    url.searchParams.append("client_id", "other");
    expect((await f.run(new Request(url))).status).toBe(403);
    expect(f.begin).toHaveBeenCalledTimes(1);
  });
  it("redirects validated requests only to local consent without credentials", async () => {
    const f = fixture();
    const url = new URL("http://localhost:3000/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "local",
      redirect_uri: "http://127.0.0.1:3456/callback",
      state: "s".repeat(32),
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    }).toString();
    const response = await f.run(new Request(url));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3000/ai/authorize?request=opaque",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("returns credentials only in the no-store exchange response body", async () => {
    const f = fixture();
    const response = await f.run(
      new Request("http://localhost:3000/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "local",
          redirect_uri: "http://127.0.0.1:3456/callback",
          code: "single",
          code_verifier: "a".repeat(43),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      access_token: "secret",
      token_type: "Bearer",
      expires_in: 30,
    });
  });
  it("does not expose unexpected errors or hidden API paths", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error("SQL secret"));
    const response = await f.run(call({ operation: "guidance", input: {} }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("SQL secret");
    expect(f.logger.error).toHaveBeenCalled();
    expect(
      (await f.run(new Request("http://localhost:3000/api/ai/trash"))).status,
    ).toBe(404);
  });
});
describe("registered AI client configuration", () => {
  it("accepts HTTPS and loopback callbacks and defaults to no clients", () => {
    expect(readFogAiClients(undefined)).toEqual([]);
    expect(
      readFogAiClients(
        JSON.stringify([
          {
            id: "local",
            name: "Local",
            redirectUris: [
              "http://127.0.0.1:3456/callback",
              "https://example.test/callback",
            ],
          },
        ]),
      ),
    ).toHaveLength(1);
  });
  it("rejects unsafe redirects and duplicate client IDs", () => {
    for (const uri of [
      "http://example.test/callback",
      "javascript:alert(1)",
      "https://user:password@example.test/callback",
      "https://example.test/callback#fragment",
    ]) {
      expect(() =>
        readFogAiClients(
          JSON.stringify([{ id: "local", name: "Local", redirectUris: [uri] }]),
        ),
      ).toThrow();
    }
    const client = {
      id: "local",
      name: "Local",
      redirectUris: ["http://127.0.0.1:3456/callback"],
    };
    expect(() => readFogAiClients(JSON.stringify([client, client]))).toThrow();
  });
});
