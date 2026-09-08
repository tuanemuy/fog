import { deriveHmacKey } from "./derivedHmac";
import { fromBase64Url, toBase64Url } from "./encoding";

/** The floor the request config asserts for `AI_CLIENT_TOKEN_SECRET`. */
export const MIN_AI_CLIENT_TOKEN_SECRET_LENGTH = 32;

export const AI_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const AI_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AI_AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const AI_AUTHORIZE_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The one scope a connection carries (`TokenScope.ai()`). */
export const AI_SCOPE = "ai";

/** `client_id` values start with this so a stray string is refused before any HMAC. */
export const AI_CLIENT_ID_PREFIX = "fog_";

const LABELS = {
  access: "fog:ai-access",
  refresh: "fog:ai-refresh",
  code: "fog:ai-code",
  client: "fog:ai-client",
  authz: "fog:ai-authz",
} as const;

export type AiAccessToken = Readonly<{
  typ: "access";
  uid: string;
  cid: string;
  scope: typeof AI_SCOPE;
  exp: number;
}>;

export type AiRefreshToken = Readonly<{
  typ: "refresh";
  uid: string;
  cid: string;
  /** The `client_id` the pair was issued to; a refresh must present the same (OAuth 2.1 §4.3). */
  client: string;
  exp: number;
}>;

/** A signed authorization code: self-contained, spent once by its `jti`. */
export type AiAuthorizationCode = Readonly<{
  typ: "code";
  jti: string;
  uid: string;
  cid: string;
  /** The `client_id` the code was issued to; the exchange must present the same. */
  client: string;
  redirect: string;
  /** PKCE S256 challenge; the exchange must present the verifier. */
  challenge: string;
  exp: number;
}>;

/** What a stateless registration signs into a `client_id`. */
export type AiClientMetadata = Readonly<{
  name: string;
  redirectUris: readonly string[];
  iat: number;
}>;

/** The validated authorization request, carried through P-14 as a signed blob. */
export type AiAuthorizeRequest = Readonly<{
  typ: "authz";
  client: string;
  name: string;
  redirect: string;
  state: string | null;
  challenge: string;
  scope: typeof AI_SCOPE;
  exp: number;
}>;

export interface AiTokenCodec {
  issueAccess(uid: string, cid: string, now: Date): Promise<string>;
  verifyAccess(token: string, now: Date): Promise<AiAccessToken | null>;
  issueRefresh(
    uid: string,
    cid: string,
    client: string,
    now: Date,
  ): Promise<string>;
  verifyRefresh(token: string, now: Date): Promise<AiRefreshToken | null>;
  issueCode(
    payload: Omit<AiAuthorizationCode, "typ" | "exp">,
    now: Date,
  ): Promise<string>;
  verifyCode(code: string, now: Date): Promise<AiAuthorizationCode | null>;
  issueClientId(metadata: AiClientMetadata): Promise<string>;
  verifyClientId(clientId: string): Promise<AiClientMetadata | null>;
  issueAuthorizeRequest(
    payload: Omit<AiAuthorizeRequest, "typ" | "exp">,
    now: Date,
  ): Promise<string>;
  verifyAuthorizeRequest(
    blob: string,
    now: Date,
  ): Promise<AiAuthorizeRequest | null>;
}

const encoder = new TextEncoder();

async function sign(key: CryptoKey, payload: unknown): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

async function open(key: CryptoKey, value: string): Promise<unknown | null> {
  const parts = value.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature) as BufferSource,
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function live(exp: unknown, now: Date): exp is number {
  return typeof exp === "number" && Number.isFinite(exp) && exp > now.getTime();
}

/**
 * The AI API's signed values (PH-07 §1.1): access and refresh tokens, the
 * authorization code, the stateless `client_id`, and the authorization
 * request P-14 carries. All share one shape — `<base64url JSON>.<HMAC>`
 * — and none shares a key: every kind is signed under its own label, so
 * a value of one kind presented as another fails its signature before
 * its `typ` is even read. Every refusal is `null`.
 */
