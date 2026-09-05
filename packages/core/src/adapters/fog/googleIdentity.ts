import { UnauthorizedError } from "@repo/core/application/errors";
import type { GoogleIdentityPort } from "@repo/core/application/fog/accountPorts";
import type { Clock } from "@repo/core/application/ports/clock";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

const loopback = (value: string) => {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password
  );
};
export function createGoogleIdentity({
  clientId,
  clientSecret,
  appUrl,
  clock,
  fixtureOrigin,
}: {
  clientId: string;
  clientSecret: string;
  appUrl: string;
  clock: Clock;
  fixtureOrigin?: string;
}): GoogleIdentityPort {
  if (fixtureOrigin && (!loopback(fixtureOrigin) || !loopback(appUrl)))
    throw new Error(
      "Local identity fixture requires loopback issuer and application URLs",
    );
  const redirectUri = new URL("/auth/google/callback", appUrl).href;
  const authorizationEndpoint = fixtureOrigin
    ? new URL("/authorize", fixtureOrigin).href
    : "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenEndpoint = fixtureOrigin
    ? new URL("/token", fixtureOrigin).href
    : "https://oauth2.googleapis.com/token";
  const jwksUri = fixtureOrigin
    ? new URL("/jwks", fixtureOrigin).href
    : "https://www.googleapis.com/oauth2/v3/certs";
  const issuer = fixtureOrigin
    ? [new URL(fixtureOrigin).origin]
    : ["https://accounts.google.com", "accounts.google.com"];
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: 10000,
    [customFetch]: (input, init) =>
      fetch(input, { ...init, redirect: "error" }),
  });
  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.href;
    },
    async exchange({ code, codeVerifier, nonce }) {
      try {
        const response = await fetch(tokenEndpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code,
            code_verifier: codeVerifier,
          }),
        });
        if (!response.ok) throw new Error("Token exchange failed");
        const tokens: unknown = await response.json();
        if (
          !tokens ||
          typeof tokens !== "object" ||
          !("id_token" in tokens) ||
          typeof tokens.id_token !== "string"
        )
          throw new Error("ID token missing");
        const { payload } = await jwtVerify(tokens.id_token, jwks, {
          issuer,
          audience: clientId,
          algorithms: ["RS256"],
          currentDate: clock.now(),
          maxTokenAge: "2h",
          clockTolerance: 5,
          requiredClaims: [
            "sub",
            "email",
            "email_verified",
            "nonce",
            "iat",
            "exp",
          ],
        });
        if (
          payload.nonce !== nonce ||
          payload.email_verified !== true ||
          typeof payload.sub !== "string" ||
          !payload.sub ||
          payload.sub.length > 255 ||
          typeof payload.email !== "string" ||
          payload.email.length > 254 ||
          (payload.azp !== undefined && payload.azp !== clientId) ||
          (Array.isArray(payload.aud) &&
            payload.aud.length > 1 &&
            payload.azp !== clientId)
        )
          throw new Error("Identity claims invalid");
        return {
          subject: payload.sub,
          email: payload.email,
          emailVerified: true,
        };
      } catch {
        throw new UnauthorizedError(
          "GOOGLE_AUTH_FAILED",
          "Googleでの認証を確認できませんでした。もう一度お試しください。",
        );
      }
    },
  };
}
