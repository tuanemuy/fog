import type { RequestContainer } from "@repo/core/application/di/types";
import { authorizeAiClient } from "@repo/core/application/identity/authorizeAiClient";
import { consumeAuthorizationCode } from "@repo/core/application/identity/consumeAuthorizationCode";
import {
  AI_ACCESS_TOKEN_TTL_MS,
  AI_SCOPE,
  type AiTokenCodec,
} from "@repo/core/application/ports/aiTokenCodec";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { ClientName } from "@repo/core/domain/identity/valueObject";
import { isPkceChallenge, isPkceVerifier, pkceChallengeOf } from "./pkce";

export type OAuthDeps = Readonly<{
  container: RequestContainer;
  tokenCodec: AiTokenCodec;
  appUrl: string;
}>;

/** P-14's route; the authorize endpoint hands the validated request to it. */
export const AUTHORIZE_PAGE_PATH = "/ai-clients/authorize";

const MAX_REDIRECT_URIS = 10;
const MAX_STATE_LENGTH = 512;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/**
 * A registered redirect URI is `https:` or a loopback `http:` (RFC 8252
 * §7.3); the authorization request must match one exactly, port included.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost")
  );
}

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: NO_STORE },
  );
}

export function handleAuthorizationServerMetadata(appUrl: string): Response {
  const issuer = new URL(appUrl).origin;
  return Response.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [AI_SCOPE],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

export function handleProtectedResourceMetadata(appUrl: string): Response {
  const origin = new URL(appUrl).origin;
  return Response.json(
    {
      resource: origin,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [AI_SCOPE],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

/**
 * Stateless dynamic client registration (RFC 7591's subset): the client
 * gets back a `client_id` that *is* its signed metadata. No table, no
 * secret — public client with PKCE, `token_endpoint_auth_method: "none"`.
 */
export async function handleRegister(
  request: Request,
  deps: OAuthDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null)
      throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError(
      "invalid_client_metadata",
      "The body must be a JSON object",
    );
  }
  let name: string;
  try {
    name = ClientName.create(
      typeof body.client_name === "string" ? body.client_name : "",
    );
  } catch (error) {
    if (isBusinessRuleError(error)) {
      return oauthError(
        "invalid_client_metadata",
        "client_name must be 1 to 100 characters",
      );
    }
    throw error;
  }
  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))
  ) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must be 1 to 10 https or loopback http URIs without a fragment",
    );
  }
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  ) {
    return oauthError(
      "invalid_client_metadata",
      'Only token_endpoint_auth_method "none" is supported',
    );
  }
  const redirectUris = uris.map(String);
  const iat = Math.floor(deps.container.clock.now().getTime() / 1000);
  const clientId = await deps.tokenCodec.issueClientId({
    name,
    redirectUris,
    iat,
  });
  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: iat,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: AI_SCOPE,
    },
    { status: 201, headers: NO_STORE },
  );
}

function authorizePageError(appUrl: string): Response {
  const page = new URL(AUTHORIZE_PAGE_PATH, appUrl);
  page.searchParams.set("error", "invalid_request");
  return Response.redirect(page.toString(), 302);
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

/**
 * `GET /oauth/authorize` (PH-07 §1.2, △-3): the request is validated here
 * and, when sound, signed into a blob P-14 carries; the page then asks the
 * logged-in user. A `client_id` that does not verify or a `redirect_uri`
 * that is not registered cannot be answered by redirect — that is the
 * page's error state. Any other defect goes back to the client as OAuth
 * prescribes. Authentication is not checked here: P-14 is behind the
 * app's guard and the login screen returns to it.
 */
export async function handleAuthorize(
  request: Request,
  deps: OAuthDeps,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET" },
    });
  }
  const q = new URL(request.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const client = await deps.tokenCodec.verifyClientId(clientId);
  if (client === null) return authorizePageError(deps.appUrl);
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return authorizePageError(deps.appUrl);
  }

  const state = q.get("state");
  if (state !== null && state.length > MAX_STATE_LENGTH) {
    return redirectWithError(
      redirectUri,
      "invalid_request",
      "state is too long",
      null,
    );
  }
  if (q.get("response_type") !== "code") {
    return redirectWithError(
      redirectUri,
      "unsupported_response_type",
      "response_type must be code",
      state,
    );
  }
  const challenge = q.get("code_challenge") ?? "";
  if (
    q.get("code_challenge_method") !== "S256" ||
    !isPkceChallenge(challenge)
  ) {
    return redirectWithError(
      redirectUri,
      "invalid_request",
      "PKCE with code_challenge_method=S256 is required",
      state,
    );
  }
  const scope = q.get("scope");
  if (scope !== null && scope.trim() !== "" && scope.trim() !== AI_SCOPE) {
    return redirectWithError(
      redirectUri,
      "invalid_scope",
      `Only scope "${AI_SCOPE}" exists`,
      state,
    );
  }
  const blob = await deps.tokenCodec.issueAuthorizeRequest(
    {
      client: clientId,
      name: client.name,
      redirect: redirectUri,
      state,
      challenge,
      scope: AI_SCOPE,
    },
    deps.container.clock.now(),
  );
  const page = new URL(AUTHORIZE_PAGE_PATH, deps.appUrl);
  page.searchParams.set("request", blob);
  return Response.redirect(page.toString(), 302);
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v),
      ]),
    );
  }
  const form = await request.formData();
  return Object.fromEntries(
    [...form.entries()].map(([k, v]) => [k, String(v)]),
  );
}