export function createAiTokenCodec(options: { secret: string }): AiTokenCodec {
  if (options.secret.length < MIN_AI_CLIENT_TOKEN_SECRET_LENGTH) {
    throw new Error(
      `AI client token secret must be at least ${MIN_AI_CLIENT_TOKEN_SECRET_LENGTH} characters`,
    );
  }
  const keys = {
    access: deriveHmacKey(options.secret, LABELS.access),
    refresh: deriveHmacKey(options.secret, LABELS.refresh),
    code: deriveHmacKey(options.secret, LABELS.code),
    client: deriveHmacKey(options.secret, LABELS.client),
    authz: deriveHmacKey(options.secret, LABELS.authz),
  };

  return {
    async issueAccess(uid, cid, now) {
      const payload: AiAccessToken = {
        typ: "access",
        uid,
        cid,
        scope: AI_SCOPE,
        exp: now.getTime() + AI_ACCESS_TOKEN_TTL_MS,
      };
      return sign(await keys.access(), payload);
    },
    async verifyAccess(token, now) {
      const v = await open(await keys.access(), token);
      if (
        !isRecord(v) ||
        v.typ !== "access" ||
        !str(v.uid) ||
        !str(v.cid) ||
        v.scope !== AI_SCOPE ||
        !live(v.exp, now)
      ) {
        return null;
      }
      return {
        typ: "access",
        uid: v.uid,
        cid: v.cid,
        scope: AI_SCOPE,
        exp: v.exp,
      };
    },

    async issueRefresh(uid, cid, client, now) {
      const payload: AiRefreshToken = {
        typ: "refresh",
        uid,
        cid,
        client,
        exp: now.getTime() + AI_REFRESH_TOKEN_TTL_MS,
      };
      return sign(await keys.refresh(), payload);
    },
    async verifyRefresh(token, now) {
      const v = await open(await keys.refresh(), token);
      if (
        !isRecord(v) ||
        v.typ !== "refresh" ||
        !str(v.uid) ||
        !str(v.cid) ||
        !str(v.client) ||
        !live(v.exp, now)
      ) {
        return null;
      }
      return {
        typ: "refresh",
        uid: v.uid,
        cid: v.cid,
        client: v.client,
        exp: v.exp,
      };
    },

    async issueCode(payload, now) {
      const code: AiAuthorizationCode = {
        typ: "code",
        ...payload,
        exp: now.getTime() + AI_AUTHORIZATION_CODE_TTL_MS,
      };
      return sign(await keys.code(), code);
    },
    async verifyCode(code, now) {
      const v = await open(await keys.code(), code);
      if (
        !isRecord(v) ||
        v.typ !== "code" ||
        !str(v.jti) ||
        !str(v.uid) ||
        !str(v.cid) ||
        !str(v.client) ||
        !str(v.redirect) ||
        !str(v.challenge) ||
        !live(v.exp, now)
      ) {
        return null;
      }
      return {
        typ: "code",
        jti: v.jti,
        uid: v.uid,
        cid: v.cid,
        client: v.client,
        redirect: v.redirect,
        challenge: v.challenge,
        exp: v.exp,
      };
    },

    async issueClientId(metadata) {
      return `${AI_CLIENT_ID_PREFIX}${await sign(await keys.client(), metadata)}`;
    },
    async verifyClientId(clientId) {
      if (!clientId.startsWith(AI_CLIENT_ID_PREFIX)) return null;
      const v = await open(
        await keys.client(),
        clientId.slice(AI_CLIENT_ID_PREFIX.length),
      );
      if (
        !isRecord(v) ||
        !str(v.name) ||
        !Array.isArray(v.redirectUris) ||
        v.redirectUris.length === 0 ||
        !v.redirectUris.every(str) ||
        typeof v.iat !== "number"
      ) {
        return null;
      }
      return {
        name: v.name,
        redirectUris: v.redirectUris.map(String),
        iat: v.iat,
      };
    },

    async issueAuthorizeRequest(payload, now) {
      const request: AiAuthorizeRequest = {
        typ: "authz",
        ...payload,
        exp: now.getTime() + AI_AUTHORIZE_REQUEST_TTL_MS,
      };
      return sign(await keys.authz(), request);
    },
    async verifyAuthorizeRequest(blob, now) {
      const v = await open(await keys.authz(), blob);
      if (
        !isRecord(v) ||
        v.typ !== "authz" ||
        !str(v.client) ||
        !str(v.name) ||
        !str(v.redirect) ||
        !(v.state === null || typeof v.state === "string") ||
        !str(v.challenge) ||
        v.scope !== AI_SCOPE ||
        !live(v.exp, now)
      ) {
        return null;
      }
      return {
        typ: "authz",
        client: v.client,
        name: v.name,
        redirect: v.redirect,
        state: v.state,
        challenge: v.challenge,
        scope: AI_SCOPE,
        exp: v.exp,
      };
    },
  };
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), compared against the challenge. */
export async function pkceChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** 43–128 characters of the unreserved set (RFC 7636 §4.1). */
export function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** The challenge is 43 characters of base64url for S256. */
export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
