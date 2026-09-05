import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "zod";

const origin = new URL(process.env.FOG_URL ?? "http://localhost:3000");
const clientId = process.env.FOG_CLIENT_ID ?? "fog-local-client";
const redirectUri =
  process.env.FOG_REDIRECT_URI ?? "http://127.0.0.1:3456/callback";
const tokenFile = process.env.FOG_TOKEN_FILE ?? "/tmp/fog-ai-local-token.json";
const tokenSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
});
const storedToken = z.object({
  accessToken: z.string(),
  origin: z.string().url(),
  clientId: z.string(),
  expiresAt: z.string(),
});

async function authorize() {
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port
  )
    throw new Error(
      "The local fixture requires an explicit 127.0.0.1 HTTP callback port.",
    );
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL("/oauth/authorize", origin);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  await new Promise<void>((resolve, reject) => {
    let handling = false;
    const server = createServer(async (request, response) => {
      const callback = new URL(request.url ?? "/", redirect);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (
        request.method !== "GET" ||
        callback.pathname !== redirect.pathname ||
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== state
      ) {
        response
          .writeHead(400)
          .end(
            "認可応答を確認できません。クライアントから接続をやり直してください。",
          );
        return;
      }
      if (handling) {
        response.writeHead(409).end("処理済みです。");
        return;
      }
      handling = true;
      try {
        if (callback.searchParams.get("error")) {
          response.end("接続を拒否しました。fogには接続していません。");
          console.log("Authorization denied; no credential was saved.");
          return;
        }
        const code = callback.searchParams.get("code");
        if (!code || callback.searchParams.getAll("code").length !== 1)
          throw new Error("Missing single authorization code");
        const exchange = await fetch(new URL("/oauth/token", origin), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            redirect_uri: redirectUri,
            code,
            code_verifier: verifier,
          }),
        });
        if (!exchange.ok)
          throw new Error(`Token exchange failed (${exchange.status})`);
        const token = tokenSchema.parse(await exchange.json());
        await writeFile(
          tokenFile,
          JSON.stringify(
            {
              accessToken: token.access_token,
              origin: origin.origin,
              clientId,
              expiresAt: new Date(
                Date.now() + token.expires_in * 1000,
              ).toISOString(),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        await chmod(tokenFile, 0o600);
        response.end(
          "接続しました。このタブを閉じて、AIクライアントを利用できます。",
        );
        console.log(`Connected. Credential saved to ${tokenFile}`);
      } catch (error) {
        response
          .writeHead(400)
          .end(
            "接続に失敗しました。クライアントから接続をやり直してください。",
          );
        reject(error);
      } finally {
        clearTimeout(timeout);
        server.close(() => resolve());
      }
    });
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("Authorization timed out"));
      },
      10 * 60 * 1000,
    );
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(Number(redirect.port), redirect.hostname, () =>
      console.log(`Open this URL in your browser:\n${url.href}`),
    );
  });
}

async function api(raw: string | undefined) {
  if (!raw)
    throw new Error(
      'Usage: fog-ai-client.ts api \'{"operation":"guidance","input":{}}\'',
    );
  const token = storedToken.parse(
    JSON.parse(await readFile(tokenFile, "utf8")),
  );
  if (token.origin !== origin.origin || token.clientId !== clientId)
    throw new Error("Credential belongs to a different origin or client");
  const response = await fetch(new URL("/api/ai", origin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(JSON.parse(raw)),
  });
  console.log(
    JSON.stringify(
      { status: response.status, result: await response.json() },
      null,
      2,
    ),
  );
  if (!response.ok) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "authorize") await authorize();
else if (command === "api") await api(process.argv[3]);
else throw new Error("Use authorize or api");
