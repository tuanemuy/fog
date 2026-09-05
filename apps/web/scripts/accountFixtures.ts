import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SMTPServer } from "smtp-server";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
const html = (response: ServerResponse, body: string) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(
    `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fog ローカル認証fixture</title><style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:16px}label,input,select{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px}article{padding:16px;border:1px solid #ccc;margin:16px 0}a{overflow-wrap:anywhere}</style>${body}</html>`,
  );
};
type Mode =
  | "normal"
  | "bad-signature"
  | "bad-issuer"
  | "bad-audience"
  | "bad-nonce"
  | "expired"
  | "unverified";
export async function startAccountFixtures({
  appUrl = "http://localhost:3000",
  issuerPort = 3457,
  mailPort = 1025,
  mailboxPort = 8025,
}: {
  appUrl?: string;
  issuerPort?: number;
  mailPort?: number;
  mailboxPort?: number;
} = {}) {
  const app = new URL(appUrl);
  if (
    app.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(app.hostname)
  )
    throw new Error("Fixture application must be HTTP loopback");
  const key = await generateKeyPair("RS256");
  const bad = await generateKeyPair("RS256");
  const kid = randomBytes(8).toString("hex");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const pending = new Map<
    string,
    { state: string; nonce: string; challenge: string; expires: number }
  >();
  const codes = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      subject: string;
      email: string;
      mode: Mode;
      expires: number;
    }
  >();
  const clientId = "fog-local-oidc";
  const clientSecret = "local-fixture-secret";
  const redirectUri = new URL("/auth/google/callback", app).href;
  let issuer = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", issuer);
      if (url.pathname === "/jwks") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const p = url.searchParams;
        if (
          p.get("client_id") !== clientId ||
          p.get("redirect_uri") !== redirectUri ||
          p.get("response_type") !== "code" ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("state") ||
          !p.get("nonce") ||
          !p.get("code_challenge")
        ) {
          response.writeHead(400).end("Invalid request");
          return;
        }
        const id = randomBytes(32).toString("base64url");
        pending.set(id, {
          state: p.get("state") ?? "",
          nonce: p.get("nonce") ?? "",
          challenge: p.get("code_challenge") ?? "",
          expires: Date.now() + 600000,
        });
        html(
          response,
          `<h1>ローカルGoogle/OIDC fixture</h1><p>実Googleへの接続は行いません。</p><form action="/approve" method="post"><input type="hidden" name="request" value="${id}"><label>メールアドレス<input name="email" value="sso-new@example.test" required></label><label>Google主体<input name="subject" value="local-google-new" required></label><label>検証モード<select name="mode"><option value="normal">正常</option><option value="bad-signature">署名不正</option><option value="bad-issuer">issuer不一致</option><option value="bad-audience">audience不一致</option><option value="bad-nonce">nonce不一致</option><option value="expired">期限切れ</option><option value="unverified">メール未確認</option></select></label><button name="decision" value="allow">許可</button> <button name="decision" value="cancel">キャンセル</button> <button name="decision" value="failure">認証失敗</button></form>`,
        );
        return;
      }
      if (
        (url.pathname === "/approve" || url.pathname === "/token") &&
        request.method === "POST"
      ) {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 16384) {
            response.writeHead(413).end();
            return;
          }
        }
        const p = new URLSearchParams(body);
        if (url.pathname === "/approve") {
          const id = p.get("request") ?? "";
          const record = pending.get(id);
          pending.delete(id);
          if (!record || record.expires <= Date.now()) {
            response.writeHead(400).end("Expired request");
            return;
          }
          const redirect = new URL(redirectUri);
          redirect.searchParams.set("state", record.state);
          if (p.get("decision") === "cancel")
            redirect.searchParams.set("error", "access_denied");
          else if (p.get("decision") === "failure")
            redirect.searchParams.set("error", "server_error");
          else {
            const code = randomBytes(32).toString("base64url");
            codes.set(code, {
              nonce: record.nonce,
              challenge: record.challenge,
              subject: p.get("subject") ?? "",
              email: p.get("email") ?? "",
              mode: (p.get("mode") ?? "normal") as Mode,
              expires: Date.now() + 120000,
            });
            redirect.searchParams.set("code", code);
          }
          response
            .writeHead(303, {
              Location: redirect.href,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            })
            .end();
          return;
        }
        const code = p.get("code") ?? "";
        const record = codes.get(code);
        codes.delete(code);
        if (
          !record ||
          record.expires <= Date.now() ||
          p.get("grant_type") !== "authorization_code" ||
          p.get("client_id") !== clientId ||
          p.get("client_secret") !== clientSecret ||
          p.get("redirect_uri") !== redirectUri ||
          createHash("sha256")
            .update(p.get("code_verifier") ?? "")
            .digest("base64url") !== record.challenge
        ) {
          response
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const mode = record.mode;
        const token = await new SignJWT({
          email: record.email,
          email_verified: mode !== "unverified",
          nonce: mode === "bad-nonce" ? "wrong" : record.nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid })
          .setSubject(record.subject)
          .setIssuer(mode === "bad-issuer" ? "https://invalid.example" : issuer)
          .setAudience(mode === "bad-audience" ? "wrong" : clientId)
          .setIssuedAt(now)
          .setExpirationTime(mode === "expired" ? now - 60 : now + 300)
          .sign(mode === "bad-signature" ? bad.privateKey : key.privateKey);
        response
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(
            JSON.stringify({
              id_token: token,
              access_token: "local-fixture-access",
              token_type: "Bearer",
              expires_in: 300,
            }),
          );
        return;
      }
      response.writeHead(404).end("Not found");
    } catch {
      response.writeHead(500).end("Fixture error");
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(issuerPort, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener missing");
  issuer = `http://127.0.0.1:${address.port}`;
  const messages: {
    id: number;
    to: string[];
    subject: string;
    text: string;
  }[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const split = raw.search(/\r?\n\r?\n/);
        const headers = raw.slice(0, split);
        let text = raw.slice(split).trim();
        if (/Content-Transfer-Encoding: base64/i.test(headers))
          text = Buffer.from(text.replace(/\s/g, ""), "base64").toString(
            "utf8",
          );
        else if (/Content-Transfer-Encoding: quoted-printable/i.test(headers))
          text = Buffer.from(
            text
              .replace(/=\r?\n/g, "")
              .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            "latin1",
          ).toString("utf8");
        messages.push({
          id: messages.length + 1,
          to: session.envelope.rcptTo.map((x) => x.address),
          subject: "fog のパスワードを再設定",
          text,
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) =>
    smtp.listen(mailPort, "127.0.0.1", resolve),
  );
  const mailbox = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/messages") {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(messages));
      return;
    }
    html(
      response,
      `<h1>ローカル復旧メール受信箱</h1><p>外部メール配送は行いません。</p>${
        messages
          .slice()
          .reverse()
          .map((m) => {
            const link = m.text.match(
              /http:\/\/(?:localhost|127\.0\.0\.1):\d+\/password\/reset\?token=[A-Za-z0-9_-]+/,
            )?.[0];
            return `<article><h2>メール ${m.id}</h2><p>宛先: ${escapeHtml(m.to.join(", "))}</p><p>${escapeHtml(m.subject)}</p>${link ? `<a href="${escapeHtml(link)}">パスワードを再設定</a>` : "<p>リンクはありません。</p>"}</article>`;
          })
          .join("") || "<p>メールはまだありません。</p>"
      }`,
    );
  });
  await new Promise<void>((resolve) =>
    mailbox.listen(mailboxPort, "127.0.0.1", resolve),
  );
  return {
    issuer,
    clientId,
    clientSecret,
    messages,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          mailbox.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve) => smtp.close(resolve)),
      ]);
    },
  };
}
