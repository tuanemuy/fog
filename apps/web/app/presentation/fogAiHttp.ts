import {
  ForbiddenError,
  UnauthorizedError,
} from "@repo/core/application/errors";
import type { AiServices } from "@repo/core/application/fog/aiTypes";
import type { Logger } from "@repo/core/application/ports/logger";
import {
  extractSerializedError,
  httpStatusFor,
  redactForClient,
} from "./errorResponse";
import {
  aiAuthorizeQuerySchema,
  aiRequestSchema,
  aiTokenSchema,
} from "./fogAiSchema";
import { validateInput } from "./validator";

const headers = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers });
const failure = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);
const paths = new Set(["/oauth/authorize", "/oauth/token", "/api/ai"]);
export const isFogAiHttp = (path: string) =>
  paths.has(path) || path.startsWith("/api/ai/");

function params(value: URLSearchParams) {
  if ([...value.keys()].some((key) => value.getAll(key).length !== 1))
    throw new ForbiddenError(
      "DUPLICATE_PARAMETER",
      "同じパラメータを複数指定できません。",
    );
  return Object.fromEntries(value);
}
async function readBody(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function handleFogAiHttp(
  request: Request,
  {
    services,
    appUrl,
    logger,
  }: {
    services: Pick<
      AiServices,
      "beginAiAuthorization" | "exchangeAiCode" | "executeAi"
    >;
    appUrl: string;
    logger: Logger;
  },
): Promise<Response> {
  const url = new URL(request.url);
  if (!paths.has(url.pathname))
    return failure(404, "NOT_FOUND", "このAPIは存在しません。");
  try {
    if (url.pathname === "/oauth/authorize") {
      if (request.method !== "GET")
        return failure(405, "METHOD_NOT_ALLOWED", "GETを使用してください。");
      if (request.headers.has("authorization"))
        throw new ForbiddenError(
          "INVALID_AUTHORIZATION",
          "認可はブラウザから開始してください。",
        );
      if (request.url.length > 8192)
        return failure(414, "REQUEST_TOO_LONG", "認可要求が長すぎます。");
      const input = validateInput(aiAuthorizeQuerySchema)(
        params(url.searchParams),
      );
      const result = await services.beginAiAuthorization({
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        state: input.state,
        codeChallenge: input.code_challenge,
        codeChallengeMethod: input.code_challenge_method,
      });
      const destination = new URL("/ai/authorize", appUrl);
      destination.searchParams.set("request", result.requestToken);
      return new Response(null, {
        status: 303,
        headers: { ...headers, Location: destination.href },
      });
    }
    if (request.method !== "POST")
      return failure(405, "METHOD_NOT_ALLOWED", "POSTを使用してください。");
    if (url.search)
      return failure(
        400,
        "INVALID_INPUT",
        "クエリパラメータは使用できません。",
      );
    if (request.headers.has("cookie"))
      throw new ForbiddenError(
        "BEARER_ONLY",
        "このAPIでは人間用のcookieを使用できません。",
      );
    if (url.pathname === "/oauth/token") {
      if (request.headers.has("authorization"))
        throw new ForbiddenError(
          "INVALID_AUTHORIZATION",
          "コードとPKCE verifierを使用してください。",
        );
      if (
        request.headers.get("content-type")?.split(";")[0] !==
        "application/x-www-form-urlencoded"
      )
        return failure(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "form-urlencodedを使用してください。",
        );
      const body = await readBody(request, 16384);
      if (body === null)
        return failure(413, "BODY_TOO_LARGE", "要求が大きすぎます。");
      const input = validateInput(aiTokenSchema)(
        params(new URLSearchParams(body)),
      );
      const token = await services.exchangeAiCode({
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        code: input.code,
        codeVerifier: input.code_verifier,
      });
      return json({
        access_token: token.accessToken,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
      });
    }
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match?.[1])
      throw new UnauthorizedError(
        "AI_TOKEN_REQUIRED",
        "AI接続の認証情報が必要です。再接続してください。",
      );
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return failure(415, "UNSUPPORTED_MEDIA_TYPE", "JSONを使用してください。");
    const body = await readBody(request, 512000);
    if (body === null)
      return failure(413, "BODY_TOO_LARGE", "要求が大きすぎます。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return failure(400, "INVALID_JSON", "JSONを確認してください。");
    }
    const input = validateInput(aiRequestSchema)(parsed);
    return json(await services.executeAi(match[1], input));
  } catch (error) {
    const serialized = extractSerializedError(error);
    if (serialized.kind === "system" || serialized.kind === "unknown")
      logger.error("[fog.ai] request failed", { cause: error });
    const result = json(
      { error: redactForClient(serialized) },
      httpStatusFor(serialized),
    );
    if (result.status === 401)
      result.headers.set(
        "WWW-Authenticate",
        'Bearer realm="fog", error="invalid_token"',
      );
    return result;
  }
}
