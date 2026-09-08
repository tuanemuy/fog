/**
 * A test client for the AI API (design D-04, PH-07 §5). Runs on Node 24
 * with type stripping — no build step:
 *
 *   pnpm --filter @repo/web ai-client -- register [--base http://localhost:3000] [--name "Test Client"]
 *   pnpm --filter @repo/web ai-client -- authorize        # prints the URL; open it in a logged-in browser
 *   pnpm --filter @repo/web ai-client -- refresh
 *   pnpm --filter @repo/web ai-client -- mcp <method> ['<json params>']
 *   pnpm --filter @repo/web ai-client -- call <tool> ['<json arguments>']
 *   pnpm --filter @repo/web ai-client -- whoami          # what the state file holds (no secrets printed)
 *
 * State lives in `apps/web/.ai-client.json` (git-ignored): the registered
 * `client_id`, the loopback redirect URI, and the tokens. `authorize`
 * starts a loopback HTTP server for the redirect, so the whole OAuth 2.1
 * round trip (DCR → authorize → code → token) happens against a real
 * server — the same one the browser is logged in to.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type State = {
  base: string;
  clientId?: string | undefined;
  redirectUri?: string | undefined;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
};

const STATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".ai-client.json",
);

function loadState(): State {
  if (!existsSync(STATE_PATH)) return { base: "http://localhost:3000" };
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function register(args: string[]): Promise<void> {
  const state = loadState();
  state.base = option(args, "--base") ?? state.base;
  const port = Number(option(args, "--port") ?? "8765");
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const response = await fetch(new URL("/oauth/register", state.base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: option(args, "--name") ?? "fog test client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await json(response)) as { client_id?: string };
  if (response.status !== 201 || typeof body.client_id !== "string") {
    console.error(`register failed: ${response.status}`);
    print(body);
    process.exit(1);
  }
  state.clientId = body.client_id;
  state.redirectUri = redirectUri;
  saveState(state);
  print({
    status: response.status,
    client_id: body.client_id,
    redirect_uri: redirectUri,
  });
}

async function authorize(args: string[]): Promise<void> {
  const state = loadState();
  if (!state.clientId || !state.redirectUri) {
    console.error("run `register` first");
    process.exit(1);
  }
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const expectedState = base64url(randomBytes(16));
  const url = new URL("/oauth/authorize", state.base);
  url.searchParams.set("client_id", state.clientId);
  url.searchParams.set("redirect_uri", state.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", expectedState);
  url.searchParams.set("scope", "ai");

  const port = Number(new URL(state.redirectUri).port);
  const code = await new Promise<string>((resolveCode, reject) => {
    const server = createServer((req, res) => {
      const incoming = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (incoming.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = incoming.searchParams.get("error");
      const returnedState = incoming.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (error !== null) {
        res.end(`fog test client: ${error}\n`);
        server.close();
        reject(new Error(`authorization ended with error=${error}`));
        return;
      }
      if (returnedState !== expectedState) {
        res.end("fog test client: state mismatch\n");
        server.close();
        reject(new Error("state mismatch"));
        return;
      }
      res.end("fog test client: authorized. You can close this tab.\n");
      server.close();
      resolveCode(incoming.searchParams.get("code") ?? "");
    });
    server.listen(port, "127.0.0.1", () => {
      console.log("Open this URL in the browser that is logged in to fog:\n");
      console.log(url.toString());
      console.log(`\nWaiting for the redirect on ${state.redirectUri} …`);
      if (args.includes("--open")) {
        import("node:child_process").then(({ spawn }) =>
          spawn("open", [url.toString()], {
            stdio: "ignore",
            detached: true,
          }).unref(),
        );
      }
    });
    setTimeout(
      () => {
        server.close();
        reject(new Error("timed out waiting for the authorization"));
      },
      10 * 60 * 1000,
    ).unref();
  });

  const response = await fetch(new URL("/oauth/token", state.base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: state.clientId,
      redirect_uri: state.redirectUri,
    }).toString(),
  });
  const tokens = (await json(response)) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (response.status !== 200 || !tokens.access_token) {
    console.error(`token exchange failed: ${response.status}`);
    print(tokens);
    process.exit(1);
  }
  state.accessToken = tokens.access_token;
  state.refreshToken = tokens.refresh_token;
  saveState(state);
  print({
    status: response.status,
    token_type: "Bearer",
    expires_in: (tokens as { expires_in?: number }).expires_in,
  });
}

async function refresh(): Promise<void> {
  const state = loadState();
  if (!state.refreshToken) {
    console.error("no refresh token; run `authorize` first");
    process.exit(1);
  }
  const response = await fetch(new URL("/oauth/token", state.base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
    }).toString(),
  });
  const tokens = (await json(response)) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (response.status === 200 && tokens.access_token) {
    state.accessToken = tokens.access_token;
    state.refreshToken = tokens.refresh_token;
    saveState(state);
  }
  print({
    status: response.status,
    ok: response.status === 200,
    body: response.status === 200 ? { refreshed: true } : tokens,
  });
}

async function mcp(args: string[]): Promise<void> {
  const state = loadState();
  const method = args[0];
  if (!method) {
    console.error("usage: mcp <method> ['<json params>']");
    process.exit(1);
  }
  const params = args[1] ? JSON.parse(args[1]) : undefined;
  const response = await fetch(new URL("/mcp", state.base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(state.accessToken
        ? { authorization: `Bearer ${state.accessToken}` }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  print({ status: response.status, body: await json(response) });
}

async function call(args: string[]): Promise<void> {
  const state = loadState();
  const tool = args[0];
  if (!tool) {
    console.error("usage: call <tool> ['<json arguments>']");
    process.exit(1);
  }
  const response = await fetch(new URL(`/api/ai/${tool}`, state.base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(state.accessToken
        ? { authorization: `Bearer ${state.accessToken}` }
        : {}),
    },
    body: args[1] ?? "{}",
  });
  print({ status: response.status, body: await json(response) });
}

function whoami(): void {
  const state = loadState();
  print({
    base: state.base,
    clientId: state.clientId ? `${state.clientId.slice(0, 16)}…` : null,
    redirectUri: state.redirectUri ?? null,
    hasAccessToken: Boolean(state.accessToken),
    hasRefreshToken: Boolean(state.refreshToken),
  });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "register":
    await register(rest);
    break;
  case "authorize":
    await authorize(rest);
    break;
  case "refresh":
    await refresh();
    break;
  case "mcp":
    await mcp(rest);
    break;
  case "call":
    await call(rest);
    break;
  case "whoami":
    whoami();
    break;
  default:
    console.error(
      "usage: ai-client <register|authorize|refresh|mcp|call|whoami> …",
    );
    process.exit(1);
}