/**
 * `POST /oauth/token` (PH-07 §1.2, △-2). `authorization_code` checks the
 * code's signature and expiry, that it was issued to this `client_id` and
 * `redirect_uri`, and the PKCE verifier; then the user's object spends the
 * `jti` and confirms the connection in one transaction. `refresh_token`
 * re-checks the connection (revocation is immediate through it) and hands
 * out a new pair — the refresh is not one-time; the connection's
 * revocation is what ends it.
 */
export async function handleToken(
  request: Request,
  deps: OAuthDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  let form: Record<string, string>;
  try {
    form = await readForm(request);
  } catch {
    return oauthError("invalid_request", "The body could not be read");
  }
  const now = deps.container.clock.now();
  const grant = form.grant_type;

  if (grant === "authorization_code") {
    const client = await deps.tokenCodec.verifyClientId(form.client_id ?? "");
    if (client === null)
      return oauthError("invalid_client", "Unknown client", 401);
    const code = await deps.tokenCodec.verifyCode(form.code ?? "", now);
    const verifier = form.code_verifier ?? "";
    if (
      code === null ||
      code.client !== form.client_id ||
      code.redirect !== (form.redirect_uri ?? "") ||
      !isPkceVerifier(verifier) ||
      (await pkceChallengeOf(verifier)) !== code.challenge
    ) {
      return oauthError("invalid_grant", "The authorization code is not valid");
    }
    const consumed = await consumeAuthorizationCode({
      container: deps.container,
      input: {
        userId: code.uid,
        jti: code.jti,
        expiresAt: new Date(code.exp),
        connectionId: code.cid,
      },
    });
    if (!consumed.ok) {
      return oauthError("invalid_grant", "The authorization code is not valid");
    }
    return tokenResponse(deps, code.uid, code.cid, code.client, now);
  }

  if (grant === "refresh_token") {
    const refresh = await deps.tokenCodec.verifyRefresh(
      form.refresh_token ?? "",
      now,
    );
    if (refresh === null)
      return oauthError("invalid_grant", "The refresh token is not valid");
    // A public client refreshes with its `client_id`, and only the client
    // the pair was issued to may (OAuth 2.1 §4.3.1).
    if ((form.client_id ?? "") !== refresh.client) {
      return oauthError(
        "invalid_grant",
        "The refresh token was not issued to this client",
      );
    }
    const client = await authorizeAiClient({
      container: deps.container,
      input: { userId: refresh.uid, connectionId: refresh.cid },
    });
    if (client === null)
      return oauthError("invalid_grant", "The connection is no longer active");
    return tokenResponse(deps, refresh.uid, refresh.cid, refresh.client, now);
  }

  return oauthError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
}

async function tokenResponse(
  deps: OAuthDeps,
  uid: string,
  cid: string,
  client: string,
  now: Date,
): Promise<Response> {
  const [access_token, refresh_token] = await Promise.all([
    deps.tokenCodec.issueAccess(uid, cid, now),
    deps.tokenCodec.issueRefresh(uid, cid, client, now),
  ]);
  return Response.json(
    {
      access_token,
      token_type: "Bearer",
      expires_in: Math.floor(AI_ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token,
      scope: AI_SCOPE,
    },
    { headers: NO_STORE },
  );
}
