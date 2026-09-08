import {
  createAiTokenCodec,
  pkceChallengeOf,
} from "@repo/core/adapters/webcrypto/aiTokenCodec";
import { trippingMemoGateway } from "@repo/core/application/__tests__/fakes";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import {
  makeContainer,
  recordingGateway,
} from "@repo/core/application/identity/__tests__/unitContainer";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../mcp";
import { handleAuthorize, handleRegister, handleToken } from "../oauth";
import { handleAiRest } from "../rest";

const APP_URL = "http://localhost:3000";
const SECRET = "s".repeat(48);
const NOW = new Date("2026-09-08T00:00:00.000Z");
const codec = createAiTokenCodec({ secret: SECRET });

type Overrides = Parameters<typeof recordingGateway>[1];

function container(
  identity: Overrides = {},
  memo: Parameters<typeof trippingMemoGateway>[1] = {},
): RequestContainer {
  // The session codec is the one request-side piece no AI handler touches.
  return makeContainer(recordingGateway([], identity), {
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }, memo),
  }) as RequestContainer;
}

const activeClient: Overrides = {
  authorizeAiClient: async () => ({ clientName: "Claude" }),
};

function deps(c: RequestContainer, appUrl = APP_URL) {
  return {
    container: c,
    tokenCodec: codec,
    appUrl,
    serverVersion: "test",
  };
}

async function bearer(uid = "user-1", cid = "conn-1"): Promise<string> {
  return `Bearer ${await codec.issueAccess(uid, cid, NOW)}`;
}

