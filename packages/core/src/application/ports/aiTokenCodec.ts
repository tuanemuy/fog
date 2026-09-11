export const AI_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const AI_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AI_AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const AI_AUTHORIZE_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The one scope a connection carries (`TokenScope.ai()`). */
export const AI_SCOPE = "ai";

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

/**
 * Issues and verifies the AI API's signed values — access and refresh
 * tokens, the authorization code, the stateless `client_id` and the
 * authorization request P-14 carries.
 *
 * **Presentation-layer port. No usecase may reference it.** The OAuth 2.1
 * surface (`apps/web/app/presentation/ai/`) is its only caller; which
 * connection a token names and whether that connection is still active is
 * decided by the usecases the handlers call, not by the codec. Like
 * `SessionCodec`, it reads no storage, and every refusal is `null` rather
 * than a throw. The composition root (`application/di/serverCloudflare.ts`)
 * supplies the WebCrypto implementation.
 */
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