function rpc(method: string, params?: unknown, auth?: string, id: unknown = 1) {
  return new Request(`${APP_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("POST /mcp", () => {
  it("refuses a missing, malformed, or revoked token with 401 and the resource metadata", async () => {
    const c = container({ authorizeAiClient: async () => null });
    for (const auth of [undefined, "Bearer nope", await bearer()]) {
      const response = await handleMcp(rpc("ping", undefined, auth), deps(c));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        `resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`,
      );
    }
  });

  it("initialize answers the protocol version, the server, and the guidance; ping and tools/list follow", async () => {
    const c = container(activeClient);
    const init = await (
      await handleMcp(rpc("initialize", {}, await bearer()), deps(c))
    ).json();
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fog", version: "test" },
      },
    });
    expect(
      (init as { result: { instructions: string } }).result.instructions,
    ).toContain("replaceAll");
    expect(
      await (
        await handleMcp(rpc("ping", undefined, await bearer()), deps(c))
      ).json(),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    const list = (await (
      await handleMcp(rpc("tools/list", {}, await bearer()), deps(c))
    ).json()) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toHaveLength(11);
    expect(
      list.result.tools.every((t) => typeof t.inputSchema === "object"),
    ).toBe(true);
  });

  it("notifications get 202, batches and non-JSON-RPC bodies 400, unknown methods -32601, GET 405", async () => {
    const c = container(activeClient);
    const notified = await handleMcp(
      new Request(`${APP_URL}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await bearer(),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
      deps(c),
    );
    expect(notified.status).toBe(202);
    const batch = await handleMcp(
      new Request(`${APP_URL}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await bearer(),
        },
        body: "[]",
      }),
      deps(c),
    );
    expect(batch.status).toBe(400);
    const unknown = (await (
      await handleMcp(rpc("resources/list", {}, await bearer()), deps(c))
    ).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
    expect(
      (await handleMcp(new Request(`${APP_URL}/mcp`), deps(c))).status,
    ).toBe(405);
    const foreign = await handleMcp(
      new Request(`${APP_URL}/mcp`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          authorization: await bearer(),
        },
        body: "{}",
      }),
      deps(c),
    );
    expect(foreign.status).toBe(403);
    // O-4: the same origin passes even when APP_URL carries a path or slash.
    const own = await handleMcp(
      new Request(`${APP_URL}/mcp`, {
        method: "POST",
        headers: {
          origin: APP_URL,
          authorization: await bearer(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      deps(c, `${APP_URL}/`),
    );
    expect(own.status).toBe(200);
  });

  it("tools/call runs the tool with the AI actor, answers a business failure as isError, a system one as -32000", async () => {
    const posted: unknown[] = [];
    const c = container(activeClient, {
      postMemo: async (userId, input) => {
        posted.push([userId, input]);
        return {
          id: "m1",
          body: input.body,
          postedAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          version: 0,
        };
      },
      getMemo: async () => {
        throw new NotFoundError("MEMO_NOT_FOUND", "The memo was not found");
      },
      recentMemos: async () => {
        throw new SystemError(
          SystemErrorCode.DatabaseError,
          "SQLITE_BUSY on memos",
        );
      },
    });
    const ok = (await (
      await handleMcp(
        rpc(
          "tools/call",
          { name: "post_memo", arguments: { body: "hello" } },
          await bearer(),
        ),
        deps(c),
      )
    ).json()) as { result: { isError: boolean; structuredContent: unknown } };
    expect(ok.result.isError).toBe(false);
    expect(ok.result.structuredContent).toMatchObject({
      memo: { id: "m1", body: "hello" },
    });
    expect(posted[0]).toEqual([
      "user-1",
      {
        body: "hello",
        actor: {
          kind: "aiClient",
          userId: "user-1",
          connectionId: "conn-1",
          clientName: "Claude",
        },
      },
    ]);

    const notFound = (await (
      await handleMcp(
        rpc(
          "tools/call",
          { name: "get", arguments: { type: "memo", id: "x" } },
          await bearer(),
        ),
        deps(c),
      )
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(notFound.result.isError).toBe(true);
    expect(JSON.parse(notFound.result.content[0]?.text ?? "{}")).toMatchObject({
      kind: "notFound",
      code: "MEMO_NOT_FOUND",
    });

    const invalid = (await (
      await handleMcp(
        rpc(
          "tools/call",
          { name: "get", arguments: { type: "nope" } },
          await bearer(),
        ),
        deps(c),
      )
    ).json()) as { error: { code: number } };
    expect(invalid.error.code).toBe(-32602);

    const unknownTool = (await (
      await handleMcp(
        rpc(
          "tools/call",
          { name: "list_trash", arguments: {} },
          await bearer(),
        ),
        deps(c),
      )
    ).json()) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32601);

    const system = (await (
      await handleMcp(
        rpc(
          "tools/call",
          { name: "recent_memos", arguments: {} },
          await bearer(),
        ),
        deps(c),
      )
    ).json()) as { error: { code: number; message: string } };
    expect(system.error.code).toBe(-32000);
    expect(system.error.message).not.toContain("SQLITE");
  });
});

describe("POST /api/ai/<tool>", () => {
  it("maps a result to 200, failures to their status, unknown tools to 404, and 401 without a token", async () => {
    const c = container(activeClient, {
      recentMemos: async () => ({ items: [] }),
      getMemo: async () => {
        throw new NotFoundError("MEMO_NOT_FOUND", "no");
      },
    });
    const okResponse = await handleAiRest(
      new Request(`${APP_URL}/api/ai/recent_memos`, {
        method: "POST",
        headers: { authorization: await bearer() },
        body: "",
      }),
      "/api/ai/recent_memos",
      deps(c),
    );
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({ result: { items: [] } });

    const missing = await handleAiRest(
      new Request(`${APP_URL}/api/ai/get`, {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "memo", id: "x" }),
      }),
      "/api/ai/get",
      deps(c),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { kind: "notFound", code: "MEMO_NOT_FOUND" },
    });

    expect(
      (
        await handleAiRest(
          new Request(`${APP_URL}/api/ai/list_trash`, { method: "POST" }),
          "/api/ai/list_trash",
          deps(c),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleAiRest(
          new Request(`${APP_URL}/api/ai/recent_memos`, { method: "POST" }),
          "/api/ai/recent_memos",
          deps(c),
        )
      ).status,
    ).toBe(401);
    const index = (await (
      await handleAiRest(new Request(`${APP_URL}/api/ai`), "/api/ai", deps(c))
    ).json()) as {
      tools: unknown[];
      instructions: string;
    };
    expect(index.tools).toHaveLength(11);
    expect(index.instructions).toContain("list_topics");
  });
});

describe("OAuth 2.1 endpoints", () => {
  async function registered(c: RequestContainer) {
    const response = await handleRegister(
      new Request(`${APP_URL}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["http://127.0.0.1:8765/callback"],
        }),
      }),
      deps(c),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { client_id: string };
  }

  it("registers a public client statelessly and refuses bad metadata", async () => {
    const c = container();
    const { client_id } = await registered(c);
    expect(await codec.verifyClientId(client_id)).toMatchObject({
      name: "Test Client",
      redirectUris: ["http://127.0.0.1:8765/callback"],
    });
    for (const body of [
      { client_name: "", redirect_uris: ["https://a.example/cb"] },
      { client_name: "x".repeat(101), redirect_uris: ["https://a.example/cb"] },
      { client_name: "ok", redirect_uris: [] },
      { client_name: "ok", redirect_uris: ["http://evil.example/cb"] },
      { client_name: "ok", redirect_uris: ["https://a.example/cb#frag"] },
      {
        client_name: "ok",
        redirect_uris: ["https://a.example/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    ]) {
      const response = await handleRegister(
        new Request(`${APP_URL}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        deps(c),
      );
      expect(response.status).toBe(400);
    }
  });

  it("authorize: a sound request becomes a signed blob for P-14; a bad client or redirect is the page's error; other defects go back to the client", async () => {
    const c = container();
    const { client_id } = await registered(c);
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceChallengeOf(verifier);
    const url = new URL(`${APP_URL}/oauth/authorize`);
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "st");
    const sound = await handleAuthorize(new Request(url), deps(c));
    expect(sound.status).toBe(302);
    const page = new URL(sound.headers.get("location") ?? "");
    expect(page.pathname).toBe("/ai-clients/authorize");
    const blob = await codec.verifyAuthorizeRequest(
      page.searchParams.get("request") ?? "",
      NOW,
    );
    expect(blob).toMatchObject({
      client: client_id,
      name: "Test Client",
      redirect: "http://127.0.0.1:8765/callback",
      state: "st",
      challenge,
    });

    const tampered = new URL(url);
    tampered.searchParams.set("client_id", "tampered-client");
    expect(
      new URL(
        (await handleAuthorize(new Request(tampered), deps(c))).headers.get(
          "location",
        ) ?? "",
      ).search,
    ).toBe("?error=invalid_request");
    const wrongRedirect = new URL(url);
    wrongRedirect.searchParams.set(
      "redirect_uri",
      "http://127.0.0.1:9999/callback",
    );
    expect(
      new URL(
        (
          await handleAuthorize(new Request(wrongRedirect), deps(c))
        ).headers.get("location") ?? "",
      ).pathname,
    ).toBe("/ai-clients/authorize");

    const noPkce = new URL(url);
    noPkce.searchParams.delete("code_challenge");
    const back = new URL(
      (await handleAuthorize(new Request(noPkce), deps(c))).headers.get(
        "location",
      ) ?? "",
    );
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:8765/callback");
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("st");
  });

  it("token: exchanges a code once under PKCE, refuses the wrong verifier / client / redirect, and refreshes while the connection lives", async () => {
    const consumed: string[] = [];
    let active = true;
    const c = container({
      consumeAuthorizationCode: async (_userId, dto) => {
        if (consumed.includes(dto.jti) || !active) return { ok: false };
        consumed.push(dto.jti);
        return { ok: true, clientName: "Test Client" };
      },
      authorizeAiClient: async () =>
        active ? { clientName: "Test Client" } : null,
    });
    const { client_id } = await registered(c);
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceChallengeOf(verifier);
    const code = await codec.issueCode(
      {
        jti: "jti-1",
        uid: "user-1",
        cid: "conn-1",
        client: client_id,
        redirect: "http://127.0.0.1:8765/callback",
        challenge,
      },
      NOW,
    );
    const exchange = (form: Record<string, string>) =>
      handleToken(
        new Request(`${APP_URL}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString(),
        }),
        deps(c),
      );
    const good = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id,
      redirect_uri: "http://127.0.0.1:8765/callback",
    };
    for (const bad of [
      {
        ...good,
        code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-1",
      },
      { ...good, redirect_uri: "http://127.0.0.1:1/callback" },
      {
        ...good,
        client_id: await codec.issueClientId({
          name: "other",
          redirectUris: ["https://o.example/cb"],
          iat: 1,
        }),
      },
    ]) {
      const response = await exchange(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect(consumed).toEqual([]);

    const first = await exchange(good);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "ai",
    });
    expect(await codec.verifyAccess(tokens.access_token, NOW)).toMatchObject({
      uid: "user-1",
      cid: "conn-1",
    });
    expect(first.headers.get("cache-control")).toBe("no-store");

    // The same code a second time is spent.
    expect((await exchange(good)).status).toBe(400);

    // O-2: the pair is bound to the client it was issued to.
    for (const client_id of [
      undefined,
      await codec.issueClientId({
        name: "other",
        redirectUris: ["https://o.example/cb"],
        iat: 1,
      }),
    ]) {
      const foreign = await exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        ...(client_id === undefined ? {} : { client_id }),
      });
      expect(foreign.status).toBe(400);
      expect(await foreign.json()).toMatchObject({ error: "invalid_grant" });
    }
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id,
    });
    expect(refreshed.status).toBe(200);
    const renewed = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(await codec.verifyAccess(renewed.access_token, NOW)).toMatchObject({
      uid: "user-1",
      cid: "conn-1",
    });
    expect(await codec.verifyRefresh(renewed.refresh_token, NOW)).toMatchObject(
      { client: client_id },
    );

    active = false;
    const dead = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id,
    });
    expect(dead.status).toBe(400);
    expect(await dead.json()).toMatchObject({ error: "invalid_grant" });

    expect((await exchange({ grant_type: "password" })).status).toBe(400);
  });
});
